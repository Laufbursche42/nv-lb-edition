// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Host activity: a full-screen WebView that renders the offline dashboard
 * (file:///android_asset/dashboard/telemetry.html) and exposes a "LB" JavaScript
 * bridge for BLE, settings, motor control and SRT streaming.
 *
 * The bridge forwards to the native BLE layer (BleManager / FrameParser / CommandBuilder) and to
 * the com.lb.srt streaming module. Live telemetry is pushed back to the WebView as localStorage
 * ['lb_live_data'] (plus window.__onBleData); scan results via window.__onBleScan; connection state
 * via window.__onBleState. Every bridge method is null/exception-safe and never throws across JS.
 */
public class MainActivity extends Activity {

    private static final String TAG = "lbedition";
    private static final int REQ_PERMS = 4711;

    private WebView webView;
    private BleManager ble;
    private DebugLog debugLog;
    private RideLogger rideLogger;
    private SharedPreferences prefs;
    // Auto-reconnect to the remembered scooter is attempted at most once per process.
    private boolean autoConnectTried = false;
    // Tracks the BLE connection state so ride-logging transitions fire exactly once per change.
    // Volatile: onState() may run on the BLE binder thread or the main thread.
    private volatile boolean rideConnected = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep the screen on while riding / dashboard is visible.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);

        // Full-screen (immersive) is user-toggleable and persisted; default OFF. When off, the
        // Android status bar (battery / clock / notifications) shows and content sits below it.
        // Delegated to UiChrome so every screen (main + native) shares the exact same inset logic.
        prefs = getSharedPreferences("lb", MODE_PRIVATE);
        UiChrome.applyFullscreen(this);

        configureWebView();
        webView.addJavascriptInterface(new LbBridge(), "LB");
        webView.loadUrl("file:///android_asset/dashboard/telemetry.html");

        ble = new BleManager(this, bleListener);

        // Ride logging: native NDJSON ride recorder, driven from the BLE listener callbacks below.
        rideLogger = new RideLogger(getApplicationContext());

        // Debug logging: persistent across restarts (SharedPreferences key lb_debug).
        // Resume capture immediately if the user left it enabled.
        debugLog = new DebugLog(getApplicationContext());
        try {
            if (debugLog.isEnabled()) debugLog.start();
        } catch (Throwable t) {
            Log.e(TAG, "debug resume failed", t);
        }

        requestRuntimePermissions();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-apply the shared window chrome on regaining focus (e.g. after a dialog) so the immersive
        // / status-bar state survives - identical to NavActivity and MapDownloadActivity.
        if (hasFocus) UiChrome.applyFullscreen(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Observe navigation and mirror the current state to the dashboard banner immediately.
        NavSession.addListener(navListener);
        navListener.onNavState(NavSession.state());
        // First time we resume with BT permission available, reconnect to the remembered scooter.
        if (!autoConnectTried) {
            boolean btOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                    || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
            if (btOk && ble != null) {
                autoConnectTried = true;
                ble.connectLast();
            }
        }
    }

    @SuppressWarnings({"SetJavaScriptEnabled"})
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // The dashboard is a self-contained bundled asset page; it never needs to read other local
        // files or make cross-origin requests FROM the file:// origin. Keeping these OFF means that
        // even if a scripting bug ever landed on the page, it could not fetch("file:///...") to exfil
        // local data or reach the network cross-origin. (Both default to false on modern WebView; set
        // explicitly so the hardening is not silently lost on an older engine.)
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setGeolocationEnabled(true);
        // The page opens external links via LB.openUrl (system browser), never its own windows.
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Pin the privileged WebView (it holds the LB firmware/BLE bridge) to the bundled dashboard.
        // Any attempt to navigate it elsewhere is cancelled, so no remote or attacker page can ever
        // inherit the JS bridge. External links are handled explicitly by LB.openUrl, not here.
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request != null ? request.getUrl() : null;
                String url = u != null ? u.toString() : "";
                return !url.startsWith("file:///android_asset/");   // true = cancel the navigation
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin, GeolocationPermissions.Callback callback) {
                // Grant location ONLY to the bundled local dashboard (its route recorder), never to
                // any other origin that might somehow request it.
                boolean local = origin != null && origin.startsWith("file://");
                callback.invoke(origin, local, false);
            }
        });
    }

    // ── Java -> JS bridge (all on the UI thread) ──

    private void runJs(final String js) {
        if (webView == null || js == null) return;
        webView.post(() -> {
            try {
                if (webView != null) webView.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.e(TAG, "evaluateJavascript failed", t);
            }
        });
    }

    /** Push each navigation guidance snapshot to the WebView (window.__onNav) for the dashboard banner. */
    private final NavSession.Listener navListener = new NavSession.Listener() {
        @Override
        public void onNavState(NavSession.State s) {
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("active", s.active);
                o.put("arrived", s.arrived);
                o.put("offRoute", s.offRoute);
                o.put("turnText", s.turnText);
                o.put("turnArrow", s.turnArrow);
                o.put("distToTurnM", s.distToTurnM);
                o.put("remainingM", s.remainingM);
                runJs("(function(){try{if(window.__onNav)window.__onNav(" + o + ");}catch(e){}})();");
            } catch (Throwable ignored) {
            }
        }
    };

    private final BleManager.Listener bleListener = new BleManager.Listener() {
        @Override
        public void onScanResults(String jsonArray) {
            if (jsonArray == null) return;
            runJs("(function(){try{if(window.__onBleScan)window.__onBleScan(" + jsonArray + ");}catch(e){}})();");
        }

        @Override
        public void onState(String json) {
            if (json == null) return;
            runJs("(function(){try{if(window.__onBleState)window.__onBleState(" + json + ");}catch(e){}})();");
            // Drive the ride logger on connect/disconnect transitions (fires once per change).
            try {
                boolean nowConnected = new JSONObject(json).optBoolean("connected", false);
                if (nowConnected != rideConnected) {
                    rideConnected = nowConnected;
                    if (rideLogger != null) {
                        if (nowConnected) rideLogger.onConnected();
                        else rideLogger.onDisconnected();
                    }
                }
            } catch (Throwable t) {
                Log.e(TAG, "ride state wiring failed", t);
            }
        }

        @Override
        public void onLiveData(String json) {
            if (json == null) return;
            // Write the JSON string to localStorage['lb_live_data'] (dashboard's tickBLE reads it)
            // and also call window.__onBleData(json) if present.
            runJs("(function(){try{var d=" + json + ";var s=JSON.stringify(d);"
                    + "try{localStorage.setItem('lb_live_data',s);}catch(e){}"
                    + "if(window.__onBleData){try{window.__onBleData(s);}catch(e){}}}catch(e){}})();");
            // Feed the latest snapshot to the ride logger (arms/samples the ride).
            try {
                if (rideLogger != null) rideLogger.onLiveData(json);
            } catch (Throwable t) {
                Log.e(TAG, "ride live-data wiring failed", t);
            }
        }

    };

    // ── Runtime permissions ──
    private void requestRuntimePermissions() {
        List<String> want = new ArrayList<>();
        want.add(Manifest.permission.ACCESS_FINE_LOCATION);
        want.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            want.add(Manifest.permission.BLUETOOTH_SCAN);
            want.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        }

        List<String> missing = new ArrayList<>();
        for (String p : want) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                missing.add(p);
            }
        }
        if (!missing.isEmpty()) {
            requestPermissions(missing.toArray(new String[0]), REQ_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMS) {
            for (int i = 0; i < permissions.length; i++) {
                Log.i(TAG, "perm " + permissions[i] + " -> " + grantResults[i]);
            }
        }
    }

    @Override
    protected void onDestroy() {
        try {
            NavSession.removeListener(navListener);
        } catch (Throwable ignored) {
        }
        try {
            if (ble != null) ble.shutdown();
        } catch (Throwable ignored) {
        }
        try {
            // Safety net: finalize any active ride and stop the foreground service on teardown.
            if (rideLogger != null) rideLogger.onDisconnected();
        } catch (Throwable ignored) {
        }
        try {
            if (debugLog != null) debugLog.stop();
        } catch (Throwable ignored) {
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * The "LB" JavaScript bridge. Forwards to the native BLE layer and the SRT streaming module.
     * Every method is null/exception-safe - nothing throws across the bridge.
     */
    private class LbBridge {

        /** End the active turn-by-turn navigation session (stops the foreground service). */
        @JavascriptInterface
        public void endNav() {
            try {
                Log.i(TAG, "LB.endNav()");
                NavigationService.stop(MainActivity.this);
            } catch (Throwable t) {
                Log.e(TAG, "endNav failed", t);
            }
        }

        @JavascriptInterface
        public void scan() {
            try {
                Log.i(TAG, "LB.scan()");
                if (ble != null) ble.scan();
            } catch (Throwable t) {
                Log.e(TAG, "scan bridge failed", t);
            }
        }

        @JavascriptInterface
        public void stopScan() {
            try {
                Log.i(TAG, "LB.stopScan()");
                if (ble != null) ble.stopScan();
            } catch (Throwable t) {
                Log.e(TAG, "stopScan bridge failed", t);
            }
        }

        @JavascriptInterface
        public void connect(String addr) {
            try {
                Log.i(TAG, "LB.connect(" + addr + ")");
                if (ble != null) ble.connect(addr);
            } catch (Throwable t) {
                Log.e(TAG, "connect bridge failed", t);
            }
        }

        /** Connect and seed the already-known BLE name so the FIN / Bluetooth name shows at once. */
        @JavascriptInterface
        public void connect(String addr, String name) {
            try {
                Log.i(TAG, "LB.connect(" + addr + ", " + name + ")");
                if (ble != null) ble.connect(addr, name);
            } catch (Throwable t) {
                Log.e(TAG, "connect bridge failed", t);
            }
        }

        @JavascriptInterface
        public void disconnect() {
            try {
                Log.i(TAG, "LB.disconnect()");
                if (ble != null) ble.disconnect();
            } catch (Throwable t) {
                Log.e(TAG, "disconnect bridge failed", t);
            }
        }

        /** @return JSON {"address","name"} of the last connected scooter or "" if none stored. */
        @JavascriptInterface
        public String lastDevice() {
            try {
                return ble.lastDeviceJson();
            } catch (Throwable t) {
                return "";
            }
        }

        // ── NAVEE settings ──

        /** Single-byte setting write: cmd + value (e.g. 0x52 cruise, 0x58 gear/drive-mode, 0x5F TCS, 0x6A start speed). */
        @JavascriptInterface
        public void sendToggle(int cmd, int val) {
            try {
                Log.i(TAG, "LB.sendToggle(0x" + Integer.toHexString(cmd) + "," + val + ")");
                if (ble != null) ble.sendToggle(cmd, val);
            } catch (Throwable t) {
                Log.e(TAG, "sendToggle bridge failed", t);
            }
        }

        /** Sub-command write: cmd + sub + value (e.g. 0x6F region sub8, 0x6E max-speed sub1). */
        @JavascriptInterface
        public void sendSub(int cmd, int sub, int val) {
            try {
                Log.i(TAG, "LB.sendSub(0x" + Integer.toHexString(cmd) + "," + sub + "," + val + ")");
                if (ble != null) ble.sendSub(cmd, sub, val);
            } catch (Throwable t) {
                Log.e(TAG, "sendSub bridge failed", t);
            }
        }

        /** Send a raw NAVEE frame from a hex string (e.g. a captured 55 AA 00 30 auth frame). */
        @JavascriptInterface
        public void sendRaw(String hex) {
            try {
                byte[] f = CommandBuilder.parseHex(hex);
                if (f != null && ble != null) ble.send(f);
            } catch (Throwable t) {
                Log.e(TAG, "sendRaw bridge failed", t);
            }
        }

        /** Re-read status (serial / params / battery / firmware). Works without the userId auth. */
        @JavascriptInterface
        public void readStatus() {
            try {
                if (ble != null) ble.readStatus();
            } catch (Throwable t) {
                Log.e(TAG, "readStatus bridge failed", t);
            }
        }

        /** Set the VCU speed lock via cmd 0x1B (TESTLOCK firmware). true = unlock, false = lock. */
        @JavascriptInterface
        public void setLock(boolean unlocked) {
            try {
                Log.i(TAG, "LB.setLock(" + unlocked + ")");
                if (ble != null) ble.setLock(unlocked);
            } catch (Throwable t) {
                Log.e(TAG, "setLock bridge failed", t);
            }
        }

        /** Open the native offline navigation screen (map + bike routing + camping/charging POIs). */
        @JavascriptInterface
        public void openNavigation() {
            Log.i(TAG, "LB.openNavigation()");
            try {
                Intent i = new Intent(MainActivity.this, NavActivity.class);
                startActivity(i);
            } catch (Throwable t) {
                Log.e(TAG, "openNavigation failed", t);
            }
        }

        /**
         * Show a recorded ride on the native offline map (instead of Google Maps). Opens
         * {@link NavActivity} in display-only mode with the track passed as a JSON array of
         * {@code {lat, lon}} points.
         */
        @JavascriptInterface
        public void showRouteOnMap(final String pointsJson) {
            Log.i(TAG, "LB.showRouteOnMap(" + (pointsJson == null ? 0 : pointsJson.length()) + " chars)");
            try {
                Intent i = new Intent(MainActivity.this, NavActivity.class);
                i.putExtra(NavActivity.EXTRA_TRACK, pointsJson);
                startActivity(i);
            } catch (Throwable t) {
                Log.e(TAG, "showRouteOnMap failed", t);
            }
        }

        @JavascriptInterface
        public void startStream(String url) {
            Log.i(TAG, "LB.startStream(" + url + ")");
            try {
                if (url == null || url.trim().isEmpty()) {
                    Log.w(TAG, "startStream: empty url, ignoring");
                    return;
                }
                Intent i = new Intent(MainActivity.this, com.lb.srt.StreamActivity.class);
                i.putExtra("url", url);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Throwable t) {
                Log.e(TAG, "startStream failed", t);
            }
        }

        @JavascriptInterface
        public void stopStream() {
            Log.i(TAG, "LB.stopStream()");
            try {
                Intent i = new Intent(MainActivity.this, com.lb.srt.StreamService.class);
                i.setAction("STOP");
                startService(i);
            } catch (Throwable t) {
                Log.e(TAG, "stopStream failed", t);
            }
        }

        @JavascriptInterface
        public String streamStatus() {
            try {
                String s = com.lb.srt.StreamService.getStatus();
                return s == null ? "" : s;
            } catch (Throwable t) {
                Log.e(TAG, "streamStatus failed", t);
                return "";
            }
        }

        @JavascriptInterface
        public String encrypt(String plain) {
            try {
                return com.lb.srt.SrtCrypto.encrypt(plain);
            } catch (Throwable t) {
                Log.e(TAG, "encrypt failed", t);
                return null;
            }
        }

        @JavascriptInterface
        public String decrypt(String stored) {
            try {
                return com.lb.srt.SrtCrypto.decrypt(stored);
            } catch (Throwable t) {
                Log.e(TAG, "decrypt failed", t);
                return null;
            }
        }

        @JavascriptInterface
        public void log(String s) {
            Log.i(TAG, "LB.log: " + s);
            try {
                if (debugLog != null && debugLog.isEnabled()) debugLog.append(s);
            } catch (Throwable ignored) {
            }
        }

        /** @return the app version as "vNAME (build CODE)", read from the package info. */
        @JavascriptInterface
        public String appVersion() {
            try {
                android.content.pm.PackageInfo pi =
                        getPackageManager().getPackageInfo(getPackageName(), 0);
                long code = (android.os.Build.VERSION.SDK_INT >= 28)
                        ? pi.getLongVersionCode() : pi.versionCode;
                return "v" + pi.versionName + " (build " + code + ")";
            } catch (Throwable t) {
                return "";
            }
        }

        /** Toggle immersive full-screen (persisted; survives restarts). Persist the pref, then let
         *  UiChrome re-apply the shared immersive + inset-padding logic on the UI thread. */
        @JavascriptInterface
        public void setFullscreen(final boolean on) {
            try {
                if (prefs != null) prefs.edit().putBoolean("fullscreen", on).apply();
                runOnUiThread(() -> UiChrome.applyFullscreen(MainActivity.this));
            } catch (Throwable t) {
                Log.e(TAG, "setFullscreen bridge failed", t);
            }
        }

        /** @return whether immersive full-screen is currently enabled (default false). */
        @JavascriptInterface
        public boolean isFullscreen() {
            try {
                return prefs != null && prefs.getBoolean("fullscreen", false);
            } catch (Throwable t) {
                return false;
            }
        }

        /**
         * Persist the app theme so the native screens (NavActivity / MapDownloadActivity chrome)
         * follow the dashboard's light/dark toggle. Stored in the "lb" prefs, default true (dark).
         */
        @JavascriptInterface
        public void setTheme(boolean dark) {
            try {
                Log.i(TAG, "LB.setTheme(dark=" + dark + ")");
                if (prefs != null) prefs.edit().putBoolean("theme_dark", dark).apply();
            } catch (Throwable t) {
                Log.e(TAG, "setTheme bridge failed", t);
            }
        }

        /** Copy text to the Android clipboard (on the UI thread; null/exception-safe). */
        @JavascriptInterface
        public void copyClipboard(final String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                try {
                    android.content.ClipboardManager cm =
                            (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("NAVEE", text));
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "copyClipboard failed", t);
                }
            });
        }

        // ── Debug logging ──

        /** Turn persistent debug logging on/off (persisted; survives restarts). */
        @JavascriptInterface
        public void setDebug(boolean on) {
            try {
                Log.i(TAG, "LB.setDebug(" + on + ")");
                if (debugLog != null) debugLog.setEnabled(on);
            } catch (Throwable t) {
                Log.e(TAG, "setDebug bridge failed", t);
            }
        }

        /** @return whether debug logging is currently enabled. */
        @JavascriptInterface
        public boolean isDebug() {
            try {
                return debugLog != null && debugLog.isEnabled();
            } catch (Throwable t) {
                Log.e(TAG, "isDebug bridge failed", t);
                return false;
            }
        }

        /** Share the debug log file via a system chooser (email/message/etc.). */
        @JavascriptInterface
        public void exportLogs() {
            runOnUiThread(() -> {
                try {
                    File f = debugLog != null ? debugLog.getLogFile() : null;
                    if (f == null || !f.exists() || f.length() == 0) {
                        Toast.makeText(MainActivity.this, "No logs yet", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    Uri uri = FileProvider.getUriForFile(
                            MainActivity.this, getPackageName() + ".fileprovider", f);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.putExtra(Intent.EXTRA_SUBJECT, "NAVEE Edition debug log");
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, "Send debug log");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(chooser);
                } catch (Throwable t) {
                    Log.e(TAG, "exportLogs failed", t);
                    try {
                        Toast.makeText(MainActivity.this, "Export failed", Toast.LENGTH_SHORT).show();
                    } catch (Throwable ignored) {
                    }
                }
            });
        }

        // ── Ride logging ──

        /** @return whether ride logging is currently enabled (persisted; default false). */
        @JavascriptInterface
        public boolean isRideLogging() {
            try {
                return rideLogger != null && rideLogger.isEnabled();
            } catch (Throwable t) {
                Log.e(TAG, "isRideLogging bridge failed", t);
                return false;
            }
        }

        /** Turn ride logging on/off (persisted). Requests notification permission on first enable. */
        @JavascriptInterface
        public void setRideLogging(boolean on) {
            try {
                Log.i(TAG, "LB.setRideLogging(" + on + ")");
                if (rideLogger != null) rideLogger.setEnabled(on);
                if (on) maybeRequestPostNotifications();
            } catch (Throwable t) {
                Log.e(TAG, "setRideLogging bridge failed", t);
            }
        }

        /**
         * @return a JSON array string of the (at most 3) newest rides, newest first. Each entry:
         * {@code {"id","start","end","durationSec","distanceKm","samples"}}. "[]" if none.
         */
        @JavascriptInterface
        public String listRides() {
            try {
                String s = rideLogger != null ? rideLogger.listRides() : "[]";
                return s;
            } catch (Throwable t) {
                Log.e(TAG, "listRides bridge failed", t);
                return "[]";
            }
        }

        /** Delete a recorded ride by id. No-op if the id is unknown / invalid. */
        @JavascriptInterface
        public void deleteRide(String id) {
            try {
                Log.i(TAG, "LB.deleteRide(" + id + ")");
                if (rideLogger != null) rideLogger.deleteRide(id);
            } catch (Throwable t) {
                Log.e(TAG, "deleteRide bridge failed", t);
            }
        }

        /** Delete every recorded ride. */
        @JavascriptInterface
        public void deleteAllRides() {
            try {
                Log.i(TAG, "LB.deleteAllRides()");
                if (rideLogger != null) rideLogger.deleteAllRides();
            } catch (Throwable t) {
                Log.e(TAG, "deleteAllRides bridge failed", t);
            }
        }

        /** Open an external http(s) URL in the system browser. Ignores anything that is not http/https. */
        @JavascriptInterface
        public void openUrl(final String url) {
            try {
                Log.i(TAG, "LB.openUrl(" + url + ")");
                if (url == null) return;
                final String u = url.trim();
                if (!u.startsWith("http://") && !u.startsWith("https://")) return;
                runOnUiThread(() -> {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Throwable t) {
                        Log.e(TAG, "openUrl start failed", t);
                    }
                });
            } catch (Throwable t) {
                Log.e(TAG, "openUrl bridge failed", t);
            }
        }

        /** Export a ride ("csv"/"json") and share it via the system chooser. No-op if id is unknown. */
        @JavascriptInterface
        public void exportRide(final String id, final String format) {
            Log.i(TAG, "LB.exportRide(" + id + ", " + format + ")");
            runOnUiThread(() -> {
                try {
                    File f = rideLogger != null ? rideLogger.exportRide(id, format) : null;
                    if (f == null || !f.exists() || f.length() == 0) {
                        Toast.makeText(MainActivity.this, "Ride not found", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    boolean csv = "csv".equalsIgnoreCase(format);
                    Uri uri = FileProvider.getUriForFile(
                            MainActivity.this, getPackageName() + ".fileprovider", f);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(csv ? "text/csv" : "application/json");
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.putExtra(Intent.EXTRA_SUBJECT, "Laufbursche Edition ride log");
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, "Share ride");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(chooser);
                } catch (Throwable t) {
                    Log.e(TAG, "exportRide failed", t);
                    try {
                        Toast.makeText(MainActivity.this, "Export failed", Toast.LENGTH_SHORT).show();
                    } catch (Throwable ignored) {
                    }
                }
            });
        }

        /**
         * Write GPX text into the phone's public Downloads folder. Synchronous so the page can
         * report the real outcome instead of assuming one.
         *
         * @return JSON {@code {"ok":true,"name":"<file actually written>"}} or
         * {@code {"ok":false,"name":"<requested>","error":"<code>"}} with code "downloads"
         * (no access to the folder), "createfile", "writer" or "save".
         */
        @JavascriptInterface
        public String saveGpxToDownloads(final String fileName, final String content) {
            final String name = safeGpxName(fileName);
            try {
                Log.i(TAG, "LB.saveGpxToDownloads(" + name + ")");
                if (content == null) return gpxResult(false, name, "save");
                return saveGpxViaMediaStore(name, content);
            } catch (Throwable t) {
                Log.e(TAG, "saveGpxToDownloads failed", t);
                return gpxResult(false, name, "save");
            }
        }
    }

    /** Downloads collection write through MediaStore. Needs no storage permission. */
    private String saveGpxViaMediaStore(String name, String content) {
        ContentResolver cr = getContentResolver();
        Uri item = null;
        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
            cv.put(MediaStore.Downloads.MIME_TYPE, "application/gpx+xml");
            cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            // Pending keeps a half-written file invisible; MediaStore also de-duplicates the name.
            cv.put(MediaStore.Downloads.IS_PENDING, 1);
            item = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (item == null) return gpxResult(false, name, "createfile");

            OutputStream out = cr.openOutputStream(item);
            if (out == null) {
                cr.delete(item, null, null);
                return gpxResult(false, name, "writer");
            }
            try {
                out.write(content.getBytes(StandardCharsets.UTF_8));
                out.flush();
            } finally {
                out.close();
            }

            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(item, done, null, null);
            return gpxResult(true, gpxDisplayName(cr, item, name), null);
        } catch (Throwable t) {
            Log.e(TAG, "saveGpx MediaStore write failed", t);
            if (item != null) {
                try {
                    cr.delete(item, null, null);
                } catch (Throwable ignored) {
                }
            }
            return gpxResult(false, name, "save");
        }
    }


    /** The name MediaStore settled on, which differs from the request when it de-duplicated. */
    private String gpxDisplayName(ContentResolver cr, Uri uri, String fallback) {
        try (Cursor c = cr.query(uri, new String[]{MediaStore.Downloads.DISPLAY_NAME},
                null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String s = c.getString(0);
                if (s != null && !s.isEmpty()) return s;
            }
        } catch (Throwable t) {
            Log.e(TAG, "saveGpx name lookup failed", t);
        }
        return fallback;
    }

    /** Never overwrite an existing export: ride.gpx becomes ride (1).gpx. */
    private static File gpxFreeFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, stem + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return f;
    }

    /** Keep the page's name from escaping the Downloads folder or losing its extension. */
    private static String safeGpxName(String raw) {
        String s = raw == null ? "" : raw.trim().replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_");
        if (s.isEmpty()) s = "navee";
        if (!s.toLowerCase(Locale.US).endsWith(".gpx")) s = s + ".gpx";
        return s;
    }

    private static String gpxResult(boolean ok, String name, String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", ok);
            o.put("name", name == null ? "" : name);
            if (error != null) o.put("error", error);
            return o.toString();
        } catch (Throwable t) {
            return ok ? "{\"ok\":true}" : "{\"ok\":false}";
        }
    }

    /** Best-effort: ask for POST_NOTIFICATIONS when ride logging is first enabled (Android 13+). */
    private void maybeRequestPostNotifications() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> {
                    try {
                        requestPermissions(
                                new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PERMS);
                    } catch (Throwable ignored) {
                    }
                });
            }
        } catch (Throwable ignored) {
        }
    }
}
