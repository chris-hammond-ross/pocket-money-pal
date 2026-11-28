package com.pocketmoneypal.parent;

import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

/**
 * What FCM delivers (ADR 0036, ADR 0037): the gateway's data message
 * {@code { v: "1", enc: "aes128gcm", body: <base64url> }}, holding the server's Web Push
 * message exactly as it was encrypted for this phone. It's decrypted with this phone's keys and
 * shown. Nothing about a message is logged beyond why it was dropped.
 */
public final class PushService extends FirebaseMessagingService {
    private static final String TAG = "PmpPush";

    @Override
    public void onMessageReceived(RemoteMessage remote) {
        Map<String, String> data = remote.getData();
        if (!Push.enabled(this)) {
            Log.i(TAG, "notifications are off; dropped");
            return;
        }
        String body = data.get("body");
        if (!"1".equals(data.get("v")) || !"aes128gcm".equals(data.get("enc")) || body == null) {
            Log.w(TAG, "not a message this app reads; dropped");
            return;
        }
        PushKeys keys = PushKeys.load(this);
        if (keys == null) {
            Log.w(TAG, "no keys to read it with; dropped");
            return;
        }
        try {
            byte[] plain = WebPushCrypto.decrypt(
                    Base64.getUrlDecoder().decode(body), keys.privateKey, keys.publicRaw, keys.auth);
            JSONObject message = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            Notifications.show(this,
                    message.optString("title", "Pocket Money Pal"),
                    message.optString("body", ""),
                    message.optString("tag", "claims"),
                    message.optString("url", "/parent"));
        } catch (Exception e) {
            // Not for these keys (an old subscription), or damaged: nothing to show.
            Log.w(TAG, "couldn't read a message: " + e.getClass().getSimpleName());
        }
    }

    @Override
    public void onNewToken(String token) {
        if (Push.enabled(this)) Push.resubscribeInBackground(this, token);
    }
}
