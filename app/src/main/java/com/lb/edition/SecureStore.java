// Laufbursche Edition (NAVEE) - an app for NAVEE e-scooters.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Source-available under the PolyForm Noncommercial License 1.0.0 with Additional Terms. See license.md.

package com.lb.edition;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small value store encrypted with an AES-256-GCM key held in the AndroidKeyStore. The key never
 * leaves the keystore, so the stored value is unreadable to other apps, to device backups and to
 * anyone reading the raw prefs file. Used for the account id needed to auth a bound scooter.
 */
final class SecureStore {

    private static final String TAG = "lbsec";
    private static final String KEY_ALIAS = "lb_secure_v1";
    private static final String PREFS = "lb_secure";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_LEN = 12;

    private final SharedPreferences prefs;

    SecureStore(Context ctx) {
        prefs = ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Store a string encrypted, or clear it when value is null/empty. */
    void putString(String name, String value) {
        if (value == null || value.isEmpty()) { remove(name); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(value.getBytes("UTF-8"));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            prefs.edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).apply();
        } catch (Throwable t) {
            Log.e(TAG, "putString failed", t);
            remove(name);
        }
    }

    /** Decrypt a stored string, or return null if absent / unreadable. */
    String getString(String name) {
        String blob = prefs.getString(name, null);
        if (blob == null) return null;
        try {
            byte[] all = Base64.decode(blob, Base64.NO_WRAP);
            if (all.length <= IV_LEN) return null;
            byte[] iv = new byte[IV_LEN];
            byte[] ct = new byte[all.length - IV_LEN];
            System.arraycopy(all, 0, iv, 0, IV_LEN);
            System.arraycopy(all, IV_LEN, ct, 0, ct.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(c.doFinal(ct), "UTF-8");
        } catch (Throwable t) {
            Log.e(TAG, "getString failed", t);
            return null;
        }
    }

    boolean has(String name) { return prefs.contains(name); }

    void remove(String name) {
        try { prefs.edit().remove(name).apply(); } catch (Throwable ignored) {}
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(KEY_ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }
}
