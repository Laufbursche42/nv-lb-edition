// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import java.util.Locale;

/** Wraps built-in TextToSpeech using only already-installed voice data. */
final class TtsHelper {

    private static final String TAG = "lbnav";

    private TextToSpeech tts;
    private volatile boolean ready = false;

    TtsHelper(Context context, Locale preferred) {
        try {
            tts = new TextToSpeech(context.getApplicationContext(), status -> {
                if (status != TextToSpeech.SUCCESS) {
                    Log.w(TAG, "TTS init failed: " + status);
                    return;
                }
                try {
                    // Try preferred locale, then US, then device default.
                    if (trySet(preferred) || trySet(Locale.US) || trySet(Locale.getDefault())) {
                        ready = true;
                    } else {
                        Log.w(TAG, "no usable TTS voice installed; voice guidance disabled");
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "TTS setLanguage failed", t);
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "TTS construction failed", t);
        }
    }

    /** @return true if the engine accepted this locale (its voice data is present). */
    private boolean trySet(Locale loc) {
        if (loc == null || tts == null) return false;
        try {
            int r = tts.setLanguage(loc);
            return r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** True once the engine is initialized and a usable voice is set. */
    boolean isReady() {
        return ready && tts != null;
    }

    /** Speak the given English text, flushing anything currently queued. No-op if not ready. */
    void speak(String text) {
        if (!ready || tts == null || text == null || text.isEmpty()) return;
        try {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "lbnav");
        } catch (Throwable t) {
            Log.w(TAG, "TTS speak failed", t);
        }
    }

    /** Stop any current utterance immediately (e.g. when voice is toggled off). */
    void stop() {
        try {
            if (tts != null) tts.stop();
        } catch (Throwable ignored) {
        }
    }

    /** Release the engine. Call from the host Activity's {@code onDestroy}. */
    void shutdown() {
        try {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
            }
        } catch (Throwable ignored) {
        } finally {
            tts = null;
            ready = false;
        }
    }
}
