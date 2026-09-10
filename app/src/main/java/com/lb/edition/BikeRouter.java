// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.mapsforge.core.model.BoundingBox;

import btools.router.OsmNodeNamed;
import btools.router.OsmPathElement;
import btools.router.OsmTrack;
import btools.router.RoutingContext;
import btools.router.RoutingEngine;

/** Offline bicycle routing via BRouter (btools) over on-demand 5°×5° .rd5 segment tiles. */
final class BikeRouter {

    /** Base URL for BRouter routing segments (5°×5° tiles). ODbL OpenStreetMap data. */
    static final String SEGMENT_BASE_URL = "https://brouter.de/brouter/segments4/";

    private BikeRouter() {}

    /** Routing failed in a way we can present to the user (no route, engine error, …). */
    static final class RoutingException extends Exception {
        RoutingException(String msg) { super(msg); }
    }

    /** A computed route: geometry (lat/lon pairs) plus total distance. */
    static final class RouteResult {
        final List<double[]> points = new ArrayList<>(); // each is {lat, lon}
        int distanceMeters;
    }

    // ─────────────────────────────────────────────── profile / assets ──

    /** Copies the default "trekking" profile + lookup into profileDir, returns the profile file. */
    static File ensureProfile(Context ctx, File profileDir) throws IOException {
        return ensureProfile(ctx, profileDir, "trekking");
    }

    /** Copies profile brouter/<profileBase>.brf + lookups.dat into profileDir, returns the .brf file. */
    static File ensureProfile(Context ctx, File profileDir, String profileBase) throws IOException {
        if (!profileDir.exists() && !profileDir.mkdirs() && !profileDir.isDirectory()) {
            throw new IOException("cannot create " + profileDir);
        }
        File brf = new File(profileDir, profileBase + ".brf");
        File lookups = new File(profileDir, "lookups.dat");
        copyAssetIfChanged(ctx, "brouter/" + profileBase + ".brf", brf);
        copyAssetIfChanged(ctx, "brouter/lookups.dat", lookups);
        return brf;
    }

    /** Copies asset to dest when dest is missing or its bytes differ from the bundled asset. */
    private static void copyAssetIfChanged(Context ctx, String assetPath, File dest) throws IOException {
        byte[] asset = readAll(ctx.getAssets().open(assetPath));
        if (dest.isFile() && dest.length() == asset.length && Arrays.equals(readFile(dest), asset)) {
            return;
        }
        OutputStream out = new FileOutputStream(dest);
        try {
            out.write(asset);
            out.flush();
        } finally {
            try { out.close(); } catch (IOException ignored) { }
        }
    }

    /** Read a (small) input stream fully, always closing it. */
    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 15);
            byte[] buf = new byte[1 << 15];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }

    /** Read a (small) file fully into memory. */
    private static byte[] readFile(File f) throws IOException {
        return readAll(new FileInputStream(f));
    }

    // ─────────────────────────────────────────────── segment tiles ──

    /** SW-corner index (multiple of 5, may be negative) of the 5° tile containing {@code deg}. */
    private static int floor5(double deg) {
        return (int) Math.floor(deg / 5.0) * 5;
    }

    /** BRouter tile name for a SW corner, e.g. lon=5,lat=45 → "E5_N45"; lon=-5 → "W5". */
    static String tileName(int lonFloor, int latFloor) {
        String lonPart = lonFloor >= 0 ? "E" + lonFloor : "W" + (-lonFloor);
        String latPart = latFloor >= 0 ? "N" + latFloor : "S" + (-latFloor);
        return lonPart + "_" + latPart;
    }

    /** Tile names covering the two points' bounding box, expanded by marginDeg. */
    static List<String> tilesFor(double lat1, double lon1, double lat2, double lon2, double marginDeg) {
        double minLat = Math.min(lat1, lat2) - marginDeg;
        double maxLat = Math.max(lat1, lat2) + marginDeg;
        double minLon = Math.min(lon1, lon2) - marginDeg;
        double maxLon = Math.max(lon1, lon2) + marginDeg;
        List<String> tiles = new ArrayList<>();
        for (int lat = floor5(minLat); lat <= floor5(maxLat); lat += 5) {
            for (int lon = floor5(minLon); lon <= floor5(maxLon); lon += 5) {
                String t = tileName(lon, lat);
                if (!tiles.contains(t)) tiles.add(t);
            }
        }
        return tiles;
    }

    /** Tile names covering the given bounding box, expanded by marginDeg. */
    static List<String> tilesFor(BoundingBox bb, double marginDeg) {
        return tilesFor(bb.minLatitude, bb.minLongitude, bb.maxLatitude, bb.maxLongitude, marginDeg);
    }

    // ─────────────────────────────────────────────── routing ──

    /** Computes a bike route start->end over segmentDir using profileFile. Runs synchronously. */
    static RouteResult route(File segmentDir, File profileFile,
                             double fromLat, double fromLon, double toLat, double toLon)
            throws RoutingException {
        RoutingContext rc = new RoutingContext();
        rc.localFunction = profileFile.getAbsolutePath(); // BRouter parses the profile from here

        List<OsmNodeNamed> waypoints = new ArrayList<>();
        waypoints.add(node(fromLon, fromLat, "from"));
        waypoints.add(node(toLon, toLat, "to"));

        RoutingEngine engine = new RoutingEngine(null, null, segmentDir, waypoints, rc, 0);
        engine.quite = true;
        engine.doRun(0);

        String err = engine.getErrorMessage();
        if (err != null) throw new RoutingException(err);

        OsmTrack track = engine.getFoundTrack();
        if (track == null || track.nodes == null || track.nodes.isEmpty()) {
            throw new RoutingException("no route found");
        }

        RouteResult result = new RouteResult();
        for (OsmPathElement e : track.nodes) {
            double lat = e.getILat() / 1_000_000.0 - 90.0;
            double lon = e.getILon() / 1_000_000.0 - 180.0;
            result.points.add(new double[]{lat, lon});
        }
        result.distanceMeters = track.distance;
        return result;
    }

    /** BRouter integer coordinate convention: ilon=(lon+180)*1e6, ilat=(lat+90)*1e6. */
    private static OsmNodeNamed node(double lon, double lat, String name) {
        OsmNodeNamed n = new OsmNodeNamed();
        n.ilon = (int) ((lon + 180.0) * 1_000_000.0 + 0.5);
        n.ilat = (int) ((lat + 90.0) * 1_000_000.0 + 0.5);
        n.name = name;
        return n;
    }
}
