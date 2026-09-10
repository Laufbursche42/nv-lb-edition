// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import java.io.File;
import java.io.IOException;

/** Path-traversal guard: verifies resolved paths stay inside an app-owned base directory. */
final class PathGuard {

    private PathGuard() {}

    /** Resolves {@code name} under {@code baseDir}, only if it stays inside. */
    static File childOf(File baseDir, String name) throws IOException {
        return ensureInside(baseDir, new File(baseDir, name));
    }

    /** Returns {@code target} only if its canonical path stays inside {@code baseDir}. */
    static File ensureInside(File baseDir, File target) throws IOException {
        String base = baseDir.getCanonicalPath();
        String path = target.getCanonicalPath();
        if (!path.equals(base) && !path.startsWith(base + File.separator)) {
            throw new IOException("path escapes base directory: " + target);
        }
        return target;
    }
}
