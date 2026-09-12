// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Recovers the account userId from an Android Bluetooth HCI snoop log (raw btsnoop, a .gz, or a bug
 * report .zip). It finds the OEM app's 0x30 auth-init frame and reads the numeric account id out of
 * it. Fully local: nothing is uploaded. Mirrors the extractor in the navee-unlock web tool.
 */
final class AuthLog {

    private static final String TAG = "lbauthlog";

    private AuthLog() {}

    /** @return the account userId found in the log, or 0 if none. */
    static long extractUserId(byte[] raw) {
        byte[] frame = findFrame(raw);
        if (frame == null) return 0;
        return userIdFromFrame(frame);
    }

    private static byte[] findFrame(byte[] raw) {
        if (raw == null || raw.length < 8) return null;
        byte[] f = scanAuthFrame(raw);
        if (f != null) return f;
        // gzip (magic 1f 8b)
        if ((raw[0] & 0xFF) == 0x1f && (raw[1] & 0xFF) == 0x8b) {
            byte[] g = gunzip(raw);
            if (g != null) { f = scanAuthFrame(g); if (f != null) return f; }
        }
        // zip / Android bug report (magic 50 4b)
        if ((raw[0] & 0xFF) == 0x50 && (raw[1] & 0xFF) == 0x4b) {
            byte[] best = null;
            try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(raw))) {
                ZipEntry e;
                while ((e = zin.getNextEntry()) != null) {
                    byte[] data = readAll(zin);
                    if (data == null) continue;
                    byte[] hit = scanAuthFrame(data);
                    if (hit == null && data.length > 1 && (data[0] & 0xFF) == 0x1f && (data[1] & 0xFF) == 0x8b) {
                        byte[] g = gunzip(data);
                        if (g != null) hit = scanAuthFrame(g);
                    }
                    if (hit != null) best = hit;   // keep the last valid frame (most recent connect)
                }
            } catch (Throwable t) {
                Log.e(TAG, "zip scan failed", t);
            }
            if (best != null) return best;
        }
        return null;
    }

    /** Last valid 55 AA 00 30 <len> <payload> <cksum> FE FD frame in the buffer. */
    private static byte[] scanAuthFrame(byte[] b) {
        byte[] found = null;
        for (int i = 0; i + 8 < b.length; i++) {
            if ((b[i] & 0xFF) != 0x55 || (b[i + 1] & 0xFF) != 0xAA
                    || (b[i + 2] & 0xFF) != 0x00 || (b[i + 3] & 0xFF) != 0x30) continue;
            int len = b[i + 4] & 0xFF;
            int total = len + 8;
            if (i + total > b.length) continue;
            if ((b[i + 6 + len] & 0xFF) != 0xFE || (b[i + 7 + len] & 0xFF) != 0xFD) continue;
            int s = 0;
            for (int k = i; k <= i + 4 + len; k++) s = (s + (b[k] & 0xFF)) & 0xFF;
            if (s != (b[i + 5 + len] & 0xFF)) continue;
            found = new byte[total];
            System.arraycopy(b, i, found, 0, total);
        }
        return found;
    }

    /**
     * userId from a 0x30 frame. Payload = [keyIdx, shareFlag, s0..s5, 0x00]; s0..s5 is the 48-bit id
     * big-endian with s0 masked. A real account id is 32-bit, so it sits in s2..s5 (frame[9..12]).
     */
    private static long userIdFromFrame(byte[] frame) {
        int len = frame[4] & 0xFF;
        if (len < 9 || frame.length < 13) return 0;
        long id = ((long) (frame[9] & 0xFF) << 24)
                | ((long) (frame[10] & 0xFF) << 16)
                | ((long) (frame[11] & 0xFF) << 8)
                | (frame[12] & 0xFF);
        return id;
    }

    private static byte[] gunzip(byte[] in) {
        try (GZIPInputStream g = new GZIPInputStream(new ByteArrayInputStream(in))) {
            return readAll(g);
        } catch (Throwable t) {
            return null;
        }
    }

    private static byte[] readAll(java.io.InputStream in) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }
}
