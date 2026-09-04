'use strict';
// NAVEE firmware patcher. Loads a stock .bin, identifies the variant, checks it against a
// fingerprint, applies the byte-table patches and re-seals the image with a fresh CRC. A wrong
// or already-patched image is refused, not modified. Raw .bin, CRC-16/XMODEM, NT5 header reseal.

// CRC-16/XMODEM: poly 0x1021, init 0x0000, non-reflected, big-endian on the wire.
function crc16Xmodem(bytes, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= (bytes[i] & 0xFF) << 8;
    for (let n = 0; n < 8; n++) {
      crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
    }
  }
  return crc & 0xFFFF;
}

// Read an unsigned big-endian integer of `size` bytes at `off`.
function beRead(u8, off, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = (v * 256) + (u8[off + i] & 0xFF);
  return v >>> 0;
}
// Write an unsigned big-endian integer of `size` bytes at `off`.
function beWrite(u8, off, size, val) {
  for (let i = size - 1; i >= 0; i--) { u8[off + i] = val & 0xFF; val = Math.floor(val / 256); }
}

function bytesAt(u8, off, arr) {
  for (let i = 0; i < arr.length; i++) if ((u8[off + i] & 0xFF) !== (arr[i] & 0xFF)) return false;
  return true;
}
function ascii(s) { return Array.from(s).map(c => c.charCodeAt(0)); }

// Each entry: recognise the image, verify it is untouched stock, re-seal it, patch it.
const IMAGES = {

  // Display/meter, identical across 9301 and 9701. Carries kickstart + cruise.
  meter: {
    label: 'NT5 Max meter 3.0.2.2',
    kind: 'meter',
    // 16-byte OTA header: tag "T2202" at 0x00, then type/version; body base 0x400.
    match: (u8) => u8.length > 0x14 && bytesAt(u8, 0, ascii('T2202')),
    verify: { size: 0x24C00, crcOff: 0x13, crcStock: 0xe7ab, lenOff: 0x10, lenStock: 0x024800 },
    bodyBase: 0x400,
    // body length as BE-24 @0x10, CRC-16/XMODEM over [0x400,EOF) as BE-16 @0x13.
    reseal: (u8) => {
      const eof = u8.length;
      beWrite(u8, 0x10, 3, eof - 0x400);
      beWrite(u8, 0x13, 2, crc16Xmodem(u8, 0x400, eof));
    },
    patches: [
      // Kickstart / zero-start: bcs -> b, skip the region clamp.
      { off: 0x14bf3, from: [0xd2], to: [0xe0], id: 'kickstart' },
      // Cruise / Tempomat: first beq store -> unconditional b store.
      { off: 0x14679, from: [0xd0], to: [0xe0], id: 'cruise' },
    ],
  },

  // BLDC 9701 (bldc 0.0.1.0). ERPM-governor cap; four cmp.w sites raise 39.0 -> 50.8.
  bldc9701: {
    label: 'NT5 Max BLDC 0.0.1.0 (9701)',
    kind: 'bldc',
    // 16-byte board magic at 0x90 identifies the family (blocks cross-flashing).
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')),
    // body length u32 BE @0x84; primary CRC-16/XMODEM @0xb0 over [0x100, 0x100+len).
    verify: { lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0xc064 },
    reseal: (u8) => {
      const len = beRead(u8, 0x84, 4);
      beWrite(u8, 0xb0, 2, crc16Xmodem(u8, 0x100, 0x100 + len));
      // secondary field @0x13 ships as garbage on this family and is left as stock.
    },
    patches: [
      { off: 0x37fe, from: [0xb9, 0xf5, 0xc3, 0x7f], to: [0xb9, 0xf5, 0xfe, 0x7f], id: 'speed-390a' },
      { off: 0x3a7a, from: [0xb6, 0xf5, 0xc3, 0x7f], to: [0xb6, 0xf5, 0xfe, 0x7f], id: 'speed-390b' },
      { off: 0x4f62, from: [0xb4, 0xf5, 0xc3, 0x7f], to: [0xb4, 0xf5, 0xfe, 0x7f], id: 'speed-390c' },
      { off: 0x4f7c, from: [0xb4, 0xf5, 0xd2, 0x7f], to: [0xb4, 0xf5, 0x08, 0x7f], id: 'speed-420' },
    ],
  },

  // BLDC 9301 (bldc 0.0.0.6). The cap1 open-region table lives in the LZ-compressed .data image;
  // its open words decode to literal bytes in the compressed stream and are edited in place.
  bldc9301: {
    label: 'NT5 Max BLDC 0.0.0.6 (9301)',
    kind: 'bldc',
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')),
    verify: { lenOff: 0x84, lenStock: 0x0000bf40, crcOff: 0xb0, crcStock: 0x122b },
    reseal: (u8) => {
      const len = beRead(u8, 0x84, 4);
      beWrite(u8, 0xb0, 2, crc16Xmodem(u8, 0x100, 0x100 + len));
      // secondary CRC-16/XMODEM @0x13 over [0x80,EOF) is populated on this family -> recompute.
      beWrite(u8, 0x13, 2, crc16Xmodem(u8, 0x80, u8.length));
    },
    patches: [
      // cap1 open words 0x031b->0x0416 (795->1046, ~38.1->50.1 km/h), stored as LZ literals in .data
      { off: 0xc01a, from: [0x1b, 0x03], to: [0x16, 0x04], id: 'speed-open-a' }, // cap1[0]; cap1[10] via backref
      { off: 0xc024, from: [0x1b, 0x03], to: [0x16, 0x04], id: 'speed-open-b' }, // cap1[6]
    ],
  },
};

// Identify which image this is, or null.
function identify(u8) {
  for (const key of Object.keys(IMAGES)) if (IMAGES[key].match(u8)) return key;
  return null;
}

// Verify the image is untouched stock (a wrong or already-patched file is refused, not damaged).
function verifyStock(u8, spec) {
  const v = spec.verify;
  if (v.size !== undefined && u8.length !== v.size)
    return 'wrong size (' + u8.length + ' bytes) - not a stock ' + spec.label + ' or already patched';
  if (v.lenOff !== undefined && beRead(u8, v.lenOff, spec.kind === 'meter' ? 3 : 4) !== v.lenStock)
    return 'length field mismatch - not stock ' + spec.label;
  if (v.crcOff !== undefined && beRead(u8, v.crcOff, 2) !== v.crcStock)
    return 'CRC field 0x' + beRead(u8, v.crcOff, 2).toString(16) + ' != stock 0x' + v.crcStock.toString(16)
         + ' - wrong firmware or already patched';
  return null;
}

// Apply one patch set with per-row expected-byte verification.
function applyPatches(u8, patches) {
  const applied = [];
  for (const p of patches) {
    for (let i = 0; i < p.from.length; i++) {
      const cur = u8[p.off + i] & 0xFF;
      if (cur !== (p.from[i] & 0xFF)) {
        throw new Error('patch "' + p.id + '" @0x' + (p.off + i).toString(16)
          + ' expected 0x' + p.from[i].toString(16) + ' but found 0x' + cur.toString(16)
          + ' (wrong firmware or already patched)');
      }
    }
    for (let i = 0; i < p.to.length; i++) u8[p.off + i] = p.to[i] & 0xFF;
    applied.push(p.id);
  }
  return applied;
}

// Take the stock .bin (ArrayBuffer), return the patched+resealed image. Throws on an unrecognised,
// wrong or already-patched image (never returns a damaged file).
function patchFirmware(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer.slice(0)); // copy: never mutate the caller's buffer
  const key = identify(u8);
  if (!key) throw new Error('Unrecognised firmware - not a NAVEE NT5 Max meter or BLDC image.');
  const spec = IMAGES[key];

  const bad = verifyStock(u8, spec);
  if (bad) throw new Error(bad);

  const applied = applyPatches(u8, spec.patches);
  spec.reseal(u8);

  return {
    image: key,
    label: spec.label,
    kind: spec.kind,
    applied: applied,
    speedPending: !!spec.speedPending,
    bytes: u8,
  };
}

if (typeof window !== 'undefined') {
  window.NVFW = { patchFirmware, identify, crc16Xmodem, IMAGES };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { patchFirmware, identify, crc16Xmodem, beRead, beWrite, IMAGES };
}
