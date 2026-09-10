// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.app.Activity;
import android.content.Context;
import android.view.View;
import android.view.Window;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** Applies the immersive full-screen preference to any Activity, managing system-bar insets as padding. */
final class UiChrome {
    private UiChrome() {}

    // Marker so the OnApplyWindowInsetsListener is only installed once per content view.
    private static final String INSET_TAG = "lb_inset_listener";

    /** Dark title-bar colour; system bars are tinted to this. */
    static final int BAR_COLOR = 0xFF111420;

    static void applyFullscreen(final Activity a) {
        try {
            boolean fs = a.getSharedPreferences("lb", Context.MODE_PRIVATE).getBoolean("fullscreen", false);
            Window w = a.getWindow();
            View decor = w.getDecorView();
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, decor);
            // Always edge-to-edge: WE manage the insets (padding below), never the framework, so the
            // status-bar behaviour is identical on the WebView and the native activities.
            WindowCompat.setDecorFitsSystemWindows(w, false);

            // Tint the system bars to the dark title-bar colour with light icons.
            try {
                w.setStatusBarColor(BAR_COLOR);
                w.setNavigationBarColor(BAR_COLOR);
            } catch (Throwable ignored) {}
            c.setAppearanceLightStatusBars(false);      // dark bar => light (white) icons
            c.setAppearanceLightNavigationBars(false);

            if (fs) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }

            // Manage content-view padding for the system-bar insets; install listener once.
            final View content = a.findViewById(android.R.id.content);
            if (content != null) {
                // The status/nav-bar strips are the content view's OWN top/bottom padding, so its
                // background paints them the dark title-bar colour on every API level.
                content.setBackgroundColor(BAR_COLOR);
                if (!INSET_TAG.equals(content.getTag())) {
                    content.setTag(INSET_TAG);
                    ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
                        try {
                            boolean fsNow = a.getSharedPreferences("lb", Context.MODE_PRIVATE)
                                    .getBoolean("fullscreen", false);
                            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                            int top = fsNow ? 0 : bars.top;
                            int bottom = fsNow ? 0 : bars.bottom;
                            v.setPadding(v.getPaddingLeft(), top, v.getPaddingRight(), bottom);
                        } catch (Throwable ignored) {}
                        // Consume: children see zero insets, so nothing else can add top/bottom inset.
                        return WindowInsetsCompat.CONSUMED;
                    });
                }
                ViewCompat.requestApplyInsets(content);
            }
        } catch (Throwable ignored) {}
    }
}
