// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Parses NAVEE frames (55 AA flag cmd len err data cksum FE FD) into the telemetry model for toJson(). */
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
    private Integer tailLight, autoLight, drl, logoLight, ambientLight;   // light switches from the 0x70 report (offsets 4/8/24/23/10)
    private Integer packMv, packMa, soh, temp, cycles;
    // EU-spec BMS lifetime block in the 0x72 report (present only when payload length > 15 = europeanRule).
    // RAW unscaled integers - the official display divisor is NOT confirmed (DeviceBatteryInfoActivity.k0 did not decompile).
    private Integer euRule, energyThroughput, capacityThroughput, deepDischarge, selfDischargeRate, ratedCapacity, extremeWeatherChargeTime;
    private Integer genYear, genMonth, genDay, highTempHours, highTempMin;   // generation date + high-temp exposure (confirmed)
    // 0x79 battery-extra report (temperature-/current-state flags)
    private Integer batTempState, batCurrentState;
    // realtime-only fields (0x90/0x91/0x92 push): charging + trip context, not in the 0x70/0x72 reads
    private Integer chargingState, batteryStatus, drivingStatus, tripMile, tripDuration, tripMax, tripAvg;
    private String fwMeter = "", fwBldc = "", fwBms = "", fwScreen = "", fwUwb = "";
    // On-board drive history (0x76): raw per-trip records + report version (mileage ÷10 when version==1).
    private JSONArray driveHistory;
    private Integer driveHistoryVersion;

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
            // Trust the length byte: trailer sits at index 8+len-1.
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
        if (err != 0 && (cmd == 0x70 || cmd == 0x72 || cmd == 0x73 || cmd == 0x74 || cmd == 0x76 || cmd == 0x79)) {
            Log.w(TAG, "cmd 0x" + Integer.toHexString(cmd) + " err " + err);
            return;
        }
        switch (cmd) {
            case 0x70: decodeParams(p); break;
            case 0x72: decodeBattery(p); break;
            case 0x79: decode79(p); break;
            case 0x73: decodeFirmware(p); break;
            case 0x74: decodeSN(p); break;
            case 0x76: decodeDriveHistory(p); break;
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
        tailLight = u8(p, 4);    // tail light (write opcode 0x54)
        autoLight = u8(p, 8);    // auto headlight / light sensor (write opcode 0x57)
        drl = u8(p, 24);         // daytime running light (write opcode 0x6D sub 3)
        logoLight = u8(p, 23);   // logo / lettering light (write opcode 0x6D sub 2)
        ambientLight = u8(p, 10); // ambient / underglow light (write opcode 0x5E)
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
        // EU-spec BMS lifetime fields (BleHandler$4.e case 114): present only when europeanRule (payload > 15).
        // Big-endian reads except the single-byte selfDischargeRate; raw/unscaled (divisor unconfirmed).
        if (p.length > 15) {
            euRule = 1;
            energyThroughput = rd(p, 15, 3, true);       // off15 len3 BE
            capacityThroughput = rd(p, 18, 2, true);     // off18 len2 BE
            deepDischarge = rd(p, 20, 2, true);          // off20 len2 BE
            selfDischargeRate = rd(p, 22, 1, false);     // off22 len1
            ratedCapacity = rd(p, 23, 2, true);          // off23 len2 BE
            Integer gy = rd(p, 25, 1, false);            // generation date: year=2000+p[25], month=p[26], day=p[27]
            if (gy != null) genYear = 2000 + gy;
            genMonth = rd(p, 26, 1, false);
            genDay = rd(p, 27, 1, false);
            Integer yrs = rd(p, 28, 1, false), mos = rd(p, 29, 1, false), dys = rd(p, 30, 1, false), hrs = rd(p, 31, 1, false);
            highTempMin = rd(p, 32, 1, false);           // p[33] is read-and-discarded by the official app
            if (yrs != null && mos != null && dys != null && hrs != null)
                highTempHours = yrs * 8760 + mos * 720 + dys * 24 + hrs;   // official total-hours formula
            extremeWeatherChargeTime = rd(p, 34, 2, true); // off34 len2 BE
        }
    }

    /** 0x79 battery-extra report (BleHandler$4.e case 121): temperature-/current-state flags. Raw values. */
    private void decode79(byte[] p) {
        batTempState = u8(p, 0);       // off0 len1
        batCurrentState = u8(p, 1);    // off1 len1
    }

    private void decodeFirmware(byte[] p) {
        fwMeter = ascii(p, 0, 4);
        fwBldc = ascii(p, 4, 4);
        fwBms = ascii(p, 8, 4);
        fwScreen = ascii(p, 12, 4);
        fwUwb = ascii(p, 16, 4);
    }

    /** Product id parsed from the serial (0x74), e.g. "2345" = ST3 Pro. Empty until the serial arrives. */
    String pid() { return pid; }

    private static final char[] HEXCH = "0123456789abcdef".toCharArray();

    private void decodeSN(byte[] p) {
        StringBuilder sb = new StringBuilder();
        for (byte b : p) { int c = b & 0xFF; if (c >= 0x20 && c < 0x7f) sb.append((char) c); }
        serial = sb.toString().trim();
        if (serial.length() >= 10) region = serial.substring(8, 10);
        Matcher m = Pattern.compile("[A-Za-z]?(\\d{4})").matcher(serial);
        pid = m.find() ? m.group(1) : "";
        // Raw config block (first 17 bytes) as lowercase hex.
        int n = Math.min(17, p.length);
        StringBuilder cr = new StringBuilder(n * 2);
        for (int i = 0; i < n; i++) { int v = p[i] & 0xFF; cr.append(HEXCH[v >> 4]).append(HEXCH[v & 0xF]); }
        configRaw = cr.toString();
    }

    // 0x76 on-board drive history (BleHandler case 118 -> o()): payload = 8-byte records, each four
    // little-endian u16 at off 0/2/4/6 = duration, mileage, avgSpeed, maxSpeed. Records with mileage==0
    // are dropped (1:1 with o()'s `if (iP2 > 0)`). version = 0 when len%8==0, else the trailing marker byte.
    private void decodeDriveHistory(byte[] p) {
        int len = p.length;
        int n = (len % 8 == 0) ? len / 8 : len / 8 + 1;
        JSONArray arr = new JSONArray();
        try {
            for (int i = 0; i < n; i++) {
                int off = i * 8;
                Integer dur = rd(p, off, 2, false), mil = rd(p, off + 2, 2, false);
                Integer avg = rd(p, off + 4, 2, false), max = rd(p, off + 6, 2, false);
                if (mil != null && mil > 0) {
                    JSONObject r = new JSONObject();
                    r.put("duration", (int) dur);
                    r.put("mileage", (int) mil);
                    r.put("avgSpeed", avg == null ? 0 : (int) avg);
                    r.put("maxSpeed", max == null ? 0 : (int) max);
                    arr.put(r);
                }
            }
        } catch (Throwable ignored) {}
        driveHistory = arr;
        driveHistoryVersion = (len % 8 == 0) ? 0 : (p[len - 1] & 0xFF);
    }

    // Realtime push frames (0x90/0x91/0x92), all fields little-endian.
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
            put(o, "tailLight", tailLight); put(o, "autoLight", autoLight); put(o, "drl", drl);
            put(o, "logoLight", logoLight); put(o, "ambientLight", ambientLight);
            put(o, "packMv", packMv); put(o, "packMa", packMa); put(o, "soh", soh);
            put(o, "temp", temp); put(o, "cycles", cycles);
            // EU-spec BMS lifetime block (0x72) + 0x79 extra. Raw/unscaled where noted in decodeBattery.
            put(o, "euRule", euRule);
            put(o, "energyThroughput", energyThroughput); put(o, "capacityThroughput", capacityThroughput);
            put(o, "deepDischarge", deepDischarge); put(o, "selfDischargeRate", selfDischargeRate);
            put(o, "ratedCapacity", ratedCapacity); put(o, "extremeWeatherChargeTime", extremeWeatherChargeTime);
            put(o, "highTempHours", highTempHours); put(o, "highTempMin", highTempMin);
            if (genYear != null && genMonth != null && genDay != null)
                o.put("genDate", String.format(java.util.Locale.ENGLISH, "%04d-%02d-%02d", genYear, genMonth, genDay));
            put(o, "batTempState", batTempState); put(o, "batCurrentState", batCurrentState);
            put(o, "chargingState", chargingState); put(o, "batteryStatus", batteryStatus);
            put(o, "drivingStatus", drivingStatus); put(o, "tripMile", tripMile);
            put(o, "tripDuration", tripDuration); put(o, "tripMax", tripMax); put(o, "tripAvg", tripAvg);
            o.put("fwMeter", fwMeter); o.put("fwBldc", fwBldc); o.put("fwBms", fwBms);
            o.put("fwScreen", fwScreen); o.put("fwUwb", fwUwb);
            // On-board drive history (0x76): raw records; mileage is km (version 0) / deci-km ÷10 (version 1).
            if (driveHistory != null) o.put("driveHistory", driveHistory);
            put(o, "driveHistoryVersion", driveHistoryVersion);
            o.put("rssi", rssi); o.put("btName", btName == null ? "" : btName);
            // Freshness stamp used by the dashboard's isFresh(ts).
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
