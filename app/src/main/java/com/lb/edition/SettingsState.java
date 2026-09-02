// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

/**
 * NAVEE current-settings snapshot, populated from the 0x70 parameter report. Unlike the Teverun
 * platform there is NO full-state serialisation frame: NAVEE settings are written as single-byte
 * opcodes (immobilizer 0x51, cruise 0x52, gear/drive-mode 0x58, start speed 0x6A, region 0x6F ...),
 * so this class only mirrors the reported values so the dashboard can show the current toggle state.
 */
final class SettingsState {

    volatile Integer lock, unit, startSpeed, limitSpeed, limitOn, maxSpeed, driveMode, breakSpeed, cruise, tcs, eco;
    volatile boolean received70 = false;

    /** Update from a decoded 0x70 param data block (offsets into byte[6]+). */
    synchronized void applyReportFrom70(byte[] p) {
        lock = u8(p, 2);
        unit = u8(p, 7);
        startSpeed = u8(p, 19);
        Integer ls = u8(p, 20);
        if (ls != null) { limitSpeed = ls & 0x7f; limitOn = (ls & 0x80) != 0 ? 1 : 0; }
        maxSpeed = u8(p, 25);
        driveMode = u8(p, 26);
        breakSpeed = u8(p, 35);
        cruise = u8(p, 3);
        tcs = u8(p, 11);
        eco = u8(p, 32);
        received70 = true;
    }

    private static Integer u8(byte[] p, int i) { return (i >= 0 && i < p.length) ? (p[i] & 0xFF) : null; }
}
