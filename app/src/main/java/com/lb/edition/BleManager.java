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

/**
 * Native BLE layer for the NAVEE scooter (proprietary 55 AA frames over a d0ff GATT service). Using
 * a NATIVE Android BLE connection here (rather than Web Bluetooth) is the whole point of this app:
 * Samsung Knox / Auto Blocker and the Xiaomi BLE stack silently block Web Bluetooth GATT connects,
 * while the native BluetoothGatt path with the proper runtime permissions works.
 *
 * Flow: scan by name prefix "NAVEE", connect GATT, discover the d0ff service, take the b002 write and
 * b003 notify characteristics, enable notifications (local + CCCD), then run one post-connect routine
 * (time sync + status reads). The account userId auth (0x30) is OPTIONAL - the meter dispatches every
 * normal command with no auth gate (verified in firmware), so lock/cruise/gear/kickstart/region plus
 * the status reads all work without it.
 *
 * All public entry points are null/exception-safe so nothing ever throws across the JS bridge.
 */
@SuppressLint("MissingPermission")
final class BleManager {

    private static final String TAG = "lbble";

    // CCCD descriptor (standard base).
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    // NAVEE GATT: the service uses a non-standard 128-bit base; the two characteristics use the
    // standard 0000-1000-8000-00805f9b34fb base.
    private static final UUID NAVEE_SERVICE = UUID.fromString("0000d0ff-3c17-d293-8e48-14fe2e4da212");
    private static final UUID NAVEE_WRITE   = UUID.fromString("0000b002-0000-1000-8000-00805f9b34fb");
    private static final UUID NAVEE_NOTIFY  = UUID.fromString("0000b003-0000-1000-8000-00805f9b34fb");

    // The scooter advertises as "NAVEE..." (same match the official app uses).
    private static final String[] NAME_PREFIXES = {"NAVEE"};

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

    BleManager(Context ctx, Listener listener) {
        this.appCtx = ctx.getApplicationContext();
        this.listener = listener;
        try {
            BluetoothManager bm = (BluetoothManager) appCtx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm != null) adapter = bm.getAdapter();
        } catch (Throwable t) {
            Log.e(TAG, "adapter init failed", t);
        }
    }

    private static final class ScanEntry {
        String name;
        String address;
        int rssi;
    }

    // Reachable for other components (the bridge) that want the parsed state directly.
    FrameParser parser() { return parser; }
    boolean isConnected() { return connected; }

    // ── Scan ──

    void scan() {
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
            // No UUID filter: the scooter does not advertise its 128-bit service UUID, so match by name.
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
            if (!nameAccepted(name)) return;
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

    private static boolean nameAccepted(String name) {
        if (name == null) return false;
        for (String p : NAME_PREFIXES) if (name.startsWith(p)) return true;
        return false;
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
            Log.i(TAG, "connect() -> " + desiredAddress + " name=" + deviceName);
            pushState("connecting");
            gatt = dev.connectGatt(appCtx, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (Throwable t) {
            Log.e(TAG, "connect failed", t);
        }
    }

    void disconnect() {
        desiredAddress = null;   // user-initiated: no auto-reconnect
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
                stopPush();
                closeGatt();
                pushState("disconnected");
                if (desiredAddress != null) {
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
            proceedAfterMtu(g);
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
                if (v != null) {
                    parser.onNotify(v);
                    if (frameCount++ % 50 == 0) Log.i(TAG, "rx frames=" + frameCount + " last=" + v.length + "b");
                }
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
            pushState("no-char");
            return;
        }
        Log.i(TAG, "service=" + NAVEE_SERVICE + " notify=" + notifyChar.getUuid() + " write=" + writeChar.getUuid());
        requestMtuThenNotify(g);
    }

    /** Ask for the same ATT MTU the manufacturer app negotiates before it opens the notify channel.
     *  The stock app does connect -> 100 ms -> requestMtu(148) -> MTU success -> 100 ms -> notify.
     *  Our frames are far below that, but a 0x70 parameter report is longer than the 20 payload
     *  bytes of the default MTU, so without this it arrives split across notifications. The parser
     *  reassembles either way; matching the stock negotiation keeps a report in one packet.
     *  onMtuChanged drives the next step; the timeout is the fallback for stacks that never call it. */
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
        try {
            g.setCharacteristicNotification(notifyChar, true);
            BluetoothGattDescriptor cccd = notifyChar.getDescriptor(CCCD);
            if (cccd != null) {
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                boolean ok = g.writeDescriptor(cccd);
                Log.i(TAG, "writeDescriptor(CCCD) initiated=" + ok);
                if (!ok) main.post(this::markReady);
            } else {
                Log.w(TAG, "CCCD descriptor missing; proceeding");
                main.post(this::markReady);
            }
        } catch (Throwable t) {
            Log.e(TAG, "enableNotifications failed", t);
            main.post(this::markReady);
        }
    }

    // Notifications are live: mark connected, persist the device, start the push loop and run the
    // one-shot post-connect routine (time sync + status reads).
    private void markReady() {
        notifyReady = true;
        connected = true;
        reconnectDelay = RECONNECT_BASE_MS;
        try {
            SharedPreferences.Editor ed = appCtx.getSharedPreferences("lb", Context.MODE_PRIVATE).edit()
                    .putString("last_device_addr", desiredAddress);
            if (deviceName != null && !deviceName.isEmpty()) ed.putString("last_device_name", deviceName);
            ed.apply();
        } catch (Throwable ignored) {}
        // The advertised name IS the NAVEE identity the dashboard shows as the model line and on the
        // info page; nothing else ever sets parser.btName, so seed it here from the scan name.
        try { if (parser != null) parser.btName = (deviceName == null) ? "" : deviceName; } catch (Throwable ignored) {}
        pushState("connected");
        startPush();
        drainWriteQueue();
        afterConnect();
    }

    // Mirrors the web tool's afterConnectCommon: time sync (0x6F sub 6) then the status reads. NAVEE
    // needs no periodic keep-alive.
    private void afterConnect() {
        if (afterConnectDone) return;
        afterConnectDone = true;
        try { enqueueWrite(CommandBuilder.timeSync()); } catch (Throwable ignored) {}
        main.postDelayed(this::readStatus, 500);
    }

    // ── Live-data push (~2x/s) ──

    private long pushTicks = 0;

    private final Runnable pushTask = new Runnable() {
        @Override
        public void run() {
            if (!connected) return;
            try {
                if (listener != null) listener.onLiveData(parser.toJson());
            } catch (Throwable t) {
                Log.e(TAG, "push failed", t);
            }
            try { if (gatt != null) gatt.readRemoteRssi(); } catch (Throwable ignored) {}
            // Poll the two reads whose values are NOT in the realtime push: 0x70 (cruise, drive mode,
            // limits, start speed, brake, TCS, unit) every ~2 s and 0x72 (SOH, temperature, cycles)
            // every ~5 s. Without this those stay frozen at the connect-time snapshot. lock, range,
            // pack voltage/current and speed come live in 0x90/0x92 and are not re-polled here.
            pushTicks++;
            long per = Math.max(1, PUSH_INTERVAL_MS);
            if (notifyReady) {
                if (pushTicks % Math.max(1, (2000 / per)) == 0) enqueueWrite(CommandBuilder.read(0x70));
                if (pushTicks % Math.max(1, (5000 / per)) == 0) enqueueWrite(CommandBuilder.read(0x72));
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
        enqueueWrite(CommandBuilder.read(0x73));   // firmware versions
    }

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

    void shutdown() {
        stopScan();
        disconnect();
    }
}
