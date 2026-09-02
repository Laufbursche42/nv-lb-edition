// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import java.util.TimeZone;

/**
 * Builds outgoing NAVEE frames.
 *   Read : 55 AA 00 <cmd> <cksum> FE FD                       (no length byte)
 *   Write: 55 AA 00 <cmd> <len> <payload...> <cksum> FE FD    (len counts payload only)
 *   Factory: same as write but the trailer is AE AD instead of FE FD (0xA0/0xA2/0xB9/0xBE).
 * cksum = (sum of every byte from 0x55 through the last payload byte) & 0xFF.
 */
final class CommandBuilder {

    private CommandBuilder() {}

    private static int ckSum(byte[] a, int len) {
        int s = 0;
        for (int i = 0; i < len; i++) s = (s + (a[i] & 0xFF)) & 0xFF;
        return s;
    }

    /** Read frame: 55 AA 00 <cmd> <ck> FE FD. */
    static byte[] read(int cmd) {
        byte[] body = {(byte) 0x55, (byte) 0xAA, 0x00, (byte) cmd};
        return finish(body, false);
    }

    /** Write frame: 55 AA 00 <cmd> <len> <payload...> <ck> FE FD. */
    static byte[] write(int cmd, byte[] payload) {
        if (payload == null) payload = new byte[0];
        byte[] body = new byte[5 + payload.length];
        body[0] = (byte) 0x55; body[1] = (byte) 0xAA; body[2] = 0x00;
        body[3] = (byte) cmd; body[4] = (byte) payload.length;
        System.arraycopy(payload, 0, body, 5, payload.length);
        return finish(body, false);
    }

    /** Factory frame (AE AD trailer). */
    static byte[] factory(int cmd, byte[] payload) {
        if (payload == null) payload = new byte[0];
        byte[] body = new byte[5 + payload.length];
        body[0] = (byte) 0x55; body[1] = (byte) 0xAA; body[2] = 0x00;
        body[3] = (byte) cmd; body[4] = (byte) payload.length;
        System.arraycopy(payload, 0, body, 5, payload.length);
        return finish(body, true);
    }

    private static byte[] finish(byte[] body, boolean factory) {
        int ck = ckSum(body, body.length);
        byte[] out = new byte[body.length + 3];
        System.arraycopy(body, 0, out, 0, body.length);
        out[body.length] = (byte) ck;
        out[body.length + 1] = (byte) (factory ? 0xAE : 0xFE);
        out[body.length + 2] = (byte) (factory ? 0xAD : 0xFD);
        return out;
    }

    /** Time sync: 0x6F sub 6 + local epoch seconds (UTC + tz offset), big-endian 4 bytes. */
    static byte[] timeSync() {
        long now = System.currentTimeMillis();
        long offSec = TimeZone.getDefault().getOffset(now) / 1000L;   // seconds ahead of UTC
        long local = now / 1000L + offSec;
        return write(0x6F, new byte[]{
                0x06,
                (byte) (local >>> 24), (byte) (local >>> 16), (byte) (local >>> 8), (byte) local});
    }

    // Parse a "55 AA 00 30 ..." style hex string (e.g. a captured auth frame) into raw bytes, or null.
    static byte[] parseHex(String s) {
        if (s == null) return null;
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) clean.append(c);
        }
        if (clean.length() < 8 || (clean.length() % 2) != 0) return null;
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
