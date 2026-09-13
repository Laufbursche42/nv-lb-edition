// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.util.Log;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * NAVEE 0x30/0x31 connection (session) auth, matching the OEM app's two-round handshake. A bound
 * scooter closes the link a few seconds after connect unless the central completes this exactly.
 * Key table mirrors NaveeDfuEngine (keep in sync). The state transitions live in BleManager.
 */
final class NaveeAuth {

    private static final String TAG = "lbauth";

    static final byte[][] KEYS = {
        {(byte)0xA0,(byte)0xA1,(byte)0xA2,(byte)0xA3,(byte)0xA4,(byte)0xA5,(byte)0xA6,(byte)0xA7,
         (byte)0xA8,(byte)0xA9,(byte)0xAA,(byte)0xAB,(byte)0xAC,(byte)0xAD,(byte)0xAE,(byte)0xAF},
        {(byte)0x44,(byte)0x6D,(byte)0x10,(byte)0x72,(byte)0x6D,(byte)0xBE,(byte)0x05,(byte)0xF6,
         (byte)0x62,(byte)0xDF,(byte)0xAA,(byte)0xF0,(byte)0x13,(byte)0x27,(byte)0x30,(byte)0x3F},
        {(byte)0xA2,(byte)0x85,(byte)0xCC,(byte)0xEC,(byte)0x81,(byte)0x4F,(byte)0xE9,(byte)0x61,
         (byte)0x74,(byte)0x29,(byte)0x95,(byte)0xE8,(byte)0xEB,(byte)0xA9,(byte)0x22,(byte)0x47},
        {(byte)0x3F,(byte)0xEE,(byte)0x80,(byte)0xFF,(byte)0x96,(byte)0xDF,(byte)0x5C,(byte)0xF5,
         (byte)0x42,(byte)0xEA,(byte)0xAC,(byte)0x93,(byte)0x28,(byte)0x1F,(byte)0xE5,(byte)0x29},
        {(byte)0x4E,(byte)0xB4,(byte)0xD4,(byte)0x64,(byte)0xD6,(byte)0xEF,(byte)0x53,(byte)0xED,
         (byte)0x6C,(byte)0xE9,(byte)0x45,(byte)0x58,(byte)0xDE,(byte)0x9A,(byte)0x5E,(byte)0xE3},
    };
    static final int KEY_IDX = 1;

    private NaveeAuth() {}

    /** 0x30 auth-init payload: [keyIdx, shareFlag, s(userId) x6, 0]. shareFlag mirrors the OEM (1 with an id). */
    static byte[] authInitPayload(long userId) {
        byte[] s = s6(userId);
        byte[] p = new byte[9];
        p[0] = (byte) KEY_IDX;
        p[1] = (byte) (userId > 0 ? 1 : 0);
        System.arraycopy(s, 0, p, 2, 6);
        p[8] = 0x00;
        return p;
    }

    /** Lower 48 bits of the account id, big-endian; first byte forced non-zero and < 0x80 (OEM ByteUtil.s). */
    private static byte[] s6(long userId) {
        if (userId <= 0) userId = (long) (Math.random() * 1_000_000_000L) + 1;
        long v = userId & 0xFFFFFFFFFFFFL;
        byte[] b = new byte[6];
        for (int i = 5; i >= 0; i--) { b[i] = (byte) (v & 0xFF); v >>= 8; }
        if ((b[0] & 0xFF) == 0 || (b[0] & 0xFF) >= 0x80) b[0] = (byte) 0x88;
        return b;
    }

    static byte[] aesEcb(byte[] key16, byte[] block16) {
        try {
            Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key16, "AES"));
            return c.doFinal(block16);
        } catch (Throwable t) {
            Log.e(TAG, "aesEcb failed", t);
            return null;
        }
    }

    private static byte[] xor16(byte[] a, byte[] key) {
        byte[] out = new byte[16];
        for (int i = 0; i < 16; i++) out[i] = (byte) ((a[i] & 0xFF) ^ (key[i] & 0xFF));
        return out;
    }

    enum Kind { CHALLENGE, COMPLETE, REJECTED, NONE }

    static final class R30 {
        final Kind kind;
        final byte[] response;   // 0x31 payload when CHALLENGE
        R30(Kind k, byte[] r) { kind = k; response = r; }
    }

    /**
     * Parse a 0x30 reply. OEM logic: errcode != 0 -> rejected; payload length 1 (errcode only) -> the
     * final reply, auth complete; longer -> a challenge. For length > 17 the first data byte selects
     * the transform (0 = XOR, else AES) over the following 16 bytes; length 17 is a bare 16-byte AES
     * challenge with no mode byte.
     */
    static R30 parse30(byte[] buf, int len) {
        int i = findFrame(buf, len, 0x30);
        if (i < 0) return new R30(Kind.NONE, null);
        int flen = buf[i + 4] & 0xFF;
        int err = buf[i + 5] & 0xFF;
        if (err != 0) return new R30(Kind.REJECTED, null);
        if (flen <= 1) return new R30(Kind.COMPLETE, null);
        int dataStart = i + 6;
        byte[] body = new byte[16];
        boolean useXor;
        if (flen > 17) {
            int mode = buf[dataStart] & 0xFF;
            if (dataStart + 1 + 16 > len) return new R30(Kind.NONE, null);
            System.arraycopy(buf, dataStart + 1, body, 0, 16);
            useXor = (mode == 0);
        } else {
            if (flen - 1 < 16 || dataStart + 16 > len) return new R30(Kind.NONE, null);
            System.arraycopy(buf, dataStart, body, 0, 16);
            useXor = false;
        }
        byte[] resp = useXor ? xor16(body, KEYS[KEY_IDX]) : aesEcb(KEYS[KEY_IDX], body);
        if (resp == null) return new R30(Kind.NONE, null);
        return new R30(Kind.CHALLENGE, resp);
    }

    /** Parse a 0x31 reply: TRUE if errcode 0 (send the next 0x30), FALSE if rejected, null if not present. */
    static Boolean parse31(byte[] buf, int len) {
        int i = findFrame(buf, len, 0x31);
        if (i < 0) return null;
        return (buf[i + 5] & 0xFF) == 0;
    }

    private static int findFrame(byte[] buf, int len, int cmd) {
        for (int i = 0; i + 8 <= len; i++) {
            if ((buf[i] & 0xFF) != 0x55 || (buf[i + 1] & 0xFF) != 0xAA) continue;
            if ((buf[i + 3] & 0xFF) != cmd) continue;
            int total = 8 + (buf[i + 4] & 0xFF);
            if (i + total > len) return -1;
            if ((buf[i + total - 2] & 0xFF) == 0xFE && (buf[i + total - 1] & 0xFF) == 0xFD) return i;
        }
        return -1;
    }
}
