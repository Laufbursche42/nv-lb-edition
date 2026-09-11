// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Native ride recorder: one NDJSON file per ride, arms on first movement, samples every 60 s. */
public final class RideLogger {

    private static final String TAG = "lbridelog";
    private static final String PREFS = "lb";                 // shared with BleManager
    private static final String KEY_ENABLED = "ride_logging"; // default false
    private static final String RIDES_DIR = "rides";
    private static final String EXPORT_DIR = "exports";       // under cacheDir (FileProvider cache-path)
    private static final long SAMPLE_INTERVAL_MS = 60_000L;   // one sample per minute after arming


    // Headline CSV columns emitted first (when present), then the rest alphabetically.
    private static final String[] CSV_HEADLINE = {"speed", "soc", "driveMode", "packMv", "packMa", "soh"};

    private final Context appCtx;
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean connected = false;
    private boolean armed = false;
    private String latestSnapshot = null;
    private Writer writer = null;

    RideLogger(Context ctx) {
        this.appCtx = ctx != null ? ctx.getApplicationContext() : null;
    }

    // ── Toggle (persisted in the "lb" prefs) ──

    /** @return the persisted ride-logging flag (default false). */
    public boolean isEnabled() {
        try {
            if (appCtx == null) return false;
            return appCtx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean(KEY_ENABLED, false);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Persist the flag; turning it off mid-ride finalizes the current ride. */
    public synchronized void setEnabled(boolean on) {
        try {
            if (appCtx != null) {
                appCtx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean(KEY_ENABLED, on).apply();
            }
            // Turning off mid-ride closes out the current ride now.
            if (!on) finalizeRide();
        } catch (Throwable t) {
            Log.e(TAG, "setEnabled failed", t);
        }
    }

    // ── BLE session callbacks (forwarded from MainActivity) ──

    /** Begin a potential session: reset state, no writing yet. */
    public synchronized void onConnected() {
        try {
            finalizeRide();            // defensive: close any ride left over from a previous link
            connected = true;
            armed = false;
            latestSnapshot = null;
        } catch (Throwable t) {
            Log.e(TAG, "onConnected failed", t);
        }
    }

    /** Finalize the current ride (if any) and clear the session. */
    public synchronized void onDisconnected() {
        try {
            finalizeRide();
            connected = false;
            latestSnapshot = null;
        } catch (Throwable t) {
            Log.e(TAG, "onDisconnected failed", t);
        }
    }

    /** Keep the latest snapshot; arm the ride on the first movement while enabled and connected. */
    public synchronized void onLiveData(String json) {
        try {
            if (json == null) return;
            latestSnapshot = json;
            if (armed || !connected || !isEnabled()) return;
            if (speedOf(json) > 0.0) arm();
        } catch (Throwable t) {
            Log.e(TAG, "onLiveData failed", t);
        }
    }

    // ── Arm / sample / finalize ──

    private void arm() {
        try {
            File dir = ridesDir();
            if (dir == null) {
                Log.e(TAG, "arm: no rides dir");
                return;
            }
            long now = System.currentTimeMillis();
            File f = PathGuard.childOf(dir, "ride-" + now + ".ndjson");
            Writer w;
            try {
                w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(f, true), "UTF-8"));
            } catch (Throwable t) {
                Log.e(TAG, "arm: open writer failed", t);
                return;
            }
            writer = w;
            armed = true;
            // First sample immediately (t=0).
            writeSample(latestSnapshot);
            startService();
            main.postDelayed(sampleTask, SAMPLE_INTERVAL_MS);
            Log.i(TAG, "ride armed: " + f.getName());
        } catch (Throwable t) {
            Log.e(TAG, "arm failed", t);
        }
    }

    private final Runnable sampleTask = new Runnable() {
        @Override
        public void run() {
            synchronized (RideLogger.this) {
                if (!armed) return;
                writeSample(latestSnapshot);
                main.postDelayed(this, SAMPLE_INTERVAL_MS);
            }
        }
    };

    // Round to 3 decimals so the derived SI values stay compact in the log.
    private static double round3(double v) { return Math.round(v * 1000.0) / 1000.0; }

    private void writeSample(String json) {
        if (json == null) return;
        Writer w = writer;
        if (w == null) return;
        // Enrich each NDJSON line with the canonical field names + SI units the LEAT desktop tool reads.
        String line = json;
        try {
            JSONObject o = new JSONObject(json);
            if (o.has("speed"))    o.put("realSpeed", o.optDouble("speed"));
            if (o.has("soc"))      o.put("SOC", o.optDouble("soc"));
            boolean haveV = o.has("packMv"), haveA = o.has("packMa");
            double volPack = haveV ? o.optDouble("packMv") / 1000.0 : 0.0;   // mV -> V
            double current = haveA ? o.optDouble("packMa") / 1000.0 : 0.0;   // mA -> A (discharge positive)
            if (haveV) o.put("VolPack", round3(volPack));
            if (haveA) o.put("current", round3(current));
            if (haveV && haveA) o.put("power", round3(volPack * current / 1000.0));   // V*A -> kW
            if (o.has("tripMile")) o.put("singleMile", o.optDouble("tripMile"));
            if (o.has("tripAvg"))  o.put("avgSpeed", o.optDouble("tripAvg"));
            if (o.has("tripMax"))  o.put("maxSpeed", o.optDouble("tripMax"));
            line = o.toString();
        } catch (Throwable t) {
            line = json;   // defensive: on any parse error write the original line unchanged
        }
        try {
            w.write(line);   // one compact JSON object per line (NDJSON)
            w.write('\n');
            w.flush();       // flush immediately so an app kill loses at most this minute
        } catch (Throwable t) {
            Log.e(TAG, "writeSample failed", t);
        }
    }

    private void finalizeRide() {
        boolean wasArmed = armed;
        armed = false;
        main.removeCallbacks(sampleTask);
        closeWriter();
        if (wasArmed) stopService();
    }

    private void closeWriter() {
        Writer w = writer;
        writer = null;
        if (w != null) {
            try { w.flush(); } catch (Throwable ignored) { }
            try { w.close(); } catch (Throwable ignored) { }
        }
    }

    // ── Foreground service control ──

    private void startService() {
        try {
            if (appCtx == null) return;
            // minSdk is 26, so a foreground service always starts via startForegroundService().
            appCtx.startForegroundService(new Intent(appCtx, RideLoggerService.class));
        } catch (Throwable t) {
            Log.e(TAG, "startService failed", t);
        }
    }

    private void stopService() {
        try {
            if (appCtx == null) return;
            appCtx.stopService(new Intent(appCtx, RideLoggerService.class));
        } catch (Throwable t) {
            Log.e(TAG, "stopService failed", t);
        }
    }

    // ── Ride listing / export (called from the JS bridge) ──

    /** @return JSON array string, newest first, of all recorded rides ("[]" if none). */
    public synchronized String listRides() {
        try {
            File dir = ridesDir();
            if (dir == null) return "[]";
            File[] files = listRideFiles(dir);
            if (files == null || files.length == 0) return "[]";
            Arrays.sort(files, (a, b) -> Long.compare(rideIdOf(b), rideIdOf(a))); // newest first
            JSONArray arr = new JSONArray();
            for (File f : files) {
                arr.put(metaFrom(readSamples(f), rideIdOf(f)));
            }
            return arr.toString();
        } catch (Throwable t) {
            Log.e(TAG, "listRides failed", t);
            return "[]";
        }
    }

    /** Build a csv/json export for a ride under cacheDir/exports; null if unknown or on failure. */
    public synchronized File exportRide(String id, String format) {
        try {
            // Parse the id to a number and rebuild every file name from that long. No string derived
            // from the caller reaches a path, so traversal is impossible by construction.
            long rid = parseId(id);
            if (rid <= 0) return null;
            File src = PathGuard.childOf(ridesDir(), "ride-" + rid + ".ndjson");
            if (!src.isFile()) return null;
            File outDir = new File(appCtx.getCacheDir(), EXPORT_DIR);
            if (!outDir.exists() && !outDir.mkdirs()) {
                Log.e(TAG, "exportRide: cannot create export dir");
                return null;
            }
            boolean csv = "csv".equalsIgnoreCase(format);
            File out = PathGuard.childOf(outDir, "ride-" + rid + (csv ? ".csv" : ".json"));
            List<JSONObject> samples = readSamples(src);
            if (csv) writeCsv(samples, out);
            else writeJson(samples, rid, out);
            return (out.isFile() && out.length() > 0) ? out : null;
        } catch (Throwable t) {
            Log.e(TAG, "exportRide failed", t);
            return null;
        }
    }

    /** Delete one recorded ride by id (no-op for an unknown or invalid id). */
    public synchronized void deleteRide(String id) {
        try {
            long rid = parseId(id);
            if (rid <= 0) return;
            File f = PathGuard.childOf(ridesDir(), "ride-" + rid + ".ndjson");
            if (!f.isFile()) return;
            if (!f.delete()) {
                Log.w(TAG, "deleteRide: could not delete " + f.getName());
            }
        } catch (Throwable t) {
            Log.e(TAG, "deleteRide failed", t);
        }
    }

    // ── JSON export ──

    private void writeJson(List<JSONObject> samples, long id, File out) {
        Writer w = null;
        try {
            // LEAT reads a bare top-level array of sample objects; a {meta,samples} wrapper makes it abort.
            JSONArray arr = new JSONArray();
            for (JSONObject o : samples) arr.put(o);
            w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(out, false), "UTF-8"));
            w.write(arr.toString());
            w.flush();
        } catch (Throwable t) {
            Log.e(TAG, "writeJson failed", t);
        } finally {
            if (w != null) try { w.close(); } catch (Throwable ignored) { }
        }
    }

    // ── CSV export (all main-screen values, flattened) ──

    private void writeCsv(List<JSONObject> samples, File out) {
        // Column universe: every scalar key present, PLUS every unique top[]/bottom[] name.
        Set<String> scalarKeys = new HashSet<>();
        Set<String> names = new LinkedHashSet<>();
        for (JSONObject o : samples) {
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                if ("top".equals(k) || "bottom".equals(k)) continue;
                Object v = o.opt(k);
                if (v instanceof JSONArray || v instanceof JSONObject) continue; // scalars only
                scalarKeys.add(k);
            }
            collectNames(o.optJSONArray("top"), names);
            collectNames(o.optJSONArray("bottom"), names);
        }
        // A top/bottom name that duplicates a scalar key is dropped (the scalar already carries it).
        List<String> nameCols = new ArrayList<>();
        for (String n : names) if (!scalarKeys.contains(n)) nameCols.add(n);
        Set<String> nameColSet = new HashSet<>(nameCols);

        // Column order: ts, headline scalars (when present), then the rest alphabetically.
        List<String> cols = new ArrayList<>();
        cols.add("ts");
        Set<String> placed = new HashSet<>();
        placed.add("ts");
        for (String h : CSV_HEADLINE) {
            if (scalarKeys.contains(h)) { cols.add(h); placed.add(h); }
        }
        List<String> rest = new ArrayList<>();
        for (String k : scalarKeys) if (!placed.contains(k)) rest.add(k);
        rest.addAll(nameCols);
        Collections.sort(rest, (a, b) -> {
            int c = a.compareToIgnoreCase(b);
            return c != 0 ? c : a.compareTo(b);
        });
        cols.addAll(rest);

        // Flatten cellMv into cell1_mV..cellN_mV columns.
        int maxCells = 0;
        for (JSONObject o : samples) {
            JSONArray cm = o.optJSONArray("cellMv");
            if (cm != null) maxCells = Math.max(maxCells, cm.length());
        }
        Map<String, Integer> cellIdx = new HashMap<>();
        for (int c = 1; c <= maxCells; c++) {
            String cn = "cell" + c + "_mV";
            cols.add(cn);
            cellIdx.put(cn, c - 1);
        }

        // Plain UTF-8, no BOM, starting with the "ts," header.
        try (Writer w = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(out, false), "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < cols.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(csvCell(cols.get(i)));
            }
            sb.append("\r\n");
            w.write(sb.toString());

            for (JSONObject o : samples) {
                Map<String, String> nvals = new HashMap<>();
                if (!nameColSet.isEmpty()) {
                    putNamedValues(o.optJSONArray("top"), nvals, nameColSet);
                    putNamedValues(o.optJSONArray("bottom"), nvals, nameColSet);
                }
                long ts = o.optLong("ts", 0);
                sb.setLength(0);
                for (int i = 0; i < cols.size(); i++) {
                    if (i > 0) sb.append(',');
                    String col = cols.get(i);
                    String cell;
                    if ("ts".equals(col)) cell = ts > 0 ? Long.toString(ts) : "";
                    else if (nameColSet.contains(col)) cell = nvals.containsKey(col) ? nvals.get(col) : "";
                    else if (cellIdx.containsKey(col)) {
                        JSONArray cm = o.optJSONArray("cellMv");
                        int idx = cellIdx.get(col);
                        cell = (cm != null && idx < cm.length()) ? String.valueOf(cm.optInt(idx, 0)) : "";
                    }
                    else cell = scalarCell(o, col);
                    sb.append(csvCell(cell));
                }
                sb.append("\r\n");
                w.write(sb.toString());
            }
            w.flush();
        } catch (Throwable t) {
            Log.e(TAG, "writeCsv failed", t);
        }
    }

    // ── Metadata derivation ──

    /** Metadata for one ride, derived from its samples (no "fin" - export adds that). */
    private static JSONObject metaFrom(List<JSONObject> samples, long id) {
        long start = 0, end = 0;
        double firstMile = Double.NaN, lastMile = Double.NaN;
        for (JSONObject o : samples) {
            long ts = o.optLong("ts", 0);
            if (ts > 0) {
                if (start == 0) start = ts;
                end = ts;
            }
            double mile = o.optDouble("totalMile", Double.NaN);
            if (!Double.isNaN(mile)) {
                if (Double.isNaN(firstMile)) firstMile = mile;
                lastMile = mile;
            }
        }
        if (start == 0) start = id;      // fallback to the filename epoch
        if (end == 0) end = start;
        long durationSec = (end - start) / 1000L;
        if (durationSec < 0) durationSec = 0;
        double distanceKm = 0;
        if (!Double.isNaN(firstMile) && !Double.isNaN(lastMile)) distanceKm = lastMile - firstMile;
        if (distanceKm < 0) distanceKm = 0;
        JSONObject meta = new JSONObject();
        try {
            meta.put("id", String.valueOf(id));
            meta.put("start", start);
            meta.put("end", end);
            meta.put("durationSec", (int) durationSec);
            meta.put("distanceKm", round2(distanceKm));
            meta.put("samples", samples.size());
        } catch (JSONException ignored) {
        }
        return meta;
    }

    // ── File / parsing helpers ──

    private File ridesDir() {
        try {
            if (appCtx == null) return null;
            File dir = appCtx.getExternalFilesDir(RIDES_DIR);
            if (dir != null && !dir.exists() && !dir.mkdirs() && !dir.exists()) {
                Log.e(TAG, "ridesDir: mkdirs failed: " + dir);
            }
            return dir;
        } catch (Throwable t) {
            return null;
        }
    }

    private static File[] listRideFiles(File dir) {
        return dir.listFiles((d, name) -> name.startsWith("ride-") && name.endsWith(".ndjson"));
    }

    /** Delete every recorded ride. @return the number of ride files deleted. */
    public synchronized int deleteAllRides() {
        int n = 0;
        try {
            File dir = ridesDir();
            if (dir == null) return 0;
            File[] files = listRideFiles(dir);
            if (files == null) return 0;
            for (File f : files) {
                try { if (f.delete()) n++; } catch (Throwable ignored) { }
            }
        } catch (Throwable t) {
            Log.e(TAG, "deleteAllRides failed", t);
        }
        return n;
    }

    /** @return the {@code <startEpochMs>} parsed from a {@code ride-<epoch>.ndjson} file name or 0. */
    private static long rideIdOf(File f) {
        try {
            String n = f.getName();
            int a = n.indexOf('-');
            int b = n.lastIndexOf('.');
            if (a >= 0 && b > a + 1) return Long.parseLong(n.substring(a + 1, b));
        } catch (Throwable ignored) {
        }
        return 0L;
    }

    /** Read a ride's NDJSON into parsed sample objects, skipping blank / unparsable lines. */
    private static List<JSONObject> readSamples(File f) {
        List<JSONObject> out = new ArrayList<>();
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                try { out.add(new JSONObject(line)); } catch (Throwable ignored) { }
            }
        } catch (Throwable t) {
            Log.e(TAG, "readSamples failed", t);
        } finally {
            if (r != null) try { r.close(); } catch (Throwable ignored) { }
        }
        return out;
    }

    private static void collectNames(JSONArray arr, Set<String> out) {
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e == null) continue;
            String name = e.optString("name", "");
            if (!name.isEmpty()) out.add(name);
        }
    }

    private static void putNamedValues(JSONArray arr, Map<String, String> out, Set<String> wanted) {
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e == null) continue;
            String name = e.optString("name", "");
            if (name.isEmpty() || !wanted.contains(name)) continue;
            out.put(name, e.optString("value", ""));
        }
    }

    private static String scalarCell(JSONObject o, String key) {
        Object v = o.opt(key);
        if (v == null || v == JSONObject.NULL) return "";
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return "";
            if (d == Math.rint(d)) return Long.toString((long) d);
            return Double.toString(d);
        }
        return String.valueOf(v);
    }

    private static String csvCell(String s) {
        if (s == null || s.isEmpty()) return "";
        boolean quote = s.indexOf(',') >= 0 || s.indexOf('"') >= 0
                || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0
                || s.charAt(0) == ' ' || s.charAt(s.length() - 1) == ' ';
        if (!quote) return s;
        return "\"" + s.replace("\"", "\"\"") + "\"";
    }

    /** Road speed of a snapshot; "speed" is the only key FrameParser emits for it. */
    private static double speedOf(String json) {
        try {
            return new JSONObject(json).optDouble("speed", 0.0);
        } catch (Throwable t) {
            return 0.0;
        }
    }

    /**
     * Parse an all-digit ride id (an epoch-ms value) to a positive long, or 0 if it is not a plain
     * positive number. Callers rebuild the file name from the returned long, so no caller-supplied
     * string ever reaches a path - traversal is impossible by construction.
     */
    private static long parseId(String id) {
        if (id == null) return 0L;
        String s = id.trim();
        if (s.isEmpty() || s.length() > 18) return 0L;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') return 0L;
        }
        try { return Long.parseLong(s); } catch (Throwable t) { return 0L; }
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
