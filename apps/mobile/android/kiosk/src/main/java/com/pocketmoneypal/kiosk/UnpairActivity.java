package com.pocketmoneypal.kiosk;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * "Unpair all phones": the tablet's version of the PC tray's item (ADR 0030). It's Android's
 * "Additional settings in the app" (Settings → Apps → Kids Board), not a notification
 * action, because kids can reach the notification shade (ADR 0032). With no paired phone, the
 * first phone to scan the kids' screen's QR code pairs as a parent, so this asks for the device's
 * screen lock first (the device's own lock, not an app PIN: ADR 0008), then confirms. With no
 * screen lock set, it only confirms, and says how to set one.
 *
 * <p>It calls {@code POST /api/devices/unpair-all}; the server does the work (ADR 0001). A
 * request from this device counts as the PC, and sends no {@code Origin}, which the route requires.
 */
public final class UnpairActivity extends Activity {
    private static final int THEME = android.R.style.Theme_DeviceDefault_Light_Dialog_Alert;
    private static final int CONFIRM_CREDENTIAL = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) return; // the lock or the dialog is already showing
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (keyguard == null || !keyguard.isDeviceSecure()) confirm(false);
        else askForScreenLock(keyguard);
    }

    /**
     * The device's PIN, pattern or password. Not fingerprints or faces: on a shared tablet a
     * kid's may be enrolled.
     */
    @SuppressWarnings("deprecation")
    private void askForScreenLock(KeyguardManager keyguard) {
        String title = getString(R.string.unpair_lock_title);
        String subtitle = getString(R.string.unpair_lock_subtitle);
        if (Build.VERSION.SDK_INT >= 30) {
            BiometricPrompt prompt = new BiometricPrompt.Builder(this)
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .build();
            prompt.authenticate(new CancellationSignal(), getMainExecutor(),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            confirm(true);
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence message) {
                            finish(); // cancelled, or too many tries
                        }
                    });
        } else {
            Intent intent = keyguard.createConfirmDeviceCredentialIntent(title, subtitle);
            if (intent == null) confirm(false);
            else startActivityForResult(intent, CONFIRM_CREDENTIAL);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CONFIRM_CREDENTIAL) return;
        if (resultCode == RESULT_OK) confirm(true);
        else finish();
    }

    private void confirm(boolean locked) {
        if (isFinishing()) return;
        String message = getString(R.string.unpair_message);
        if (!locked) message += getString(R.string.unpair_no_lock);
        new AlertDialog.Builder(this, THEME)
                .setTitle(R.string.unpair_title)
                .setMessage(message)
                .setPositiveButton(R.string.unpair_confirm, (d, w) -> unpair())
                .setNegativeButton(R.string.cancel, (d, w) -> finish())
                .setOnCancelListener(d -> finish())
                .show();
    }

    private void unpair() {
        new Thread(() -> {
            String title;
            String message;
            try {
                int revoked = callUnpairAll();
                Log.i(ServerService.TAG, "unpaired " + revoked + " phone(s) from the app's settings");
                title = revoked == 0
                        ? getString(R.string.unpaired_none)
                        : getResources().getQuantityString(R.plurals.unpaired_count, revoked, revoked);
                message = getString(R.string.unpaired_detail);
            } catch (Exception e) {
                Log.w(ServerService.TAG, "unpair all failed", e);
                title = getString(R.string.unpair_failed);
                message = e.getMessage();
            }
            String shownTitle = title;
            String shownMessage = message;
            runOnUiThread(() -> {
                if (isFinishing()) return;
                new AlertDialog.Builder(this, THEME)
                        .setTitle(shownTitle)
                        .setMessage(shownMessage)
                        .setPositiveButton(R.string.ok, null)
                        .setOnDismissListener(d -> finish())
                        .show();
            });
        }, "unpair-all").start();
    }

    private static int callUnpairAll() throws Exception {
        HttpURLConnection c = (HttpURLConnection)
                new URL("http://127.0.0.1:" + ServerService.PORT + "/api/devices/unpair-all").openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(5000);
            c.setReadTimeout(10000);
            // An empty JSON body. Without one, Android still labels a POST
            // application/x-www-form-urlencoded, which the server refuses with 415.
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            try (OutputStream out = c.getOutputStream()) {
                out.write("{}".getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("The server said " + code + ".");
            return new JSONObject(readAll(c.getInputStream())).getInt("revoked");
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
