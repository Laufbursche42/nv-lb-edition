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
      { off: 0x15d44, from: [0x1e, 0x28], to: [0xff, 0x28], id: 'beep-overspeed-nag' }, // continuous over-speed nag: 30 km/h trigger (cmp #0x1e) -> #0xff so the steady tone never fires; 0x15de4 is the separate one-shot chirp
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
      { off: 0x15cf0, from: [0x1e, 0x28], to: [0xff, 0x28], id: 'beep-overspeed-nag' }, // continuous over-speed nag: 30 km/h trigger (cmp #0x1e) -> #0xff so the steady tone never fires; 0x15da2 is the separate one-shot chirp
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
      { off: 0x15cf4, from: [0x1e, 0x28], to: [0xff, 0x28], id: 'beep-overspeed-nag' }, // continuous over-speed nag: 30 km/h trigger (cmp #0x1e) -> #0xff so the steady tone never fires; 0x15da6 is the separate one-shot chirp
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
      { off: 0x14b88, from: [0x33], to: [0x35], id: 'version-marker' }, // meter version builder leading '3' -> '5' (movs r0,#0x33 @raw 0x14b88), fwMeter '3016' -> '5016' so the app/tool detect the patched meter (was missing -> patch was invisible)
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
      { off: 0x13164, from: [0x00, 0x21], to: [0x00, 0xbf], id: 'speedsel' }, // region gate NOP (movs r1,#0 -> nop): frame byte10 then follows the BLE speed cell in every region, so live 0x6E sub1 selects 22/32/45 (controller governor; byte10==0 keeps the stock default cap, never a stop). Experimental, offline top = persisted cell, HW-unconfirmed
      { off: 0x15b3e, from: [0xff, 0xf7, 0x4f, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' }, // over-speed warning bl -> nop
      { off: 0x15b5e, from: [0xff, 0xf7, 0x3f, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed2' }, // over-speed 2nd bl -> nop
      { off: 0x15b8c, from: [0xcb, 0xf7, 0x8c, 0xd9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/alarm bl -> nop
      { off: 0x15be4, from: [0xff, 0xf7, 0xfd, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm2' }, // find-me/alarm 2nd bl -> nop
      { off: 0x15c50, from: [0xff, 0xf7, 0xea, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' }, // startup/error melody bl -> nop
    ],
  },

  // Meter 3.0.2.3 - newer NAVEE build, shared across XT5 Pro (5301) / Max (5901) / Ultra (5801), byte-identical.
  // Same patch set as meterXT5 but the meter firmware was restructured, so all offsets were re-located and
  // byte-verified against the stock 3.0.2.3 image; reseal CRC16-XMODEM over [0x400:eof] reproduces 0x6a2f.
  // The marker base is '3023' here (not '3020'), so the version-marker flip yields fwMeter '5023'.
  meterXT5_3023: {
    label: 'XT5 meter 3.0.2.3 (5301/5801/5901)',
    kind: 'meter',
    match: (u8) => u8.length === 0x24c00 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x6a2f,
    verify: { size: 0x24c00, crcOff: 0x13, crcStock: 0x6a2f, lenOff: 0x10, lenStock: 0x024800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    patches: [
      { off: 0x14c13, from: [0xd2], to: [0xe0], id: 'kickstart' },                                      // zero-start region floor (bhs) -> unconditional, launch levels 0-2 in every region
      { off: 0x14d8e, from: [0x33], to: [0x35], id: 'version-marker' },                                  // marker byte0 '3' -> '5', fwMeter '3023' -> '5023'
      { off: 0x131ce, from: [0x00, 0x21], to: [0x00, 0xbf], id: 'speedsel' },                            // region gate NOP (movs r1,#0 -> nop): frame byte10 follows the BLE speed cell, live 0x6E sub1 selects 22/32/45
      { off: 0x15d92, from: [0xff, 0xf7, 0x4b, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' },  // over-speed warning bl -> nop
      { off: 0x15db2, from: [0xff, 0xf7, 0x3b, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed2' }, // over-speed 2nd bl -> nop
      { off: 0x15e24, from: [0xcb, 0xf7, 0x40, 0xd8], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' },      // find-me/alarm bl -> nop
      { off: 0x15e7c, from: [0xff, 0xf7, 0xb3, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm2' },     // find-me/alarm 2nd bl -> nop
      { off: 0x15ee8, from: [0xff, 0xf7, 0xa0, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' },     // startup/error melody bl -> nop
    ],
  },

  // Meter 2.0.4.6, byte-identical across ST3 Pro (12501/3801), ST3 (3701) and GT3 / GT3 Pro / GT3 Max (3601/3401/3501/12601).
  meterST3GT3: {
    label: 'ST3/GT3 meter 2.0.4.6',
    mark: '5.0.4.6',
    kind: 'meter',
    match: (u8) => u8.length === 0x22800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0x9bce,
    verify: { size: 0x22800, crcOff: 0x13, crcStock: 0x9bce, lenOff: 0x10, lenStock: 0x022400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    // Zero-start (launch level): the periodic drive-state builder re-clamps any level below 3 back to 3
    // (meter-side, FUN_0800f1e0, store @ VA 0x0800f37e, gated on the reported BLDC version flag). NOP the
    // sub-3 branch so levels 0-2 persist; the >5 high clamp is left intact. The version marker flips the
    // reported meter version '2'->'5' (fwMeter "2046"->"5046") so the app offers levels 0-2 only on a
    // patched meter. Experimental: this meter hosts BLE and has no confirmed SWD recovery, so a failed
    // flash can be unrecoverable - it carries the red untested warning plus an extra confirmation.
    patches: [
      { off: 0xf374, from: [0x03, 0xd3], to: [0x00, 0xbf], id: 'kickstart' },   // sub-3 launch-level force-to-3 bcc -> nop
      // Switchable BT drossel (feature 'speed'): DE region gate on the outbound 0x51 frame speed byte (cell
      // 0x20c663). (1) retarget the DE force-22 beq to the follow-cell path, (2) lower the follow-cell floor
      // 32 -> 22. After this, frame byte10 follows the live BLE cell over [22..40] (<25 -> 22, >40 pre-clamped),
      // set live by class 0x6E sub1 (22 = locked, 40 = open); boot/unset 0 floors to 22 = safe locked default.
      { off: 0xf306, from: [0x26, 0xd0], to: [0x12, 0xd0], id: 'speedsel' },         // DE beq force-22 -> follow-cell
      { off: 0xf336, from: [0x20, 0x20], to: [0x16, 0x20], id: 'speedsel-floor' },   // follow-cell floor 32 -> 22
      { off: 0x10770, from: [0x32], to: [0x35], id: 'version-marker' },         // reported meter version 2.0.4.6 -> 5.0.4.6 ("5046")
      // Per-tone beep silences. Each site is a movs r0,#<on-duration>; FUN_0800d6a2 early-returns for
      // dur < 2 (cmp r0,#2; bcc) without driving the buzzer or changing state, so #<dur> -> #1 mutes just
      // that tone with control flow intact. The confirm/button beep (0xdab0/0xdab6/0xdadc/0xd9a2) is left on.
      { off: 0xd92a,  from: [0x23, 0x20], to: [0x01, 0x20], id: 'beep-overspeed-nag' },  // continuous >~30 km/h over-speed nag
      { off: 0x11b3e, from: [0x32, 0x20], to: [0x01, 0x20], id: 'beep-overspeed-m67a' }, // modes 6/7 over-speed onset
      { off: 0x11bb4, from: [0x05, 0x20], to: [0x01, 0x20], id: 'beep-overspeed-m67b' }, // modes 6/7 over-speed cadence
      { off: 0xd9d6,  from: [0x64, 0x20], to: [0x01, 0x20], id: 'beep-connect' },        // BLE connect beep
      { off: 0xd75a,  from: [0x28, 0x20], to: [0x01, 0x20], id: 'beep-melody-a' },       // startup / not-ready chime
      { off: 0xd778,  from: [0x05, 0x20], to: [0x01, 0x20], id: 'beep-melody-b' },       // startup / not-ready chime
      { off: 0xd7a8,  from: [0x05, 0x20], to: [0x01, 0x20], id: 'beep-melody-c' },       // startup / not-ready chime
      { off: 0xd990,  from: [0x0a, 0x20], to: [0x01, 0x20], id: 'beep-alarm-findmy' },   // find-my active alarm
      { off: 0xd986,  from: [0x23, 0x20], to: [0x01, 0x20], id: 'beep-alarm-lock' },     // lock / find-my repeating alarm
      { off: 0xd9ae,  from: [0x08, 0x20], to: [0x01, 0x20], id: 'beep-fault' },          // fault / warning tone
    ],
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
    mark: '5.0.0.4',
    kind: 'meter',
    match: (u8) => u8.length === 0x23400 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xc780,
    verify: { size: 0x23400, crcOff: 0x13, crcStock: 0xc780, lenOff: 0x10, lenStock: 0x023000 },
    bodyBase: 0x400,
    reseal: meterReseal,
    // Switchable BT drossel (feature 'speed'): NOP the DE zero-store of the forwarded speed cell config+0x1b
    // (strb r7,[r4,#0x1b], r7=0) inside the 0x51 frame builder; frame byte10 then follows the live BLE cell
    // in every region, set by class 0x6E sub1 (22 = locked, 40 = open). In-place, no len-extend, no cave.
    // Experimental: BLE-host meter, no confirmed SWD recovery -> red untested warning plus extra confirmation.
    patches: [
      { off: 0x12c22, from: [0xe7, 0x76], to: [0x00, 0xbf], id: 'speedsel' },        // NOP DE zero-store of config+0x1b
      { off: 0x14126, from: [0x31], to: [0x35], id: 'version-marker' },              // fwMeter "1004" -> "5004"
      // Per-tone beep silences (bl -> nop; this meter's buzzer is a GPIO with no dur<2 guard, so the
      // ST3/GT3 duration trick does not apply - NOP the call). Control flow + state stores stay intact.
      // The BLE-ACK and physical-button confirm beeps are left on.
      { off: 0x14d32, from: [0xff, 0xf7, 0x5c, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed-nag' }, // continuous >~30 km/h nag (sport-exempt)
      { off: 0x14f14, from: [0xff, 0xf7, 0x5a, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-connect-a' },     // BLE connect/disconnect edge
      { off: 0x150ec, from: [0xff, 0xf7, 0x6e, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-connect-b' },
      { off: 0x14fba, from: [0xff, 0xf7, 0x07, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-a' },      // status / fault-code announce melody
      { off: 0x15032, from: [0xff, 0xf7, 0xcb, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-b' },
      { off: 0x15074, from: [0xff, 0xf7, 0xaa, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-c' },
      { off: 0x15762, from: [0xff, 0xf7, 0x42, 0xfa], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-a' },       // low-speed periodic warning + status long-beep
      { off: 0x157e2, from: [0xff, 0xf7, 0x02, 0xfa], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-b' },
      { off: 0x158a0, from: [0xff, 0xf7, 0xa3, 0xf9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-c' },
      { off: 0x150ce, from: [0xff, 0xf7, 0x7d, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-d' },
    ],
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
    mark: '8.8.2.8',
    kind: 'bldc',
    match: (u8) => u8.length === 0xd080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x02, 0x00]),
    verify: { size: 0xd080, lenOff: 0x84, lenStock: 0x0000cd34, crcOff: 0xb0, crcStock: 0x4805 },
    reseal: bldcResealLz,
    // Same family as GT3 Pro but divisor 0x60 (scale 0x829/0x60 = 21.76 counts/km/h) and the ceiling is a
    // flash constant, not an immediate. Governor FUN_00003d2c: meter byte 10 -> cap cell 0x20000260 (single
    // writer at 0x7e5a) -> sVar10 = 2089*[cell]/96 -> ride modes 3/5 cap = sVar10, clamped by the flash
    // ceiling at 0x4164 (stock 866 = 39.8 km/h) which also feeds the mode-4 fixed cap. Working lever forces
    // byte 10 to the target (sVar10 = T km/h) and sets the flash ceiling to the same, so mode 3/4/5 all land
    // on T. The old mode3/5/cap patches were overwritten by the meter every cycle (no road effect). Selectable.
    patches: [
      { off: 0x7e5a, from: [0x81, 0x7a], to: [0x28, 0x21], id: 'speed-source' }, // ldrb r1,[r0,#0xa] -> movs r1,#40
      { off: 0x4164, from: [0x62, 0x03], to: [0x66, 0x03], id: 'speed-cap-ceiling' }, // flash ceiling 866 -> 870 (40.0 km/h)
      { off: 0x8556, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "0020" -> "8828"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x7e5a, from: [0x81, 0x7a], to: [0x16, 0x21], id: 'speed-source' },
        { off: 0x4164, from: [0x62, 0x03], to: [0xde, 0x01], id: 'speed-cap-ceiling' }, // 478 (22.0 km/h)
        { off: 0x8556, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x7e5a, from: [0x81, 0x7a], to: [0x19, 0x21], id: 'speed-source' },
        { off: 0x4164, from: [0x62, 0x03], to: [0x20, 0x02], id: 'speed-cap-ceiling' }, // 544 (25.0 km/h)
        { off: 0x8556, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x7e5a, from: [0x81, 0x7a], to: [0x1e, 0x21], id: 'speed-source' },
        { off: 0x4164, from: [0x62, 0x03], to: [0x8c, 0x02], id: 'speed-cap-ceiling' }, // 652 (30.0 km/h)
        { off: 0x8556, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x7e5a, from: [0x81, 0x7a], to: [0x23, 0x21], id: 'speed-source' },
        { off: 0x4164, from: [0x62, 0x03], to: [0xf9, 0x02], id: 'speed-cap-ceiling' }, // 761 (35.0 km/h)
        { off: 0x8556, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x7e5a, from: [0x81, 0x7a], to: [0x2d, 0x21], id: 'speed-source' },
        { off: 0x4164, from: [0x62, 0x03], to: [0xd3, 0x03], id: 'speed-cap-ceiling' }, // 979 (45.0 km/h)
        { off: 0x8556, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
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

  // GT3 Pro / GT3 Max BLDC 0.0.1.7 (3401/3601/12601), 02831 capZ latch.
  bldcGT3Pro: {
    label: 'GT3 Pro / GT3 Max BLDC 0.0.1.7 (3401/3601/12601)',
    mark: '8.8.1.7',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x07]) && beRead(u8, 0xb0, 2) === 0x599b,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000b9a8, crcOff: 0xb0, crcStock: 0x599b },
    reseal: bldcResealLz,
    // Real top-speed path (FUN_0000387c): the meter commands the limit via frame byte 10, stored at
    // cap cell 0x2000025c (single writer at 0x764a/0x764c). The governor scales it sVar10 = 2089*[cell]/100
    // and in ride modes 3/5 sets the active cap to sVar10, clamped by the hard ceiling (0xa7<<2 = 668 = 32 km/h).
    // Mode 4 uses a fixed cap (same 668). The old mode3/5/cap patches touched a non-governing cell and did
    // nothing on the road. The working lever forces byte 10 to the target (movs r1,#T, sVar10 = 2089*T/100 = T km/h),
    // raises both caps so the forced value is not clipped, and keeps the marker. Target speed is selectable.
    patches: [
      { off: 0x774a, from: [0x81, 0x7a], to: [0x28, 0x21], id: 'speed-source' }, // ldrb r1,[r0,#0xa] -> movs r1,#40
      { off: 0x3a50, from: [0xa7], to: [0xd1], id: 'speed-cap-mode4' }, // mode 4 fixed cap 0xd1<<2 = 836 (40.0 km/h)
      { off: 0x3a78, from: [0xa7], to: [0xd1], id: 'speed-cap-ceiling' }, // governor hard ceiling 836 (40.0 km/h)
      { off: 0x7e4c, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "0017" -> "8817"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x774a, from: [0x81, 0x7a], to: [0x16, 0x21], id: 'speed-source' }, // movs r1,#22
        { off: 0x3a50, from: [0xa7], to: [0x73], id: 'speed-cap-mode4' }, // 0x73<<2 = 460 (22.0 km/h)
        { off: 0x3a78, from: [0xa7], to: [0x73], id: 'speed-cap-ceiling' },
        { off: 0x7e4c, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x774a, from: [0x81, 0x7a], to: [0x19, 0x21], id: 'speed-source' }, // movs r1,#25
        { off: 0x3a50, from: [0xa7], to: [0x83], id: 'speed-cap-mode4' }, // 0x83<<2 = 524 (25.1 km/h)
        { off: 0x3a78, from: [0xa7], to: [0x83], id: 'speed-cap-ceiling' },
        { off: 0x7e4c, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x774a, from: [0x81, 0x7a], to: [0x1e, 0x21], id: 'speed-source' }, // movs r1,#30
        { off: 0x3a50, from: [0xa7], to: [0x9d], id: 'speed-cap-mode4' }, // 0x9d<<2 = 628 (30.1 km/h)
        { off: 0x3a78, from: [0xa7], to: [0x9d], id: 'speed-cap-ceiling' },
        { off: 0x7e4c, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x774a, from: [0x81, 0x7a], to: [0x23, 0x21], id: 'speed-source' }, // movs r1,#35
        { off: 0x3a50, from: [0xa7], to: [0xb7], id: 'speed-cap-mode4' }, // 0xb7<<2 = 732 (35.0 km/h)
        { off: 0x3a78, from: [0xa7], to: [0xb7], id: 'speed-cap-ceiling' },
        { off: 0x7e4c, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x774a, from: [0x81, 0x7a], to: [0x2d, 0x21], id: 'speed-source' }, // movs r1,#45
        { off: 0x3a50, from: [0xa7], to: [0xeb], id: 'speed-cap-mode4' }, // 0xeb<<2 = 940 (45.0 km/h)
        { off: 0x3a78, from: [0xa7], to: [0xeb], id: 'speed-cap-ceiling' },
        { off: 0x7e4c, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
  },

  // GT3 BLDC 0.0.1.1 (3501), 02831 capZ latch.
  bldcGT3_0101: {
    label: 'GT3 BLDC 0.0.1.1 (3501)',
    mark: '8.8.1.1',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0xfdb3,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b304, crcOff: 0xb0, crcStock: 0xfdb3 },
    reseal: bldcResealLz,
    // Same governor as GT3 Pro (FUN_000035a0): meter byte 10 -> cap cell 0x20000242 (single writer at
    // 0x727a) -> sVar9 = 2089*[cell]/100 -> ride modes 3/5 cap = sVar9, clamped by the hard ceiling
    // (movs r0,#0xa7; lsls#2 = 668 = 32 km/h at 0x3748) and the mode-4 fixed cap (same 668 at 0x37a4). The
    // working lever forces byte 10 to the target (movs r1,#T, sVar9 = T km/h) and raises both caps. Selectable.
    patches: [
      { off: 0x727a, from: [0x81, 0x7a], to: [0x28, 0x21], id: 'speed-source' }, // ldrb r1,[r0,#0xa] -> movs r1,#40
      { off: 0x3748, from: [0xa7], to: [0xd1], id: 'speed-cap-ceiling' }, // ceiling 0xd1<<2 = 836 (40.0 km/h)
      { off: 0x37a4, from: [0xa7], to: [0xd1], id: 'speed-cap-mode4' }, // mode 4 fixed cap 836 (40.0 km/h)
      { off: 0x7988, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "0011" -> "8811"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x727a, from: [0x81, 0x7a], to: [0x16, 0x21], id: 'speed-source' },
        { off: 0x3748, from: [0xa7], to: [0x73], id: 'speed-cap-ceiling' },
        { off: 0x37a4, from: [0xa7], to: [0x73], id: 'speed-cap-mode4' },
        { off: 0x7988, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x727a, from: [0x81, 0x7a], to: [0x19, 0x21], id: 'speed-source' },
        { off: 0x3748, from: [0xa7], to: [0x83], id: 'speed-cap-ceiling' },
        { off: 0x37a4, from: [0xa7], to: [0x83], id: 'speed-cap-mode4' },
        { off: 0x7988, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x727a, from: [0x81, 0x7a], to: [0x1e, 0x21], id: 'speed-source' },
        { off: 0x3748, from: [0xa7], to: [0x9d], id: 'speed-cap-ceiling' },
        { off: 0x37a4, from: [0xa7], to: [0x9d], id: 'speed-cap-mode4' },
        { off: 0x7988, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x727a, from: [0x81, 0x7a], to: [0x23, 0x21], id: 'speed-source' },
        { off: 0x3748, from: [0xa7], to: [0xb7], id: 'speed-cap-ceiling' },
        { off: 0x37a4, from: [0xa7], to: [0xb7], id: 'speed-cap-mode4' },
        { off: 0x7988, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x727a, from: [0x81, 0x7a], to: [0x2d, 0x21], id: 'speed-source' },
        { off: 0x3748, from: [0xa7], to: [0xeb], id: 'speed-cap-ceiling' },
        { off: 0x37a4, from: [0xa7], to: [0xeb], id: 'speed-cap-mode4' },
        { off: 0x7988, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
  },

  // GT3 Max BLDC 0.0.1.1 (3601), 02831 capZ latch.
  bldcGT3Max_0101: {
    label: 'GT3 Max BLDC 0.0.1.1 (3601)',
    mark: '8.8.1.1',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0x5ce3,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b348, crcOff: 0xb0, crcStock: 0x5ce3 },
    reseal: bldcResealLz,
    // Same governor as GT3 3501 (byte 10 -> cap cell 0x20000242, writer at 0x729e; sVar9 = 2089*[cell]/100;
    // ceiling movs r0,#0xa7;lsls#2 = 668 at 0x3760; mode-4 fixed cap same at 0x37bc). Force byte 10 to the
    // target and raise both caps. Selectable.
    patches: [
      { off: 0x729e, from: [0x81, 0x7a], to: [0x28, 0x21], id: 'speed-source' }, // ldrb r1,[r0,#0xa] -> movs r1,#40
      { off: 0x3760, from: [0xa7, 0x20], to: [0xd1, 0x20], id: 'speed-cap-ceiling' }, // 836 (40.0 km/h)
      { off: 0x37bc, from: [0xa7, 0x22], to: [0xd1, 0x22], id: 'speed-cap-mode4' }, // 836 (40.0 km/h)
      { off: 0x79be, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "0011" -> "8811"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x729e, from: [0x81, 0x7a], to: [0x16, 0x21], id: 'speed-source' },
        { off: 0x3760, from: [0xa7, 0x20], to: [0x73, 0x20], id: 'speed-cap-ceiling' },
        { off: 0x37bc, from: [0xa7, 0x22], to: [0x73, 0x22], id: 'speed-cap-mode4' },
        { off: 0x79be, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x729e, from: [0x81, 0x7a], to: [0x19, 0x21], id: 'speed-source' },
        { off: 0x3760, from: [0xa7, 0x20], to: [0x83, 0x20], id: 'speed-cap-ceiling' },
        { off: 0x37bc, from: [0xa7, 0x22], to: [0x83, 0x22], id: 'speed-cap-mode4' },
        { off: 0x79be, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x729e, from: [0x81, 0x7a], to: [0x1e, 0x21], id: 'speed-source' },
        { off: 0x3760, from: [0xa7, 0x20], to: [0x9d, 0x20], id: 'speed-cap-ceiling' },
        { off: 0x37bc, from: [0xa7, 0x22], to: [0x9d, 0x22], id: 'speed-cap-mode4' },
        { off: 0x79be, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x729e, from: [0x81, 0x7a], to: [0x23, 0x21], id: 'speed-source' },
        { off: 0x3760, from: [0xa7, 0x20], to: [0xb7, 0x20], id: 'speed-cap-ceiling' },
        { off: 0x37bc, from: [0xa7, 0x22], to: [0xb7, 0x22], id: 'speed-cap-mode4' },
        { off: 0x79be, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x729e, from: [0x81, 0x7a], to: [0x2d, 0x21], id: 'speed-source' },
        { off: 0x3760, from: [0xa7, 0x20], to: [0xeb, 0x20], id: 'speed-cap-ceiling' },
        { off: 0x37bc, from: [0xa7, 0x22], to: [0xeb, 0x22], id: 'speed-cap-mode4' },
        { off: 0x79be, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
  },

  // ST3 BLDC 0.0.1.1 (3701), 02831 capZ latch.
  bldcST3_0101: {
    label: 'ST3 BLDC 0.0.1.1 (3701)',
    mark: '8.8.1.1',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x01]) && beRead(u8, 0xb0, 2) === 0x21e9,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b3e4, crcOff: 0xb0, crcStock: 0x21e9 },
    reseal: bldcResealLz,
    // ST3-family governor (like ST3 Pro): divisor 0x60 (scale 0x829/0x60 = 21.76 counts/km/h), and the
    // ceiling + mode-4 cap are one pool constant at 0x3950 (stock 866 = 39.8 km/h). Meter byte 10 -> cap cell
    // 0x20000242 (single writer at 0x733a) -> sVar10 = 2089*[cell]/96. Force byte 10 to the target and set the
    // ceiling constant to the same, so mode 3/4/5 all land on T. Old mode3/5/cap patches had no road effect. Selectable.
    patches: [
      { off: 0x733a, from: [0x81, 0x7a], to: [0x28, 0x21], id: 'speed-source' }, // ldrb r1,[r0,#0xa] -> movs r1,#40
      { off: 0x3950, from: [0x62, 0x03], to: [0x66, 0x03], id: 'speed-cap-ceiling' }, // ceiling+mode4 866 -> 870 (40.0 km/h)
      { off: 0x7a5a, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "0011" -> "8811"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x733a, from: [0x81, 0x7a], to: [0x16, 0x21], id: 'speed-source' },
        { off: 0x3950, from: [0x62, 0x03], to: [0xde, 0x01], id: 'speed-cap-ceiling' }, // 478 (22.0 km/h)
        { off: 0x7a5a, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x733a, from: [0x81, 0x7a], to: [0x19, 0x21], id: 'speed-source' },
        { off: 0x3950, from: [0x62, 0x03], to: [0x20, 0x02], id: 'speed-cap-ceiling' }, // 544 (25.0 km/h)
        { off: 0x7a5a, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x733a, from: [0x81, 0x7a], to: [0x1e, 0x21], id: 'speed-source' },
        { off: 0x3950, from: [0x62, 0x03], to: [0x8c, 0x02], id: 'speed-cap-ceiling' }, // 652 (30.0 km/h)
        { off: 0x7a5a, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x733a, from: [0x81, 0x7a], to: [0x23, 0x21], id: 'speed-source' },
        { off: 0x3950, from: [0x62, 0x03], to: [0xf9, 0x02], id: 'speed-cap-ceiling' }, // 761 (35.0 km/h)
        { off: 0x7a5a, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x733a, from: [0x81, 0x7a], to: [0x2d, 0x21], id: 'speed-source' },
        { off: 0x3950, from: [0x62, 0x03], to: [0xd3, 0x03], id: 'speed-cap-ceiling' }, // 979 (45.0 km/h)
        { off: 0x7a5a, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
  },

  // Newer ST3 controller 0.0.1.2 (3701). Same in-place ST3-family speed lever as 0.0.1.1 (force meter byte10
  // via speed-source + set the ceiling/mode-4 cap constant), offsets re-located and byte-verified; the 02831
  // dual-CRC reseal (crc@0xb0 over [0x100,0x100+len] + crc@0x13 over [0x80,eof]) reproduces 0x0482 and 0xf57e.
  // Stock version string is '0012', so the marker flip yields fwBldc '3312'. Scale unchanged (stock ceiling 866).
  bldcST3_0102: {
    label: 'ST3 BLDC 0.0.1.2 (3701)',
    mark: '8.8.1.2',
    kind: 'bldc',
    match: (u8) => u8.length === 0xb880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x02]) && beRead(u8, 0xb0, 2) === 0x0482,
    verify: { size: 0xb880, lenOff: 0x84, lenStock: 0x0000b65c, crcOff: 0xb0, crcStock: 0x0482 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x75ec, from: [0x81, 0x7a], to: [0x28, 0x21], id: 'speed-source' }, // ldrb r1,[r0,#0xa] -> movs r1,#40
      { off: 0x3bec, from: [0x62, 0x03], to: [0x66, 0x03], id: 'speed-cap-ceiling' }, // ceiling+mode4 866 -> 870 (40.0 km/h)
      { off: 0x7cca, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc '0012' -> '8812'
    ],
    stdSpeedKmh: 40,
    variants: {
      speed22: { experimental: true, speedKmh: 22, patches: [
        { off: 0x75ec, from: [0x81, 0x7a], to: [0x16, 0x21], id: 'speed-source' },
        { off: 0x3bec, from: [0x62, 0x03], to: [0xde, 0x01], id: 'speed-cap-ceiling' }, // 478 (22.0 km/h)
        { off: 0x7cca, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x75ec, from: [0x81, 0x7a], to: [0x19, 0x21], id: 'speed-source' },
        { off: 0x3bec, from: [0x62, 0x03], to: [0x20, 0x02], id: 'speed-cap-ceiling' }, // 544 (25.0 km/h)
        { off: 0x7cca, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x75ec, from: [0x81, 0x7a], to: [0x1e, 0x21], id: 'speed-source' },
        { off: 0x3bec, from: [0x62, 0x03], to: [0x8c, 0x02], id: 'speed-cap-ceiling' }, // 652 (30.0 km/h)
        { off: 0x7cca, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x75ec, from: [0x81, 0x7a], to: [0x23, 0x21], id: 'speed-source' },
        { off: 0x3bec, from: [0x62, 0x03], to: [0xf9, 0x02], id: 'speed-cap-ceiling' }, // 761 (35.0 km/h)
        { off: 0x7cca, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed45: { experimental: true, speedKmh: 45, patches: [
        { off: 0x75ec, from: [0x81, 0x7a], to: [0x2d, 0x21], id: 'speed-source' },
        { off: 0x3bec, from: [0x62, 0x03], to: [0xd3, 0x03], id: 'speed-cap-ceiling' }, // 979 (45.0 km/h)
        { off: 0x7cca, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
  },

  // GT5 Pro/Max BLDC 0.0.1.6 (shared 8401/8501, byte-identical). Ported from 0.0.1.3. 02831 speed-cap
  // pointer-retarget: the speed-cap literal @0x40c8 (= RAM pointer 0x20000362) is retargeted to a FLASH
  // address X whose LE16 halfword at file (X+0x100) holds floor(2089*km/h/100). Mapping file=X+0x100 proven
  // on all 7 old entries; every chosen address was re-read to hold the exact count, even-aligned, in bounds.
  // Dual-CRC reseal (crc@0xb0 over [0x100,0x100+len] + crc@0x13 over [0x80,eof]) reproduces 0x0b1d/0x47ac.
  // 22 and 45 km/h have no even-aligned constant in this build -> intentionally not offered.
  bldcGT5_0016: {
    label: 'GT5 Pro/Max BLDC 0.0.1.6 (8401/8501)',
    mark: '8.8.1.6',
    kind: 'bldc',
    match: (u8) => u8.length === 0xd880 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x06]) && beRead(u8, 0xb0, 2) === 0x0b1d,
    verify: { size: 0xd880, lenOff: 0x84, lenStock: 0x0000d160, crcOff: 0xb0, crcStock: 0x0b1d },
    reseal: bldcResealLz,
    patches: [
      { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
      { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0xd8, 0x3f, 0x00, 0x00], id: 'speed-cap' }, // X=0x3fd8 (835 = 40.0 km/h)
      { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' }, // fwBldc "0016" -> "8816"
    ],
    stdSpeedKmh: 40,
    variants: {
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0x00, 0x37, 0x00, 0x00], id: 'speed-cap' }, // X=0x3700 (522)
        { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0x54, 0x37, 0x00, 0x00], id: 'speed-cap' }, // X=0x3754 (564)
        { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0xc0, 0x0a, 0x00, 0x00], id: 'speed-cap' }, // X=0x0ac0 (626)
        { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0xc0, 0x0d, 0x00, 0x00], id: 'speed-cap' }, // X=0x0dc0 (668)
        { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0x0c, 0xb9, 0x00, 0x00], id: 'speed-cap' }, // X=0xb90c (731)
        { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed50: { experimental: true, speedKmh: 50, patches: [
        { off: 0x3d5c, from: [0x07], to: [0x08], id: 'speed-mode3' },
        { off: 0x3d60, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x40c8, from: [0x62, 0x03, 0x00, 0x20], to: [0x04, 0xd1, 0x00, 0x00], id: 'speed-cap' }, // X=0xd104 (1044)
        { off: 0x87e8, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
  },

  // UT3 Max BLDC 1.0.0.7 (10501). Ported from 0.0.0.5 (big version jump). Same 02831 speed-cap pointer-retarget
  // (literal @0x3da4 = RAM pointer 0x2000035e -> flash address X holding floor(2089*km/h/100) at file X+0x100),
  // scale + mapping proven on the old UT3 Max entries; every address re-read exact, even-aligned, in bounds.
  // Dual-CRC reseal reproduces 0x01f3/0xde61. mode3 dispatch restructured: 0x3a02 0x23->0x04 retargets to the
  // mode5 skip. 22/45/50 km/h have no even-aligned constant -> not offered. CAVEAT: the version-marker builder
  // is RAM-sourced, so the resulting fwBldc string cannot be byte-verified statically - app patched-detection
  // for UT3 Max needs a hardware read to confirm the string (speed patch itself is independent of the marker).
  bldcUT3Max_1007: {
    label: 'UT3 Max BLDC 1.0.0.7 (10501)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xc080 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-02831')) && bytesAt(u8, 0x80, [0x01, 0x00, 0x00, 0x07]) && beRead(u8, 0xb0, 2) === 0x01f3,
    verify: { size: 0xc080, lenOff: 0x84, lenStock: 0x0000bee8, crcOff: 0xb0, crcStock: 0x01f3 },
    reseal: bldcResealLz,
    patches: [
      { off: 0x39fe, from: [0x05], to: [0x06], id: 'speed-mode5' },
      { off: 0x3a02, from: [0x23], to: [0x04], id: 'speed-mode3' }, // restructured dispatch: retarget mode3 beq to the mode5 skip
      { off: 0x3da4, from: [0x5e, 0x03, 0x00, 0x20], to: [0x18, 0x6a, 0x00, 0x00], id: 'speed-cap' }, // X=0x6a18 (835 = 40.0 km/h)
      { off: 0x8546, from: [0x30], to: [0x38], id: 'version-marker' }, // RAM-sourced builder, leading digit; resulting fwBldc not statically verifiable
    ],
    stdSpeedKmh: 40,
    variants: {
      speed25: { experimental: true, speedKmh: 25, patches: [
        { off: 0x39fe, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3a02, from: [0x23], to: [0x04], id: 'speed-mode3' },
        { off: 0x3da4, from: [0x5e, 0x03, 0x00, 0x20], to: [0x44, 0x34, 0x00, 0x00], id: 'speed-cap' }, // X=0x3444 (522)
        { off: 0x8546, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed27: { experimental: true, speedKmh: 27, patches: [
        { off: 0x39fe, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3a02, from: [0x23], to: [0x04], id: 'speed-mode3' },
        { off: 0x3da4, from: [0x5e, 0x03, 0x00, 0x20], to: [0x94, 0x34, 0x00, 0x00], id: 'speed-cap' }, // X=0x3494 (564)
        { off: 0x8546, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed30: { experimental: true, speedKmh: 30, patches: [
        { off: 0x39fe, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3a02, from: [0x23], to: [0x04], id: 'speed-mode3' },
        { off: 0x3da4, from: [0x5e, 0x03, 0x00, 0x20], to: [0xa0, 0x0d, 0x00, 0x00], id: 'speed-cap' }, // X=0x0da0 (626)
        { off: 0x8546, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed32: { experimental: true, speedKmh: 32, patches: [
        { off: 0x39fe, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3a02, from: [0x23], to: [0x04], id: 'speed-mode3' },
        { off: 0x3da4, from: [0x5e, 0x03, 0x00, 0x20], to: [0xe4, 0x0d, 0x00, 0x00], id: 'speed-cap' }, // X=0x0de4 (668)
        { off: 0x8546, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
      speed35: { experimental: true, speedKmh: 35, patches: [
        { off: 0x39fe, from: [0x05], to: [0x06], id: 'speed-mode5' },
        { off: 0x3a02, from: [0x23], to: [0x04], id: 'speed-mode3' },
        { off: 0x3da4, from: [0x5e, 0x03, 0x00, 0x20], to: [0x24, 0xa6, 0x00, 0x00], id: 'speed-cap' }, // X=0xa624 (731)
        { off: 0x8546, from: [0x30], to: [0x38], id: 'version-marker' },
      ] },
    },
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
    // Top speed is min(meter region value * 10, gate ceiling), floored at 200 (FUN_08004080 / the gate at
    // 0x8f20). The gate (below) raises the ceiling to the selected km/h*10 when the unlock bit is set, but the
    // meter region value [0x20000352] (written at 0x8ef8 from frame byte 0xa * 10) binds the min() - so with a
    // low region value the ceiling never takes effect. speed-source forces that load (ldrb r0,[r1,#0xa] at
    // 0x8ee8 = file 0x9300) to 70, so [0x20000352] = 700 and the gate ceiling always wins; the locked ceiling
    // (220) still clamps when the unlock bit is clear, so lock behaviour is unchanged.
    patches: [
      { off: 0x9300, from: [0x88, 0x7a], to: [0x46, 0x20], id: 'speed-source' }, // ldrb r0,[r1,#0xa] -> movs r0,#70
      { off: 0x9338, from: [0x40, 0xf6, 0x22, 0x20, 0xc2, 0xf2, 0x00, 0x00, 0x00, 0x78, 0x01, 0x28, 0x04, 0xd1, 0xff, 0xe7, 0xdc, 0x20, 0xad, 0xf8, 0x36, 0x00, 0x11, 0xe0, 0x40, 0xf6, 0x22, 0x20, 0xc2, 0xf2, 0x00, 0x00, 0x00, 0x78, 0x09, 0x28, 0x04, 0xd1, 0xff, 0xe7, 0xfa, 0x20, 0xad, 0xf8, 0x36, 0x00, 0x04, 0xe0, 0x4f, 0xf4, 0x2f, 0x70, 0xad, 0xf8, 0x36, 0x00, 0xff, 0xe7, 0xff, 0xe7], to: [0x40, 0xf6, 0x22, 0x30, 0xc2, 0xf2, 0x00, 0x00, 0x00, 0x7b, 0x00, 0xf0, 0x10, 0x00, 0x00, 0x28, 0x04, 0xd0, 0x40, 0xf2, 0x90, 0x10, 0xad, 0xf8, 0x36, 0x00, 0x0f, 0xe0, 0xdc, 0x20, 0xad, 0xf8, 0x36, 0x00, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf], id: 'switchable-gate' },
      { off: 0xb249, from: [0x31], to: [0x39], id: 'version-marker' },
    ],
  },

  // XT5 Ultra BLDC 0.0.2.7 (T2443/MM32F5333). Not patched - the top speed opens over Bluetooth
  // without flashing, so a controller flash is never needed. Recognised only to refuse it clearly.
  bldcXT5Ultra: {
    label: 'XT5 Ultra BLDC 0.0.2.7',
    kind: 'bldc',
    match: (u8) => u8.length === 0xcb68 && bytesAt(u8, 0, ascii('T2443')) && bytesAt(u8, 0x404, [0xb3, 0xc0, 0xe9, 0xd3]),
    verify: { size: 0xcb68 },
    reseal: bldcResealCrc32,
    blocked: 'The XT5 Ultra controller is never patched - its top speed opens over Bluetooth without flashing (the app speed release, gear 4), so a controller flash is not needed.',
    patches: [],
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
    blocked: 'XT5 Pro/Max on controller 0.0.1.0 opens flash-free over Bluetooth (gear 4) - no controller flash needed. (Only the newer 0.0.1.3, where NAVEE removed the gear-4 path, carries a controller patch.)',
    stdSpeedKmh: 40,
    patches: [  // std: top gear-4 bucket at 40 (movw r1,#726); speed variants below cover 22-50
      { off: 0x43e0, from: [0x40, 0xf2, 0xd6, 0x21], to: [0x40, 0xf2, 0xd6, 0x21], id: 'speed' },
      { off: 0x1b6a, from: [0x05, 0x29, 0x1f, 0xd0], to: [0x04, 0x29, 0x1f, 0xda], id: 'launch-ramp' }, // drive-mode test beq #5 -> bge #4: mode 4 joins mode 5 on the 3-count ramp step instead of 2
    ],
  },

  // XT5 Pro/Max BLDC 0.0.1.3 (3553G/T2416): NAVEE OTA removed the explicit mode-4 case, so mode 4
  // defaults to the stock 0xb5 (~10 km/h). Patch: redirect the cap-select cmp at raw 0x47d8 from
  // `cmp r2,#5` -> `cmp r2,#4` (OTA 0x48d8: 05 2a -> 04 2a). Mode 4 then falls into the mode-5
  // branch which loads the meter-driven cap cell (PTR_DAT_00004b68, ~816 counts = 45 km/h with meter
  // patch active). No clamp problem: mode 4 is already at-or-below the cap by construction.
  // Version 0.0.1.3 writes fwBldc at notification[r1+1..4] (vs [r1+4..7] in 0.0.1.0), so
  // fwBldc[0]='3' (0x33) for unpatched; marker patch changes that to '5' (0x35).
  bldcXT5ProMax0013: {
    label: 'XT5 Pro/Max BLDC 0.0.1.3 (5301/5901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xe500 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x03]) && beRead(u8, 0xb0, 2) === 0x9757,
    verify: { size: 0xe500, lenOff: 0x84, lenStock: 0x0000e400, crcOff: 0xb0, crcStock: 0x9757 },
    reseal: bldcResealErpm,
    stdSpeedKmh: 45,
    patches: [
      { off: 0x48d8, from: [0x05, 0x2a], to: [0x04, 0x2a], id: 'speed' },        // cmp r2,#5->4: mode-4 -> cap cell (raw 0x47d8)
      { off: 0x0908e, from: [0x33, 0x20], to: [0x35, 0x20], id: 'version-marker' },      // fwBldc[0]: '3' -> '5'
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
  // Mechanics: the ride-gear limit is COMMANDED BY THE METER, not the controller. The meter sends it in
  // every frame (byte 10 -> [0x20000274], single writer at 0x0a73e, single reader the cap calc at 0x497a),
  // and in gears 3/4/5 the controller writes that value straight into the active cap at 0x4a3e - so an
  // earlier patch of the gear-ceiling cell is overwritten every cycle and has no road effect (seen on
  // hardware). The working lever is to force the meter value at its source: replace the byte-10 load at
  // 0x0a73e (ldrb.w r0,[lr,#0xa]) with an immediate (movw r0,#40), so the controller runs the top gear at
  // 40 km/h regardless of what the meter sends. Eco keeps its own lower cell (gear 2 is min(cell,40)); the
  // over-rev governor (cmp #0x186 = 39.0 at km/h*10, 0x384e/0x3ade/0x517c/0x5198) shaves the top to ~39.
  // In-place, inside the payload, len@0x84 untouched. Marker "0080" (= 0.0.8.0, not in the latch list).
  bldcUT5Max: {
    label: 'UT5 Max BLDC 0.0.1.0 (8901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xf900 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x00]) && beRead(u8, 0xb0, 2) === 0xb58f,
    verify: { size: 0xf900, lenOff: 0x84, lenStock: 0x0000f800, crcOff: 0xb0, crcStock: 0xb58f },
    reseal: bldcResealErpm,
    // Switchable controller patch - harmonises with the 0060 meter. The meter forwards the live 0x6E speed
    // value as drive-frame byte10; the stock controller reads it (ldrb @0xa73e) but its master clamp @0x4a5a
    // pulls it back to the per-gear ceiling (~22) every cycle. We NOP ONLY that clamp and LEAVE the byte10
    // read intact, so the controller obeys exactly what the meter sends - the app selector sets the speed
    // live (locked <-> open), no fixed value baked in. Over-rev governor caps the real top near 45.
    patches: [
      { off: 0x4a5a, from: [0x08, 0x83], to: [0x00, 0xbf], id: 'speed-clamp-nop' }, // NOP master clamp strh.gt r0,[r1,#0x18] -> controller obeys the meter-sent byte10
      { off: 0xaf26, from: [0x30, 0x21], to: [0x35, 0x21], id: 'version-marker' }, // fwBldc "0010" -> "5515" (leading '5' so the app detects the patched controller)
    ],
    atomic: true,
  },

  // Newer UT5 Max controller 0.0.1.3 (8901). Same in-place speed lever as 0.0.1.0 (force meter byte10 to the
  // target AND NOP the master clamp @speed-clamp-nop), offsets re-located and byte-verified against the stock
  // 0.0.1.3 image; reseal CRC16-XMODEM over [0x100,0x100+len] reproduces 0x8c7c. Marker moved to movs r1 (r2
  // in 0.0.1.0) and the stock version string is '0013', so the flip yields fwBldc '0083'.
  bldcUT5Max_0013: {
    label: 'UT5 Max BLDC 0.0.1.3 (8901)',
    kind: 'bldc',
    match: (u8) => u8.length === 0xfd00 && bytesAt(u8, 0x90, ascii('SZMC-ES-ZM-3553G')) && bytesAt(u8, 0x80, [0x00, 0x00, 0x01, 0x03]) && beRead(u8, 0xb0, 2) === 0x8c7c,
    verify: { size: 0xfd00, lenOff: 0x84, lenStock: 0x0000fc00, crcOff: 0xb0, crcStock: 0x8c7c },
    reseal: bldcResealErpm,
    // Switchable controller patch - harmonises with the 0060 meter (same design as 0.0.1.0, offsets relocated).
    // NOP ONLY the master clamp @0x4e12, leave the byte10 read (@0xac12) intact, so the meter-sent live value
    // is the cap - the app selector sets the speed live. Over-rev governor caps the real top near 45.
    patches: [
      { off: 0x4e12, from: [0x08, 0x83], to: [0x00, 0xbf], id: 'speed-clamp-nop' }, // NOP master clamp -> controller obeys the meter-sent byte10
      // No cruise patch on the controller. The engage FSM (hold branch @VA 0x4d76) gates on the CCS-arm cell
      // 0x20000395; on US hardware that is simply set to 1 and the stock hold latches. The real EU gap is that
      // the meter never sends byte9.bit5=1, so 0x395 stays 0. The fix lives entirely on the meter side
      // (meterUT5Max cruise-arm). The former dwell/steady edits here (VA 0x4014/0x401e) targeted the wrong
      // gate and are removed - they never made cruise latch and only risked disturbing the stock hold.
      { off: 0xb3d4, from: [0x30, 0x21], to: [0x35, 0x21], id: 'version-marker' }, // fwBldc "0013" -> "5513" (leading '5' = detected)
    ],
    atomic: true,
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
    // Switchable BT drossel (feature 'drossel'): the meter forwards a 0x51 drive frame whose byte10 is the
    // governed speed (config cell 0x20aa13); a region gate (FUN_08016e26: country in {6,7,8} open, else DE
    // clamp) zeroes it. NOP the frame-builder clamp (0x12e4e) so a set value is forwarded, and NOP the
    // setter region-skip (0x13e1e) so class 0x6E sub1 can write the cell (22 = locked, up = open) in DE.
    // The boot-init clamp is left intact, so it boots at the stock DE default and only opens on a BLE write.
    // In-place, length untouched, resealed. Experimental and HW-UNCONFIRMED: there is no ST5 controller
    // image, so whether the controller honours the forwarded byte can only be shown on hardware; BLE-host
    // meter with no confirmed SWD recovery -> red untested warning plus extra confirmation.
    patches: [
      { off: 0x12e4e, from: [0xee, 0x72], to: [0x00, 0xbf], id: 'speedsel' },        // NOP frame-builder DE zero-store of byte10
      { off: 0x13e1e, from: [0x47, 0xd0], to: [0x00, 0xbf], id: 'speedsel-setter' }, // NOP setter region-skip (allow 0x6E write in DE)
      { off: 0x1427c, from: [0x30], to: [0x35], id: 'version-marker' }, // reported meter version is code-built in the 0x73 handler (movs r1,#'0' @0x1427c -> #'5'), NOT a data string. fwMeter '0024' -> '5024', so app/tool detect the patch. (Old 0x1938c patched a dead debug literal - the meter kept reporting 0024 and the patch was invisible; same class as the UT5 Max 0x1a7da bug.)
      // Per-tone beep silences (bl -> nop; T2314 buzzer setter has no dur<2 guard). BLE-cmd + state-change
      // confirm beeps (0x13d3c/0x13d4e/0x151dc/0x1c3a6) are left on. Fault-B site 0x158f6 is deliberately
      // EXCLUDED: its bl is followed by a bl with no register setup, so a bare NOP would leave stale regs.
      { off: 0x15212, from: [0xff, 0xf7, 0x58, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed' },       // >~30 km/h, region-gated
      { off: 0x15200, from: [0xff, 0xf7, 0x86, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' },          // status / fault-code announce
      { off: 0x1519a, from: [0xff, 0xf7, 0x85, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-findmy-on' }, // find-my / anti-theft cluster
      { off: 0x151ac, from: [0xff, 0xf7, 0x7c, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-findmy-off' },
      { off: 0x16078, from: [0xfe, 0xf7, 0xd4, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-engage' },
      { off: 0x16228, from: [0xfe, 0xf7, 0xfc, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-lock1' },
      { off: 0x162e0, from: [0xfe, 0xf7, 0xa0, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-lock2' },
      { off: 0x16386, from: [0xfe, 0xf7, 0x4d, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-speedlock' },
      { off: 0x163d8, from: [0xfe, 0xf7, 0x24, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-state' },
      { off: 0x15230, from: [0xff, 0xf7, 0xf8, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-connect' },         // connect / ready chime
      { off: 0x1528a, from: [0xff, 0xf7, 0xcb, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault' },           // fault / warning
      { off: 0x1587a, from: [0xff, 0xf7, 0xd3, 0xfb], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-b' },
      { off: 0x159b2, from: [0xff, 0xf7, 0x37, 0xfb], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-c' },
    ],
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

  // UT5 Max meter 0.0.3.0 (8901). T2314. Switchable speed selector + kickstart + beep silences, all in-place
  // (len@0x10 untouched, image passes its own len+CRC gate; stock CRC 0x010a, re-sealed per selection).
  // Two NOPs make the BLE drossel work in every region: speedsel clears the DE region skip (beq) inside
  // the class 0x6E sub1 handler (FUN_080142ae @ 0x142ce) so 0x6E sub1 writes the live speed cell 0x20aae6
  // in every region, and speedsel-frame forces the frame builder's region path selector (FUN_8017658 @
  // 0x13396, beq -> b) onto the cell-forward branch so drive-frame byte10 FOLLOWS that cell in every
  // region. Without speedsel-frame the selector takes the restricted path on DE and byte10 is pinned to
  // the 0x32 stock sentinel, so BT speed switching does nothing - that was the bug. byte10 != 0x32 then
  // copies the cell directly with no further gate.
  // The controller honours byte10 as a linear cap, so the app selects both the locked and the open
  // km/h (class 0x6E sub1). Marker "0060" (not "0050") so the app tells this value-selector meter apart
  // from the earlier "0050" on/off (0x81-flag) meter. Confirmed on hardware.
  meterUT5Max: {
    label: 'UT5 Max meter 0.0.3.0 (8901)',
    kind: 'meter',
    match: (u8) => u8.length === 0x25c00 && bytesAt(u8, 0, ascii('T2314')) && beRead(u8, 0x13, 2) === 0x010a,
    verify: { size: 0x25c00, crcOff: 0x13, crcStock: 0x010a, lenOff: 0x10, lenStock: 0x025800 },
    bodyBase: 0x400,
    reseal: meterReseal,
    // Drossel, kickstart and the beep silences are each chosen on their own (a user may want only kickstart
    // or only the quiet beeps). The version marker means "drossel present" (the app enables the BLE toggle
    // off it), so it is pinned to the drossel via markerFeature - picking kickstart or a beep silence alone
    // writes no marker and therefore no dead toggle.
    markerFeature: 'drossel',
    patches: [
      { off: 0x13396, from: [0x07, 0xd0], to: [0x07, 0xe0], id: 'speedsel-frame' }, // frame-builder region path selector (FUN_8017658 @ 0x13390): beq -> b forces the cell-forward branch so drive byte10 follows the 0x6E speed cell in EVERY region; the stock selector takes the restricted path on DE and byte10 is pinned to the 0x32 sentinel (BT speed switch did nothing without this)
      { off: 0x142ce, from: [0x04, 0xd0], to: [0x00, 0xbf], id: 'speedsel' }, // class 0x6E sub1 handler (FUN_080142ae): NOP the DE region skip (beq) so the speed cell 0x20aae6 is written in every region; drive-frame byte10 then follows it (locked/open km/h both set live by 0x6E sub1)
      { off: 0x169c2, from: [0x32, 0x28, 0x07, 0xd1], to: [0x00, 0x20, 0x03, 0xe0], id: 'speedsel-bootlock' }, // boot-init: force the live speed cell 0x20aae6 to 0 (= locked / stock DE cap) on every power-on, overriding any value a prior 0x6E write persisted, so the scooter ALWAYS boots throttled regardless of which app (ours/stock/none) connects next. The live 0x6E write still opens it for the running session; a power cycle re-locks. In-place 4 bytes (movs r0,#0; b 0x169ce) reusing the existing zero+persist tail (FUN_08015c2c, field 0x40) that stock already runs on every DE boot. featureOf('speedsel-*')='drossel' so it ships with the drossel, never alone.
      { off: 0x1438f, from: [0xd2], to: [0xe0], id: 'kickstart' }, // zero-start region floor (bhs) -> unconditional, launch levels 0-2 accepted in every region
      { off: 0x14068, from: [0x0b, 0xd0], to: [0x00, 0xbf], id: 'cruise' }, // cmd 0x52 cruise-enable handler (dispatch @0x52 -> FUN @0x1405a): NOP the DE region skip (beq) so the app on/off enable (byte5.bit5 -> controller cell 0x20000267, read by the detector FSM @0x3dd0) reaches the controller in every region. This is what makes cruise SWITCHABLE: app off -> enable=0 -> detector clears engage, app on -> enable=1. off==stock. Needs cruise-arm below to make the feature available at all.
      { off: 0x13316, from: [0xa3, 0x79], to: [0x01, 0x23], id: 'cruise-arm' }, // frame builder FUN_080131bc: byte9.bit5 is built from [0x20aac6].bit0 (ldrb r3,[r4,6], r4=0x20aac0) -> the controller unpacker (@0xaaec) stores it to the CCS-arm cell 0x20000395, which the engage FSM hold branch (@0x4d76) gates on. On US hardware [0x20aac6]=1 and the stock hold latches; on EU it is 0, so 0x395 stays 0 and cruise never arms however long throttle is held. Force the source to 1 (movs r3,#1) = exactly the US config value = byte-identical US cruise behaviour. SWITCHABILITY is unaffected: this only makes the feature AVAILABLE; the app 0x52 enable (cruise above) still gates on/off via the detector FSM, and the unconditional brake torque-cut (0x27da->0x275c) is never armed by this. off==stock a3 79.
      { off: 0x159fc, from: [0xff, 0xf7, 0x1f, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm' }, // find-me/anti-theft alarm bl (FUN_0801543e) -> nop
      { off: 0x15ae4, from: [0xff, 0xf7, 0xd0, 0xfc], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody' }, // fault/error-code announce bl (FUN_08015488) -> nop; silences every fault tone on this meter
      { off: 0x14ab4, from: [0x33], to: [0x36], id: 'version-marker' }, // reported meter version is CODE-BUILT in the 0x73 response handler (movs r2,#'3' @0x14ab4 -> #'6'), NOT a data string. fwMeter '0030' -> '0060', so the app/tool detect the patched meter. (The old 0x1a7da patched a dead debug literal that nothing reads - the meter kept reporting 0030 and the patch was invisible, which is why no UT5 Max ever switched.)
    ],
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

  // N65i II meter 2.0.5.8 (6001). Switchable BT drossel (feature 'drossel'): the meter forwards a 0x51
  // drive frame whose payload[7] (= whole-frame offset 0xa, exactly what the N65i II controller reads with
  // ldrb r1,[r0,#0xa] and uses as cap = min(modeCap, byte*scale)) is the controller speed cap. The outbound
  // byte comes from BLE cell 0x0020ab9e, which 0x6E sub1 (caseD_6e: cVar1==1 -> *(r4+0x1a)=cVar2) writes
  // UNCLAMPED - but the frame builder FUN_08012ad8 region-gates it: payload[7] is passed only when
  // regionVariant(0x20abb2) in 1..7 OR country(0x20abb1) in {8,9,10}, else 0 (DE forces 0 -> controller
  // fallback ~22). NOPing the bhi makes the gate fall through for every region, so payload[7] always follows
  // the cell and live 0x6E sub1 picks locked/open km/h. Controller mode-4 cap (~40) bounds the open side.
  // The marker is pinned to 'drossel' (writing it without the drossel would show a dead BLE toggle).
  // Byte-verified against the raw DE image (gate 0x12c48, marker 0x1400e, mapping delta 0). HW-untested.
  n65ii6001_meter: {
    label: 'N65i II meter 2.0.5.8 (6001)',
    kind: 'meter',
    match: (u8) => u8.length === 0x23000 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xfaf,
    verify: { size: 0x23000, crcOff: 0x13, crcStock: 0xfaf, lenOff: 0x10, lenStock: 0x022c00 },
    bodyBase: 0x400,
    reseal: meterReseal,
    markerFeature: 'drossel',
    patches: [
      { off: 0x12c48, from: [0x03, 0xd8], to: [0x00, 0xbf], id: 'speedsel' }, // region gate in frame builder FUN_08012ad8 @0x08012c42 (bhi 0x08012c52) -> nop: payload[7] then follows BLE speed cell 0x20ab9e in every region, live 0x6E sub1 = lock/open. Experimental, HW-unconfirmed
      { off: 0x1400e, from: [0x32], to: [0x35], id: 'version-marker' }, // reported meter version is CODE-BUILT in the 0x73 response builder FUN_0801400e (movs r1,#'2' @0x1400e -> #'5'), NOT a data string. fwMeter '2058' -> '5058', so the app/tool detect the patched meter (the dead debug literal '2058handle key value read' @0x19664 is NOT read - never patch there)
      // Per-tone beep silences (bl -> nop; GPIO buzzer, no dur<2 guard). BLE-command confirm chirps left on.
      { off: 0x15f84, from: [0x1e, 0x28], to: [0xff, 0x28], id: 'beep-overspeed-nag' },   // continuous >~30 km/h nag: cmp #0x1e -> #0xff
      { off: 0x155fe, from: [0xff, 0xf7, 0x6e, 0xfa], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-a' },     // fault/status threshold tone
      { off: 0x1567e, from: [0xff, 0xf7, 0x2e, 0xfa], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-b' },     // status-change event tone
      { off: 0x1573c, from: [0xff, 0xf7, 0xcf, 0xf9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-c' },     // periodic warning cadence
      { off: 0x15cd2, from: [0xfe, 0xf7, 0x04, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-a' },    // startup / mode-entry melody
      { off: 0x15f5c, from: [0xfe, 0xf7, 0xbf, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-b' },    // announce melody
      { off: 0x16052, from: [0xfe, 0xf7, 0x44, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-c' },    // event-announce melody
      { off: 0x15e12, from: [0xfe, 0xf7, 0x66, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-d' },    // mode/state tick chime
      { off: 0x165cc, from: [0xfe, 0xf7, 0x87, 0xfa], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-findmy' }, // find-me / locate chirp
    ],
  },

  // N65i II meter 2.0.5.9 (10701, US). No drossel patch needed: the US image already ships OPEN - its init
  // writes the cell to 40 for country {8,9,10} (byte-verified in the US decompile FUN_08017b26), so a US
  // N65i II is not region-throttled the way the DE 2.0.5.8 is. The drossel patch exists to lift the DE
  // region gate; there is nothing to lift on US. Left intentionally patchless (not a TODO). The US build is
  // also structurally different (its frame builder near 0x12c8a has no DE "cmp #6 / bhi" region gate), so the
  // DE NOP has no US equivalent anyway - do NOT guess a US offset here (brick risk).
  n65ii10701_meter: {
    label: 'N65i II meter 2.0.5.9 (10701)',
    kind: 'meter',
    match: (u8) => u8.length === 0x23800 && bytesAt(u8, 0, ascii('T2202')) && beRead(u8, 0x13, 2) === 0xa321,
    verify: { size: 0x23800, crcOff: 0x13, crcStock: 0xa321, lenOff: 0x10, lenStock: 0x023400 },
    bodyBase: 0x400,
    reseal: meterReseal,
    // No drossel/marker: the US image already ships open (init sets the speed cell to 40 for country
    // {8,9,10}) and its frame builder has no DE region gate - nothing to lift. Only per-tone beep silences
    // (bl -> nop; GPIO buzzer, no dur<2 guard). BLE-command confirm chirps left on.
    patches: [
      { off: 0x16430, from: [0x1e, 0x28], to: [0xff, 0x28], id: 'beep-overspeed-nag' },   // continuous >~30 km/h nag: cmp #0x1e -> #0xff
      { off: 0x14e78, from: [0xff, 0xf7, 0x90, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed-onset' },   // over-speed onset
      { off: 0x14dfe, from: [0xff, 0xf7, 0xcd, 0xff], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed-cadence' }, // over-speed cadence
      { off: 0x15a66, from: [0xff, 0xf7, 0xa8, 0xf9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-alarm-a' },     // long alarm tone
      { off: 0x15ba0, from: [0xff, 0xf7, 0x0b, 0xf9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-a' },     // speed-mismatch fault
      { off: 0x150be, from: [0xff, 0xf7, 0x6d, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-b' },     // status / fault-code announce
      { off: 0x150ee, from: [0xff, 0xf7, 0x55, 0xfe], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-c' },
      { off: 0x151ec, from: [0xff, 0xf7, 0xd6, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-d' },
      { off: 0x15220, from: [0xff, 0xf7, 0xbc, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-e' },
      { off: 0x15262, from: [0xff, 0xf7, 0x9b, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-f' },
      { off: 0x152b6, from: [0xff, 0xf7, 0x71, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-g' },
      { off: 0x152d4, from: [0xff, 0xf7, 0x62, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-h' },
      { off: 0x152e6, from: [0xff, 0xf7, 0x59, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-i' },
      { off: 0x1531a, from: [0xff, 0xf7, 0x3f, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-fault-j' },
    ],
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
    markerFeature: 'drossel',
    // Switchable BT drossel: the G5 controller honours drive-frame byte10 as min(modeCap, byte10*20.89), so
    // NOP the meter's region clamp (FUN_080173c2 @0x173f4: bls -> unconditional b to 0x17402); the BLE-set
    // speed (class 0x6E sub1) is then forwarded as byte10 in every region (22 locked, up to 40 open).
    // Controller stays stock. In-place, no cave. Experimental - BLE-host meter, red untested warning.
    patches: [
      { off: 0x173f4, from: [0x05, 0xd9], to: [0x05, 0xe0], id: 'speedsel' },        // region clamp bls -> unconditional b (0x17402)
      { off: 0x19b5c, from: [0x32], to: [0x35], id: 'version-marker' },              // fwMeter "2057" -> "5057"
      // Per-tone beep silences (bl -> nop; GPIO buzzer, no dur<2 guard). BLE-command confirm chirps left on.
      { off: 0x15ea2, from: [0x1e, 0x28], to: [0xff, 0x28], id: 'beep-overspeed-nag' },   // continuous >~30 km/h nag: cmp #0x1e -> #0xff (also disarms the mode-5 cadence)
      { off: 0x1568c, from: [0xff, 0xf7, 0xc7, 0xf9], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed-cadence' }, // over-speed sustained cadence
      { off: 0x1554e, from: [0xff, 0xf7, 0x66, 0xfa], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-overspeed-warn' },    // over-speed warning
      { off: 0x15e7a, from: [0xfe, 0xf7, 0xd0, 0xfd], to: [0x00, 0xbf, 0x00, 0xbf], id: 'beep-melody-a' },          // over-speed state-transition chime
    ],
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

// NT5 Max 9301 (02831) reaches higher than the shared NT5 set: no sub-50 governor on this build
// (field: 49 km/h real at the 50 setting). capZ = imm8 << shift. imm8 = km/h*5 while <=255 (lsls #2);
// above 51 km/h switch to lsls #3 so imm8 = round(km/h*2.5) fits one byte, and rescale the locked value
// to 55 (55<<3 = 440 = 22 km/h) so the locked state stays identical. All in-place, no length change.
function nt9301SpeedVariants(spec, find, kmhList) {
  const out = {};
  for (const kmh of kmhList) {
    const patches = spec.patches.map((p) => ({ off: p.off, from: p.from, to: p.to.slice(), id: p.id }));
    const lp = patches.find((p) => p.id === 'capz-latch');
    if (!lp) throw new Error('nt9301SpeedVariants: capz-latch patch missing');
    const at = findSub(lp.to, find);           // open immediate (movs r6,#imm8) inside the latch block
    if (at < 0) throw new Error('nt9301SpeedVariants: open immediate not found');
    if (kmh * 5 <= 255) {
      lp.to[at] = (kmh * 5) & 0xff;             // open imm8 (<<2); locked 110 and lsls #2 stay stock
    } else {
      lp.to[at] = Math.round(kmh * 2.5) & 0xff; // open imm8 for lsls #3
      lp.to[at + 4] = 55;                        // locked 55 (55 << 3 = 440 = 22 km/h)
      lp.to[at + 6] = 0xf6;                      // lsls r6,r6,#3 (was 0xb6 = #2)
    }
    out['speed' + kmh] = { mark: spec.mark, experimental: true, speedKmh: kmh, patches: patches };
  }
  return out;
}

IMAGES.bldc9301.stdSpeedKmh = 40;
IMAGES.bldc9301.variants = nt9301SpeedVariants(IMAGES.bldc9301, [0xc8, 0x26], [22, 25, 30, 35, 45, 50, 60]);
// Current (power) scaler, independent axis: [0x2000020e]/[0x20000214] = raw * factor/10 (two movs #imm8
// feeding muls). Stock 0x3384=22, 0x3390=18. Raising = more phase current (more launch/accel torque).
// In-place single-byte immediates. Experimental, HW-unconfirmed by us (third party field-ran 22/25).
IMAGES.bldc9301.currentVariants = {
  cur22: { level: 22, patches: [
    { off: 0x3390, from: [0x12], to: [0x16], id: 'current' },
  ] },
  cur25: { level: 25, patches: [
    { off: 0x3384, from: [0x16], to: [0x19], id: 'current' },
    { off: 0x3390, from: [0x12], to: [0x19], id: 'current' },
  ] },
  cur30: { level: 30, patches: [
    { off: 0x3384, from: [0x16], to: [0x1e], id: 'current' },
    { off: 0x3390, from: [0x12], to: [0x1e], id: 'current' },
  ] },
};
IMAGES.bldc9207.stdSpeedKmh = 40; IMAGES.bldc9207.variants = ntSpeedVariants(IMAGES.bldc9207, { latchId: 'capz-latch', enc: 'movs8', find: [0xc8, 0x21] });
IMAGES.bldc9701.stdSpeedKmh = 40; IMAGES.bldc9701.variants = ntSpeedVariants(IMAGES.bldc9701, { latchId: 'latch-cave', enc: 'movw', find: [0x40, 0xf2, 0x20, 0x30], rd: 0 });
IMAGES.bldc9401.stdSpeedKmh = 40; IMAGES.bldc9401.variants = ntSpeedVariants(IMAGES.bldc9401, { latchId: 'latch-cave', enc: 'movw', find: [0x40, 0xf2, 0x20, 0x30], rd: 0 });
// bldcUT5Max stdSpeedKmh (40) and variants (22-40) are defined in its IMAGES block above; over-rev governor shaves the top to ~39.

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
function xtBucketVariants(buckets, rd, scaleFn, topOff, speeds, extra) {
  const build = (kmh) => {
    const t = scaleFn(kmh), ps = [];
    for (const b of buckets) if (b.cap > t) ps.push({ off: b.off, from: b.from, to: movwLE(rd, t), id: 'speed' });
    if (!ps.length) { const tb = buckets.find((b) => b.off === topOff); ps.push({ off: tb.off, from: tb.from, to: movwLE(rd, t), id: 'speed' }); }
    return ps.concat(extra || []);   // a named variant replaces spec.patches, so carry them along
  };
  const v = {};
  for (const kmh of speeds) v['speed' + kmh] = { experimental: true, speedKmh: kmh, patches: build(kmh) };
  return v;
}
IMAGES.bldcXT5ProMax.variants = xtBucketVariants(
  [{ off: 0x43e0, from: [0x40, 0xf2, 0xd6, 0x21], cap: 726 }, { off: 0x43cc, from: [0x4f, 0xf4, 0xe3, 0x71], cap: 454 }],
  1, (k) => Math.floor(k * 2089 / 115), 0x43e0, [22, 25, 27, 30, 35, 45, 50],
  [{ off: 0x1b6a, from: [0x05, 0x29, 0x1f, 0xd0], to: [0x04, 0x29, 0x1f, 0xda], id: 'launch-ramp' }]);

// Identify which image this is, or null.
// Which images the patcher will flash. Experimental models (EXPERIMENTAL set below) show a warning and
// need an extra confirmation before patching; none of the experimental speed patches is confirmed on hardware.
const FLASH_ENABLED = new Set([
  'meterMax', 'meterTurboUltra', 'meterMaxPlus', 'meterUltraX',   // NT5 family meters
  'meterXT5', 'meterXT5_3023',                                    // XT5 meter (3.0.2.0 plus newer 3.0.2.3)
  'meterUT5Max',                                                  // UT5 Max meter (drossel toggle + kickstart + cruise + beep silences, HW-confirmed)
  'meterST3GT3',                                                  // ST3/GT3 meter (zero-start level 0-2 unlock + switchable drossel + version marker, experimental)
  'meterGT5',                                                     // GT5 meter (switchable drossel + version marker, experimental; previously blocked)
  'meterG5',                                                      // G5/Pro/Max meter (switchable drossel + version marker, experimental)
  'st5_meter',                                                    // ST5 Pro/Max meter (switchable drossel + version marker, experimental; no ST5 controller image, HW-unconfirmed; previously blocked)
  'n65ii6001_meter',                                             // N65i II meter 2.0.5.8 DE (switchable drossel: region-gate NOP + version marker, controller stays stock, experimental)
  'n65ii10701_meter',                                            // N65i II meter 2.0.5.9 US (per-tone beep silences only; US ships open so no drossel, experimental)
  'bldc9701', 'bldc9401', 'bldc9301', 'bldc9207',                 // NT5 family controllers
  'bldcUT5Max', 'bldcUT5Max_0013',                                // UT5 Max controller (switchable 22-40, obeys the meter-sent byte10; 0.0.1.0 plus newer 0.0.1.3; flashed with the meter, HW-confirmed)
  'bldcUT5UltraX',                                                // UT5 Ultra X controller (target-speed selector 22-50, experimental)
  'bldcXT5ProMax0013',                                            // XT5 Pro/Max controller 0.0.1.3 (45 km/h via meter cap, experimental)
  'bldcST3Pro', 'bldcGT3Pro', 'bldcST3_0101', 'bldcST3_0102', 'bldcGT3_0101', 'bldcGT3Max_0101', // ST3/GT3 controllers
  'bldcG5', 'bldcGT5Max', 'bldcGT5Pro', 'bldcGT5_0016', 'bldcUT3Max', 'bldcUT3Max_1007', 'bldcNT3Max', // 02831 in-place target-speed selector, raised top gear (experimental)
  'bldcNT3Pro',                                                  // NT3 Pro controller (experimental; meter not yet enabled)
  'bldcG5Max', 'bldcG5Pro', 'bldcV45i', 'bldcN65iII10701', 'bldcN65iII6001', 'bldcS2', 'bldcV40iProII', 'bldcV3Pro', 'bldcS60', 'bldcS40', 'bldcV40i', 'bldcV50iPro', 'bldcN65i', 'bldcV25', 'bldcE20LiteE25Go', 'bldcE45E60', 'bldcE20E25', 'bldcK100', 'bldcK100Pro', 'bldcK100Max', // 02831 shared-store builds: clamp nop plus cap repoint (experimental)
]);

// Flashable but not yet confirmed on recoverable hardware. The UI must show a red untested warning
// plus an extra confirmation before creating or flashing these images.
const EXPERIMENTAL = new Set(['meterST3GT3', 'meterGT5', 'meterG5', 'st5_meter', 'n65ii6001_meter', 'n65ii10701_meter', 'meterXT5_3023', 'bldcUT5UltraX', 'bldcXT5ProMax0013', 'bldcST3Pro', 'bldcGT3Pro', 'bldcST3_0101', 'bldcST3_0102', 'bldcGT3_0101', 'bldcGT3Max_0101', 'bldcNT3Pro', 'bldcG5', 'bldcGT5Max', 'bldcGT5Pro', 'bldcGT5_0016', 'bldcUT3Max', 'bldcUT3Max_1007', 'bldcNT3Max', 'bldcG5Max', 'bldcG5Pro', 'bldcV45i', 'bldcS2', 'bldcV40iProII', 'bldcN65i', 'bldcV3Pro', 'bldcS60', 'bldcS40', 'bldcV40i', 'bldcV50iPro', 'bldcV25', 'bldcE20LiteE25Go', 'bldcE45E60', 'bldcE20E25', 'bldcK100', 'bldcK100Pro', 'bldcK100Max']);
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
  if (id.indexOf('beep-connect') === 0) return 'beep-connect';
  if (id.indexOf('beep-fault') === 0) return 'beep-fault';
  if (id.indexOf('beep-') === 0) return id; // beep-silence legacy or any other single beep patch
  if (id.indexOf('speedsel') === 0) return 'drossel'; // meter region-gate -> switchable BT drossel (separate from controller 'speed')
  if (id.indexOf('version-marker') === 0) return 'marker';
  if (id.indexOf('launch-ramp') === 0) return 'launchramp';   // 'launch-degate' stays part of the speed set
  if (id.indexOf('current') === 0) return 'current';           // controller current (power) scaler, own axis
  return 'speed';
}

// Apply a patch set with per-row expected-byte verification.
function applyPatches(u8, patches, selected, markerFeature) {
  const want = selected ? new Set(selected) : null;
  const anyNonMarker = patches.some(p => featureOf(p.id) !== 'marker' && (!want || want.has(featureOf(p.id))));
  const applied = [];
  for (const p of patches) {
    const feat = featureOf(p.id);
    // A marker is normally written whenever any real feature is applied. markerFeature pins it to ONE
    // feature instead (e.g. the UT5 Max version marker means "drossel present": writing it without the
    // drossel would make the app show a dead BLE toggle), so unrelated single features stay marker-free.
    const apply = feat === 'marker'
      ? (!want || (markerFeature ? want.has(markerFeature) : anyNonMarker))
      : (!want || want.has(feat));
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
  const core = new Set(IMAGES[key].coreFeatures || []);   // forced features are not user-choosable
  for (const p of IMAGES[key].patches) {
    const f = featureOf(p.id);
    if (f !== 'marker' && !core.has(f) && feats.indexOf(f) < 0) feats.push(f);
  }
  return { image: key, kind: IMAGES[key].kind, features: feats };
}

// Selectable current (power) levels of an identified image, for the UI to offer a second picker next to
// the speed picker. Returns null when the image has no current axis. 'std' = stock current (no patch).
function imageCurrentVariants(u8) {
  const key = identify(u8);
  const spec = key && IMAGES[key];
  if (!spec || !spec.currentVariants) return null;
  const keys = ['std'].concat(Object.keys(spec.currentVariants));
  const level = {};
  keys.forEach((c) => { level[c] = c === 'std' ? null : (spec.currentVariants[c].level || null); });
  return { image: key, currents: keys, level: level };
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
function patchFirmware(arrayBuffer, selected, variantKey, currentKey) {
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
  // coreFeatures always apply (the drossel+marker set the app keys its toggle and launch 0-2 off); any
  // other feature (beep silences) honours the selection. Legacy atomic (whole set) still forces all.
  const sel = spec.atomic ? null
    : spec.coreFeatures ? Array.from(new Set((selected || []).concat(spec.coreFeatures)))
    : selected;
  const applied = applyPatches(u8, patchList, sel, spec.markerFeature);
  // Current (power) axis: independent of the speed variant, applied on top (own offsets, no overlap).
  const curSpec = (currentKey && currentKey !== 'std' && spec.currentVariants) ? spec.currentVariants[currentKey] : null;
  if (curSpec) applyPatches(u8, curSpec.patches, null).forEach((id) => applied.push(id));
  spec.reseal(u8);

  return {
    image: key,
    label: spec.label,
    kind: spec.kind,
    variant: variant ? variantKey : 'std',
    current: curSpec ? currentKey : 'std',
    mark: (variant && variant.mark) || spec.mark || null,
    experimental: variant ? !!variant.experimental : isExperimental(key),
    applied: applied,
    nothingToPatch: applied.length === 0,
    bytes: u8,
  };
}

if (typeof window !== 'undefined') {
  window.NVFW = { patchFirmware, identify, imageFeatures, imageVariants, imageCurrentVariants, isExperimental, crc16Xmodem, IMAGES };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { patchFirmware, identify, imageFeatures, imageVariants, imageCurrentVariants, isExperimental, featureOf, crc16Xmodem, beRead, beWrite, IMAGES };
}
