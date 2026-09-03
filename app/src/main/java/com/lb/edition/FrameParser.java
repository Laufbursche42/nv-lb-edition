// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.util.Log;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses incoming NAVEE frames and maintains the telemetry model that {@link #toJson()} serialises
 * for the WebView dashboard. NAVEE frames are variable length: 55 AA <flag> <cmd> <len> <errcode>
 * <data...> <cksum> FE FD (factory replies end AE AD). len counts errcode + data; the decoded data
 * block starts at byte[6]. Multi-byte battery/telemetry fields are little-endian.
 */
final class FrameParser {

    private static final String TAG = "lbparse";
    private final SettingsState settings;

    FrameParser(SettingsState s) { this.settings = s; }

    // transport
    int rssi = 0;
    String btName = "";

    // live / status model
    private Integer speed, mode, soc, range, totalMile, fault;
    private String region = "", serial = "", pid = "", configRaw = "";
    private Integer maxSpeed, limitSpeed, limitOn, startSpeed, lock, unit, breakSpeed, driveMode, cruise, tcs, eco;
    private Integer packMv, packMa, soh, temp, cycles;
    // realtime-only fields (0x90/0x91/0x92 push): charging + trip context, not in the 0x70/0x72 reads
    private Integer chargingState, batteryStatus, drivingStatus, tripMile, tripDuration, tripMax, tripAvg;
    private String fwMeter = "", fwBldc = "", fwBms = "", fwScreen = "", fwUwb = "";

    // reassembly buffer
    private final byte[] rx = new byte[1024];
    private int rxLen = 0;

    void onNotify(byte[] chunk) {
        if (chunk == null) return;
        try {
            for (byte b : chunk) { if (rxLen < rx.length) rx[rxLen++] = b; }
            extractFrames();
        } catch (Throwable t) {
            Log.e(TAG, "onNotify failed", t);
            rxLen = 0;
        }
    }

    private void extractFrames() {
        while (true) {
            int start = -1;
            for (int i = 0; i + 1 < rxLen; i++) {
                if ((rx[i] & 0xFF) == 0x55 && (rx[i + 1] & 0xFF) == 0xAA) { start = i; break; }
            }
            if (start < 0) { if (rxLen > 0) { rx[0] = rx[rxLen - 1]; rxLen = 1; } return; }
            // Drop any noise before the start marker so the length below is read at a fixed offset.
            if (start > 0) { System.arraycopy(rx, start, rx, 0, rxLen - start); rxLen -= start; }
            int cmd = (rxLen > 3) ? (rx[3] & 0xFF) : -1;
            int end = -1;
            // Preferred: trust the length byte. Frame = 55 AA <flag> <cmd> <len> <len bytes> <ck> t1 t2,
            // so the trailer sits at index 8+len-1. Jumping there means a payload that happens to contain
            // an FE FD (or AE AD) byte pair can no longer truncate the report - the bug that intermittently
            // nulled the high 0x70 offsets (tcs@11, maxSpeed@25, driveMode@26).
            if (rxLen >= 5) {
                int total = 8 + (rx[4] & 0xFF);
                if (rxLen >= total) {
                    int t1 = rx[total - 2] & 0xFF, t2 = rx[total - 1] & 0xFF;
                    if ((t1 == 0xFE && t2 == 0xFD) || (t1 == 0xAE && t2 == 0xAD && cmd >= 0xA0)) end = total - 1;
                }
            }
            // Fallback: scan for the trailer if the length byte did not line up (corrupt/misaligned).
            if (end < 0) {
                for (int i = 4; i + 1 < rxLen; i++) {
                    int a = rx[i] & 0xFF, b = rx[i + 1] & 0xFF;
                    if (a == 0xFE && b == 0xFD) { end = i + 1; break; }
                    if (a == 0xAE && b == 0xAD && cmd >= 0xA0) { end = i + 1; break; }
                }
            }
            if (end < 0) return;                          // frame not complete yet - wait for more bytes
            byte[] f = Arrays.copyOfRange(rx, 0, end + 1);
            try { dispatch(f); } catch (Throwable t) { Log.e(TAG, "dispatch failed", t); }
            int consumed = end + 1;
            System.arraycopy(rx, consumed, rx, 0, rxLen - consumed);
            rxLen -= consumed;
        }
    }

    private void dispatch(byte[] f) {
        if (f.length < 8) return;
        int cmd = f[3] & 0xFF, len = f[4] & 0xFF, err = f[5] & 0xFF;
        int dataStart = 6, dataLen = Math.max(0, len - 1);
        if (dataStart + dataLen > f.length - 3) dataLen = Math.max(0, f.length - 3 - dataStart);
        byte[] p = Arrays.copyOfRange(f, dataStart, dataStart + dataLen);
        if (err != 0 && (cmd == 0x70 || cmd == 0x72 || cmd == 0x73 || cmd == 0x74)) {
            Log.w(TAG, "cmd 0x" + Integer.toHexString(cmd) + " err " + err);
            return;
        }
        switch (cmd) {
            case 0x70: decodeParams(p); break;
            case 0x72: decodeBattery(p); break;
            case 0x73: decodeFirmware(p); break;
            case 0x74: decodeSN(p); break;
            case 0x90: case 0x91: case 0x92: decodeRealtime(cmd, p); break;
            default: break;
        }
    }

    private static Integer rd(byte[] p, int off, int len, boolean big) {
        if (off < 0 || off + len > p.length) return null;
        long v = 0;
        if (big) { for (int i = 0; i < len; i++) v = (v << 8) | (p[off + i] & 0xFF); }
        else { for (int i = len - 1; i >= 0; i--) v = (v << 8) | (p[off + i] & 0xFF); }
        return (int) v;
    }

    private static Integer u8(byte[] p, int i) { return (i >= 0 && i < p.length) ? (p[i] & 0xFF) : null; }

    private void decodeParams(byte[] p) {
        lock = u8(p, 2);
        unit = u8(p, 7);
        startSpeed = u8(p, 19);
        Integer ls = u8(p, 20);
        if (ls != null) { limitSpeed = ls & 0x7f; limitOn = (ls & 0x80) != 0 ? 1 : 0; }
        maxSpeed = u8(p, 25);
        driveMode = u8(p, 26);
        breakSpeed = u8(p, 35);
        cruise = u8(p, 3);
        tcs = u8(p, 11);   // TCS / traction control (write opcode 0x5F)
        eco = u8(p, 32);   // low-power / eco mode (write opcode 0x6F sub 5)
        if (settings != null) settings.applyReportFrom70(p);
    }

    private void decodeBattery(byte[] p) {
        soc = rd(p, 1, 1, false);
        packMv = rd(p, 2, 4, false);
        Integer c = rd(p, 6, 4, false);
        if (c != null) packMa = ((c & 0x80000000) != 0) ? -(c & 0x7fffffff) : c;
        soh = rd(p, 10, 1, false);
        temp = rd(p, 11, 1, false);
        cycles = rd(p, 13, 2, false);
    }

    private void decodeFirmware(byte[] p) {
        fwMeter = ascii(p, 0, 4);
        fwBldc = ascii(p, 4, 4);
        fwBms = ascii(p, 8, 4);
        fwScreen = ascii(p, 12, 4);
        fwUwb = ascii(p, 16, 4);
    }

    private static final char[] HEXCH = "0123456789abcdef".toCharArray();

    private void decodeSN(byte[] p) {
        StringBuilder sb = new StringBuilder();
        for (byte b : p) { int c = b & 0xFF; if (c >= 0x20 && c < 0x7f) sb.append((char) c); }
        serial = sb.toString().trim();
        if (serial.length() >= 10) region = serial.substring(8, 10);
        Matcher m = Pattern.compile("[A-Za-z]?(\\d{4})").matcher(serial);
        pid = m.find() ? m.group(1) : "";
        // Raw config block (first 17 bytes) as lowercase hex, for the NT5 region read-modify-write:
        // the region letters live at bytes 8-9 and are rewritten via the factory 0xA2 config write.
        int n = Math.min(17, p.length);
        StringBuilder cr = new StringBuilder(n * 2);
        for (int i = 0; i < n; i++) { int v = p[i] & 0xFF; cr.append(HEXCH[v >> 4]).append(HEXCH[v & 0xF]); }
        configRaw = cr.toString();
    }

    // Realtime push frames. Offsets verified against the manufacturer app BleHandler (cases 144/145/146)
    // and DeviceHomePageInfo / DeviceSubPageInfo. All fields little-endian. These frames carry the
    // fast-changing values live; the slow ones (SOH, cycles, temperature, cruise, drive mode, limits)
    // only come from the polled 0x70/0x72 reads.
    private void decodeRealtime(int cmd, byte[] p) {
        if (cmd == 0x90) {                                   // homepage report
            fault = rd(p, 0, 1, false);                      // warning code, raw BCD byte (decoded to the shared table in the UI)
            mode = rd(p, 1, 1, false);                       // drive mode (display)
            Integer s = rd(p, 2, 1, false); if (s != null) soc = s;          // battery charge
            batteryStatus = rd(p, 3, 1, false);
            chargingState = rd(p, 4, 1, false);
            Integer r = rd(p, 6, 1, false); if (r != null) range = r;        // remaining range
            Integer lk = rd(p, 7, 1, false);                 // lock status is byte7 - 1 when byte7 > 0
            if (lk != null && lk > 0) lock = lk - 1;
            if (p.length >= 16) {
                Integer mv = rd(p, 8, 4, false); if (mv != null && mv > 0) packMv = mv;
                Integer ma = rd(p, 12, 4, false);            // sign in bit 31, same as the 0x72 block
                if (ma != null && ma != 0) packMa = ((ma & 0x80000000) != 0) ? -(ma & 0x7fffffff) : ma;
            }
        } else if (cmd == 0x91) {                            // ride report v0 (whole units)
            drivingStatus = rd(p, 1, 1, false);
            Integer sp = rd(p, 2, 1, false); if (sp != null) speed = sp;
            Integer r = rd(p, 3, 1, false); if (r != null) range = r;
            tripMile = rd(p, 4, 1, false);
            Integer tot = rd(p, 8, 1, false); if (tot != null) totalMile = tot;
        } else if (cmd == 0x92) {                            // ride report v1 (deci-units, /10)
            Integer s = rd(p, 0, 1, false); if (s != null) soc = s;
            drivingStatus = rd(p, 1, 1, false);
            Integer sp = rd(p, 2, 2, false); if (sp != null) speed = sp / 10;
            Integer r = rd(p, 4, 1, false); if (r != null) range = r;
            Integer td = rd(p, 5, 2, false); if (td != null) tripMile = td / 10;
            tripDuration = rd(p, 7, 1, false);               // minutes, not scaled
            Integer mx = rd(p, 8, 2, false); if (mx != null) tripMax = mx / 10;
            Integer av = rd(p, 10, 2, false); if (av != null) tripAvg = av / 10;
            Integer tot = rd(p, 12, 2, false); if (tot != null) totalMile = tot / 10;
            if (p.length >= 18) { Integer t4 = rd(p, 14, 4, false); if (t4 != null && t4 > 0) totalMile = t4 / 10; }
        }
    }

    private static String ascii(byte[] p, int off, int len) {
        if (off + len > p.length) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = off; i < off + len; i++) { int c = p[i] & 0xFF; sb.append((c >= 0x20 && c < 0x7f) ? (char) c : '.'); }
        return sb.toString();
    }

    String toJson() {
        try {
            JSONObject o = new JSONObject();
            put(o, "speed", speed); put(o, "mode", mode); put(o, "driveMode", driveMode);
            put(o, "soc", soc); put(o, "range", range); put(o, "totalMile", totalMile); put(o, "fault", fault);
            o.put("region", region); o.put("serial", serial); o.put("pid", pid);
            o.put("configRaw", configRaw);
            put(o, "maxSpeed", maxSpeed); put(o, "limitSpeed", limitSpeed); put(o, "limitOn", limitOn);
            put(o, "startSpeed", startSpeed); put(o, "lock", lock); put(o, "unit", unit);
            put(o, "breakSpeed", breakSpeed); put(o, "cruise", cruise); put(o, "tcs", tcs); put(o, "eco", eco);
            put(o, "packMv", packMv); put(o, "packMa", packMa); put(o, "soh", soh);
            put(o, "temp", temp); put(o, "cycles", cycles);
            put(o, "chargingState", chargingState); put(o, "batteryStatus", batteryStatus);
            put(o, "drivingStatus", drivingStatus); put(o, "tripMile", tripMile);
            put(o, "tripDuration", tripDuration); put(o, "tripMax", tripMax); put(o, "tripAvg", tripAvg);
            o.put("fwMeter", fwMeter); o.put("fwBldc", fwBldc); o.put("fwBms", fwBms);
            o.put("fwScreen", fwScreen); o.put("fwUwb", fwUwb);
            o.put("rssi", rssi); o.put("btName", btName == null ? "" : btName);
            // Freshness stamp: the dashboard's parseBLE() treats a snapshot without a numeric ts as
            // invalid and isFresh(ts) drives the connected/disconnected UI, so every push carries one.
            o.put("ts", System.currentTimeMillis());
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    private static void put(JSONObject o, String k, Integer v) {
        try { if (v != null) o.put(k, (int) v); } catch (Throwable ignored) {}
    }
}
