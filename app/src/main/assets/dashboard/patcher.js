'use strict';
// NAVEE firmware patcher. Loads a stock .bin, identifies the NT5 variant, checks it against a
// fingerprint, applies the byte-table patches and re-seals the image with a fresh CRC. A wrong
// or already-patched image is refused, not modified. Raw .bin, CRC-16/XMODEM.

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

// Meter reseal: 24-bit body length @0x10, CRC-16/XMODEM over [0x400,EOF) @0x13. Body base 0x400.
function meterReseal(u8) {
  const eof = u8.length;
  beWrite(u8, 0x10, 3, eof - 0x400);
  beWrite(u8, 0x13, 2, crc16Xmodem(u8, 0x400, eof));
}
// ERPM-governor BLDC reseal: primary CRC-16/XMODEM over [0x100,0x100+len) @0xb0 only.
function bldcResealErpm(u8) {
  const len = beRead(u8, 0x84, 4);
  beWrite(u8, 0xb0, 2, crc16Xmodem(u8, 0x100, 0x100 + len));
}
// LZ-.data BLDC reseal: primary @0xb0 over [0x100,0x100+len), then secondary @0x13 over [0x80,EOF).
// Secondary runs last because @0xb0 lies inside [0x80,EOF).
function bldcResealLz(u8) {
  const len = beRead(u8, 0x84, 4);
  beWrite(u8, 0xb0, 2, crc16Xmodem(u8, 0x100, 0x100 + len));
  beWrite(u8, 0x13, 2, crc16Xmodem(u8, 0x80, u8.length));
}

// Each entry: recognise the image, verify it is untouched stock, re-seal it, patch it.
// Board magics and the T2202 meter tag are shared within a family, so BLDC entries pin the exact
// build by the 4-byte version word @0x80 and meter entries by size plus the stock CRC @0x13.
const IMAGES = {

  // Meter 3.0.2.2, NT5 Max (9301 / 9701). 150528 bytes. Carries kickstart plus cruise.
  meterMax: {
    label: 'NT5 Max meter 3.0.2.2',
    kind: 'meter',
    match: (u8) => u8.length === 0x24C00 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xe7ab,
    verify: { size: 0x24C00, crcOff: 0x13, crcStock: 0xe7ab, lenOff: 0x10, lenStock: 0x024800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [
      { off: 0x14bf3, from: [0xd2], to: [0xe0], id: 'kickstart' },
      { off: 0x14679, from: [0xd0], to: [0xe0], id: 'cruise' },
      // Over-speed warn 'R' -> silent. The de-capped controller asserts an over-speed warn above its
      // former limit; the meter turns any non-silent warn code into a continuous beep. 0x52('R') is the
      // only non-silent letter, so storing 0x00 instead keeps the scooter quiet while real faults still beep.
      { off: 0x1404e, from: [0x52], to: [0x00], id: 'beep-r-warn' },
      { off: 0x14d6e, from: [0x33], to: [0x35], id: 'version-marker' }, // reported meter version 3.0.2.2 -> 5.0.2.2
    ],
  },

  // Meter 3.0.2.2, NT5 Turbo (11101) / Ultra (9401), byte-identical. 149504 bytes.
  meterTurboUltra: {
    label: 'NT5 Turbo / Ultra meter 3.0.2.2',
    kind: 'meter',
    match: (u8) => u8.length === 0x24800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xce12,
    verify: { size: 0x24800, crcOff: 0x13, crcStock: 0xce12, lenOff: 0x10, lenStock: 0x024400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [
      { off: 0x14b9f, from: [0xd2], to: [0xe0], id: 'kickstart' },
      { off: 0x14631, from: [0xd0], to: [0xe0], id: 'cruise' },
    ],
  },

  // Meter 3.0.2.2, NT5 Max+ (9201). Same 149504 size as Turbo/Ultra but a different build (CRC 0x0f34).
  meterMaxPlus: {
    label: 'NT5 Max+ meter 3.0.2.2',
    kind: 'meter',
    match: (u8) => u8.length === 0x24800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x0f34,
    verify: { size: 0x24800, crcOff: 0x13, crcStock: 0x0f34, lenOff: 0x10, lenStock: 0x024400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [
      { off: 0x14ba3, from: [0xd2], to: [0xe0], id: 'kickstart' },
      { off: 0x14635, from: [0xd0], to: [0xe0], id: 'cruise' },
    ],
  },

  // Meter 3.0.1.6, NT5 Ultra X (9501). 148480 bytes. This build predates the kickstart/cruise
  // region handling, so there is nothing to patch; the entry only identifies the image.
  meterUltraX: {
    label: 'NT5 Ultra X meter 3.0.1.6',
    kind: 'meter',
    match: (u8) => u8.length === 0x24400 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x9f3a,
    verify: { size: 0x24400, crcOff: 0x13, crcStock: 0x9f3a, lenOff: 0x10, lenStock: 0x024000 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [],
  },

  // BLDC 9701 (bldc 0.0.1.0, NT5 Max). ERPM-governor cap; four cmp.w sites raise 39.0 -> 50.8.
  // Magic collides with 9401; the version word @0x80 (00 00 01 00) splits them.
  bldc9701: {
    label: 'NT5 Max BLDC 0.0.1.0 (9701)',
    kind: 'bldc',
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x00]),
    verify: { size: 0xf900, lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0xc064 },
    reseal: bldcResealErpm,
    patches: [
      { off: 0x37fe, from: [0xb9, 0xf5, 0xc3, 0x7f], to: [0xb9, 0xf5, 0xfe, 0x7f], id: 'speed-390a' },
      { off: 0x3a7a, from: [0xb6, 0xf5, 0xc3, 0x7f], to: [0xb6, 0xf5, 0xfe, 0x7f], id: 'speed-390b' },
      { off: 0x4f62, from: [0xb4, 0xf5, 0xc3, 0x7f], to: [0xb4, 0xf5, 0xfe, 0x7f], id: 'speed-390c' },
      { off: 0x4f7c, from: [0xb4, 0xf5, 0xd2, 0x7f], to: [0xb4, 0xf5, 0x08, 0x7f], id: 'speed-420' },
    ],
  },

  // BLDC 9401 (bldc 0.0.0.5, NT5 Ultra). ERPM-governor cap, same four sites as 9701 shifted earlier.
  // Magic collides with 9701; version word @0x80 (00 00 00 05) splits them.
  bldc9401: {
    label: 'NT5 Ultra BLDC 0.0.0.5 (9401)',
    kind: 'bldc',
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]),
    verify: { size: 0xf900, lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0x14d4 },
    reseal: bldcResealErpm,
    patches: [
      { off: 0x3616, from: [0xb9, 0xf5, 0xc3, 0x7f], to: [0xb9, 0xf5, 0xfe, 0x7f], id: 'speed-390a' },
      { off: 0x3892, from: [0xb6, 0xf5, 0xc3, 0x7f], to: [0xb6, 0xf5, 0xfe, 0x7f], id: 'speed-390b' },
      { off: 0x4d2a, from: [0xb4, 0xf5, 0xc3, 0x7f], to: [0xb4, 0xf5, 0xfe, 0x7f], id: 'speed-390c' },
      { off: 0x4d44, from: [0xb4, 0xf5, 0xd2, 0x7f], to: [0xb4, 0xf5, 0x08, 0x7f], id: 'speed-420' },
    ],
  },

  // BLDC 9301 (bldc 0.0.0.6, NT5 Max). LZ-.data cap1 open words 0x031b->0x0416 (795->1046).
  // Magic collides with 9201/11101; version word @0x80 (00 00 00 06) splits them.
  bldc9301: {
    label: 'NT5 Max BLDC 0.0.0.6 (9301)',
    kind: 'bldc',
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x06]),
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000bf40, crcOff: 0xb0, crcStock: 0x122b },
    reseal: bldcResealLz,
    patches: [
      // capZ lock/unlock, boot-throttled, latched. The region matcher writes the top-speed clamp at
      // 0x2000035a; NOP its two stores and drive capZ ourselves. An inline setter in the drive-frame
      // block latches capZ: mode nibble 5 -> 800 (unlock ~44), nibble 6 -> 400 (lock ~22), any other
      // nibble (gear change) leaves capZ untouched. A boot-init stub (reached by redirecting the boot
      // thunk's literal) seeds capZ = 400 after scatterload and before main, so the scooter boots
      // rideable at ~22, unlocks and locks on the app's command and re-locks on every reboot (RAM).
      { off: 0x4be4, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-a' },
      { off: 0x4c00, from: [0x02, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-b' },
      { off: 0x7d14,
        from: [0x11, 0x78, 0x01, 0x29, 0x6b, 0xd1, 0x62, 0x49, 0x09, 0x78, 0x14, 0x29, 0x67, 0xd2, 0x19, 0x07, 0x09, 0x0f, 0x0b, 0x29, 0x00, 0xd0, 0x02, 0x21, 0x31, 0x70],
        to:   [0x19, 0x07, 0x09, 0x0f, 0x13, 0x46, 0x9c, 0x3b, 0xc8, 0x26, 0x76, 0x00, 0x06, 0x29, 0x02, 0xd0, 0x05, 0x29, 0x01, 0xd1, 0x76, 0x00, 0x1e, 0x80, 0x00, 0xbf],
        id: 'capz-latch' },
      // boot-init: stub in reserved-vector free space seeds capZ = 400 (22 km/h) before main
      { off: 0x110,
        from: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        to:   [0x02, 0x48, 0xc8, 0x21, 0x49, 0x00, 0x01, 0x80, 0x01, 0x48, 0x00, 0x47, 0x5a, 0x03, 0x00, 0x20, 0x49, 0xac, 0x00, 0x00],
        id: 'capz-boot-stub' },
      { off: 0x1cc, from: [0x49, 0xac, 0x00, 0x00], to: [0x11, 0x00, 0x00, 0x00], id: 'capz-boot-thunk' },
      { off: 0x8532, from: [0x30], to: [0x35], id: 'version-marker' }, // bldc version 0.0.0.6 -> 5.5.5.6
    ],
  },

  // BLDC 9207 (bldc 0.0.0.7, NT5 Max+ 9201 / Turbo 11101, byte-identical). LZ-.data, same cap1 words.
  // Magic collides with 9301; version word @0x80 (00 00 00 07) splits them.
  bldc9207: {
    label: 'NT5 Max+ / Turbo BLDC 0.0.0.7 (9201/11101)',
    kind: 'bldc',
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x07]),
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000ba88, crcOff: 0xb0, crcStock: 0xcaa9 },
    reseal: bldcResealLz,
    patches: [
      { off: 0xbb5f, from: [0x1b, 0x03], to: [0x16, 0x04], id: 'speed-open-a' },
      { off: 0xbb69, from: [0x1b, 0x03], to: [0x16, 0x04], id: 'speed-open-b' },
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
  if (!key) throw new Error('Unrecognised firmware - not a known NAVEE NT5 meter or BLDC image.');
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
    nothingToPatch: applied.length === 0,
    bytes: u8,
  };
}

if (typeof window !== 'undefined') {
  window.NVFW = { patchFirmware, identify, crc16Xmodem, IMAGES };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { patchFirmware, identify, crc16Xmodem, beRead, beWrite, IMAGES };
}
