// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Native BLE layer for the NAVEE scooter (55 AA frames over the d0ff GATT service). */
@SuppressLint("MissingPermission")
final class BleManager {

    private static final String TAG = "lbble";
    private static final String WIRE_TAG = "lbwire";

    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    /** Strip CR/LF so a crafted device name / address cannot forge extra log lines. */
    private static String logSafe(String s) {
        if (s == null) return "null";
        return s.replace('\r', ' ').replace('\n', ' ');
    }

    // Wire log with personal data masked: the 0x30 auth-init frame carries s(userId) and the 0x74
    // reply carries the serial number. Scan the buffer for those frames and show their bytes as XX so
    // an uploaded log never leaks them; everything else prints normally.
    private static String wireHex(byte[] b) {
        if (b == null) return hex(b);
        boolean[] mask = new boolean[b.length];
        boolean any = false;
        for (int i = 0; i + 8 <= b.length; i++) {
            if ((b[i] & 0xFF) != 0x55 || (b[i + 1] & 0xFF) != 0xAA) continue;
            int cmd = b[i + 3] & 0xFF, len = b[i + 4] & 0xFF, total = 8 + len;
            if (i + total > b.length) continue;
            if ((b[i + total - 2] & 0xFF) != 0xFE || (b[i + total - 1] & 0xFF) != 0xFD) continue;
            if (cmd == 0x30 && len == 9) { for (int k = i + 7; k <= i + 12; k++) mask[k] = true; any = true; }
            else if (cmd == 0x74 && len > 1) { for (int k = i + 6; k <= i + 4 + len; k++) mask[k] = true; any = true; }
        }
        if (!any) return hex(b);
        StringBuilder sb = new StringBuilder(b.length * 3);
        for (int i = 0; i < b.length; i++) {
            if (i > 0) sb.append(' ');
            if (mask[i]) sb.append("XX");
            else sb.append(HEX[(b[i] >> 4) & 0xF]).append(HEX[b[i] & 0xF]);
        }
        return sb.toString();
    }

    private static String hex(byte[] b) {
        if (b == null) return "null";
        StringBuilder sb = new StringBuilder(b.length * 3);
        for (int i = 0; i < b.length; i++) {
            if (i > 0) sb.append(' ');
            sb.append(HEX[(b[i] >> 4) & 0xF]).append(HEX[b[i] & 0xF]);
        }
        return sb.toString();
    }

    // CCCD descriptor (standard base).
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    // NAVEE GATT: the service uses a non-standard 128-bit base; the two characteristics use the
    // standard 0000-1000-8000-00805f9b34fb base.
    private static final UUID NAVEE_SERVICE = UUID.fromString("0000d0ff-3c17-d293-8e48-14fe2e4da212");
    private static final UUID NAVEE_WRITE   = UUID.fromString("0000b002-0000-1000-8000-00805f9b34fb");
    private static final UUID NAVEE_NOTIFY  = UUID.fromString("0000b003-0000-1000-8000-00805f9b34fb");

    private static final long DISCOVER_DELAY_MS = 1200;   // Android settle time after connect
    // The stock NAVEE app negotiates ATT MTU 148 before it opens the notify channel and waits
    // ~100 ms on either side of the exchange (BleHandler.X). Same values here.
    private static final int NAVEE_MTU = 148;
    private static final long MTU_SETTLE_MS = 100;        // pause between MTU success and notify
    private static final long MTU_TIMEOUT_MS = 1500;      // fallback if onMtuChanged never fires
    private static final long WRITE_GAP_MS = 200;         // spacing between serialised writes
    private static final long RECONNECT_BASE_MS = 3000;    // exponential-backoff base delay
    private static final long RECONNECT_MAX_MS = 30000;    // exponential-backoff cap
    private static final long PUSH_INTERVAL_MS = 500;     // live-data push ~2x/s

    interface Listener {
        void onScanResults(String jsonArray);
        void onState(String json);
        void onLiveData(String json);
        // Firmware-flash callbacks. json fields: progress {percent,block,count,phase}; state {state,message}.
        void onFwProgress(String json);
        void onFwLog(String line);
        void onFwState(String json);
    }

    private final Context appCtx;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private final SettingsState settings = new SettingsState();
    private final FrameParser parser = new FrameParser(settings);

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private volatile boolean scanning = false;
    private final Map<String, ScanEntry> found = new LinkedHashMap<>();

    private volatile BluetoothGatt gatt;
    private volatile BluetoothGattCharacteristic notifyChar;
    private volatile BluetoothGattCharacteristic writeChar;
    private volatile boolean notifyReady = false;
    private volatile boolean connected = false;
    private volatile boolean charsSetupDone = false;   // one-shot guard for characteristic setup
    private volatile boolean afterConnectDone = false; // one-shot guard for the post-connect routine
    private volatile boolean mtuStepDone = false;      // one-shot guard for the MTU -> notify hand-off

    private String desiredAddress;
    private String deviceName = "";

    private volatile long reconnectDelay = RECONNECT_BASE_MS;

    // write serialisation
    private final ArrayDeque<byte[]> writeQueue = new ArrayDeque<>();
    private boolean writing = false;

    // firmware flash: owns the write/notify path while running
    private volatile NaveeDfuEngine dfu;

    // ST3 Pro (pid 2345) tears the BLE link down mid-flash; only that model gets DFU resume.
    private static final String DFU_RESUME_PID = "2345";
    // Native DFU flash block list, by pid. Empty = no model is hard-blocked here; unconfirmed
    // models are gated at the patcher instead, so a stock recovery flash stays possible.
    private static final String[] DFU_BLOCKED_PIDS = {};

    private static boolean isFlashBlocked(String pid) {
        if (pid == null) return false;
        for (String p : DFU_BLOCKED_PIDS) if (p.equals(pid)) return true;
        return false;
    }
    private static final long DFU_RESUME_DELAY_MS = 800;   // fast reconnect while a resumable flash is paused
    private static final int DFU_RESUME_MAX_TRIES = 8;
    private volatile boolean dfuResumePending = false;
    private int dfuResumeTries = 0;

    // Optional account id for bound scooters (e.g. ST3 Pro): without the 0x30/0x31 session auth the
    // scooter drops the link after ~10 s. Stored Keystore-encrypted, never handed back to the WebView.
    private SecureStore secure;
    private volatile long accountId = 0;
    private volatile boolean authPending = false;
    private int authRounds = 0;
    // Arm-only handshake: no account id, so we send 0x30 -> 0x31 once to set the meter's report gate
    // and then STOP. We never send a second 0x30, which (and only which) would pair the scooter to a
    // dummy id in its flash and break the owner's manufacturer-app pairing.
    private boolean armOnly = false;
    // One-shot flag so a test log carries a single clear line when the report push actually starts.
    private boolean reportLiveLogged = false;
    private static final int AUTH_MAX_ROUNDS = 4;   // guard against a challenge loop
    private static final String SEC_ACCOUNT = "account_id";

    // ── Offline simulation (debug build with no BT hardware = the emulator) ──
    // With no Bluetooth adapter there is no scooter to reach. Sim mode exercises the full connect +
    // patcher flow on a virtual scooter: scan() lists virtual NAVEE models, connect() to a SIM- address
    // seeds a synthetic scooter of the chosen pid (so liveRaw().pid and every patcher gate behave exactly
    // as on hardware), and a flash is replayed as a successful DFU. Gated on a debuggable build AND a
    // null adapter, so it can never engage in a release build or on a device that has real BT hardware.
    private final boolean sim;
    private volatile boolean simFlashing = false;
    private volatile boolean simFlashCancel = false;
    private static final String SIM_ADDR_PREFIX = "SIM-";

    BleManager(Context ctx, Listener listener) {
        this.appCtx = ctx.getApplicationContext();
        this.listener = listener;
        try {
            secure = new SecureStore(appCtx);
            String v = secure.getString(SEC_ACCOUNT);
            if (v != null) { try { accountId = Long.parseLong(v.trim()); } catch (Throwable ignored) {} }
        } catch (Throwable t) {
            Log.e(TAG, "secure store init failed", t);
        }
        try {
            BluetoothManager bm = (BluetoothManager) appCtx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm != null) adapter = bm.getAdapter();
        } catch (Throwable t) {
            Log.e(TAG, "adapter init failed", t);
        }
        boolean dbg = false;
        try { dbg = (appCtx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0; }
        catch (Throwable ignored) {}
        // Engage only in a debuggable build, and only on the emulator (deterministic Build check) or when
        // there is genuinely no adapter. Never on a real phone, never in a release build.
        sim = dbg && (isEmulator() || adapter == null);
        if (sim) Log.i(TAG, "SIM mode active (debug build on emulator) - virtual scooter for patcher testing");
    }

    private static final class ScanEntry {
        String name;
        String address;
        int rssi;
    }

    // Reachable for other components (the bridge) that want the parsed state directly.
    FrameParser parser() { return parser; }
    boolean isConnected() { return connected; }
    boolean isReadyForDfu() { return connected && notifyReady && !isDfuActive(); }

    // ── Scan ──

    void scan() {
        if (sim) { pushSimScan(); return; }
        try {
            if (adapter == null || !adapter.isEnabled()) {
                Log.w(TAG, "scan: adapter unavailable/disabled");
                return;
            }
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) return;
            synchronized (found) { found.clear(); }
            if (scanning) return;
            ScanSettings s = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
            // No UUID or name filter: list every advertising LE device; the NAVEE service (d0ff) is bound at connect, not matched here.
            scanner.startScan(null, s, scanCallback);
            scanning = true;
            Log.i(TAG, "scan started");
        } catch (Throwable t) {
            Log.e(TAG, "scan failed", t);
        }
    }

    void stopScan() {
        try {
            if (scanner != null && scanning) scanner.stopScan(scanCallback);
        } catch (Throwable t) {
            Log.e(TAG, "stopScan failed", t);
        } finally {
            scanning = false;
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            handleScan(result);
        }

        @Override
        public void onBatchScanResults(java.util.List<ScanResult> results) {
            if (results != null) for (ScanResult r : results) handleScan(r);
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.w(TAG, "scan failed code=" + errorCode);
            scanning = false;
        }
    };

    private void handleScan(ScanResult result) {
        try {
            if (result == null || result.getDevice() == null) return;
            String addr = result.getDevice().getAddress();
            String name = null;
            if (result.getScanRecord() != null) name = result.getScanRecord().getDeviceName();
            if (name == null || name.isEmpty()) {
                try { name = result.getDevice().getName(); } catch (Throwable ignored) {}
            }
            ScanEntry e = new ScanEntry();
            e.name = (name == null) ? "" : name;
            e.address = addr;
            e.rssi = result.getRssi();
            boolean changed;
            synchronized (found) {
                ScanEntry prev = found.get(addr);
                changed = prev == null;
                found.put(addr, e);
            }
            if (changed) { Log.i(TAG, "found: " + e.name + " [" + addr + "] rssi=" + e.rssi); pushScanResults(); }
        } catch (Throwable t) {
            Log.e(TAG, "handleScan failed", t);
        }
    }

    private void pushScanResults() {
        try {
            JSONArray arr = new JSONArray();
            synchronized (found) {
                for (ScanEntry e : found.values()) {
                    JSONObject o = new JSONObject();
                    o.put("name", e.name);
                    o.put("address", e.address);
                    o.put("rssi", e.rssi);
                    arr.put(o);
                }
            }
            if (listener != null) listener.onScanResults(arr.toString());
        } catch (Throwable t) {
            Log.e(TAG, "pushScanResults failed", t);
        }
    }

    // ── Connect / disconnect ──

    void connect(String address, String name) {
        if (name != null && !name.trim().isEmpty()) deviceName = name.trim();
        connect(address);
    }

    void connect(String address) {
        if (sim) { simConnect(address); return; }
        try {
            if (address == null || address.trim().isEmpty() || adapter == null) return;
            desiredAddress = address.trim();
            stopScan();
            synchronized (found) {
                ScanEntry e = found.get(desiredAddress);
                if (e != null && e.name != null) deviceName = e.name;
            }
            closeGatt();
            BluetoothDevice dev = adapter.getRemoteDevice(desiredAddress);
            if (deviceName == null || deviceName.isEmpty()) {
                try { String n = dev.getName(); if (n != null) deviceName = n; } catch (Throwable ignored) {}
            }
            Log.i(TAG, "connect() -> " + logSafe(desiredAddress) + " name=" + logSafe(deviceName));
            pushState("connecting");
            gatt = dev.connectGatt(appCtx, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (Throwable t) {
            Log.e(TAG, "connect failed", t);
        }
    }

    void disconnect() {
        desiredAddress = null;   // user-initiated: no auto-reconnect
        if (sim) {
            stopSimPush();
            simFlashing = false;
            simFlashCancel = true;
            connected = false;
            notifyReady = false;
            pushState("disconnected");
            return;
        }
        stopPush();
        try {
            if (gatt != null) gatt.disconnect();
        } catch (Throwable t) {
            Log.e(TAG, "disconnect failed", t);
        }
        closeGatt();
        connected = false;
        notifyReady = false;
        pushState("disconnected");
    }

    /** @return JSON {"address","name"} of the last successfully connected scooter or "" if none. */
    String lastDeviceJson() {
        try {
            SharedPreferences sp = appCtx.getSharedPreferences("lb", Context.MODE_PRIVATE);
            String addr = sp.getString("last_device_addr", "");
            if (addr == null || addr.isEmpty()) return "";
            String name = sp.getString("last_device_name", "");
            JSONObject o = new JSONObject();
            o.put("address", addr);
            o.put("name", name == null ? "" : name);
            return o.toString();
        } catch (Throwable t) {
            Log.e(TAG, "lastDeviceJson failed", t);
            return "";
        }
    }

    void connectLast() {
        try {
            if (connected || desiredAddress != null) return;
            SharedPreferences sp = appCtx.getSharedPreferences("lb", Context.MODE_PRIVATE);
            String addr = sp.getString("last_device_addr", "");
            if (addr != null && !addr.isEmpty()) {
                Log.i(TAG, "connectLast() -> " + addr);
                connect(addr);
            }
        } catch (Throwable t) {
            Log.e(TAG, "connectLast failed", t);
        }
    }

    private void closeGatt() {
        try {
            if (gatt != null) gatt.close();
        } catch (Throwable ignored) {
        } finally {
            gatt = null;
            notifyChar = null;
            writeChar = null;
            notifyReady = false;
            charsSetupDone = false;
            afterConnectDone = false;
            mtuStepDone = false;
            synchronized (writeQueue) { writeQueue.clear(); writing = false; }
        }
    }

    // ── GATT callback ──

    private long frameCount = 0;
    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                Log.i(TAG, "GATT connected");
                pushState("discovering");
                main.postDelayed(() -> {
                    try { if (gatt != null) gatt.discoverServices(); } catch (Throwable ignored) {}
                }, DISCOVER_DELAY_MS);
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                Log.i(TAG, "GATT disconnected status=" + status);
                connected = false;
                notifyReady = false;
                authPending = false;
                stopPush();

                // ST3 Pro only: pause + fast reconnect to resume; other models fall through as before.
                NaveeDfuEngine d = dfu;
                boolean resumeThis = d != null && d.isRunning() && d.isResumable() && desiredAddress != null;
                if (resumeThis && ++dfuResumeTries > DFU_RESUME_MAX_TRIES) {
                    Log.i(TAG, "DFU resume gave up after " + DFU_RESUME_MAX_TRIES + " reconnect tries");
                    resumeThis = false;
                    dfuResumePending = false;
                    try { d.cancel(); } catch (Throwable ignored) {}
                }

                closeGatt();
                pushState("disconnected");

                if (resumeThis) {
                    dfuResumePending = true;
                    try { d.pause(); } catch (Throwable ignored) {}
                    Log.i(TAG, "DFU resume: reconnect in " + DFU_RESUME_DELAY_MS + " ms (try " + dfuResumeTries + ")");
                    main.postDelayed(() -> { if (desiredAddress != null) connect(desiredAddress); }, DFU_RESUME_DELAY_MS);
                } else if (desiredAddress != null) {
                    long delay = reconnectDelay;
                    Log.i(TAG, "scheduling reconnect in " + delay + " ms (backoff)");
                    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
                    main.postDelayed(() -> {
                        if (desiredAddress != null) connect(desiredAddress);
                    }, delay);
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            try {
                Log.i(TAG, "onServicesDiscovered status=" + status + " count=" + (g == null ? 0 : g.getServices().size()));
                setupCharacteristics(g, 0);
            } catch (Throwable t) {
                Log.e(TAG, "onServicesDiscovered failed", t);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            Log.i(TAG, "onMtuChanged mtu=" + mtu + " status=" + status);
            // Android / the peer may negotiate the MTU on its own right after connect, BEFORE service
            // discovery has assigned notifyChar. Only let an MTU event drive the notify hand-off once the
            // characteristics exist; otherwise it latches the MTU step and arms notifications on a null
            // characteristic (NPE), leaving the link "connected" but silent (no RX).
            if (notifyChar != null) proceedAfterMtu(g);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
            Log.i(TAG, "CCCD write status=" + status);
            markReady();
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            synchronized (writeQueue) { writing = false; }
            main.postDelayed(BleManager.this::drainWriteQueue, WRITE_GAP_MS);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            try {
                byte[] v = c.getValue();
                if (v == null) return;
                // During a flash the DFU engine owns b003 (XMODEM ACKs + text tokens, not 55 AA frames).
                NaveeDfuEngine d = dfu;
                if (d != null && d.isRunning()) { d.onNotify(v); return; }
                if (DebugLog.WIRE) Log.i(WIRE_TAG, "RX " + wireHex(v));
                // Drive the OEM two-round 0x30/0x31 session handshake (bound scooters) before parsing.
                if (authPending) {
                    NaveeAuth.R30 r = NaveeAuth.parse30(v, v.length);
                    if (r.kind != NaveeAuth.Kind.NONE) {
                        switch (r.kind) {
                            case CHALLENGE:
                                enqueueWrite(CommandBuilder.write(0x31, r.response));
                                Log.i(TAG, "session auth: challenge -> 0x31");
                                break;
                            case COMPLETE:
                                authPending = false;
                                Log.i(TAG, "session auth complete -> clock + 0x7B");
                                afterAuthComplete();
                                break;
                            case REJECTED:
                                authPending = false;
                                Log.i(TAG, "session auth rejected by scooter");
                                afterAuthComplete();
                                break;
                            default: break;
                        }
                    } else {
                        Boolean ok = NaveeAuth.parse31(v, v.length);
                        if (ok != null) {
                            if (ok && armOnly) {
                                // Gate is now set by the 0x31 crypto match, so the scooter will push
                                // 0x90/0x92. Stop: a further 0x30 while the gate is set would pair the
                                // scooter to the dummy id in its flash. One round is all we send here.
                                authPending = false;
                                Log.i(TAG, "session auth: 0x31 ok -> report stream armed (arm-only)");
                                afterAuthComplete();
                            } else if (ok && ++authRounds < AUTH_MAX_ROUNDS) {
                                enqueueWrite(CommandBuilder.write(0x30, NaveeAuth.authInitPayload(accountId)));
                                Log.i(TAG, "session auth: 0x31 ok -> 0x30 (round " + (authRounds + 1) + ")");
                            } else {
                                authPending = false;
                                Log.i(TAG, ok ? "session auth: round cap reached" : "session auth: 0x31 rejected");
                                afterAuthComplete();
                            }
                        }
                    }
                }
                parser.onNotify(v);
                // One-shot, un-gated: proves in any log that the report push is live. A pushed homepage
                // (0x90 >= 16 B) or a trip report (0x91/0x92) only arrives once the meter's report gate
                // is armed, unlike the 1-byte 0x90 pull ack.
                if (!reportLiveLogged && v.length >= 7 && (v[0] & 0xFF) == 0x55 && (v[1] & 0xFF) == 0xAA) {
                    int rcmd = v[3] & 0xFF, rlen = v[4] & 0xFF;
                    if ((rcmd == 0x90 && rlen >= 16) || rcmd == 0x91 || rcmd == 0x92) {
                        reportLiveLogged = true;
                        Log.i(TAG, "report stream live: cmd=0x" + Integer.toHexString(rcmd) + " len=" + rlen);
                    }
                }
                if (frameCount++ % 50 == 0) Log.i(TAG, "rx frames=" + frameCount + " last=" + v.length + "b");
            } catch (Throwable t) {
                Log.e(TAG, "onCharacteristicChanged failed", t);
            }
        }

        @Override
        public void onReadRemoteRssi(BluetoothGatt g, int rssi, int status) {
            parser.rssi = rssi;
        }
    };

    // Try to bind the NAVEE service + characteristics; retry a few times for the Android discovery race.
    private void setupCharacteristics(BluetoothGatt g, int attempt) {
        if (g == null) return;
        synchronized (this) {
            if (charsSetupDone) return;
        }
        BluetoothGattService svc = g.getService(NAVEE_SERVICE);
        if (svc == null) {
            if (attempt < 3) {
                Log.w(TAG, "NAVEE service not found yet, retry " + (attempt + 1));
                main.postDelayed(() -> setupCharacteristics(gatt, attempt + 1), 400);
                return;
            }
            Log.w(TAG, "no NAVEE service");
            desiredAddress = null;   // tapped a non-NAVEE device: do not arm the backoff reconnect
            closeGatt();             // drop the idle link; close() is silent and will not clobber the status below
            pushState("no-service");
            return;
        }
        synchronized (this) {
            if (charsSetupDone) return;
            charsSetupDone = true;
        }
        notifyChar = svc.getCharacteristic(NAVEE_NOTIFY);
        writeChar = svc.getCharacteristic(NAVEE_WRITE);
        if (notifyChar == null || writeChar == null) {
            Log.w(TAG, "notify/write characteristic missing (notify=" + notifyChar + " write=" + writeChar + ")");
            desiredAddress = null;
            closeGatt();
            pushState("no-char");
            return;
        }
        Log.i(TAG, "service=" + NAVEE_SERVICE + " notify=" + notifyChar.getUuid() + " write=" + writeChar.getUuid());
        requestMtuThenNotify(g);
    }

    /** Request MTU 148 then open the notify channel; timeout is the fallback if onMtuChanged never fires. */
    private void requestMtuThenNotify(BluetoothGatt g) {
        if (mtuStepDone) return;
        boolean started = false;
        try {
            started = g.requestMtu(NAVEE_MTU);
        } catch (Throwable t) {
            Log.e(TAG, "requestMtu failed", t);
        }
        Log.i(TAG, "requestMtu(" + NAVEE_MTU + ") initiated=" + started);
        if (!started) { proceedAfterMtu(g); return; }
        main.postDelayed(() -> proceedAfterMtu(gatt), MTU_TIMEOUT_MS);
    }

    /** One-shot hand-off from the MTU step to the notify step (callback or timeout, whichever first). */
    private void proceedAfterMtu(BluetoothGatt g) {
        synchronized (this) {
            if (mtuStepDone) return;
            mtuStepDone = true;
        }
        if (g == null) return;
        main.postDelayed(() -> { if (gatt != null) enableNotifications(gatt); }, MTU_SETTLE_MS);
    }

    private void enableNotifications(BluetoothGatt g) {
        // Snapshot the field: a concurrent disconnect can null it between the guard and the call.
        final BluetoothGattCharacteristic nc = notifyChar;
        if (g == null || nc == null) {
            // Not ready (e.g. an MTU event arrived before discovery). Do NOT markReady - that would fake
            // a connection with no notifications and therefore no telemetry. A reconnect retries cleanly.
            Log.w(TAG, "enableNotifications skipped: gatt/notifyChar not ready");
            return;
        }
        try {
            g.setCharacteristicNotification(nc, true);
            BluetoothGattDescriptor cccd = nc.getDescriptor(CCCD);
            if (cccd != null) {
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                boolean ok = g.writeDescriptor(cccd);
                Log.i(TAG, "writeDescriptor(CCCD) initiated=" + ok);
                if (!ok) { Log.w(TAG, "writeDescriptor rejected; reconnecting"); reconnectForNotify(g); }
            } else {
                Log.w(TAG, "CCCD descriptor missing; proceeding");
                main.post(this::markReady);
            }
        } catch (Throwable t) {
            Log.e(TAG, "enableNotifications failed", t);
            reconnectForNotify(g);   // was markReady(): that faked a live link with no RX (no telemetry)
        }
    }

    /** Notifications could not be armed: drop the link so the normal backoff reconnect gives a clean retry. */
    private void reconnectForNotify(BluetoothGatt g) {
        try { if (g != null) g.disconnect(); } catch (Throwable ignored) {}
    }

    // Notifications are live: mark connected, persist the device, start the push loop and run the
    // one-shot post-connect routine (time sync + status reads).
    private void markReady() {
        notifyReady = true;
        connected = true;
        try { BluetoothGatt g = gatt; if (g != null) g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH); } catch (Throwable ignored) {}
        reconnectDelay = RECONNECT_BASE_MS;
        try {
            SharedPreferences.Editor ed = appCtx.getSharedPreferences("lb", Context.MODE_PRIVATE).edit()
                    .putString("last_device_addr", desiredAddress);
            if (deviceName != null && !deviceName.isEmpty()) ed.putString("last_device_name", deviceName);
            ed.apply();
        } catch (Throwable ignored) {}
        // Seed parser.btName from the scan name.
        try { if (parser != null) parser.btName = (deviceName == null) ? "" : deviceName; } catch (Throwable ignored) {}
        pushState("connected");

        // ST3 Pro DFU resume: skip telemetry/time-sync and hand the reconnected link back to the flash engine.
        NaveeDfuEngine d = dfu;
        if (dfuResumePending && d != null && d.isRunning() && d.isResumable()) {
            dfuResumePending = false;
            try { d.resume(); } catch (Throwable t) { Log.e(TAG, "DFU resume failed", t); }
            return;
        }

        startPush();
        drainWriteQueue();
        afterConnect();
    }

    // Mirrors the web tool's afterConnectCommon: time sync (0x6F sub 6) then the status reads. NAVEE
    // needs no periodic keep-alive.
    private void afterConnect() {
        if (afterConnectDone) return;
        afterConnectDone = true;
        reportLiveLogged = false;
        // Every connect runs the OEM 0x30/0x31 session handshake: it sets the meter's report-enable
        // gate, which is the only thing that makes the scooter push the full 0x90/0x92 reports
        // (remaining range, trip and total mileage). A bound scooter also closes the link after ~10 s
        // unless this completes. With no account id we arm only (0x30 -> challenge -> 0x31, then stop);
        // with one we use the real id, which a bound scooter requires.
        try {
            authPending = true;
            authRounds = 0;
            armOnly = (accountId <= 0);
            enqueueWrite(CommandBuilder.write(0x30, NaveeAuth.authInitPayload(accountId)));
            Log.i(TAG, "session auth: 0x30 sent (round 1" + (armOnly ? ", arm-only" : "") + ")");
        } catch (Throwable t) {
            Log.e(TAG, "session auth send failed", t);
            authPending = false;
            afterAuthComplete();
        }
        // afterAuthComplete() runs the time sync + status reads once the handshake ends or is rejected.
    }

    private void afterAuthComplete() { connectTail(); }

    // Connect tail, run after the session handshake: clock (0x6F sub 6), then a fault-history read
    // (0x7B, which the meter only acks - it does NOT arm the report stream; the 0x30/0x31 handshake
    // sets the meter's report gate), then the dashboard status reads.
    private void connectTail() {
        try { enqueueWrite(CommandBuilder.timeSync()); } catch (Throwable ignored) {}
        try { enqueueWrite(CommandBuilder.read(0x7B)); } catch (Throwable ignored) {}
        main.postDelayed(this::readStatus, 500);
    }

    /** Store the account id for bound-scooter auth (0 or empty clears it). Kept Keystore-encrypted. */
    void setAccountId(long id) {
        accountId = id > 0 ? id : 0;
        try {
            if (secure != null) {
                if (accountId > 0) secure.putString(SEC_ACCOUNT, Long.toString(accountId));
                else secure.remove(SEC_ACCOUNT);
            }
        } catch (Throwable t) { Log.e(TAG, "setAccountId persist failed", t); }
    }

    void clearAccountId() { setAccountId(0); }

    /** Whether an account id is stored (never returns the value itself to callers/JS). */
    boolean hasAccountId() { return accountId > 0; }

    // ── Live-data push (~2x/s) ──

    private long pushTicks = 0;

    private final Runnable pushTask = new Runnable() {
        @Override
        public void run() {
            if (!connected) return;
            // Pause telemetry reads/pushes while a flash owns the link.
            if (isDfuActive()) { main.postDelayed(this, PUSH_INTERVAL_MS); return; }
            try {
                if (listener != null) listener.onLiveData(parser.toJson());
            } catch (Throwable t) {
                Log.e(TAG, "push failed", t);
            }
            try { if (gatt != null) gatt.readRemoteRssi(); } catch (Throwable ignored) {}
            // Poll 0x70 every ~2 s and 0x72 + 0x79 every ~5 s (not in the realtime push).
            pushTicks++;
            long per = Math.max(1, PUSH_INTERVAL_MS);
            if (notifyReady) {
                // Poll 0x90 so the warn/fault code is captured even when not riding.
                enqueueWrite(CommandBuilder.read(0x90));
                if (pushTicks % Math.max(1, (2000 / per)) == 0) enqueueWrite(CommandBuilder.read(0x70));
                if (pushTicks % Math.max(1, (5000 / per)) == 0) {
                    enqueueWrite(CommandBuilder.read(0x72));
                    enqueueWrite(CommandBuilder.read(0x79));   // battery extra (temp/current state + EU lifetime)
                }
            }
            main.postDelayed(this, PUSH_INTERVAL_MS);
        }
    };

    /** After a settings write, re-read 0x70 shortly after so the UI reflects what the scooter actually
     *  accepted (mirrors the manufacturer app, which re-reads 0x70 after every parameter write). */
    private void scheduleParamReread() {
        main.postDelayed(() -> { if (connected && notifyReady) enqueueWrite(CommandBuilder.read(0x70)); }, 350);
    }

    private void startPush() {
        main.removeCallbacks(pushTask);
        main.postDelayed(pushTask, PUSH_INTERVAL_MS);
    }

    private void stopPush() {
        main.removeCallbacks(pushTask);
    }

    // ── Write queue (serialised GATT writes) ──

    private void enqueueWrite(byte[] frame) {
        if (frame == null) return;
        synchronized (writeQueue) { writeQueue.add(frame); }
        drainWriteQueue();
    }

    private void drainWriteQueue() {
        if (!notifyReady) return;
        if (isDfuActive()) return;   // the flash engine drives b002 directly while running
        byte[] frame;
        synchronized (writeQueue) {
            if (writing) return;
            frame = writeQueue.poll();
            if (frame == null) return;
            writing = true;
        }
        boolean started = doWrite(frame);
        if (!started) {
            synchronized (writeQueue) { writing = false; }
            main.postDelayed(this::drainWriteQueue, WRITE_GAP_MS);
        }
    }

    private boolean doWrite(byte[] frame) {
        try {
            BluetoothGatt g = gatt;
            BluetoothGattCharacteristic wc = writeChar;
            if (g == null || wc == null) return false;
            int props = wc.getProperties();
            // NAVEE b002 is write-without-response; the reply returns over the b003 notify path.
            if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
                wc.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            } else if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) {
                wc.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            }
            wc.setValue(frame);
            if (DebugLog.WIRE) Log.i(WIRE_TAG, "TX " + wireHex(frame));
            return g.writeCharacteristic(wc);
        } catch (Throwable t) {
            Log.e(TAG, "doWrite failed", t);
            return false;
        }
    }

    // ── High-level commands (from the JS bridge) ──

    /** Send a fully built raw NAVEE frame (hex-parsed on the JS side, or one of the builders below). */
    void send(byte[] frame) { enqueueWrite(frame); }

    /** Single-byte setting write: 55 AA 00 <cmd> 01 <val> cksum FE FD. */
    void sendToggle(int cmd, int val) {
        try { enqueueWrite(CommandBuilder.write(cmd, new byte[]{(byte) (val & 0xFF)})); scheduleParamReread(); }
        catch (Throwable t) { Log.e(TAG, "sendToggle failed", t); }
    }

    /** Sub-command write: 55 AA 00 <cmd> 02 <sub> <val> cksum FE FD (e.g. 0x6F region, 0x6E max-speed). */
    void sendSub(int cmd, int sub, int val) {
        try { enqueueWrite(CommandBuilder.write(cmd, new byte[]{(byte) (sub & 0xFF), (byte) (val & 0xFF)})); scheduleParamReread(); }
        catch (Throwable t) { Log.e(TAG, "sendSub failed", t); }
    }

    /** Immobilizer via 0x51: unlocked=true -> unlock (val 0), false -> lock (val 1). */
    void setLock(boolean unlocked) { sendToggle(0x51, unlocked ? 0 : 1); }

    /** Trigger the status reads (serial/params/battery/firmware). Work without the userId auth. */
    void readStatus() {
        enqueueWrite(CommandBuilder.read(0x74));   // serial (region + model pid)
        enqueueWrite(CommandBuilder.read(0x70));   // full param block (speeds, toggles)
        enqueueWrite(CommandBuilder.read(0x72));   // battery telemetry
        enqueueWrite(CommandBuilder.read(0x79));   // battery extra (temp/current state + EU lifetime)
        enqueueWrite(CommandBuilder.read(0x73));   // firmware versions
        enqueueWrite(CommandBuilder.read(0x76));   // on-board drive history (trip records)
    }

    // ── Firmware flash (XMODEM-128 DFU) ──

    boolean isDfuActive() {
        if (simFlashing) return true;
        NaveeDfuEngine d = dfu;
        return d != null && d.isRunning();
    }

    /** Start flashing a patched image. target: 1 = meter, 2 = bldc. userId <= 0 = random 0x30 init. */
    void startDfu(final byte[] image, final int target, final long userId) {
        try {
            if (isDfuActive()) return;
            if (!connected || !notifyReady) {
                if (listener != null) listener.onFwState("{\"state\":\"failed\",\"message\":\"Connect the scooter first\"}");
                return;
            }
            if (sim) { simStartFlash(image, target); return; }
            // Hard flash block for the UT5 Max (no recovery path); other unconfirmed models are gated
            // at the patcher so a stock recovery flash stays possible.
            String pidNow = null;
            try { pidNow = parser.pid(); } catch (Throwable ignored) {}
            if (isFlashBlocked(pidNow)) {
                Log.i(TAG, "flash refused for pid " + pidNow + " (flashing disabled for this model)");
                if (listener != null) listener.onFwState("{\"state\":\"failed\",\"message\":\"Flashing is disabled for this model in this version.\"}");
                return;
            }
            stopPush();
            final NaveeDfuEngine engine = new NaveeDfuEngine(dfuHost);
            dfu = engine;
            dfuResumePending = false;
            dfuResumeTries = 0;
            // Only the ST3 Pro (pid 2345) gets reconnect-and-resume; other models flash as before.
            String pid = null;
            try { pid = parser.pid(); } catch (Throwable ignored) {}
            if (DFU_RESUME_PID.equals(pid)) {
                engine.setResumable(true);
                Log.i(TAG, "DFU resume enabled for pid " + pid + " (ST3 Pro)");
            }
            final long uid = userId > 0 ? userId : accountId;   // fall back to the stored account id
            main.postDelayed(() -> { if (dfu == engine) engine.start(image, target, uid); }, 200);
        } catch (Throwable t) {
            Log.e(TAG, "startDfu failed", t);
        }
    }

    void cancelDfu() {
        try {
            if (sim) { simFlashCancel = true; return; }
            NaveeDfuEngine d = dfu;
            if (d != null) d.cancel();
        } catch (Throwable t) {
            Log.e(TAG, "cancelDfu failed", t);
        }
    }

    // Direct no-response write to b002 (the flash engine paces itself; the normal queue is bypassed).
    private boolean doWriteDfu(byte[] frame) {
        try {
            BluetoothGatt g = gatt;
            BluetoothGattCharacteristic wc = writeChar;
            if (g == null || wc == null) return false;
            wc.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            wc.setValue(frame);
            return g.writeCharacteristic(wc);
        } catch (Throwable t) {
            Log.e(TAG, "doWriteDfu failed", t);
            return false;
        }
    }

    private final NaveeDfuEngine.Host dfuHost = new NaveeDfuEngine.Host() {
        @Override
        public boolean write(byte[] frame) { return doWriteDfu(frame); }

        @Override
        public void setHighPriority(boolean high) {
            try {
                BluetoothGatt g = gatt;
                if (g != null) g.requestConnectionPriority(high
                        ? BluetoothGatt.CONNECTION_PRIORITY_HIGH
                        : BluetoothGatt.CONNECTION_PRIORITY_BALANCED);
            } catch (Throwable ignored) {}
        }

        @Override
        public void progress(int percent, int block, int count, String phase) {
            try {
                JSONObject o = new JSONObject();
                o.put("percent", percent);
                o.put("block", block);
                o.put("count", count);
                if (phase != null) o.put("phase", phase);
                if (listener != null) listener.onFwProgress(o.toString());
            } catch (Throwable ignored) {}
        }

        @Override
        public void log(String line) {
            try { if (listener != null) listener.onFwLog(line == null ? "" : line); } catch (Throwable ignored) {}
        }

        @Override
        public void state(String st, String message) {
            try {
                JSONObject o = new JSONObject();
                o.put("state", st == null ? "" : st);
                if (message != null) o.put("message", message);
                if (listener != null) listener.onFwState(o.toString());
            } catch (Throwable ignored) {}
        }

        @Override
        public void finished(boolean success) {
            dfu = null;
            dfuResumePending = false;
            dfuResumeTries = 0;
            // Resume telemetry polling on the surviving connection.
            if (connected && notifyReady) startPush();
        }
    };

    // ── State reporting ──

    private void pushState(String status) {
        try {
            JSONObject o = new JSONObject();
            o.put("connected", connected);
            o.put("name", deviceName == null ? "" : deviceName);
            o.put("address", desiredAddress == null ? "" : desiredAddress);
            o.put("status", status == null ? "" : status);
            if (listener != null) listener.onState(o.toString());
        } catch (Throwable t) {
            Log.e(TAG, "pushState failed", t);
        }
    }

    // ── Offline simulation (emulator) ─────────────────────────────────────────

    // pid -> model name, mirrors NAVEE_MODELS in telemetry.html so the virtual device list matches the
    // patcher's own model table. Reference data; the pid is what every patcher gate keys on.
    private static final String[][] SIM_MODELS = {
        {"2213","N65i"},{"2314","V25/V25i"},{"2322","S40"},{"2326","V3 Pro"},{"2327","V25 Pro/V25i Pro"},
        {"2328","V40i/V40i Pro"},{"2329","V50i Pro"},{"2334","S60"},{"2345","ST3 Pro"},{"2353","P50"},
        {"2401","ST3"},{"2402","GT3"},{"2403","GT3 Pro"},{"2416","XT5 Pro"},{"2417","E20"},{"2418","GT3 Max"},
        {"2422","E25"},{"2435","Birdie 3"},{"2436","V25i Pro II"},{"2437","V40i Pro II"},{"2438","V50i Pro II"},
        {"2441","ST5 Pro"},{"2442","G5"},{"2443","XT5 Ultra"},{"2449","NT5 Ultra X"},{"2504","K100"},{"2505","K100 Pro"},
        {"2506","K100 Max"},{"2509","N65i II"},{"2515","Birdie 3x"},{"2517","ST5 Max"},{"2518","G5 pro"},{"2519","G5 Max"},
        {"2529","XT5 Max"},{"2536","S2"},{"2538","UT5 Max"},{"2543","NT5 Max"},{"2545","GT5 Pro"},{"2546","GT5 Max"},
        {"2547","UT5 Ultra"},{"2573","E25 Go"},{"2585","UT5 Ultra X"},{"2611","E45 Pro"},{"2612","E60 Pro"},{"2614","S2"},
        {"2619","UT3 Pro"},{"2620","UT3 Max"},{"2623","V45i"},{"2634","E20 Lite"},{"2643","E60 Pro"},{"2646","UT3"},
        {"2657","NT5 Max+"},{"2658","NT5 Ultra"},{"2701","NT3 Pro"},{"2704","GT3 Pro"},{"2707","NT5 Turbo"},{"2714","ST3 Pro"},
        {"2736","KG05"},{"2739","WOLF X"},{"2745","NT3 Max"},{"2753","E45 Pro"},{"2754","E60 Pro"},{"2768","EXO S Pro"},
    };

    // Deterministic emulator detection (Build properties), independent of whether the image fakes a BT adapter.
    private static boolean isEmulator() {
        try {
            String fp = android.os.Build.FINGERPRINT, model = android.os.Build.MODEL, hw = android.os.Build.HARDWARE,
                   prod = android.os.Build.PRODUCT, brand = android.os.Build.BRAND, dev = android.os.Build.DEVICE;
            if (fp != null && (fp.startsWith("generic") || fp.startsWith("unknown") || fp.contains("emulator")
                    || fp.contains("vbox") || fp.contains("sdk_gphone"))) return true;
            if (hw != null && (hw.contains("goldfish") || hw.contains("ranchu") || hw.contains("vbox"))) return true;
            if (model != null && (model.contains("Emulator") || model.contains("Android SDK built for"))) return true;
            if (prod != null && (prod.contains("sdk") || prod.contains("emulator") || prod.contains("sdk_gphone"))) return true;
            return brand != null && brand.startsWith("generic") && dev != null && dev.startsWith("generic");
        } catch (Throwable t) { return false; }
    }

    private static String simModelName(String pid) {
        if (pid != null) for (String[] m : SIM_MODELS) if (m[0].equals(pid)) return m[1];
        return "NAVEE";
    }

    // Emit the virtual model list into the normal scan-result path; names start with "NAVEE " so the UI
    // sorts and highlights them like a real scooter, addresses encode the pid as "SIM-<pid>".
    private void pushSimScan() {
        try {
            String[][] sorted = SIM_MODELS.clone();
            java.util.Arrays.sort(sorted, (a, b) -> a[1].compareToIgnoreCase(b[1]));
            JSONArray arr = new JSONArray();
            for (String[] m : sorted) {
                JSONObject o = new JSONObject();
                o.put("name", "NAVEE " + m[1] + " (SIM)");
                o.put("address", SIM_ADDR_PREFIX + m[0]);
                o.put("rssi", -50);
                arr.put(o);
            }
            Log.i(TAG, "SIM scan -> " + arr.length() + " virtual models");
            if (listener != null) listener.onScanResults(arr.toString());
        } catch (Throwable t) {
            Log.e(TAG, "pushSimScan failed", t);
        }
    }

    // Fake a connected scooter of the chosen pid. Seeds the parser with synthetic 0x74/0x73/0x70/0x72
    // replies so the whole dashboard + patcher light up exactly as with real hardware.
    private void simConnect(String address) {
        String addr = (address == null || address.trim().isEmpty()) ? SIM_ADDR_PREFIX + "2538" : address.trim();
        String pid = addr.startsWith(SIM_ADDR_PREFIX) ? addr.substring(SIM_ADDR_PREFIX.length()) : "2538";
        if (pid.length() != 4) pid = "2538";
        desiredAddress = addr;
        deviceName = "NAVEE " + simModelName(pid) + " (SIM)";
        Log.i(TAG, "SIM connect -> pid " + pid + " (" + simModelName(pid) + ")");
        pushState("connecting");
        simSeed(pid);
        connected = true;
        notifyReady = true;
        simFlashing = false;
        simFlashCancel = false;
        try { parser.btName = deviceName; } catch (Throwable ignored) {}
        try {
            appCtx.getSharedPreferences("lb", Context.MODE_PRIVATE).edit()
                    .putString("last_device_addr", desiredAddress)
                    .putString("last_device_name", deviceName).apply();
        } catch (Throwable ignored) {}
        pushState("connected");
        startSimPush();
    }

    private void simSeed(String pid) {
        try {
            // 0x74 serial: the pid is the first 4-digit run; region = chars [8..10] ("DE").
            simFeed(0x74, asciiBytes("S" + pid + "SIMDE01"));
            // 0x73 firmware: meter/bldc/bms/screen/uwb, 4 ASCII each.
            simFeed(0x73, asciiBytes("00300010" + "0012" + "    " + "    "));
            // 0x70 params (41 bytes): unlocked, startSpeed 3, no region limit, maxSpeed 25, drive mode 2.
            byte[] p70 = new byte[41];
            p70[2] = 0; p70[7] = 1; p70[19] = 3; p70[20] = 0; p70[25] = 25; p70[26] = 2;
            simFeed(0x70, p70);
            // 0x72 battery (15 bytes = no EU block): soc 80 %, 48.0 V, soh 100, 25 C, 50 cycles.
            byte[] p72 = new byte[15];
            p72[1] = (byte) 80;
            int mv = 48000;
            p72[2] = (byte) mv; p72[3] = (byte) (mv >> 8); p72[4] = (byte) (mv >> 16); p72[5] = (byte) (mv >> 24);
            p72[10] = (byte) 100; p72[11] = (byte) 25; p72[13] = (byte) 50; p72[14] = 0;
            simFeed(0x72, p72);
        } catch (Throwable t) {
            Log.e(TAG, "simSeed failed", t);
        }
    }

    // Wrap data in a NAVEE reply frame (err byte 0 + payload) and feed it through the real parser.
    private void simFeed(int cmd, byte[] data) {
        byte[] payload = new byte[data.length + 1];
        payload[0] = 0x00;
        System.arraycopy(data, 0, payload, 1, data.length);
        parser.onNotify(CommandBuilder.write(cmd, payload));
    }

    private static byte[] asciiBytes(String s) {
        byte[] o = new byte[s.length()];
        for (int i = 0; i < s.length(); i++) o[i] = (byte) (s.charAt(i) & 0xFF);
        return o;
    }

    private final Runnable simPush = new Runnable() {
        @Override
        public void run() {
            if (!connected || !sim) return;
            if (isDfuActive()) { main.postDelayed(this, PUSH_INTERVAL_MS); return; }
            try { if (listener != null) listener.onLiveData(parser.toJson()); } catch (Throwable ignored) {}
            parser.rssi = -55 - (int) (pushTicks % 8);
            pushTicks++;
            main.postDelayed(this, PUSH_INTERVAL_MS);
        }
    };

    private void startSimPush() { main.removeCallbacks(simPush); main.postDelayed(simPush, 200); }
    private void stopSimPush() { main.removeCallbacks(simPush); }

    // Replay a successful DFU: the same phase/log/progress/state callbacks the real engine emits, so the
    // patcher UI runs end to end. finished() is NOT used here (it would start the real GATT push loop);
    // the flash is marked done via state("success") + clearing simFlashing, which isFwActive() polls.
    private void simStartFlash(final byte[] image, final int target) {
        stopSimPush();
        simFlashCancel = false;
        simFlashing = true;
        final int count = Math.max(1, ((image == null ? 128 : image.length) + 127) / 128);
        dfuHost.setHighPriority(true);
        dfuHost.state("running", null);
        dfuHost.progress(0, 0, count, "prepare");
        dfuHost.log("SIM flash - no scooter connected, replaying a successful DFU");
        dfuHost.log("image " + (image == null ? 0 : image.length) + " bytes, " + count + " blocks, target " + target);
        // Short handshake replay, then a block sweep, then EOT -> success.
        main.postDelayed(() -> { if (checkSimCancel()) return; dfuHost.log("auth init (key 1)"); dfuHost.log("-> down dfu_start " + target); }, 300);
        main.postDelayed(() -> { if (checkSimCancel()) return; dfuHost.log("-> down ble_rand"); }, 650);
        main.postDelayed(() -> { if (checkSimCancel()) return; dfuHost.log("-> down ble_key (mode 0)"); }, 1000);
        main.postDelayed(() -> {
            if (checkSimCancel()) return;
            dfuHost.log("C received");
            dfuHost.progress(0, 0, count, "flash");
            simFlashBlocks(count, 0, Math.max(1, count / 60));
        }, 1350);
    }

    private boolean checkSimCancel() {
        if (!simFlashCancel) return false;
        dfuHost.log("cancel");
        simFlashing = false;
        dfuHost.setHighPriority(false);
        dfuHost.state("failed", "cancelled");
        if (connected) startSimPush();
        return true;
    }

    private void simFlashBlocks(final int count, final int done, final int inc) {
        if (checkSimCancel()) return;
        int b = Math.min(count, done + inc);
        int pct = (int) Math.round(b * 100.0 / count);
        dfuHost.progress(pct, b, count, "flash");
        if (b >= count) {
            dfuHost.progress(100, count, count, "finish");
            dfuHost.log("-> EOT");
            main.postDelayed(() -> {
                if (checkSimCancel()) return;
                dfuHost.log("dfu_ok");
                simFlashing = false;
                dfuHost.setHighPriority(false);
                dfuHost.state("success", "done");
                if (connected) startSimPush();
            }, 450);
            return;
        }
        final int nb = b;
        main.postDelayed(() -> simFlashBlocks(count, nb, inc), 50);
    }

    void shutdown() {
        stopScan();
        disconnect();
    }
}
