package com.pocketmoneypal.parent;

import android.content.Context;
import android.annotation.SuppressLint;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.google.android.gms.tasks.Tasks;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Notifications in the parents' app (ADR 0033, ADR 0036, ADR 0037). The app acts as a Web Push
 * "browser": it keeps its own keys ({@link PushKeys}), gets an FCM token, and hands the page an
 * ordinary subscription whose endpoint is the push gateway. The page stores it on the server like
 * a browser's; the server encrypts to it and posts to the gateway, which forwards through FCM to
 * {@link PushService}.
 *
 * <p>FCM is off until a parent turns notifications on ({@code firebase_messaging_auto_init_enabled}
 * is false in the manifest), so a phone without them never has a token.
 *
 * <p>State is written with {@code commit()}: always off the main thread, and it must be on disk
 * before the page hears "on" or the service's process goes.
 */
@SuppressLint("ApplySharedPref")
final class Push {
    private static final String TAG = "PmpPush";
    /** The push gateway (ADR 0036). One for every build: it keeps no state to stage. */
    static final String GATEWAY = "https://push.pocketmoneypal.app/v1/fcm/";
    private static final String PREFS = "push";
    private static final String ENABLED = "enabled";
    private static final String ASKED = "asked-permission";
    private static final long FCM_WAIT_S = 30;
    private static final int TIMEOUT_MS = 5000;

    private Push() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** A parent turned notifications on in this app, and not off since. */
    static boolean enabled(Context context) {
        return prefs(context).getBoolean(ENABLED, false);
    }

    /** Android's notification question has been asked (to tell "denied" from "not asked"). */
    static boolean askedPermission(Context context) {
        return prefs(context).getBoolean(ASKED, false);
    }

    static void markAskedPermission(Context context) {
        prefs(context).edit().putBoolean(ASKED, true).apply();
    }

    /**
     * Turns notifications on and returns the subscription, as a browser's
     * {@code PushSubscription.toJSON()}. Blocks on FCM: call it off the main thread.
     */
    static JSONObject subscribe(Context context) throws Exception {
        FirebaseMessaging fcm = FirebaseMessaging.getInstance();
        fcm.setAutoInitEnabled(true);
        String token = Tasks.await(fcm.getToken(), FCM_WAIT_S, TimeUnit.SECONDS);
        PushKeys keys = PushKeys.loadOrCreate(context);
        prefs(context).edit().putBoolean(ENABLED, true).commit();
        return subscription(token, keys);
    }

    /**
     * Turns notifications off: forgets the keys and deletes the FCM token, so the old endpoint
     * answers 410 and the server drops it even if it never heard. Blocks: off the main thread.
     */
    static void unsubscribe(Context context) {
        prefs(context).edit().putBoolean(ENABLED, false).commit();
        PushKeys.forget(context);
        Notifications.cancelAll(context);
        FirebaseMessaging fcm = FirebaseMessaging.getInstance();
        fcm.setAutoInitEnabled(false);
        try {
            Tasks.await(fcm.deleteToken(), FCM_WAIT_S, TimeUnit.SECONDS);
        } catch (Exception e) {
            Log.w(TAG, "couldn't delete the FCM token", e);
        }
    }

    /** Unpaired: off, in the background (the server already ignores a revoked phone). */
    static void forget(Context context) {
        Context app = context.getApplicationContext();
        // Never turned on: nothing to undo, and no reason to wake Firebase.
        if (!enabled(app)) return;
        new Thread(() -> unsubscribe(app), "push-forget").start();
    }

    static JSONObject subscription(String token, PushKeys keys) throws JSONException {
        Base64.Encoder base64url = Base64.getUrlEncoder().withoutPadding();
        return new JSONObject()
                .put("endpoint", GATEWAY + token)
                .put("expirationTime", JSONObject.NULL)
                .put("keys", new JSONObject()
                        .put("p256dh", base64url.encodeToString(keys.publicRaw))
                        .put("auth", base64url.encodeToString(keys.auth)));
    }

    /**
     * A new FCM token (ADR 0037): stores the new subscription on the server straight away, with
     * this phone's device token, on the first address that takes it. If none does, the page
     * stores it the next time the app opens. Reads the cookie on the main thread (the WebView's
     * cookie store), then posts off it.
     */
    static void resubscribeInBackground(Context context, String token) {
        Context app = context.getApplicationContext();
        new Handler(Looper.getMainLooper()).post(() -> {
            Addresses addresses = new Addresses(app);
            String device = addresses.token();
            List<String> origins = addresses.candidates();
            if (device == null || origins.isEmpty()) return;
            new Thread(() -> {
                try {
                    String body = subscription(token, PushKeys.loadOrCreate(app)).toString();
                    for (String origin : origins) {
                        int code = post(origin + "/api/devices/me/push-subscription", device, body);
                        if (code >= 200 && code < 300) {
                            Log.i(TAG, "new token stored on the family PC");
                            return;
                        }
                    }
                    Log.i(TAG, "new token not stored yet; the page sends it next time");
                } catch (Exception e) {
                    Log.w(TAG, "couldn't store the new token", e);
                }
            }, "push-resubscribe").start();
        });
    }

    private static int post(String url, String device, String body) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            // Fastify refuses Android's default form type (as the kiosk's Unpair all found).
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Cookie", Addresses.COOKIE + "=" + device);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(bytes);
            }
            int code = c.getResponseCode();
            c.disconnect();
            return code;
        } catch (Exception e) {
            return -1;
        }
    }
}
