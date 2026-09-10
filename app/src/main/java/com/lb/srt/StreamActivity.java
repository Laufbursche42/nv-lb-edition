// Laufbursche Edition - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.srt;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.util.Log;

/** Transparent activity that requests MediaProjection permission and starts StreamService with the URL. */
public class StreamActivity extends Activity {

    private static final String TAG = "lbsrt";
    private static final int REQ_PROJ = 9527;
    private String url;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        url = getIntent().getStringExtra("url");
        Log.i(TAG, "StreamActivity onCreate, url=" + StreamService.redact(url));
        // Video only: no microphone -> no RECORD_AUDIO request, go straight to screen capture.
        requestProjection();
    }

    private void requestProjection() {
        MediaProjectionManager mpm =
                (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJ);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        Log.i(TAG, "onActivityResult req=" + req + " res=" + res + " data=" + (data != null));
        if (req == REQ_PROJ && res == RESULT_OK && data != null) {
            Intent svc = new Intent(this, StreamService.class);
            svc.putExtra("url", url);
            svc.putExtra("code", res);
            svc.putExtra("data", data);
            // minSdk is 26, so a foreground service start is always available here.
            startForegroundService(svc);
        } else {
            StreamService.setStatus("cancelled");
        }
        finish();
    }
}
