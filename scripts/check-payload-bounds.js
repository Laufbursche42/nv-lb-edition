'use strict';
// Guard against the brick class that killed real devices (ST3 Pro, GT3 Pro, UT5 Max meter cruise-hold, ...):
// a BLDC or meter patch that writes bytes into the ERASED 0xFF TAIL of the image. Those bytes are past the
// last real content byte; the device does not reliably program/execute them, so any jump (bl/b) into that
// region -> jump into unprogrammed/unmapped flash -> HARDFAULT -> boot loop. CRC passing and DFU "complete"
// do NOT prove the bytes are executable there (the tail is still inside the CRC range).
//
// TWO checks, both hard-fail (exit 1) for any FLASH_ENABLED build:
//   A) BOUNDS: every patch byte lies inside [base, base+declared-len]  (base: bldc 0x100 / meter 0x400).
//   B) TAIL:   no patch byte lands at or beyond the stock image's CONTENT END (= last non-0xFF byte + 1).
//              This is THE check that catches cave/trampoline patches placed in the 0xFF tail - the exact
//              thing that must never ship again. Internal 0xFF gaps inside real content are fine; only the
//              trailing erased tail is rejected. Needs the stock .bin (found by size+CRC in the firmware
//              dir); if a stock bin for an enabled build is not found, that is reported as a hard FAIL for
//              enabled builds (we never ship a patch whose tail-safety we could not verify).
//
// Usage: node scripts/check-payload-bounds.js [engine/navee-patch.js]
//   FW_DIR env var overrides the firmware directory to scan for stock bins.
const fs = require('fs');
const path = require('path');
const enginePath = process.argv[2] || path.join(__dirname, '..', 'engine', 'navee-patch.js');
const src = fs.readFileSync(enginePath, 'utf8');

// Candidate firmware dirs to find stock bins (first that exists is scanned recursively).
const fwCandidates = [
  process.env.FW_DIR,
  path.join(__dirname, '..', '..', '..', 'navee', 'nogit', 'firmware'),
  'C:/Users/Bob/Documents/scooter/navee/nogit/firmware',
].filter(Boolean);
const fwDir = fwCandidates.find(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }) || null;

function beRead(buf, off, n) { let v = 0; for (let i = 0; i < n; i++) v = (v * 256) + buf[off + i]; return v >>> 0; }

// Index all .bin files in the firmware dir by size -> [paths], lazily (recursive walk once).
let binsBySize = null;
function indexBins() {
  binsBySize = new Map();
  if (!fwDir) return;
  const stack = [fwDir];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.bin')) {
        let sz; try { sz = fs.statSync(full).size; } catch (e2) { continue; }
        if (!binsBySize.has(sz)) binsBySize.set(sz, []);
        binsBySize.get(sz).push(full);
      }
    }
  }
}
// Find the stock bin matching an image's verify {size, crcOff, crcStock}; return its Buffer or null.
function findStock(size, crcOff, crcStock) {
  if (binsBySize === null) indexBins();
  const cands = (binsBySize && binsBySize.get(size)) || [];
  for (const p of cands) {
    let b; try { b = fs.readFileSync(p); } catch (e) { continue; }
    if (b.length !== size) continue;
    if (crcOff === undefined || crcStock === undefined) return b; // size-only match
    if (beRead(b, crcOff, 2) === crcStock) return b;
  }
  return null;
}
function contentEnd(buf) { let i = buf.length - 1; while (i >= 0 && buf[i] === 0xff) i--; return i + 1; }

const feM = src.match(/const\s+FLASH_ENABLED\s*=\s*new Set\(\[([^\]]*)\]/);
const enabled = new Set(feM ? [...feM[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []);

// HW-CONFIRMED cave builds allowed to place a patch in the [content-end, len] region. These 3553G/NT5
// controllers program the FULL declared length, so an in-len cave there is really in programmed flash and
// is confirmed running on hardware. A build may ONLY be added here after it is flashed+confirmed on a
// recoverable device. Everything else that writes at/into the 0xFF tail hard-fails (the UT5 Max T2314
// meter did NOT program its tail -> the cruise-hold cave there bricked; see navee-flash-brick-rules).
const CONFIRMED_TAIL_SAFE = new Set(['bldc9701', 'bldc9401', 'bldc9301']);

const heads = [...src.matchAll(/\n {2}(\w+):\s*\{/g)];
let fail = false;
const warns = [];
if (!fwDir) console.log('NOTE: no firmware dir found - TAIL check (B) skipped; set FW_DIR to enable it.');

for (let i = 0; i < heads.length; i++) {
  const name = heads[i][1];
  const sec = src.slice(heads[i].index, i + 1 < heads.length ? heads[i + 1].index : src.length);
  const isMeter = /kind:\s*'meter'/.test(sec);
  const isBldc = /kind:\s*'bldc'/.test(sec);
  if (!isMeter && !isBldc) continue;
  const base = isMeter ? 0x400 : 0x100;
  const lenFieldOff = isMeter ? 0x10 : 0x84;
  const lenM = sec.match(/lenStock:\s*(0x[0-9a-fA-F]+)/);
  const sizeM = sec.match(/verify:\s*\{\s*size:\s*(0x[0-9a-fA-F]+)/);
  const crcOffM = sec.match(/crcOff:\s*(0x[0-9a-fA-F]+)/);
  const crcStockM = sec.match(/crcStock:\s*(0x[0-9a-fA-F]+)/);
  if (!lenM && !sizeM) continue;
  const size = sizeM ? parseInt(sizeM[1], 16) : null;
  let eff = lenM ? parseInt(lenM[1], 16) : (size - base);

  // collect patches (off, from[], to[])
  const pats = [...sec.matchAll(/\{\s*off:\s*(0x[0-9a-fA-F]+)\s*,\s*from:\s*\[([^\]]*)\]\s*,\s*to:\s*\[([^\]]*)\]\s*,\s*id:\s*'([^']+)'/g)]
    .map(m => ({
      off: parseInt(m[1], 16),
      from: (m[2].match(/0x[0-9a-fA-F]+/g) || []).map(x => parseInt(x, 16)),
      to: (m[3].match(/0x[0-9a-fA-F]+/g) || []).map(x => parseInt(x, 16)),
      id: m[4],
    }));
  // len-extend field raises effective len
  const le = pats.find(p => p.off === lenFieldOff);
  if (le) eff = le.to.reduce((a, x) => ((a << 8) | x) >>> 0, 0) >>> 0;
  const payloadEnd = base + eff;
  const on = enabled.has(name);
  if (!pats.length) { console.log('ok   ' + name + (on ? ' [enabled]' : '') + ' no patches'); continue; }

  // ---- Check A: bounds (declared length) ----
  const maxEnd = Math.max(...pats.map(p => p.off + p.to.length));
  if (maxEnd > payloadEnd) {
    if (on) { console.log('FAIL ' + name + ' (ENABLED): patch reaches 0x' + maxEnd.toString(16) + ' past payload end 0x' + payloadEnd.toString(16)); fail = true; }
    else warns.push(name + ': out-of-bounds (0x' + maxEnd.toString(16) + ' > 0x' + payloadEnd.toString(16) + ')');
    continue;
  }

  // ---- Check B: tail (no patch at/into the erased 0xFF tail of the stock image) ----
  if (!fwDir) { console.log('ok   ' + name + (on ? ' [enabled]' : '') + ' bounds 0x' + maxEnd.toString(16) + ' <= 0x' + payloadEnd.toString(16) + ' (tail check skipped)'); continue; }
  const stock = size ? findStock(size, crcOffM ? parseInt(crcOffM[1], 16) : undefined, crcStockM ? parseInt(crcStockM[1], 16) : undefined) : null;
  if (!stock) {
    const msg = name + ': stock bin not found (size 0x' + (size ? size.toString(16) : '?') + ') - cannot verify tail safety';
    if (on) { console.log('FAIL ' + msg); fail = true; }
    else warns.push(msg);
    continue;
  }
  const cEnd = contentEnd(stock);
  const tailHit = pats.filter(p => p.off + p.to.length > cEnd);
  if (tailHit.length) {
    const ids = tailHit.map(p => p.id + '@0x' + p.off.toString(16)).join(', ');
    if (CONFIRMED_TAIL_SAFE.has(name)) {
      console.log('ok   ' + name + (on ? ' [enabled]' : '') + ' tail cave ALLOWED (HW-confirmed whitelist): ' + ids);
    } else if (on) { console.log('FAIL ' + name + ' (ENABLED): patch in the erased 0xFF tail (content ends 0x' + cEnd.toString(16) + '): ' + ids + ' -- cave/trampoline in unprogrammed flash BRICKS. Confirm on recoverable HW and add to CONFIRMED_TAIL_SAFE, or use an in-place patch.'); fail = true; }
    else warns.push(name + ': patch in 0xFF tail (content ends 0x' + cEnd.toString(16) + '): ' + ids);
  } else {
    console.log('ok   ' + name + (on ? ' [enabled]' : '') + ' in-bounds + no tail write (content ends 0x' + cEnd.toString(16) + ')');
  }
}
if (warns.length) {
  console.log('\nDisabled builds to fix before enabling:');
  warns.forEach(w => console.log('  ' + w));
}
console.log(fail ? '\nGUARD FAILED: a build writes past its length or into the erased 0xFF tail (brick class).' : '\nGUARD OK: no enabled build writes past its length or into the 0xFF tail.');
process.exit(fail ? 1 : 0);
