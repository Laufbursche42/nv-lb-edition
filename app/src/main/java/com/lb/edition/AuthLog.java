// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PushbackInputStream;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Recovers the account userId from an Android Bluetooth HCI snoop log (raw btsnoop, a .gz, or a bug
 * report .zip). It finds the OEM app's 0x30 auth-init frame and reads the numeric account id out of
 * it. Fully local: nothing is uploaded. Mirrors the extractor in the navee-unlock web tool.
 *
 * The scan streams the input through a small sliding window and keeps only the last valid frame, so
 * memory stays flat no matter how large the picked log is. A real btsnoop_hci.log grows without
 * bound on the phone (tens to hundreds of MB); reading it whole into the heap used to OOM the app.
 */
final class AuthLog {

    private static final String TAG = "lbauthlog";

    // Read window: CHUNK bytes of fresh data per pass, plus CARRY bytes carried over so a frame that
    // straddles two passes is still seen. A 0x30 frame is at most 8 + 255 = 263 bytes, so CARRY (512)
    // comfortably covers any frame split across the boundary.
    private static final int CHUNK = 64 * 1024;
    private static final int CARRY = 512;
    private static final int MAX_DEPTH = 4;   // guard against pathologically nested archives

    private AuthLog() {}

    /** @return the account userId found in the log, or 0 if none. */
    static long extractUserId(InputStream in) {
        if (in == null) return 0;
        // Wrap once so inner archive/decompression wrappers can be closed without closing the
        // caller-owned stream (the caller closes it).
        try {
            byte[] frame = findFrame(new NonClosing(in), 0);
            return frame == null ? 0 : userIdFromFrame(frame);
        } catch (Throwable t) {
            Log.e(TAG, "auth log scan failed", t);
            return 0;
        }
    }

    /** Convenience overload for an already in-memory buffer (e.g. tests). */
    static long extractUserId(byte[] raw) {
        if (raw == null) return 0;
        return extractUserId(new ByteArrayInputStream(raw));
    }

    /**
     * Routes by magic bytes: raw btsnoop is stream-scanned directly; gzip is inflated on the fly; a
     * zip / Android bug report is walked entry by entry (each entry itself may be gzip). Returns the
     * last valid 0x30 frame found anywhere in the input (the most recent connect).
     */
    private static byte[] findFrame(InputStream src, int depth) throws IOException {
        if (depth > MAX_DEPTH) return null;
        try (PushbackInputStream pin = new PushbackInputStream(new BufferedInputStream(src, CHUNK), 2)) {
            int b0 = pin.read();
            if (b0 < 0) return null;
            int b1 = pin.read();
            if (b1 >= 0) pin.unread(b1);
            pin.unread(b0);
            boolean gzip = (b0 & 0xFF) == 0x1f && (b1 & 0xFF) == 0x8b;
            boolean zip = (b0 & 0xFF) == 0x50 && (b1 & 0xFF) == 0x4b;
            if (gzip) {
                try (GZIPInputStream g = new GZIPInputStream(pin)) {
                    return scanStream(g);
                }
            }
            if (zip) {
                byte[] best = null;
                try (ZipInputStream zin = new ZipInputStream(pin)) {
                    while (zin.getNextEntry() != null) {
                        byte[] hit = findFrame(new NonClosing(zin), depth + 1);
                        if (hit != null) best = hit;   // keep the last valid frame (most recent connect)
                    }
                }
                return best;
            }
            return scanStream(pin);
        }
    }

    /** Sliding-window scan of a raw byte stream; returns the last valid 0x30 frame, or null. */
    private static byte[] scanStream(InputStream in) throws IOException {
        byte[] buf = new byte[CARRY + CHUNK];
        int carry = 0;
        byte[] best = null;
        int n;
        while ((n = fill(in, buf, carry, CHUNK)) > 0) {
            int filled = carry + n;
            byte[] hit = scanAuthFrame(buf, filled);
            if (hit != null) best = hit;
            if (filled > CARRY) {
                // keep the trailing CARRY bytes so a frame crossing this boundary completes next pass
                System.arraycopy(buf, filled - CARRY, buf, 0, CARRY);
                carry = CARRY;
            } else {
                carry = filled;
            }
        }
        return best;
    }

    /** Read up to max bytes into buf at off, looping until the window is full or the stream ends. */
    private static int fill(InputStream in, byte[] buf, int off, int max) throws IOException {
        int total = 0;
        while (total < max) {
            int r = in.read(buf, off + total, max - total);
            if (r < 0) break;
            total += r;
        }
        return total;
    }

    /** Last valid 55 AA 00 30 <len> <payload> <cksum> FE FD frame in buf[0..filled). */
    private static byte[] scanAuthFrame(byte[] b, int filled) {
        byte[] found = null;
        for (int i = 0; i + 8 < filled; i++) {
            if ((b[i] & 0xFF) != 0x55 || (b[i + 1] & 0xFF) != 0xAA
                    || (b[i + 2] & 0xFF) != 0x00 || (b[i + 3] & 0xFF) != 0x30) continue;
            int len = b[i + 4] & 0xFF;
            // The account-id 0x30 frame carries a >=9-byte payload; shorter valid 0x30 frames
            // (e.g. len 1) must not overwrite it. Mirror userIdFromFrame's minimum.
            if (len < 9) continue;
            int total = len + 8;
            if (i + total > filled) continue;
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

    /** Filter stream whose close() does not propagate, so a shared parent (e.g. a ZipInputStream
     *  being walked) stays open while a wrapper around one entry is closed. */
    private static final class NonClosing extends FilterInputStream {
        NonClosing(InputStream in) { super(in); }
        @Override public void close() { /* keep the shared parent stream open */ }
    }
}
