'use strict';
// NAVEE firmware patcher.

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
// MM32F5333 hardware-CRC32: poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no final xor, MSB-first.
function crc32Mm(u8, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    c = (c ^ (u8[i] << 24)) >>> 0;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? (((c << 1) ^ 0x04C11DB7) >>> 0) : ((c << 1) >>> 0);
  }
  return c >>> 0;
}
// T2443 (MM32F5333) BLDC reseal: CRC32 over the flashed region [0x418,EOF) stored little-endian @0x404.
// The seal word lies before the CRC range so writing it never invalidates the checksum.
function bldcResealCrc32(u8) {
  const crc = crc32Mm(u8, 0x418, u8.length);
  u8[0x404] = crc & 0xff; u8[0x405] = (crc >>> 8) & 0xff; u8[0x406] = (crc >>> 16) & 0xff; u8[0x407] = (crc >>> 24) & 0xff;
}
// MM32SPIN0280 (K100 family, Cortex-M0) BLDC reseal: CRC32 over [0x18,EOF) stored little-endian @0x04.
// The seal word sits before the CRC range so writing it never invalidates the checksum.
function bldcResealCrc32K100(u8) {
  const crc = crc32Mm(u8, 0x18, u8.length);
  u8[0x04] = crc & 0xff; u8[0x05] = (crc >>> 8) & 0xff; u8[0x06] = (crc >>> 16) & 0xff; u8[0x07] = (crc >>> 24) & 0xff;
}

// Each entry: recognise the image, verify it is untouched stock, re-seal it, patch it.
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
      { off: 0x14d6e, from: [0x33], to: [0x35], id: 'version-marker' }, // reported meter version 3.0.2.2 -> 5.0.2.2
      { off: 0x15de4, from: [0xff, 0xf7, 0xef, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' }, // over-speed warning bl -> nop
      { off: 0x15e58, from: [0xff, 0xf7, 0xb5, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/alarm bl -> nop
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
      { off: 0x14d1a, from: [0x33], to: [0x35], id: 'version-marker' }, // reported meter version 3.0.2.2 -> 5.0.2.2
      { off: 0x15da2, from: [0xff, 0xf7, 0x07, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' }, // over-speed warning bl -> nop
      { off: 0x15e1c, from: [0xff, 0xf7, 0xa9, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/alarm bl -> nop
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
      { off: 0x14d1e, from: [0x33], to: [0x35], id: 'version-marker' }, // reported meter version 3.0.2.2 -> 5.0.2.2
      { off: 0x15da6, from: [0xff, 0xf7, 0x07, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' }, // over-speed warning bl -> nop
      { off: 0x15e48, from: [0xff, 0xf7, 0x95, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/alarm bl -> nop
      { off: 0x15e8c, from: [0xff, 0xf7, 0x96, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' }, // startup/error melody bl -> nop
    ],
  },

  // Meter 3.0.1.6, NT5 Ultra X (9501).
  meterUltraX: {
    label: 'NT5 Ultra X meter 3.0.1.6',
    kind: 'meter',
    match: (u8) => u8.length === 0x24400 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x9f3a,
    verify: { size: 0x24400, crcOff: 0x13, crcStock: 0x9f3a, lenOff: 0x10, lenStock: 0x024000 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [
      { off: 0x1314e, from: [0x92, 0x7d], to: [0x06, 0x22], id: 'speed-region-unlock' }, // region read -> movs r2,#6 (force unrestricted, keep CONFIG_SPEED)
      { off: 0x182f6, from: [0xfd, 0xf7, 0x93, 0xfb], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' }, // over-speed warning bl -> nop
      { off: 0x15ba8, from: [0xff, 0xf7, 0xfd, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/alarm bl -> nop
      { off: 0x15c14, from: [0xff, 0xf7, 0xea, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' }, // startup/error melody bl -> nop
    ],
  },

  // Meter 3.0.2.0, byte-identical across XT5 Pro (5301), XT5 Ultra (5801) and XT5 Max (5901).
  meterXT5: {
    label: 'XT5 meter 3.0.2.0 (5301/5801/5901)',
    kind: 'meter',
    match: (u8) => u8.length === 0x24400 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xb37d,
    verify: { size: 0x24400, crcOff: 0x13, crcStock: 0xb37d, lenOff: 0x10, lenStock: 0x024000 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [
      { off: 0x14a49, from: [0xd2], to: [0xe0], id: 'kickstart' }, // zero-start region floor (bcs) -> unconditional, levels 0-2 accepted in every region
      { off: 0x14bba, from: [0x33], to: [0x35], id: 'version-marker' }, // meter version builder leading digit '3' -> '5', reported meter version 3.0.2.0 -> 5.0.2.0 (fwMeter "5020")
      { off: 0x15b3e, from: [0xff, 0xf7, 0x4f, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' }, // over-speed warning bl -> nop
      { off: 0x15b5e, from: [0xff, 0xf7, 0x3f, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed2' }, // over-speed 2nd bl -> nop
      { off: 0x15b8c, from: [0xcb, 0xf7, 0x8c, 0xd9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/alarm bl -> nop
      { off: 0x15be4, from: [0xff, 0xf7, 0xfd, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm2' }, // find-me/alarm 2nd bl -> nop
      { off: 0x15c50, from: [0xff, 0xf7, 0xea, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' }, // startup/error melody bl -> nop
    ],
  },

  // Meter 2.0.4.6, byte-identical across ST3 Pro (12501/3801), ST3 (3701) and GT3 / GT3 Pro / GT3 Max (3601/3401/3501/12601).
  meterST3GT3: {
    label: 'ST3/GT3 meter 2.0.4.6',
    kind: 'meter',
    match: (u8) => u8.length === 0x22800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x9bce,
    verify: { size: 0x22800, crcOff: 0x13, crcStock: 0x9bce, lenOff: 0x10, lenStock: 0x022400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'The ST3/GT3 meter is never patched: it hosts BLE and is the only route back for a failed controller update, so a bad meter commit cannot be undone. The controller carries the raised top gear on its own.',
    patches: [],
  },

  // Meter 0.0.0.7, NT3 Pro (12401). 146432 bytes. Beep-silence (buzzer gate) so a de-capped controller stays quiet.
  meterNT3Pro: {
    label: 'NT3 Pro meter 0.0.0.7',
    kind: 'meter',
    match: (u8) => u8.length === 0x23c00 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xe77b,
    verify: { size: 0x23c00, crcOff: 0x13, crcStock: 0xe77b, lenOff: 0x10, lenStock: 0x023800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // Meter 0.0.0.7, NT3 Max (12701). 146432 bytes. Beep-silence (buzzer gate).
  meterNT3Max: {
    label: 'NT3 Max meter 0.0.0.7',
    kind: 'meter',
    match: (u8) => u8.length === 0x23c00 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xb450,
    verify: { size: 0x23c00, crcOff: 0x13, crcStock: 0xb450, lenOff: 0x10, lenStock: 0x023800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // Meter 1.0.0.4, GT5 Pro / GT5 Max (8401/8501, byte-identical).
  meterGT5: {
    label: 'GT5 meter 1.0.0.4',
    kind: 'meter',
    match: (u8) => u8.length === 0x23400 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xc780,
    verify: { size: 0x23400, crcOff: 0x13, crcStock: 0xc780, lenOff: 0x10, lenStock: 0x023000 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'The GT5 meter is never patched: it hosts BLE and is the only route back from a failed controller update. The controller carries the raised top gear on its own.',
    patches: [],
  },

  // BLDC 9701 (bldc 0.0.1.0, NT5 Max).
  bldc9701: {
    label: 'NT5 Max BLDC 0.0.1.0 (9701)',
    mark: '5.0.5.0',
    kind: 'bldc',
    match: (u8) => u8.length === 0xf900 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x00]) && beRead(u8, 0xb0, 2) === 0xc064,
    verify: { size: 0xf900, lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0xc064 },
    reseal: bldcResealErpm,
    patches: [
      { off: 0x5f70, from: [0x18, 0x80], to: [0x00, 0xbf], id: 'latch-nop-init-a' }, // drop region-init store to 0x350
      { off: 0x5f90, from: [0x1c, 0x80], to: [0x00, 0xbf], id: 'latch-nop-init-b' }, // drop 2nd region-init store to 0x350
      { off: 0x4d00, from: [0x4e, 0x03, 0x00, 0x20], to: [0x50, 0x03, 0x00, 0x20], id: 'latch-repoint-mode3' }, // mode-3 ptr 0x2000034e -> 0x20000350
      { off: 0x401a, from: [0x01, 0xf0, 0x6f, 0xff], to: [0x0b, 0xf0, 0xe9, 0xfb], id: 'latch-boot-seed-call' }, // region-init bl -> cave seed
      { off: 0xf7f0,
        from: [0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff],
        to:   [0x00,0xb5,0xf6,0xf7,0x83,0xfb,0x40,0xf2, 0xb8,0x10,0x40,0xf2,0x50,0x31,0xc2,0xf2, 0x00,0x01,0x08,0x80,0x00,0xbd,0x9e,0xf8, 0x03,0x20,0x02,0xf0,0x0f,0x03,0x07,0x2b, 0x02,0xd0,0x06,0x2b,0x03,0xd0,0x09,0xe0, 0x40,0xf2,0x20,0x30,0x01,0xe0,0x40,0xf2, 0xb8,0x10,0x40,0xf2,0x50,0x33,0xc2,0xf2, 0x00,0x03,0x18,0x80,0xfa,0xf7,0x0e,0xbc],
        id: 'latch-cave' }, // seed 440 + real init, then nibble 7->800 (app-only) / 6->440 on 0x20000350
      { off: 0xa048, from: [0x9e, 0xf8, 0x03, 0x20], to: [0x05, 0xf0, 0xdd, 0xbb], id: 'latch-detour' }, // drive-mode byte3 read -> cave latch
      { off: 0xa8ee, from: [0x30, 0x21, 0x39, 0x71, 0x79, 0x71, 0x31, 0x22, 0xba, 0x71, 0xf9, 0x71], to: [0x35, 0x22, 0x30, 0x21, 0x3a, 0x71, 0x79, 0x71, 0xba, 0x71, 0xf9, 0x71], id: 'version-marker' }, // fwBldc "0010" -> "5050"
    ],
  },

  // BLDC 9401 (bldc 0.0.0.5, NT5 Ultra).
  bldc9401: {
    label: 'NT5 Ultra BLDC 0.0.0.5 (9401)',
    mark: '5.0.5.5',
    kind: 'bldc',
    match: (u8) => u8.length === 0xf900 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0x14d4,
    verify: { size: 0xf900, lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0x14d4 },
    reseal: bldcResealErpm,
    patches: [
      { off: 0x5d14, from: [0x18, 0x80], to: [0x00, 0xbf], id: 'latch-nop-init-a' }, // drop region-init store to 0x350
      { off: 0x5d34, from: [0x1c, 0x80], to: [0x00, 0xbf], id: 'latch-nop-init-b' }, // drop 2nd region-init store to 0x350
      { off: 0x4ad8, from: [0x4e, 0x03, 0x00, 0x20], to: [0x50, 0x03, 0x00, 0x20], id: 'latch-repoint-mode3' }, // mode-3 ptr 0x2000034e -> 0x20000350
      { off: 0x3e2a, from: [0x01, 0xf0, 0x39, 0xff], to: [0x0b, 0xf0, 0xe1, 0xfc], id: 'latch-boot-seed-call' }, // region-init bl -> cave seed
      { off: 0xf7f0,
        from: [0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff],
        to:   [0x00,0xb5,0xf6,0xf7,0x55,0xfa,0x40,0xf2, 0xb8,0x10,0x40,0xf2,0x50,0x31,0xc2,0xf2, 0x00,0x01,0x08,0x80,0x00,0xbd,0x00,0xbf, 0x9e,0xf8,0x03,0x10,0x01,0xf0,0x0f,0x03, 0x07,0x2b,0x02,0xd0,0x06,0x2b,0x03,0xd0, 0x09,0xe0,0x40,0xf2,0x20,0x30,0x01,0xe0, 0x40,0xf2,0xb8,0x10,0x40,0xf2,0x50,0x33, 0xc2,0xf2,0x00,0x03,0x18,0x80,0xfa,0xf7, 0x8f,0xba],
        id: 'latch-cave' }, // seed 440 + real init, then nibble 7->800 (app-only) / 6->440 on 0x20000350
      { off: 0x9d4c, from: [0x9e, 0xf8, 0x03, 0x10], to: [0x05, 0xf0, 0x5c, 0xbd], id: 'latch-detour' }, // drive-mode byte3 read -> cave latch
      { off: 0xa5e0, from: [0x30, 0x21, 0x39, 0x71, 0x79, 0x71, 0xb9, 0x71, 0x35, 0x21, 0xf9, 0x71], to: [0x35, 0x22, 0x30, 0x21, 0x3a, 0x71, 0x79, 0x71, 0xba, 0x71, 0xfa, 0x71], id: 'version-marker' }, // fwBldc "0005" -> "5055"
    ],
  },

  // BLDC 9301 (bldc 0.0.0.6, NT5 Max). LZ-.data cap1 open words 0x031b->0x0416 (795->1046).
  // Magic collides with 9201/11101; version word @0x80 (00 00 00 06) splits them.
  bldc9301: {
    label: 'NT5 Max BLDC 0.0.0.6 (9301)',
    mark: '5.5.6.6',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x06]) && beRead(u8, 0xb0, 2) === 0x122b, // size+CRC pin (verword 06 also on S60 0xa080)
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000bf40, crcOff: 0xb0, crcStock: 0x122b },
    reseal: bldcResealLz,
    // The "full" (launch-torque) variant used a firmware length-extension and is DISABLED: it was
    // confirmed to brick the controller on hardware. Only the in-place standard patches below ship.
    variantsDisabled: {
      full: {
        mark: '5.6.6.6',
        experimental: true,
        patches: [
          { off: 0x84, from: [0x00, 0x00, 0xbf, 0x40], to: [0x00, 0x00, 0xbf, 0x80], id: 'len-extend-cave' }, // declared length covers the tail cave
          { off: 0x4be4, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-a' }, // drop region-init store to capZ
          { off: 0x4c00, from: [0x02, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-b' },
          { off: 0x4bda, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'eco-nop-matcher-a' }, // drop region-init store to eco
          { off: 0x4bf4, from: [0x13, 0x80], to: [0x00, 0xbf], id: 'eco-nop-matcher-b' },
          { off: 0x3a2e, from: [0x06, 0xd1], to: [0x00, 0xbf], id: 'launch-degate' }, // run the mode-2 launch setpoint (298) unlocked
          { off: 0x7d18, from: [0x6b, 0xd1], to: [0x00, 0xbf], id: 'modeforce-degate' }, // run the stock mode-2 force unlocked
          { off: 0x7cf8, from: [0xc3, 0x78, 0x67, 0x49], to: [0x04, 0xf0, 0xa2, 0xb9], id: 'latch-detour' }, // byte3 read -> b.w cave
          { off: 0xc040,
            from: [0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0xff,0xff,0xff],
            to:   [0xc3,0x78,0x3a,0x0e,0x12,0x0f,0x07,0x2a, 0x04,0xd0,0x06,0x2a,0x09,0xd1,0x40,0xf2, 0xb8,0x12,0x01,0xe0,0x40,0xf2,0x20,0x32, 0x40,0xf2,0x5a,0x36,0xc2,0xf2,0x00,0x06, 0x32,0x80,0x40,0xf2,0x48,0x21,0xc2,0xf2, 0x00,0x01,0xfb,0xf7,0x47,0xbe],
            id: 'latch-cave' }, // nibble 7 -> capZ=800, nibble 6 -> capZ=440, replay displaced insns, return
          { off: 0x110,
            from: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            to:   [0x03, 0x48, 0xc8, 0x21, 0x49, 0x00, 0x01, 0x80, 0x41, 0x80, 0x02, 0x48, 0x00, 0x47, 0x00, 0x00, 0x58, 0x03, 0x00, 0x20, 0x49, 0xac, 0x00, 0x00],
            id: 'capz-boot-stub' }, // seed capZ + eco = 400 (locked start; never boots unthrottled, re-locks on restart), then jump real main
          { off: 0x1cc, from: [0x49, 0xac, 0x00, 0x00], to: [0x11, 0x00, 0x00, 0x00], id: 'capz-boot-thunk' },
          { off: 0x8532, from: [0x30, 0x23, 0x03, 0x71, 0x43, 0x71, 0x83, 0x71, 0x36, 0x23, 0xc3, 0x71], to: [0x35, 0x23, 0x03, 0x71, 0x36, 0x23, 0x43, 0x71, 0x83, 0x71, 0xc3, 0x71], id: 'version-marker' }, // fwBldc "0006" -> "5666"
        ],
      },
    },
    patches: [
      // capZ lock/unlock, boot-throttled, latched, TOP GEAR ONLY.
      { off: 0x4be4, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-a' },
      { off: 0x4c00, from: [0x02, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-b' },
      { off: 0x4bda, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'eco-nop-matcher-a' },
      { off: 0x4bf4, from: [0x13, 0x80], to: [0x00, 0xbf], id: 'eco-nop-matcher-b' },
      { off: 0x7d14,
        from: [0x11, 0x78, 0x01, 0x29, 0x6b, 0xd1, 0x62, 0x49, 0x09, 0x78, 0x14, 0x29, 0x67, 0xd2, 0x19, 0x07, 0x09, 0x0f, 0x0b, 0x29, 0x00, 0xd0, 0x02, 0x21, 0x31, 0x70],
        to:   [0x19, 0x07, 0x09, 0x0f, 0x13, 0x46, 0x9c, 0x3b, 0x06, 0x29, 0x03, 0xd0, 0x07, 0x29, 0x04, 0xd1, 0xc8, 0x26, 0x00, 0xe0, 0x6e, 0x26, 0xb6, 0x00, 0x1e, 0x80],
        id: 'capz-latch' },
      // boot-init: stub in reserved-vector free space seeds top-gear capZ 0x2000035a = 400 AND pins the
      // eco cell 0x20000358 = 400 (~20 km/h) before main
      { off: 0x110,
        from: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        to:   [0x03, 0x48, 0xc8, 0x21, 0x49, 0x00, 0x01, 0x80, 0x41, 0x80, 0x02, 0x48, 0x00, 0x47, 0x00, 0x00, 0x58, 0x03, 0x00, 0x20, 0x49, 0xac, 0x00, 0x00],
        id: 'capz-boot-stub' },
      { off: 0x1cc, from: [0x49, 0xac, 0x00, 0x00], to: [0x11, 0x00, 0x00, 0x00], id: 'capz-boot-thunk' },
      { off: 0x8532, from: [0x30, 0x23, 0x03, 0x71, 0x43, 0x71, 0x83, 0x71, 0x36, 0x23, 0xc3, 0x71], to: [0x35, 0x23, 0x03, 0x71, 0x43, 0x71, 0x36, 0x23, 0x83, 0x71, 0xc3, 0x71], id: 'version-marker' }, // fwBldc "0006" -> "5566"
    ],
  },

  // BLDC 9207 (bldc 0.0.0.7, NT5 Max+ 9201 / Turbo 11101, byte-identical). LZ-.data, same cap1 words.
  // Magic collides with 9301; version word @0x80 (00 00 00 07) splits them.
  bldc9207: {
    label: 'NT5 Max+ / Turbo BLDC 0.0.0.7 (9201/11101)',
    mark: '5.5.6.6',
    kind: 'bldc',
    match: (u8) => u8.length > 0xa0 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x07]) && beRead(u8, 0xb0, 2) === 0xcaa9, // CRC pin: version word 07 also on NT3 Pro (12401)
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000ba88, crcOff: 0xb0, crcStock: 0xcaa9 },
    reseal: bldcResealLz,
    patches: [
      // Unified capZ top-gear latch, sibling of bldc9301 (v07 offsets).
      { off: 0x4b4a, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'eco-nop-matcher-a' },
      { off: 0x4b54, from: [0x01, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-a' },
      { off: 0x4b64, from: [0x13, 0x80], to: [0x00, 0xbf], id: 'eco-nop-matcher-b' },
      { off: 0x4b70, from: [0x02, 0x80], to: [0x00, 0xbf], id: 'capz-nop-matcher-b' },
      { off: 0x7884,
        from: [0x16, 0x78, 0x01, 0x2e, 0x6b, 0xd1, 0x79, 0x4e, 0x36, 0x78, 0x14, 0x2e, 0x67, 0xd2, 0x1b, 0x07, 0x1b, 0x0f, 0x0b, 0x2b, 0x00, 0xd0, 0x02, 0x23, 0x0b, 0x70],
        to:   [0x1b, 0x07, 0x1b, 0x0f, 0x16, 0x46, 0x9c, 0x3e, 0x06, 0x2b, 0x03, 0xd0, 0x07, 0x2b, 0x04, 0xd1, 0xc8, 0x21, 0x00, 0xe0, 0x6e, 0x21, 0x89, 0x00, 0x31, 0x80],
        id: 'capz-latch' },
      { off: 0x110,
        from: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        to:   [0x03, 0x48, 0xc8, 0x21, 0x49, 0x00, 0x01, 0x80, 0x41, 0x80, 0x02, 0x48, 0x00, 0x47, 0x00, 0x00, 0x58, 0x03, 0x00, 0x20, 0x8d, 0xa7, 0x00, 0x00],
        id: 'capz-boot-stub' },
      { off: 0x1cc, from: [0x8d, 0xa7, 0x00, 0x00], to: [0x11, 0x00, 0x00, 0x00], id: 'capz-boot-thunk' },
      { off: 0x80a8, from: [0x30, 0x23, 0x03, 0x71, 0x43, 0x71, 0x83, 0x71, 0x37, 0x23, 0xc3, 0x71], to: [0x35, 0x23, 0x03, 0x71, 0x43, 0x71, 0x36, 0x23, 0x83, 0x71, 0xc3, 0x71], id: 'version-marker' }, // fwBldc "0007" -> "5566"
    ],
  },

  // BLDC 0.0.2.0, ST3 Pro (12501 / 3801, 02831 family).
  bldcST3Pro: {
    label: 'ST3 Pro BLDC 0.0.2.0 (12501/3801)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xd080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x02, 0x00]),
    verify: { size: 0xd080, lenOff: 0x84, lenStock: 0x0000cd34, crcOff: 0xb0, crcStock: 0x4805 },
    reseal: bldcResealLz,
    patches: [
      // The meter sends its speed limit in frame type 9 and the controller then forces that value on
      // drive modes 3 and 5, ignoring the region table. These two branch displacements make modes 3
      // and 5 skip that override block (exactly as if the meter had sent 0), so the mode limit stands.
      { off: 0x3ec0, from: [0x07], to: [0x08], id: 'speed-mode3' },
      { off: 0x3ec4, from: [0x05], to: [0x06], id: 'speed-mode5' },
      // Mode 3/5 then read their limit through this literal. Repoint it from the region RAM cell to
      // flash 0x4064, the build's own ceiling constant 866 = 39.8 km/h (0x829/0x60 = 21.76 per km/h).
      { off: 0x4160, from: [0x5a, 0x03, 0x00, 0x20], to: [0x64, 0x40, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x8556, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "0020" -> "4424"
    ],
  },

  // NT3 Pro BLDC 0.0.0.7 (12401), 02831 capZ latch.
  bldcNT3Pro: {
    label: 'NT3 Pro BLDC 0.0.0.7 (12401)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x07]) && beRead(u8, 0xb0, 2) === 0xcad0,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000bb18, crcOff: 0xb0, crcStock: 0xcad0 },
    reseal: bldcResealLz,
    patches: [
      // Same shape as the ST3/GT3 family: drive modes 3 and 5 skip the meter speed-limit override
      // (their two branch displacements now point at the join), so the mode limit stands. Their two
      // arms jump to DIFFERENT targets here, hence the different values.
      { off: 0x3944, from: [0x49], to: [0x4a], id: 'speed-mode5' },
      { off: 0x3948, from: [0x1a], to: [0x48], id: 'speed-mode3' },
      // Mode 3/5 limit source -> flash 0x5eb0 = 795 units. This build has no ceiling constant of its
      // own (no mode 4 arm, no unconditional clamp), so 795 is a chosen target: 0x829/0x69 = 19.895
      // units per km/h -> 39.96 km/h. The low-battery floor (397 = 20 km/h below 10 percent) is stock.
      { off: 0x3cd0, from: [0x62, 0x03, 0x00, 0x20], to: [0xb0, 0x5e, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x810c, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "0007" -> "4447"
    ],
  },

  // NT3 Max BLDC 0.0.1.0 (12701), 02831 capZ latch.
  bldcNT3Max: {
    label: 'NT3 Max BLDC 0.0.1.0 (12701)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x00]) && beRead(u8, 0xb0, 2) === 0x9901,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000ba30, crcOff: 0xb0, crcStock: 0x9901 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
      { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
      { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x04, 0x5e, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x6a, 0xb6, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x0c, 0xba, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0xf0, 0xb6, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x40, 0x3f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x74, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x4c, 0x4b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3940, from: [0x49], to: [0x2c], id: 'speed-mode3' },
        { off: 0x3944, from: [0x1a], to: [0x2a], id: 'speed-mode5' },
        { off: 0x3cd8, from: [0x62, 0x03, 0x00, 0x20], to: [0x54, 0x1f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8024, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4414"
      ] },
    },
  },

  // GT3 Pro BLDC 0.0.1.7 (3401/12601), 02831 capZ latch.
  bldcGT3Pro: {
    label: 'GT3 Pro BLDC 0.0.1.7 (3401/12601)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x07]) && beRead(u8, 0xb0, 2) === 0x599b,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000b9a8, crcOff: 0xb0, crcStock: 0x599b },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3a0c, from: [0x07], to: [0x08], id: 'speed-mode3' }, // skip the meter-override block
      { off: 0x3a10, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3c8c, from: [0x56, 0x03, 0x00, 0x20], to: [0x90, 0x0d, 0x00, 0x00], id: 'speed-cap' }, // -> flash 0x0d90 = 668 (32.0 km/h, 0x829/0x64)
      { off: 0x7e4c, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "0017" -> "4417"
    ],
  },

  // GT3 BLDC 0.0.1.1 (3501), 02831 capZ latch.
  bldcGT3_0101: {
    label: 'GT3 BLDC 0.0.1.1 (3501)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0xfdb3,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b304, crcOff: 0xb0, crcStock: 0xfdb3 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3730, from: [0x07], to: [0x08], id: 'speed-mode3' }, // skip the meter-override block
      { off: 0x3734, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3980, from: [0x32, 0x03, 0x00, 0x20], to: [0x00, 0x42, 0x00, 0x00], id: 'speed-cap' }, // -> flash 0x4200 = 668 (32.0 km/h)
      { off: 0x7988, from: [0x30], to: [0x31], id: 'version-marker' }, // fwBldc "0011" -> "1111"
    ],
  },

  // GT3 Max BLDC 0.0.1.1 (3601), 02831 capZ latch.
  bldcGT3Max_0101: {
    label: 'GT3 Max BLDC 0.0.1.1 (3601)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0x5ce3,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b348, crcOff: 0xb0, crcStock: 0x5ce3 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3748, from: [0x07], to: [0x08], id: 'speed-mode3' }, // skip the meter-override block
      { off: 0x374c, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x398c, from: [0x32, 0x03, 0x00, 0x20], to: [0x10, 0x42, 0x00, 0x00], id: 'speed-cap' }, // -> flash 0x4210 = 668 (32.0 km/h)
      { off: 0x79be, from: [0x30], to: [0x32], id: 'version-marker' }, // fwBldc "0011" -> "2211"
    ],
  },

  // ST3 BLDC 0.0.1.1 (3701), 02831 capZ latch.
  bldcST3_0101: {
    label: 'ST3 BLDC 0.0.1.1 (3701)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0x21e9,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b3e4, crcOff: 0xb0, crcStock: 0x21e9 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3724, from: [0x07], to: [0x08], id: 'speed-mode3' }, // skip the meter-override block
      { off: 0x3728, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3974, from: [0x32, 0x03, 0x00, 0x20], to: [0x50, 0x38, 0x00, 0x00], id: 'speed-cap' }, // -> flash 0x3850 = 866 (39.8 km/h)
      { off: 0x7a5a, from: [0x30], to: [0x33], id: 'version-marker' }, // fwBldc "0011" -> "3311"
    ],
  },

  // BLDC 0.0.1.3, GT5 Pro (8401), 02831 capZ latch on the byte3 drive mode.
  bldcGT5Pro: {
    label: 'GT5 Pro BLDC 0.0.1.3 (8401)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xd080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x03]) && beRead(u8, 0xb0, 2) === 0x274a,
    verify: { size: 0xd080, lenOff: 0x84, lenStock: 0x0000c994, crcOff: 0xb0, crcStock: 0x274a },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
      { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x4c, 0x3c, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x08, 0x34, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x74, 0x21, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x84, 0x2e, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x44, 0xb1, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x3c, 0x1d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3a1e, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3a22, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d30, from: [0x52, 0x03, 0x00, 0x20], to: [0x3a, 0xc9, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8018, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4413"
      ] },
    },
  },

  // BLDC 0.0.1.1, GT5 Max (8501), 02831 capZ latch on the byte3 drive mode (same method as GT5 Pro, GT5 Max offsets).
  bldcGT5Max: {
    label: 'GT5 Max BLDC 0.0.1.1 (8501)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xd080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0xffaa,
    verify: { size: 0xd080, lenOff: 0x84, lenStock: 0x0000c8e4, crcOff: 0xb0, crcStock: 0xffaa },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
      { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0xc0, 0x3b, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0x7c, 0x33, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0x6c, 0x21, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0xfc, 0x2d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0x94, 0xb0, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0x3c, 0x1d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3992, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3996, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3ca4, from: [0x52, 0x03, 0x00, 0x20], to: [0x8a, 0xc8, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f60, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4411"
      ] },
    },
  },

  // S40 BLDC 0.0.0.5 (1601). Same design. This build runs on a different scale: its region table
  // DE row is 476 = 22 km/h -> 21.64 units per km/h.
  bldcS40: {
    label: 'S40 BLDC 0.0.0.5 (1601)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xa080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0x58e8,
    verify: { size: 0xa080, lenOff: 0x84, lenStock: 0x00009bb0, crcOff: 0xb0, crcStock: 0x58e8 },
    reseal: bldcResealLz,
patches: [
      { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xac, 0x3f, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
      { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x70, 0x5b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x50, 0x0f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x68, 0x42, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x68, 0x64, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xec, 0x2d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xa0, 0x38, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xb0, 0x99, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x37], id: 'version-marker' },
        { off: 0x6276, from: [0x35], to: [0x38], id: 'version-marker' },   // fwBldc "7778"
      ] },
    },
  },

  // S60 BLDC 0.0.0.6 (2501). Same scale as the S40, own offsets.
  bldcS60: {
    label: 'S60 BLDC 0.0.0.6 (2501)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xa080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x06]) && beRead(u8, 0xb0, 2) === 0x1170,
    verify: { size: 0xa080, lenOff: 0x84, lenStock: 0x00009bcc, crcOff: 0xb0, crcStock: 0x1170 },
    reseal: bldcResealLz,
patches: [
      { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0xb0, 0x36, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0x10, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0x34, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0x38, 0x2c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0x58, 0x64, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0x18, 0x6c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0xda, 0x65, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x37b4, from: [0xd0, 0x02, 0x00, 0x20], to: [0xcc, 0x99, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x626e, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6666"
      ] },
    },
  },

  // V50i Pro BLDC 0.0.0.7 (1201). Same design as the V25, own offsets. Region table DE row 459 =
  // 22 km/h -> 20.86 units per km/h.
  bldcV50iPro: {
    label: 'V50i Pro BLDC 0.0.0.7 (1201)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xa080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x07]) && beRead(u8, 0xb0, 2) === 0xb1df,
    verify: { size: 0xa080, lenOff: 0x84, lenStock: 0x00009c2c, crcOff: 0xb0, crcStock: 0xb1df },
    reseal: bldcResealLz,
patches: [
      { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x0c, 0x15, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x94, 0x96, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x92, 0x96, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x4c, 0x21, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xc8, 0x49, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x90, 0x96, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x40, 0x6c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xb8, 0x2d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6667"
      ] },
    },
  },

  // G5 BLDC 0.0.0.5 (5401). SZMC-ES-ZM-02831 capZ top-gear latch (0x2000033a). Meter drive-mode passthrough. Marker "2225".
  bldcG5: {
    label: 'G5 BLDC 0.0.0.5 (5401)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0xb56a,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b71c, crcOff: 0xb0, crcStock: 0xb56a },
    reseal: bldcResealLz,
    patches: [
      { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
      { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0x9c, 0x46, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0xe4, 0xb6, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0x1c, 0x31, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0x60, 0x3b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0xc0, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0xa8, 0x43, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0x0c, 0x5b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0x7c, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x36ac, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x3904, from: [0x3a, 0x03, 0x00, 0x20], to: [0xc0, 0xb6, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6e70, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4445"
      ] },
    },
  },

  // G5 Pro BLDC 0.0.0.4 (5601). Same design as the G5 Max, own offsets.
  bldcG5Pro: {
    label: 'G5 Pro BLDC 0.0.0.4 (5601)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x04]) && beRead(u8, 0xb0, 2) === 0x58c0,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b5e4, crcOff: 0xb0, crcStock: 0x58c0 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
      { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0xf4, 0x45, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0xae, 0xb5, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0x7c, 0x31, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0xc0, 0x3b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0x58, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0x08, 0x42, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0x58, 0x5a, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3710, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3960, from: [0x3a, 0x03, 0x00, 0x20], to: [0x14, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7c40, from: [0x30], to: [0x35], id: 'version-marker' }, // fwBldc "5554"
      ] },
    },
  },


  // UT3 Max BLDC 0.0.0.5 (10501). SZMC-ES-ZM-02831 capZ top-gear latch (0x20000356). Paired meter UT3 Max needs the trampoline. Marker "3335".
  bldcUT3Max: {
    label: 'UT3 Max BLDC 0.0.0.5 (10501)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0x8fa,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000be38, crcOff: 0xb0, crcStock: 0x8fa },
    reseal: bldcResealLz,
    patches: [
      { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
      { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0x34, 0x3c, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0x00, 0x34, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0x48, 0x1f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0xfc, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0x04, 0x62, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0x08, 0x1b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x39e6, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x39ea, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3d14, from: [0x56, 0x03, 0x00, 0x20], to: [0xde, 0xbd, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x83fa, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "8885"
      ] },
    },
  },

  // G5 Max BLDC 0.0.0.5 (5701). The mode arms branch backwards into one shared setpoint store,
  // so there is no path past the meter override to retarget. Instead the override clamp store
  // (0x3684) becomes a nop and the dispatcher cap pointer (0x38d4) is repointed to a flash
  // halfword. Only the top gear reads that word (0x36a4), the region writer keeps its own copy.
  // Scale 0x829/0x64 = 20.89 units per km/h. No cave, no length change.
  bldcG5Max: {
    label: 'G5 Max BLDC 0.0.0.5 (5701)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0x827e,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b550, crcOff: 0xb0, crcStock: 0x827e },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
      { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x70, 0x45, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
      { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x1a, 0xb5, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x08, 0x31, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x34, 0x3b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x58, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x84, 0x41, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0xd4, 0x59, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3684, from: [0xe0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x38d4, from: [0x3a, 0x03, 0x00, 0x20], to: [0x14, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7b9c, from: [0x30], to: [0x36], id: 'version-marker' },
        { off: 0x7ba4, from: [0x35], to: [0x38], id: 'version-marker' }, // fwBldc "5555"
      ] },
    },
  },

  // V45i BLDC 0.0.0.5 (10201). Same design. The cap pointer is hoisted into r7 (0x39a0) and read
  // three times: the top-gear arm (0x39ea), the threshold compare (0x39cc) and the path taken when
  // the meter reports nothing (0x39fa). Repointing covers all three, which only ever raises.
  bldcV45i: {
    label: 'V45i BLDC 0.0.0.5 (10201)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0x38aa,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000bbec, crcOff: 0xb0, crcStock: 0x38aa },
    reseal: bldcResealLz,
    patches: [
      { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
      { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0x00, 0x67, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0xae, 0xbb, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0xfc, 0x33, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0x44, 0x34, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0x7c, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0xc0, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0x04, 0xa3, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x39ca, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c2c, from: [0x5e, 0x03, 0x00, 0x20], to: [0x8a, 0xbb, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x817c, from: [0x30], to: [0x39], id: 'version-marker' }, // fwBldc "9995"
      ] },
    },
  },

  // S2 BLDC 0.0.0.1 (9901). SZMC-ES-ZM-02831 capZ top-gear latch (0x20000332). Paired meter S2 needs the trampoline. Marker "9991".
  // UT5 Ultra X BLDC 0.0.1.9 (9601). T2443/MM32F5333. Switchable region gate reads control-frame byte 0x0c bit4 (meter sets it on the gear-4 unlock). CRC32 reseal @0x404. Marker "0099".
  bldcUT5UltraX: {
    label: 'UT5 Ultra X BLDC 0.0.1.9 (9601)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xe3e4 && bytesAt(u8, 0, ascii('T2443')) && bytesAt(u8, 0x404, [0xb5, 0x7b, 0xa1, 0xf7]),
    verify: { size: 0xe3e4 },
    reseal: bldcResealCrc32,
    patches: [
      { off: 0x9338, from: [0x40, 0xf6, 0x22, 0x20, 0xc2, 0xf2, 0x00, 0x00, 0x00, 0x78, 0x01, 0x28, 0x04, 0xd1, 0xff, 0xe7, 0xdc, 0x20, 0xad, 0xf8, 0x36, 0x00, 0x11, 0xe0, 0x40, 0xf6, 0x22, 0x20, 0xc2, 0xf2, 0x00, 0x00, 0x00, 0x78, 0x09, 0x28, 0x04, 0xd1, 0xff, 0xe7, 0xfa, 0x20, 0xad, 0xf8, 0x36, 0x00, 0x04, 0xe0, 0x4f, 0xf4, 0x2f, 0x70, 0xad, 0xf8, 0x36, 0x00, 0xff, 0xe7, 0xff, 0xe7], to: [0x40, 0xf6, 0x22, 0x30, 0xc2, 0xf2, 0x00, 0x00, 0x00, 0x7b, 0x00, 0xf0, 0x10, 0x00, 0x00, 0x28, 0x04, 0xd0, 0x40, 0xf2, 0x90, 0x10, 0xad, 0xf8, 0x36, 0x00, 0x0f, 0xe0, 0xdc, 0x20, 0xad, 0xf8, 0x36, 0x00, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf], id: 'switchable-gate' },
      { off: 0xb249, from: [0x31], to: [0x39], id: 'version-marker' },
    ],
  },

  // XT5 Ultra BLDC 0.0.2.7 (T2443/MM32F5333). Top-speed cap in FUN_08003364: the region-locked
  // 250-bucket loads `mov.w r9,#0xff` (25.5 km/h) at 0x37e0; retargeted to `movw r9,#(km/h*10)`.
  // No overspeed governor (byte-verified). Field weakening needs cap >= 501 (`cmp.w r0,#0x1f4` at
  // 0x49ba) and the firmware winds it back above 516 measured (51.6 km/h), so the useful window is
  // 501..515: 50 uses 508, 51 uses 510. Above that the cap only raises the target, not the current.
  bldcXT5Ultra: {
    label: 'XT5 Ultra BLDC 0.0.2.7',
    kind: 'bldc',
    match: (u8) => u8.length === 0xcb68 && bytesAt(u8, 0, ascii('T2443')) && bytesAt(u8, 0x404, [0xb3, 0xc0, 0xe9, 0xd3]),
    verify: { size: 0xcb68 },
    reseal: bldcResealCrc32,
    stdSpeedKmh: 40,
    patches: [  // std: clamp every over-40 bucket to 40 (movw r9,#400); speed variants below cover 22-50
      { off: 0x37ae, from: [0x4f, 0xf4, 0xfe, 0x79], to: [0x40, 0xf2, 0x90, 0x19], id: 'speed' },
      { off: 0x37cc, from: [0x40, 0xf2, 0x95, 0x19], to: [0x40, 0xf2, 0x90, 0x19], id: 'speed' },
      { off: 0x37d6, from: [0x40, 0xf2, 0xc7, 0x19], to: [0x40, 0xf2, 0x90, 0x19], id: 'speed' },
    ],
  },

  // XT5 Pro/Max BLDC 0.0.1.0 (5301/5901, byte-identical). T2416/SZMC-ES-ZM-3553G. Top-speed cap is a
  // region bucket in the meter-frame parser: the region-locked bucket at 0x43cc loads `mov.w r1,#454`
  // (25 km/h) on the scale km/h*2089/115 (~*18.165). Retargeted in-place to `movw r1,#round(km/h*2089/115)`.
  // Stock top is 40 (gear-4 bucket 726). A d-axis current gate sits at 816 counts = 45.0 km/h
  // (`mov.w r3,#0x330` at 0x1298, compared against the measured speed at 0x132a and 0x1542), so 45 and
  // 50 open extra field-weakening current. No clamp writes the cap back down - the only speed-triggered
  // sites found are counters at 1000 counts (55.1 km/h). Reseal = ERPM CRC-16 @0xb0 like UT5 Max.
  bldcXT5ProMax: {
    label: 'XT5 Pro/Max BLDC 0.0.1.0 (5301/5901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xe100 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x00]) && beRead(u8, 0xb0, 2) === 0x1611,
    verify: { size: 0xe100, lenOff: 0x84, lenStock: 0x0000e000, crcOff: 0xb0, crcStock: 0x1611 },
    reseal: bldcResealErpm,
    stdSpeedKmh: 40,
    patches: [  // std: top gear-4 bucket at 40 (movw r1,#726); speed variants below cover 22-35
      { off: 0x43e0, from: [0x40, 0xf2, 0xd6, 0x21], to: [0x40, 0xf2, 0xd6, 0x21], id: 'speed' },
    ],
  },

  // S2 BLDC 0.0.0.1 (9901). Same design. The pointer is reloaded with a different struct right after
  // the clamp, so the stores further down belong to that second pointer, not to the limit cell.
  bldcS2: {
    label: 'S2 BLDC 0.0.0.1 (9901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x01]) && beRead(u8, 0xb0, 2) === 0x7b6c,
    verify: { size: 0xb080, lenOff: 0x84, lenStock: 0x0000ae10, crcOff: 0xb0, crcStock: 0x7b6c },
    reseal: bldcResealLz,
patches: [
      { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x54, 0x78, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x60, 0xa8, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0xa8, 0x30, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x68, 0x6f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x68, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x1c, 0x40, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x28, 0x57, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0x40, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3810, from: [0x32, 0x03, 0x00, 0x20], to: [0xdc, 0x2b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7488, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4441"
      ] },
    },
  },

  // V25 / V25i BLDC 0.0.0.9 (701). This family has no meter speed converter: the top gear reads
  // its limit through one hoisted pointer (0x37fe) and the only clamp (0x3820) compares against
  // that very pointer, so repointing the single literal word (0x3954) raises both together. No
  // nop, no cave, no length change. The scale comes from the build's own region table at file
  // 0x9688: its DE row is 459 = 22 km/h, so 459/22 = 20.86 units per km/h.
  bldcV25: {
    label: 'V25 / V25i BLDC 0.0.0.9 (701)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xa080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x09]) && beRead(u8, 0xb0, 2) === 0xef0f,
    verify: { size: 0xa080, lenOff: 0x84, lenStock: 0x00009b54, crcOff: 0xb0, crcStock: 0xef0f },
    reseal: bldcResealLz,
patches: [
      { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0x0c, 0x15, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0xbc, 0x95, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0x68, 0x38, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0x4c, 0x21, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0x78, 0x49, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0x18, 0x75, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0x68, 0x6b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3954, from: [0xcc, 0x02, 0x00, 0x20], to: [0xb8, 0x2d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x61fc, from: [0x30], to: [0x35], id: 'version-marker' },   // fwBldc "5559"
      ] },
    },
  },

  // N65i BLDC 0.0.1.1 (1101). Same design, own offsets. Drive mode 4 writes the limit through the
  // same pointer (0x3612), so it follows the repoint as well. Region table DE row 437 = 22 km/h
  // -> 19.86 units per km/h.
  bldcN65i: {
    label: 'N65i BLDC 0.0.1.1 (1101)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xa880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0x87df,
    verify: { size: 0xa880, lenOff: 0x84, lenStock: 0x0000a6b0, crcOff: 0xb0, crcStock: 0x87df },
    reseal: bldcResealLz,
patches: [
      { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0x32, 0x8d, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
      { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0x3c, 0xa1, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0x3a, 0xa1, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0xf4, 0x14, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0xf0, 0x0c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0x04, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0x86, 0x38, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x374c, from: [0xe0, 0x02, 0x00, 0x20], to: [0x92, 0x83, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x6d74, from: [0x30], to: [0x34], id: 'version-marker' },
        { off: 0x6d7a, from: [0x31], to: [0x37], id: 'version-marker' },   // fwBldc "4477"
      ] },
    },
  },

  // E20 Lite BLDC 0.0.0.4 (10101), byte-identical to the E25 Go image (9101). Two clamps run in
  // series here: the gated meter clamp (0x391a) becomes a nop, the second one is an unconditional
  // ceiling fed from the very cell the top gear reads (0x20000342), so repointing that one literal
  // word (0x3b34) raises the top gear and the ceiling together and clamp two becomes a no-op.
  // Scale 0x829/0x57 = 24.01 units per km/h, setpoint field 0x14. No cave, no length change.
  bldcE20LiteE25Go: {
    label: 'E20 Lite / E25 Go BLDC 0.0.0.4 (10101/9101)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x04]) && beRead(u8, 0xb0, 2) === 0x2aa6,
    verify: { size: 0xb080, lenOff: 0x84, lenStock: 0x0000aeb8, crcOff: 0xb0, crcStock: 0x2aa6 },
    reseal: bldcResealLz,
patches: [
      { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
      { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x30, 0x15, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x08, 0xa9, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x90, 0x19, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x94, 0x33, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x74, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x6c, 0x58, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x82, 0x05, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0x40, 0x44, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x391a, from: [0xa0, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3b34, from: [0x42, 0x03, 0x00, 0x20], to: [0xdc, 0xac, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x752a, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6664"
      ] },
    },
  },

  // E45 Pro / E60 Pro BLDC 0.0.0.7 (10001/10301/10601/12801/12901, one image for all five). Three
  // ceilings sit in series here. Drive mode 3 branches straight into the meter clamp, so that one
  // branch (0x3940) is retargeted past it while the clamp keeps working for every other mode; the
  // two flag gated ceilings (522 and 459 units) become nops. The limit pointer (0x3c04) is then
  // repointed. Scale 0x829/0x64 = 20.89 units per km/h, read from the build's own converter.
  bldcE45E60: {
    label: 'E45 Pro / E60 Pro BLDC 0.0.0.7 (10001/10301/10601/12801/12901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x07]) && beRead(u8, 0xb0, 2) === 0xd18b,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000b994, crcOff: 0xb0, crcStock: 0xd18b },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
      { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
      { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
      { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0x68, 0x49, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0x5e, 0xb9, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0xc8, 0x33, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0x3c, 0x3e, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0x58, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0xa8, 0x46, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0xc4, 0x5d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0x90, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3940, from: [0x03], to: [0x04], id: 'speed-mode3' },
        { off: 0x398c, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-a' },
        { off: 0x39a2, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-ceiling-b' },
        { off: 0x3c04, from: [0x3a, 0x03, 0x00, 0x20], to: [0x3a, 0xb9, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7f5e, from: [0x30], to: [0x38], id: 'version-marker' },   // fwBldc "8887"
      ] },
    },
  },

  // E20 / E25 BLDC 0.0.0.7 (4001/4101, byte-identical). Older shape with no meter converter: the
  // top gear reads its limit through one hoisted pointer (0x386a) and the only clamp (0x388a)
  // compares against that same pointer, so repointing the single literal word (0x3a84) raises both.
  // Scale 0x829/0x57 = 24.01 units per km/h, from the sibling E20 Lite build that carries the
  // converter, confirmed against this image's region table (360/480/600 = 15/20/25 km/h).
  bldcE20E25: {
    label: 'E20 / E25 BLDC 0.0.0.7 (4001/4101)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x07]) && beRead(u8, 0xb0, 2) === 0xd6c8,
    verify: { size: 0xb080, lenOff: 0x84, lenStock: 0x0000ae34, crcOff: 0xb0, crcStock: 0xd6c8 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x2c, 0x15, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x90, 0xa8, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0xa4, 0x19, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x6c, 0x2e, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x88, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0xa0, 0x57, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x82, 0x05, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x34, 0x2e, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x3a84, from: [0x46, 0x03, 0x00, 0x20], to: [0x56, 0xac, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x74b2, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7777"
      ] },
    },
  },

  // UT5 Max BLDC 0.0.1.0 (8901). SZMC-ES-ZM-3553G. verword 0100 + tag T2416 collide with 9701 -> CRC pin
  // 0xb58f mandatory. Permanent top-gear cap, controller only - the meter is never flashed (its own
  // bootloader is not in any dump and rejects a patched image; that is what bricked a device).
  // Mechanics: the drive-mode limit selector (0x49a8..0x49e0) reads the ceiling for gear 3/4 from
  // 0x20000376, a cell with no writer anywhere in the app. The ldrh is replaced by an immediate, so the
  // stock top gear carries the target itself (km/h*20, 800 = 40) and no meter-side nibble is needed.
  // Left stock on purpose: the fault derate at 0x4a40 (clamps to [0x20000378] while error flag
  // 0x2000037a or 0x20000387 is set), gear 2, the walk mode and the whole boot path. The over-rev
  // governor (cmp #0x186 = 39.0 at km/h*10, 0x384e/0x3ade/0x517c/0x5198) shaves the top to ~39.
  // Marker "0090".
  bldcUT5Max: {
    label: 'UT5 Max BLDC 0.0.1.0 (8901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xf900 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x00]) && beRead(u8, 0xb0, 2) === 0xb58f,
    verify: { size: 0xf900, lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0xb58f },
    reseal: bldcResealErpm,
    patches: [
      { off: 0x49cc, from: [0xb9, 0xf8, 0x00, 0xc0], to: [0x40, 0xf2, 0x20, 0x3c], id: 'speed' }, // gear 3/4 ceiling: ldrh.w r12,[r9] -> movw r12,#800 (40 km/h)
      { off: 0xaf2c, from: [0x31, 0x22], to: [0x39, 0x22], id: 'version-marker' },
    ],
  },
  // S2 meter 2.0.0.1 (9901). Drive-mode clamped -> one-shot trampoline routes app nibble 5/6 into the control frame for bldcS2. Kickstart gate flip.
  meterS2: {
    label: 'S2 meter 2.0.0.1 (9901)',
    kind: 'meter',
    match: (u8) => u8.length === 0x21c00 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x3a9a,
    verify: { size: 0x21c00, crcOff: 0x13, crcStock: 0x3a9a, lenOff: 0x10, lenStock: 0x021800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },


  // UT3 Max meter 0.0.0.4 (10501). Drive-mode clamped -> one-shot trampoline routes app nibble 5/6 into the control frame for bldcUT3Max.
  meterUT3Max: {
    label: 'UT3 Max meter 0.0.0.4 (10501)',
    kind: 'meter',
    match: (u8) => u8.length === 0x24000 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x0b10,
    verify: { size: 0x24000, crcOff: 0x13, crcStock: 0x0b10, lenOff: 0x10, lenStock: 0x023c00 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'The UT3 Max meter is never patched: it hosts BLE and is the only route back from a failed controller update. The controller carries the raised top gear on its own.',
    patches: [],
  },

  // ST5 Pro/Max meter 0.0.2.4 (4901/7801). Meter feature patches (no speed latch on this family). 
  st5_meter: {
    label: 'ST5 Pro/Max meter 0.0.2.4 (4901/7801)',
    kind: 'meter',
    match: (u8) => u8.length === 0x24800 && bytesAt(u8, 0, ascii('T2314')) && beRead(u8, 0x13, 2) === 0x9e11,
    verify: { size: 0x24800, crcOff: 0x13, crcStock: 0x9e11, lenOff: 0x10, lenStock: 0x024400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // K100 Max meter 0.0.1.4 (5001). Meter feature patches (no speed latch on this family). 
  k100max_meter: {
    label: 'K100 Max meter 0.0.1.4 (5001)',
    kind: 'meter',
    match: (u8) => u8.length === 0x22c00 && bytesAt(u8, 0, ascii('T2314')) && beRead(u8, 0x13, 2) === 0x48d8,
    verify: { size: 0x22c00, crcOff: 0x13, crcStock: 0x48d8, lenOff: 0x10, lenStock: 0x022800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
    // cruise (cmd 0x52 -> handler @0x1373a) stores the flag and forwards it unconditionally via the 0xa08 control frame - already works stock, no patch.
  },

  // UT5 Ultra X meter 0.0.3.0 (9601). Meter feature patches (no speed latch on this family).
  ut5ultrax_meter: {
    label: 'UT5 Ultra X meter 0.0.3.0 (9601)',
    kind: 'meter',
    match: (u8) => u8.length === 0x25c00 && bytesAt(u8, 0, ascii('T2314')) && beRead(u8, 0x13, 2) === 0x31f1,
    verify: { size: 0x25c00, crcOff: 0x13, crcStock: 0x31f1, lenOff: 0x10, lenStock: 0x025800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // UT5 Max meter 0.0.3.0 (8901). T2314. NOT flashable and deliberately kept out of FLASH_ENABLED: the
  // meter bootloader is in no dump, rejects a patched image and killed a device (it also hosts BLE, so a
  // failed commit takes the DFU gateway with it). Kept only so the CRC pin 0x010a documents the split
  // from UT5 Ultra X (0x31f1). The speed lever lives in bldcUT5Max alone.
  meterUT5Max: {
    label: 'UT5 Max meter 0.0.3.0 (8901)',
    kind: 'meter',
    match: (u8) => u8.length === 0x25c00 && bytesAt(u8, 0, ascii('T2314')) && beRead(u8, 0x13, 2) === 0x010a,
    verify: { size: 0x25c00, crcOff: 0x13, crcStock: 0x010a, lenOff: 0x10, lenStock: 0x025800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'The UT5 Max meter is never patched: its bootloader rejects a patched image and it hosts BLE, so a failed update cannot be undone. Patch the controller instead - it carries the 40 km/h top gear on its own.',
    patches: [],
  },

  // E20 / E25 meter 2.0.0.7 (4001/4101). Meter feature patches (region-gated kickstart/cruise flipped to work in every region, plus per-tone beep silences).
  e20_meter: {
    label: 'E20 / E25 meter 2.0.0.7 (4001/4101)',
    kind: 'meter',
    match: (u8) => u8.length === 0xa800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xc4f5,
    verify: { size: 0xa800, crcOff: 0x13, crcStock: 0xc4f5, lenOff: 0x10, lenStock: 0x00a400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // E20 Lite / E25 Go meter 0.0.0.6 (10101/9101). Meter feature patches (region-gated kickstart/cruise flipped to work in every region, plus per-tone beep silences).
  e20lite_meter: {
    label: 'E20 Lite / E25 Go meter 0.0.0.6 (10101/9101)',
    kind: 'meter',
    match: (u8) => u8.length === 0xb000 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x1ab0,
    verify: { size: 0xb000, crcOff: 0x13, crcStock: 0x1ab0, lenOff: 0x10, lenStock: 0x00ac00 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // E45 / E60 Pro meter 2.0.2.5 (10001/10301/10601/12801/12901). Meter feature patches (region-gated kickstart/cruise flipped to work in every region, plus per-tone beep silences).
  e45_meter: {
    label: 'E45 / E60 Pro meter 2.0.2.5 (10001/10301/10601/12801/12901)',
    kind: 'meter',
    match: (u8) => u8.length === 0x22800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x1717,
    verify: { size: 0x22800, crcOff: 0x13, crcStock: 0x1717, lenOff: 0x10, lenStock: 0x022400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // V40i Pro II meter 2.0.0.8 (4401). Meter feature patches (region-gated flips + per-tone beep silences).
  v40iproii_meter: {
    label: 'V40i Pro II meter 2.0.0.8 (4401)',
    kind: 'meter',
    match: (u8) => u8.length === 0x21400 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x5f01,
    verify: { size: 0x21400, crcOff: 0x13, crcStock: 0x5f01, lenOff: 0x10, lenStock: 0x021000 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // N65i II meter 2.0.5.8 (6001). Meter feature patches (region-gated flips + per-tone beep silences).
  n65ii6001_meter: {
    label: 'N65i II meter 2.0.5.8 (6001)',
    kind: 'meter',
    match: (u8) => u8.length === 0x23000 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xfaf,
    verify: { size: 0x23000, crcOff: 0x13, crcStock: 0xfaf, lenOff: 0x10, lenStock: 0x022c00 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // N65i II meter 2.0.5.9 (10701). Meter feature patches (region-gated flips + per-tone beep silences).
  n65ii10701_meter: {
    label: 'N65i II meter 2.0.5.9 (10701)',
    kind: 'meter',
    match: (u8) => u8.length === 0x23800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xa321,
    verify: { size: 0x23800, crcOff: 0x13, crcStock: 0xa321, lenOff: 0x10, lenStock: 0x023400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // V40i / V40i Pro BLDC 0.0.0.8 (1301). Same build shape as the V50i Pro, own marker.
  bldcV40i: {
    label: 'V40i / V40i Pro BLDC 0.0.0.8 (1301)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xa080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x08]) && beRead(u8, 0xb0, 2) === 0xf0cd,
    verify: { size: 0xa080, lenOff: 0x84, lenStock: 0x00009c2c, crcOff: 0xb0, crcStock: 0xf0cd },
    reseal: bldcResealLz,
patches: [
      { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x0c, 0x15, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x94, 0x96, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x92, 0x96, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x4c, 0x21, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xc8, 0x49, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x90, 0x96, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0x40, 0x6c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x39a4, from: [0xcc, 0x02, 0x00, 0x20], to: [0xb8, 0x2d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x62b8, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4448"
      ] },
    },
  },

  // V40i Pro II BLDC 0.0.0.2 (4401). Same design as the V50i Pro, own offsets and marker.
  bldcV40iProII: {
    label: 'V40i Pro II BLDC 0.0.0.2 (4401)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x02]) && beRead(u8, 0xb0, 2) === 0x4a9e,
    verify: { size: 0xb080, lenOff: 0x84, lenStock: 0x0000adbc, crcOff: 0xb0, crcStock: 0x4a9e },
    reseal: bldcResealLz,
patches: [
      { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x64, 0x78, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x0c, 0xa8, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x9c, 0x30, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x18, 0x6f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x68, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0xf4, 0x3f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x00, 0x57, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0x40, 0x15, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x37e4, from: [0x32, 0x03, 0x00, 0x20], to: [0xd0, 0x2b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7422, from: [0x30], to: [0x34], id: 'version-marker' },   // fwBldc "4442"
      ] },
    },
  },

  // V3 Pro BLDC 0.0.2.0 (4201). Same design, own offsets. Region table DE row 459 = 22 km/h ->
  // 20.86 units per km/h.
  bldcV3Pro: {
    label: 'V3 Pro BLDC 0.0.2.0 (4201)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x02, 0x00]) && beRead(u8, 0xb0, 2) === 0x13b8,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b4e8, crcOff: 0xb0, crcStock: 0x13b8 },
    reseal: bldcResealLz,
patches: [
      { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0xc4, 0x39, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0x4c, 0xaf, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0xec, 0x33, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0xb8, 0x0c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0x20, 0x45, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0x7c, 0x5c, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0x18, 0x4b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3ac8, from: [0xf0, 0x02, 0x00, 0x20], to: [0x60, 0x2f, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7914, from: [0x30], to: [0x36], id: 'version-marker' },   // fwBldc "6626"
      ] },
    },
  },

  meterG5: {
    label: 'G5 / G5 Pro / G5 Max meter 2.0.5.7',
    kind: 'meter',
    match: (u8) => u8.length === 0x23000 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x9e34,
    verify: { size: 0x23000, crcOff: 0x13, crcStock: 0x9e34, lenOff: 0x10, lenStock: 0x022c00 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  meterS40: {
    label: 'S40 / S60 meter 1.0.1.0',
    kind: 'meter',
    match: (u8) => u8.length === 0x23c00 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x75e7,
    verify: { size: 0x23c00, crcOff: 0x13, crcStock: 0x75e7, lenOff: 0x10, lenStock: 0x023800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    blocked: 'This meter is not patched: it hosts BLE and is the only route back from a failed controller update, so a bad meter commit cannot be undone. Its patches were never confirmed on hardware.',
    patches: [],
  },

  // N65i II BLDC 0.0.0.6 (10701). Same design, setpoint field 0x18, scale 0x829/0x69 = 19.90 units
  // per km/h. Drive modes 3 and 5 share one arm (0x39d2). Replaces the old cave latch, whose cave
  // sat past the declared length.
  bldcN65iII10701: {
    label: 'N65i II BLDC 0.0.0.6 (10701)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x06]) && beRead(u8, 0xb0, 2) === 0x8bd1,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000bae8, crcOff: 0xb0, crcStock: 0x8bd1 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
      { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0x8a, 0xa1, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0x22, 0xb7, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0xc4, 0xba, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0xa8, 0xb7, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0x10, 0x2a, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0x84, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x399a, from: [0x21, 0x83], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3c60, from: [0x5a, 0x03, 0x00, 0x20], to: [0xc0, 0x2e, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x8100, from: [0x30], to: [0x34], id: 'version-marker' }, // fwBldc "4446"
      ] },
    },
  },

  // N65i II BLDC 0.0.0.5 (6001). Second controller build of the same scooter: same shared-store
  // design as the 0.0.0.6 build, own offsets. Every single-byte marker of this family is taken, so
  // both immediates of the version frame are patched instead. Scale 0x829/0x69 = 19.90 per km/h.
  bldcN65iII6001: {
    label: 'N65i II BLDC 0.0.0.5 (6001)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x00, 0x05]) && beRead(u8, 0xb0, 2) === 0x4e08,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b768, crcOff: 0xb0, crcStock: 0x4e08 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x36fe, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
      { off: 0x3964, from: [0x3a, 0x03, 0x00, 0x20], to: [0x78, 0x38, 0x00, 0x00], id: 'speed-cap' },
      { off: 0x7dca, from: [0x30], to: [0x38], id: 'version-marker' },
      { off: 0x7dd2, from: [0x35], to: [0x39], id: 'version-marker' },   // fwBldc "4447"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed20: { experimental: true, speedKmh: 20, patches: [
        { off: 0x36fe, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3964, from: [0x3a, 0x03, 0x00, 0x20], to: [0xa2, 0xb3, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7dca, from: [0x30], to: [0x38], id: 'version-marker' },
        { off: 0x7dd2, from: [0x35], to: [0x39], id: 'version-marker' },   // fwBldc "4447"
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x36fe, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3964, from: [0x3a, 0x03, 0x00, 0x20], to: [0x4e, 0xb4, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7dca, from: [0x30], to: [0x38], id: 'version-marker' },
        { off: 0x7dd2, from: [0x35], to: [0x39], id: 'version-marker' },   // fwBldc "4447"
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x36fe, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3964, from: [0x3a, 0x03, 0x00, 0x20], to: [0x58, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7dca, from: [0x30], to: [0x38], id: 'version-marker' },
        { off: 0x7dd2, from: [0x35], to: [0x39], id: 'version-marker' },   // fwBldc "4447"
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x36fe, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3964, from: [0x3a, 0x03, 0x00, 0x20], to: [0x78, 0x0d, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7dca, from: [0x30], to: [0x38], id: 'version-marker' },
        { off: 0x7dd2, from: [0x35], to: [0x39], id: 'version-marker' },   // fwBldc "4447"
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x36fe, from: [0xe2, 0x82], to: [0x00, 0xbf], id: 'speed-clamp' },
        { off: 0x3964, from: [0x3a, 0x03, 0x00, 0x20], to: [0x78, 0x5b, 0x00, 0x00], id: 'speed-cap' },
        { off: 0x7dca, from: [0x30], to: [0x38], id: 'version-marker' },
        { off: 0x7dd2, from: [0x35], to: [0x39], id: 'version-marker' },   // fwBldc "4447"
      ] },
    },
  },

  // K100 family (MM32SPIN0280D6FF). Own container: length at 0x00, CRC32 over the body at 0x04,
  // chip name at 0x08, body from 0x18 linked at 0x08000000. The top gear reads its limit from byte
  // +5 of a region selected config struct, so that one load becomes an immediate. 203 is the
  // manufacturer value for US and CN on the K100 Max (EU/AU/UK/RU get 158 there). On the K100 Pro
  // and the K100 every region branch falls through to one value (160), so those two take the same
  // 203 from the same silicon. The km/h per unit of this platform is not established, so there is
  // no target-speed selector here.
  bldcK100Max: {
    label: 'K100 Max BLDC 0.0.3.4 (5001)',
    kind: 'bldc',
    match: (u8) => u8.length === 0x8aa0 && beRead(u8, 0x04, 4) === 0x4e65ec21 && u8[0x38ee] === 0x40 && u8[0x38ef] === 0x79,
    verify: { size: 0x8aa0 },
    reseal: bldcResealCrc32K100,
patches: [
      { off: 0x38ee, from: [0x40, 0x79], to: [0xcb, 0x20], id: 'speed' },
      { off: 0x86e9, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7034"
    ],
  },

  bldcK100: {
    label: 'K100 BLDC 0.0.3.3 (5201)',
    kind: 'bldc',
    match: (u8) => u8.length === 0x8594 && beRead(u8, 0x04, 4) === 0xad38aa6e && u8[0x3964] === 0x40 && u8[0x3965] === 0x79,
    verify: { size: 0x8594 },
    reseal: bldcResealCrc32K100,
    patches: [
      { off: 0x3964, from: [0x40, 0x79], to: [0xcb, 0x20], id: 'speed' },
      { off: 0x81dd, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7033"
    ],
  },

  bldcK100Pro: {
    label: 'K100 Pro BLDC 0.0.3.2 (5101)',
    kind: 'bldc',
    match: (u8) => u8.length === 0x85b4 && beRead(u8, 0x04, 4) === 0xd000ab23 && u8[0x396c] === 0x40 && u8[0x396d] === 0x79,
    verify: { size: 0x85b4 },
    reseal: bldcResealCrc32K100,
    patches: [
      { off: 0x396c, from: [0x40, 0x79], to: [0xcb, 0x20], id: 'speed' },
      { off: 0x81f9, from: [0x30], to: [0x37], id: 'version-marker' },   // fwBldc "7032"
    ],
  },
};

// ── NT5 top-gear speed variants (22-40 km/h) ──────────────────────────────
// Same capZ top-gear latch as the std build; only the UNLOCK cap value changes. The lock/boot value
// stays 22 km/h, so the scooter still re-locks on restart; std already delivers the tested 40.
// capZ = km/h * 20. 02831 (9301/9207): latch stores capZ via `movs r,#imm8; lsls #2`, so imm8 = km/h*5
// (one byte). 3553G (9701/9401): latch-cave stores capZ via `movw r0,#imm16`, so imm16 = km/h*20.
// All of 22-40 verified reachable on NT5 (no measured-speed governor cuts in below 40).
const NT5_SPEED_KMH = [22, 25, 27, 30, 35];

function movwLE(rd, imm) {  // Thumb-2 MOVW rd,#imm16 -> 4 little-endian bytes
  const i = (imm >> 11) & 1, imm4 = (imm >> 12) & 0xf, imm3 = (imm >> 8) & 7, imm8 = imm & 0xff;
  const hw1 = 0xf240 | (i << 10) | imm4, hw2 = (imm3 << 12) | ((rd & 0xf) << 8) | imm8;
  return [hw1 & 0xff, (hw1 >> 8) & 0xff, hw2 & 0xff, (hw2 >> 8) & 0xff];
}
function findSub(arr, sub) {
  for (let i = 0; i + sub.length <= arr.length; i++) {
    let ok = true;
    for (let j = 0; j < sub.length; j++) if (arr[i + j] !== sub[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
// sel: { latchId, enc: 'movs8'|'movw', find: <current UNLOCK bytes to locate>, rd }
function ntSpeedVariants(spec, sel) {
  const out = {};
  for (const kmh of NT5_SPEED_KMH) {
    const patches = spec.patches.map((p) => ({ off: p.off, from: p.from, to: p.to.slice(), id: p.id }));
    const lp = patches.find((p) => p.id === sel.latchId);
    if (!lp) throw new Error('ntSpeedVariants: latch patch ' + sel.latchId + ' missing');
    const at = findSub(lp.to, sel.find);
    if (at < 0) throw new Error('ntSpeedVariants: unlock immediate not found in ' + sel.latchId);
    if (sel.enc === 'movs8') {
      lp.to[at] = (kmh * 5) & 0xff;                 // capZ = (km/h * 5) << 2 = km/h * 20
    } else {
      const b = movwLE(sel.rd, kmh * 20);           // capZ = km/h * 20
      for (let k = 0; k < 4; k++) lp.to[at + k] = b[k];
    }
    out['speed' + kmh] = { mark: spec.mark, experimental: true, speedKmh: kmh, patches: patches };
  }
  return out;
}

IMAGES.bldc9301.stdSpeedKmh = 40; IMAGES.bldc9301.variants = ntSpeedVariants(IMAGES.bldc9301, { latchId: 'capz-latch', enc: 'movs8', find: [0xc8, 0x26] });
IMAGES.bldc9207.stdSpeedKmh = 40; IMAGES.bldc9207.variants = ntSpeedVariants(IMAGES.bldc9207, { latchId: 'capz-latch', enc: 'movs8', find: [0xc8, 0x21] });
IMAGES.bldc9701.stdSpeedKmh = 40; IMAGES.bldc9701.variants = ntSpeedVariants(IMAGES.bldc9701, { latchId: 'latch-cave', enc: 'movw', find: [0x40, 0xf2, 0x20, 0x30], rd: 0 });
IMAGES.bldc9401.stdSpeedKmh = 40; IMAGES.bldc9401.variants = ntSpeedVariants(IMAGES.bldc9401, { latchId: 'latch-cave', enc: 'movw', find: [0x40, 0xf2, 0x20, 0x30], rd: 0 });
IMAGES.bldcUT5Max.stdSpeedKmh = 40;  // single permanent cap, no selector (governor shaves it to ~39)

// UT5 Ultra X (T2443): the switchable-gate block sets the unlocked region ceiling (km/h*10) via the
// unlock `movw r0,#imm` in its `to` (std = 400 = 40). The firmware clamps the cap back to 600 unless
// [0x200000e9] == 3 (`cmp.w r0,#0x258` at 0x44fa), and 600 itself passes the compare, so 22-60 are
// all reachable. Only the unlock immediate changes; the lock value (220 = 22) and the gate branch
// logic are untouched. The effective top speed is min(meter request, this cap, 600).
IMAGES.bldcUT5UltraX.stdSpeedKmh = 40;
IMAGES.bldcUT5UltraX.variants = (function () {
  const out = {};
  for (const kmh of [22, 25, 27, 30, 35, 45, 50, 55, 60]) {
    const patches = IMAGES.bldcUT5UltraX.patches.map((p) => ({ off: p.off, from: p.from, to: p.to.slice(), id: p.id }));
    const g = patches.find((p) => p.id === 'switchable-gate');
    const at = findSub(g.to, [0x40, 0xf2, 0x90, 0x10]);   // std unlock movw r0,#400
    if (at < 0) throw new Error('UT5UltraX: unlock immediate not found');
    const b = movwLE(0, kmh * 10);
    for (let k = 0; k < 4; k++) g.to[at + k] = b[k];
    out['speed' + kmh] = { experimental: true, speedKmh: kmh, patches: patches };
  }
  return out;
})();

// XT5 top speed is a switch of per-command buckets; the cap must bind after unlock, so clamp every
// bucket above the target down to it (Ultra r9=km/h*10, 50 keeps 508 for the FW gate; Pro/Max r1=km/h*2089/115).
// std is inline in each block so the payload-bounds guard reads the offsets; only variants generated here.
function xtBucketVariants(buckets, rd, scaleFn, topOff, speeds) {
  const build = (kmh) => {
    const t = scaleFn(kmh), ps = [];
    for (const b of buckets) if (b.cap > t) ps.push({ off: b.off, from: b.from, to: movwLE(rd, t), id: 'speed' });
    if (!ps.length) { const tb = buckets.find((b) => b.off === topOff); ps.push({ off: tb.off, from: tb.from, to: movwLE(rd, t), id: 'speed' }); }
    return ps;
  };
  const v = {};
  for (const kmh of speeds) v['speed' + kmh] = { experimental: true, speedKmh: kmh, patches: build(kmh) };
  return v;
}
IMAGES.bldcXT5Ultra.variants = xtBucketVariants(
  [{ off: 0x37ae, from: [0x4f, 0xf4, 0xfe, 0x79], cap: 508 }, { off: 0x37c2, from: [0x40, 0xf2, 0x45, 0x19], cap: 325 },
   { off: 0x37cc, from: [0x40, 0xf2, 0x95, 0x19], cap: 405 }, { off: 0x37d6, from: [0x40, 0xf2, 0xc7, 0x19], cap: 455 },
   { off: 0x37e0, from: [0x4f, 0xf0, 0xff, 0x09], cap: 255 }],
  9, (k) => (k === 50 ? 508 : k * 10), 0x37ae, [22, 25, 27, 30, 35, 45, 50, 51]);
IMAGES.bldcXT5ProMax.variants = xtBucketVariants(
  [{ off: 0x43e0, from: [0x40, 0xf2, 0xd6, 0x21], cap: 726 }, { off: 0x43cc, from: [0x4f, 0xf4, 0xe3, 0x71], cap: 454 }],
  1, (k) => Math.floor(k * 2089 / 115), 0x43e0, [22, 25, 27, 30, 35, 45, 50]);

// Identify which image this is, or null.
// Only hardware-confirmed families are flashable: the NT5 family and the XT5. Everything else is
// blocked while the patches are re-checked, after device-damaging reports on unconfirmed models.
const FLASH_ENABLED = new Set([
  'meterMax', 'meterTurboUltra', 'meterMaxPlus', 'meterUltraX',   // NT5 family meters
  'meterXT5',                                                     // XT5 meter
  'bldc9701', 'bldc9401', 'bldc9301', 'bldc9207',                 // NT5 family controllers
  'bldcXT5Ultra',                                                 // XT5 Ultra controller (target-speed selector, experimental)
  'bldcUT5Max',                                                   // UT5 Max controller (permanent 40 km/h top gear, meter never flashed, experimental)
  'bldcUT5UltraX',                                                // UT5 Ultra X controller (target-speed selector 22-50, experimental)
  'bldcXT5ProMax',                                                // XT5 Pro/Max controller (target-speed selector 22-40, experimental)
  'bldcST3Pro', 'bldcGT3Pro', 'bldcST3_0101', 'bldcGT3_0101', 'bldcGT3Max_0101', // ST3/GT3 controllers
  'bldcG5', 'bldcGT5Max', 'bldcGT5Pro', 'bldcUT3Max', 'bldcNT3Max', // 02831 in-place target-speed selector (experimental) (raised top gear, meter never flashed, experimental)
  'bldcNT3Pro',                                                  // NT3 Pro controller (experimental; meter not yet enabled)
  'bldcG5Max', 'bldcG5Pro', 'bldcV45i', 'bldcN65iII10701', 'bldcN65iII6001', 'bldcS2', 'bldcV40iProII', 'bldcV3Pro', 'bldcS60', 'bldcS40', 'bldcV40i', 'bldcV50iPro', 'bldcN65i', 'bldcV25', 'bldcE20LiteE25Go', 'bldcE45E60', 'bldcE20E25', 'bldcK100', 'bldcK100Pro', 'bldcK100Max', // 02831 shared-store builds: clamp nop plus cap repoint (experimental)
]);

// Flashable but not yet confirmed on recoverable hardware. The UI must show a red untested warning
// plus an extra confirmation before creating or flashing these images.
const EXPERIMENTAL = new Set(['bldcXT5Ultra', 'bldcUT5Max', 'bldcUT5UltraX', 'bldcXT5ProMax', 'bldcST3Pro', 'bldcGT3Pro', 'bldcST3_0101', 'bldcGT3_0101', 'bldcGT3Max_0101', 'bldcNT3Pro', 'bldcG5', 'bldcGT5Max', 'bldcGT5Pro', 'bldcUT3Max', 'bldcNT3Max', 'bldcG5Max', 'bldcG5Pro', 'bldcV45i', 'bldcN65iII10701', 'bldcN65iII6001', 'bldcS2', 'bldcV40iProII', 'bldcN65i', 'bldcV3Pro', 'bldcS60', 'bldcS40', 'bldcV40i', 'bldcV50iPro', 'bldcV25', 'bldcE20LiteE25Go', 'bldcE45E60', 'bldcE20E25', 'bldcK100', 'bldcK100Pro', 'bldcK100Max']);
function isExperimental(key) { return EXPERIMENTAL.has(key); }

function identify(u8) {
  for (const key of Object.keys(IMAGES)) if (FLASH_ENABLED.has(key) && IMAGES[key].match(u8)) return key;
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

// Map a patch id to the user-facing feature it belongs to.
function featureOf(id) {
  if (id.indexOf('cruise') === 0) return 'cruise'; // cruise + cruise-region3 fold to one feature
  if (id.indexOf('kickstart') === 0) return 'kickstart';
  if (id.indexOf('beep-overspeed') === 0) return 'beep-overspeed'; // multi-site tones fold to one feature
  if (id.indexOf('beep-alarm') === 0) return 'beep-alarm';
  if (id.indexOf('beep-melody') === 0) return 'beep-melody';
  if (id.indexOf('beep-') === 0) return id; // beep-silence legacy or any other single beep patch
  if (id.indexOf('version-marker') === 0) return 'marker';
  return 'speed';
}

// Apply a patch set with per-row expected-byte verification.
function applyPatches(u8, patches, selected) {
  const want = selected ? new Set(selected) : null;
  const anyNonMarker = patches.some(p => featureOf(p.id) !== 'marker' && (!want || want.has(featureOf(p.id))));
  const applied = [];
  for (const p of patches) {
    const feat = featureOf(p.id);
    const apply = feat === 'marker' ? (!want || anyNonMarker) : (!want || want.has(feat));
    if (!apply) continue;
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

// Distinct user-selectable features an identified stock image supports (markers excluded), for the UI to
// build its checkboxes. Returns null for an unrecognised image.
function imageFeatures(u8) {
  const key = identify(u8);
  if (!key) return null;
  const feats = [];
  for (const p of IMAGES[key].patches) {
    const f = featureOf(p.id);
    if (f !== 'marker' && feats.indexOf(f) < 0) feats.push(f);
  }
  return { image: key, kind: IMAGES[key].kind, features: feats };
}

// Selectable build variants of an identified image (e.g. std vs full-torque), for the UI to offer a
// picker. Returns null when the image has only the default build.
function imageVariants(u8) {
  const key = identify(u8);
  const spec = key && IMAGES[key];
  if (!spec || !spec.variants) return null;
  const vs = spec.variants;
  const keys = ['std'].concat(Object.keys(vs));
  const speedKmh = {};
  keys.forEach(v => { speedKmh[v] = v === 'std' ? (spec.stdSpeedKmh || null) : (vs[v].speedKmh || null); });
  return {
    image: key,
    variants: keys,
    experimental: Object.fromEntries(keys.map(v => [v, v !== 'std' && !!vs[v].experimental])),
    speedKmh: speedKmh,
  };
}

// Take the stock .bin (ArrayBuffer), return the patched+resealed image. Throws on an unrecognised,
// wrong or already-patched image (never returns a damaged file). variantKey picks a build variant
// (default/'std' = spec.patches); a named variant supplies its own patch list, mark and experimental flag.
function patchFirmware(arrayBuffer, selected, variantKey) {
  const u8 = new Uint8Array(arrayBuffer.slice(0)); // copy: never mutate the caller's buffer
  const key = identify(u8);
  if (!key) {
    // A blocked model still matches its signature; give a clear message instead of "unrecognised".
    for (const k of Object.keys(IMAGES)) if (!FLASH_ENABLED.has(k) && IMAGES[k].match(u8)) throw new Error(IMAGES[k].blocked || 'Flashing this model is disabled in this version.');
    throw new Error('Unrecognised firmware - not a known NAVEE NT5 meter or BLDC image.');
  }
  const spec = IMAGES[key];
  const variant = (variantKey && variantKey !== 'std' && spec.variants) ? spec.variants[variantKey] : null;

  const bad = verifyStock(u8, spec);
  if (bad) throw new Error(bad);

  const patchList = (variant && variant.patches) || spec.patches;
  // SAFETY: a firmware length-extension (any patch to len@0x84) bricks these controllers - confirmed
  // on hardware (NT5 Max, and earlier). Never build such an image; recovery from it needs SWD.
  if (patchList.some(p => p.off === 0x84)) {
    throw new Error('This build type (firmware length-extension) is disabled: it bricks the controller. Recovery needs SWD.');
  }
  const applied = applyPatches(u8, patchList, selected);
  spec.reseal(u8);

  return {
    image: key,
    label: spec.label,
    kind: spec.kind,
    variant: variant ? variantKey : 'std',
    mark: (variant && variant.mark) || spec.mark || null,
    experimental: variant ? !!variant.experimental : isExperimental(key),
    applied: applied,
    nothingToPatch: applied.length === 0,
    bytes: u8,
  };
}

if (typeof window !== 'undefined') {
  window.NVFW = { patchFirmware, identify, imageFeatures, imageVariants, isExperimental, crc16Xmodem, IMAGES };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { patchFirmware, identify, imageFeatures, imageVariants, isExperimental, featureOf, crc16Xmodem, beRead, beWrite, IMAGES };
}
