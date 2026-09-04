// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * NAVEE XMODEM-128 firmware flash over the normal control GATT (service d0ff, write b002,
 * notify b003). Text handshake (dfu_start / ble_rand / ble_key), then 128-byte XMODEM blocks
 * with a CRC-16/XMODEM per block, EOT and the rsq result token.
 *
 * The engine runs entirely on the main looper: {@link #onNotify} re-posts there, so no locking.
 * Every b003 notification is routed here by {@link BleManager} while a flash is running.
 */
final class NaveeDfuEngine {

    private static final String TAG = "lbdfu";

    /** BLE + UI callbacks, implemented by {@link BleManager}. Every call runs on the main looper. */
    interface Host {
        boolean write(byte[] frame);
        void setHighPriority(boolean high);
        void progress(int percent, int block, int count, String phase);
        void log(String line);
        void state(String state, String message);
        void finished(boolean success);
    }

    // XMODEM control bytes.
    private static final int SOH = 0x01, EOT = 0x04, ACK = 0x06, NAK = 0x15, CAN = 0x18;
    private static final int CRCREQ = 0x43;   // 'C'
    private static final int PAD = 0x1A;      // last-block padding
    private static final int BLOCK = 128;

    // Timeouts / budgets.
    private static final long AUTH_SETTLE_MS = 1500;
    private static final long STEP_TIMEOUT_MS = 3000;
    private static final long ENTER_TIMEOUT_MS = 60000;   // wait for 'C' (OEM waits effectively unbounded)
    private static final long FINISH_TIMEOUT_MS = 3000;   // OEM watchdog B
    private static final int BLOCK_RETRIES = 10;
    private static final int EOT_RETRIES = 5;
    // OEM resends each enter command on a repeating timer until the reply arrives.
    private static final int DFU_START_TICKS = 11;   // ~33 s
    private static final int BLE_RAND_TICKS = 6;     // ~18 s
    private static final int BLE_KEY_TICKS = 6;      // ~18 s

    // b002 accepts one 133-byte block per write at the negotiated MTU (148).
    // Connection-auth key table (b003 XOR gate uses the entry at keyIdx).
    private static final byte[][] KEYS = {
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
    private static final int KEY_IDX = 1;

    private enum St { IDLE, AUTH, DFU_START, BLE_RAND, WAIT_C, XMODEM, EOT, FINISH, DONE, FAILED }

    private final Host host;
    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile boolean running = false;
    private St state = St.IDLE;

    private byte[] image;
    private int target;        // dfu_start component number (1 = meter, 2 = bldc)
    private long userId;

    // text/frame reassembly for the handshake states
    private final byte[] rx = new byte[512];
    private int rxLen = 0;

    // xmodem cursor
    private int blockCount, blockIndex, seq, blockRetries, eotTries;

    // handshake resend
    private int enterTicks;
    private byte[] bleKeyFrame;

    private Runnable timeout;

    NaveeDfuEngine(Host host) { this.host = host; }

    boolean isRunning() { return running; }

    /** Begin a flash. target: 1 = meter, 2 = bldc. userId <= 0 selects a random id for the 0x30 init. */
    void start(final byte[] img, final int targetN, final long uid) {
        main.post(() -> {
            if (running) return;
            if (img == null || img.length < BLOCK) { fail("empty firmware image"); return; }
            running = true;
            image = img;
            target = targetN;
            userId = uid;
            blockCount = (image.length + BLOCK - 1) / BLOCK;
            blockIndex = 0;
            seq = 1;
            blockRetries = 0;
            eotTries = 0;
            host.setHighPriority(true);
            host.state("running", null);
            host.progress(0, 0, blockCount, "prepare");
            host.log("image " + image.length + " bytes, " + blockCount + " blocks, target " + target);
            beginAuth();
        });
    }

    void cancel() {
        main.post(() -> {
            if (!running) return;
            host.log("cancel");
            try { host.write(new byte[]{ (byte)CAN,(byte)CAN,(byte)CAN,(byte)CAN,(byte)CAN,
                    (byte)CAN,(byte)CAN,(byte)CAN,(byte)CAN,(byte)CAN }); } catch (Throwable ignored) {}
            finish(false, "cancelled", "cancelled");
        });
    }

    /** Every b003 notification while a flash runs. Re-posted to the main looper. */
    void onNotify(final byte[] value) {
        if (value == null || value.length == 0) return;
        final byte[] v = value.clone();
        main.post(() -> {
            if (!running) return;
            try { handleNotify(v); }
            catch (Throwable t) { Log.e(TAG, "notify handling failed", t); fail("internal error: " + t); }
        });
    }

    // ── handshake ──

    private void beginAuth() {
        state = St.AUTH;
        host.progress(0, 0, blockCount, "enter");
        host.log("auth init (key " + KEY_IDX + ")");
        host.write(CommandBuilder.write(0x30, authInitPayload(KEY_IDX, userId)));
        arm(AUTH_SETTLE_MS, this::beginDfuStart);
    }

    private void beginDfuStart() {
        state = St.DFU_START;
        rxLen = 0;
        enterTicks = DFU_START_TICKS;
        resendDfuStart();
    }
    private void resendDfuStart() {
        host.log("-> down dfu_start " + target);
        host.write(ascii("down dfu_start " + target + "\r"));
        if (--enterTicks <= 0) arm(STEP_TIMEOUT_MS, () -> fail("no reply to dfu_start"));
        else arm(STEP_TIMEOUT_MS, this::resendDfuStart);
    }

    private void beginBleRand() {
        state = St.BLE_RAND;
        rxLen = 0;
        enterTicks = BLE_RAND_TICKS;
        resendBleRand();
    }
    private void resendBleRand() {
        host.log("-> down ble_rand");
        host.write(ascii("down ble_rand\r"));
        if (--enterTicks <= 0) arm(STEP_TIMEOUT_MS, () -> fail("no reply to ble_rand"));
        else arm(STEP_TIMEOUT_MS, this::resendBleRand);
    }

    private void sendBleKey(int mode, byte[] rand16) {
        byte[] resp = transform(mode, rand16, KEYS[KEY_IDX]);
        if (resp == null) { fail("ble_key transform failed"); return; }
        byte[] prefix = ascii("down ble_key ");
        byte[] frame = new byte[prefix.length + 16 + 1];
        System.arraycopy(prefix, 0, frame, 0, prefix.length);
        System.arraycopy(resp, 0, frame, prefix.length, 16);
        frame[frame.length - 1] = 0x0d;
        bleKeyFrame = frame;
        state = St.WAIT_C;
        rxLen = 0;
        enterTicks = BLE_KEY_TICKS;
        host.log("-> down ble_key (mode " + mode + ")");
        resendBleKey();
    }
    private void resendBleKey() {
        host.write(bleKeyFrame);
        // resend ble_key each tick, then wait long for 'C' (OEM effectively waits unbounded).
        if (--enterTicks <= 0) arm(ENTER_TIMEOUT_MS, () -> fail("scooter did not enter DFU (no C)"));
        else arm(STEP_TIMEOUT_MS, this::resendBleKey);
    }

    private void handleNotify(byte[] v) {
        switch (state) {
            case AUTH:        onAuthNotify(v); break;
            case DFU_START:   append(v); if (contains(rx, rxLen, new byte[]{0x6f,0x6b,0x0d})) { clearTimeout(); beginBleRand(); } break;
            case BLE_RAND:    append(v); tryBleRand(); break;
            case WAIT_C:
                if (hasByte(v, CRCREQ)) { clearTimeout(); host.log("C received"); beginXmodem(); }
                else { append(v); if (contains(rx, rxLen, new byte[]{0x6f,0x6b,0x0d})) { clearTimeout(); rxLen = 0; host.log("ble_key ok - waiting for C"); arm(ENTER_TIMEOUT_MS, () -> fail("scooter did not enter DFU (no C)")); } }
                break;
            case XMODEM:      onXmodemNotify(v); break;
            case EOT:
                append(v);
                // The real scooter does not always send a 0x06 EOT-ACK - it may send the result token
                // straight away. Accept rsq dfu_ok/dfu_error here too, not only 0x06.
                if (contains(rx, rxLen, ascii("dfu_error"))) { clearTimeout(); fail("scooter reported dfu_error"); }
                else if (contains(rx, rxLen, ascii("dfu_ok"))) { clearTimeout(); succeed("done"); }
                else if (hasByte(v, ACK)) { clearTimeout(); beginFinish(); }
                break;
            case FINISH:      onFinishNotify(v); break;
            default: break;
        }
    }

    // 0x30 connection-auth challenge: answer with 0x31 so the meter records keyIdx / completes auth.
    private void onAuthNotify(byte[] v) {
        append(v);
        int i = findFrame(rx, rxLen, 0x30);
        if (i < 0) return;
        int len = rx[i + 4] & 0xFF;
        // errcode 0xFF: a bound scooter rejected the random id. The DFU gate is the ble_key challenge,
        // not this auth, so log and continue to dfu_start instead of aborting - flashes without a userId.
        if ((rx[i + 5] & 0xFF) == 0xFF) { rxLen = 0; host.log("0x30 rejected (bound) - continuing to DFU"); return; }
        int dataStart = i + 6, dataLen = len - 1;
        if (dataLen >= 16 && dataStart + dataLen <= rxLen) {
            byte[] challenge = new byte[16];
            System.arraycopy(rx, dataStart + dataLen - 16, challenge, 0, 16);
            byte[] resp = aesEcb(KEYS[KEY_IDX], challenge);
            if (resp != null) { host.log("auth challenge -> 0x31"); host.write(CommandBuilder.write(0x31, resp)); }
        }
        rxLen = 0;
    }

    private void tryBleRand() {
        // frame: 6f 6b 20 <mode> <16 rand> 0d
        for (int i = 0; i + 20 < rxLen; i++) {
            if ((rx[i] & 0xFF) == 0x6f && (rx[i + 1] & 0xFF) == 0x6b && (rx[i + 2] & 0xFF) == 0x20) {
                if (i + 21 > rxLen) return;   // wait for the rest
                int mode = rx[i + 3] & 0xFF;
                byte[] rand16 = new byte[16];
                System.arraycopy(rx, i + 4, rand16, 0, 16);
                clearTimeout();
                sendBleKey(mode, rand16);
                return;
            }
        }
    }

    // ── xmodem ──

    private void beginXmodem() {
        state = St.XMODEM;
        blockIndex = 0;
        seq = 1;
        blockRetries = 0;
        host.progress(0, 0, blockCount, "flash");
        sendBlock();
    }

    private void sendBlock() {
        byte[] data = new byte[BLOCK];
        int off = blockIndex * BLOCK;
        int n = Math.min(BLOCK, image.length - off);
        System.arraycopy(image, off, data, 0, n);
        for (int i = n; i < BLOCK; i++) data[i] = (byte) PAD;

        int crc = crc16Xmodem(data, 0, BLOCK);
        byte[] frame = new byte[3 + BLOCK + 2];
        frame[0] = (byte) SOH;
        frame[1] = (byte) (seq & 0xFF);
        frame[2] = (byte) (~seq & 0xFF);
        System.arraycopy(data, 0, frame, 3, BLOCK);
        frame[3 + BLOCK] = (byte) ((crc >> 8) & 0xFF);
        frame[3 + BLOCK + 1] = (byte) (crc & 0xFF);

        host.write(frame);
        arm(STEP_TIMEOUT_MS, this::onBlockTimeout);
    }

    private void onXmodemNotify(byte[] v) {
        for (int i = 0; i < v.length; i++) {
            int c = v[i] & 0xFF;
            if (c == NAK) { clearTimeout(); host.log("block " + seq + " NAK"); resendBlock(); return; }
            if (c == CAN) { clearTimeout(); fail("scooter aborted (CAN)"); return; }
            if (c == ACK) {
                clearTimeout();
                // ACK is [06 blk]: the block byte must echo the block we just sent (like the OEM app).
                int blk = (i + 1 < v.length) ? (v[i + 1] & 0xFF) : (seq & 0xFF);
                if (blk == (seq & 0xFF)) { advanceBlock(); }
                else { host.log("ack for block " + blk + ", expected " + seq); fail("wrong-block ack"); }
                return;
            }
        }
    }

    private void advanceBlock() {
        blockIndex++;
        blockRetries = 0;
        int pct = (int) Math.round(blockIndex * 100.0 / blockCount);
        host.progress(pct, blockIndex, blockCount, "flash");
        if (blockIndex >= blockCount) { beginEot(); return; }
        seq = (seq + 1) & 0xFF;
        if (seq == 0) seq = 1;
        sendBlock();
    }

    // OEM aborts the whole DFU on a block-ACK timeout; only a NAK resends. No auto-resend on timeout.
    private void onBlockTimeout() { fail("block " + seq + " ACK timeout"); }

    private void resendBlock() {
        if (++blockRetries >= BLOCK_RETRIES) { fail("block " + seq + " failed after " + BLOCK_RETRIES + " retries"); return; }
        sendBlock();
    }

    // ── finish ──

    private void beginEot() {
        state = St.EOT;
        eotTries = 0;
        rxLen = 0;
        host.progress(100, blockCount, blockCount, "finish");
        sendEot();
    }

    private void sendEot() {
        host.log("-> EOT");
        host.write(new byte[]{ (byte) EOT });
        arm(STEP_TIMEOUT_MS, this::onEotTimeout);
    }

    private void onEotTimeout() {
        // OEM does not require a 0x06 EOT-ACK; after a few EOT resends it just waits for the rsq result
        // token. So stop resending and wait for rsq dfu_ok instead of failing with "no ACK for EOT".
        if (++eotTries >= EOT_RETRIES) { beginFinish(); return; }
        sendEot();
    }

    private void beginFinish() {
        state = St.FINISH;
        rxLen = 0;
        host.log("EOT ack, waiting for result");
        // OEM watchdog: no rsq dfu_ok before the timeout means FAILURE, not success.
        arm(FINISH_TIMEOUT_MS, () -> fail("no result token (dfu_ok) from scooter"));
    }

    private void onFinishNotify(byte[] v) {
        append(v);
        if (contains(rx, rxLen, ascii("dfu_error"))) { clearTimeout(); fail("scooter reported dfu_error"); return; }
        if (contains(rx, rxLen, ascii("dfu_ok"))) { clearTimeout(); succeed("done"); }
    }

    // ── crypto / transform ──

    private static byte[] authInitPayload(int keyIdx, long userId) {
        byte[] s = s6(userId);
        byte[] p = new byte[9];
        p[0] = (byte) keyIdx;
        p[1] = 0x00;
        System.arraycopy(s, 0, p, 2, 6);
        p[8] = 0x00;
        return p;
    }

    private static byte[] s6(long userId) {
        if (userId <= 0) userId = (long) (Math.random() * 1_000_000_000L) + 1;
        long v = userId & 0xFFFFFFFFFFFFL;
        byte[] b = new byte[6];
        for (int i = 5; i >= 0; i--) { b[i] = (byte) (v & 0xFF); v >>= 8; }
        if ((b[0] & 0xFF) == 0 || (b[0] & 0xFF) >= 0x80) b[0] = (byte) 0x88;
        return b;
    }

    // mode 0 -> XOR with key; otherwise AES-128-ECB encrypt.
    private static byte[] transform(int mode, byte[] rand16, byte[] key16) {
        if (mode == 0) {
            byte[] out = new byte[16];
            for (int i = 0; i < 16; i++) out[i] = (byte) ((rand16[i] & 0xFF) ^ (key16[i] & 0xFF));
            return out;
        }
        return aesEcb(key16, rand16);
    }

    private static byte[] aesEcb(byte[] key16, byte[] block16) {
        try {
            Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key16, "AES"));
            return c.doFinal(block16);
        } catch (Throwable t) {
            Log.e(TAG, "aesEcb failed", t);
            return null;
        }
    }

    // CRC-16/XMODEM: poly 0x1021, init 0x0000, non-reflected.
    private static int crc16Xmodem(byte[] b, int start, int end) {
        int crc = 0;
        for (int i = start; i < end; i++) {
            crc ^= (b[i] & 0xFF) << 8;
            for (int n = 0; n < 8; n++) crc = ((crc & 0x8000) != 0) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
        }
        return crc & 0xFFFF;
    }

    // ── buffers / timers ──

    private void append(byte[] v) {
        for (byte b : v) {
            if (rxLen >= rx.length) { System.arraycopy(rx, rx.length / 2, rx, 0, rx.length / 2); rxLen = rx.length / 2; }
            rx[rxLen++] = b;
        }
    }

    private static boolean hasByte(byte[] v, int target) {
        for (byte b : v) if ((b & 0xFF) == target) return true;
        return false;
    }

    private static boolean contains(byte[] buf, int len, byte[] pat) {
        return indexOf(buf, len, pat) >= 0;
    }

    private static int indexOf(byte[] buf, int len, byte[] pat) {
        outer:
        for (int i = 0; i + pat.length <= len; i++) {
            for (int j = 0; j < pat.length; j++) if ((buf[i + j] & 0xFF) != (pat[j] & 0xFF)) continue outer;
            return i;
        }
        return -1;
    }

    // Locate a 55 AA .. FE FD frame with the given command byte; returns its start index or -1.
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

    private static byte[] ascii(String s) {
        byte[] out = new byte[s.length()];
        for (int i = 0; i < s.length(); i++) out[i] = (byte) (s.charAt(i) & 0xFF);
        return out;
    }

    private void arm(long ms, Runnable r) {
        clearTimeout();
        timeout = r;
        main.postDelayed(r, ms);
    }

    private void clearTimeout() {
        if (timeout != null) { main.removeCallbacks(timeout); timeout = null; }
    }

    private void succeed(String msg) { finish(true, "success", msg); }
    private void fail(String msg) { host.log("FAIL: " + msg); finish(false, "failed", msg); }

    private void finish(boolean ok, String stateName, String msg) {
        clearTimeout();
        state = ok ? St.DONE : St.FAILED;
        running = false;
        rxLen = 0;
        try { host.setHighPriority(false); } catch (Throwable ignored) {}
        try { host.state(stateName, msg); } catch (Throwable ignored) {}
        try { host.finished(ok); } catch (Throwable ignored) {}
    }
}
