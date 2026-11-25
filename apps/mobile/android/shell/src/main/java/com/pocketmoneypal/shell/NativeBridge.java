package com.pocketmoneypal.shell;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * The Android side of the page↔app bridge (ADR 0034, contract in
 * {@code packages/shared/src/native-bridge.ts}). It puts {@code pmpNative} in pages from the
 * family's own addresses only ({@link #setOrigins}), never in anything else the WebView shows.
 * Requests are JSON strings with an {@code id} and {@code type}; each gets exactly one answer.
 *
 * <p>The shell answers {@code info} and {@code openExternal} itself; everything else goes to the
 * app's {@link Handler}. A type nobody handles is answered {@code unsupported}, which is how an
 * older app tells a newer page it can't do something.
 *
 * <p>Needs {@code androidx.webkit} in the app (the shell compiles against it only).
 */
public final class NativeBridge {
    /** {@code NATIVE_BRIDGE_VERSION}: bumped only when a message changes incompatibly. */
    public static final int BRIDGE_VERSION = 1;
    /** {@code NATIVE_BRIDGE_OBJECT}. */
    public static final String OBJECT = "pmpNative";
    private static final String TAG = "PmpShell";

    /** What the app does beyond {@code info} and {@code openExternal}. */
    public interface Handler {
        /** Handle {@code type}, answering through {@code reply} once; false if it isn't one of ours. */
        boolean onRequest(String type, JSONObject request, Reply reply);
    }

    /** The one answer to a request. Safe to call from any thread; later calls are ignored. */
    public static final class Reply {
        private final JavaScriptReplyProxy proxy;
        private final String id;
        private final android.os.Handler main = new android.os.Handler(Looper.getMainLooper());
        private boolean sent;

        Reply(JavaScriptReplyProxy proxy, String id) {
            this.proxy = proxy;
            this.id = id;
        }

        public void ok(JSONObject result) {
            JSONObject answer = new JSONObject();
            try {
                answer.put("id", id).put("ok", true).put("result", result == null ? new JSONObject() : result);
            } catch (JSONException e) {
                throw new IllegalStateException(e);
            }
            send(answer);
        }

        /** {@code code}: unsupported, cancelled, denied or failed. */
        public void error(String code, String message) {
            JSONObject answer = new JSONObject();
            try {
                JSONObject error = new JSONObject().put("code", code);
                if (message != null) error.put("message", message);
                answer.put("id", id).put("ok", false).put("error", error);
            } catch (JSONException e) {
                throw new IllegalStateException(e);
            }
            send(answer);
        }

        // Only reached from a listener setOrigins added, which it does only when the feature is there.
        @SuppressLint("RequiresFeature")
        private void send(JSONObject answer) {
            main.post(() -> {
                if (sent) return;
                sent = true;
                try {
                    proxy.postMessage(answer.toString());
                } catch (RuntimeException e) {
                    Log.w(TAG, "the page went before its answer", e);
                }
            });
        }
    }

    private final WebView web;
    private final String app;
    private final String version;
    private final JSONArray features;
    private final Handler handler;
    private Set<String> origins = new LinkedHashSet<>();
    private boolean installed;

    /**
     * @param app "parent" or "kiosk"
     * @param features what the app can do, as named in {@code nativeFeatureSchema}; list only
     *     what's implemented
     */
    public NativeBridge(WebView web, String app, String version, Collection<String> features, Handler handler) {
        this.web = web;
        this.app = app;
        this.version = version;
        this.features = new JSONArray(features);
        this.handler = handler;
    }

    /** This WebView can have the bridge at all (any WebView from the last few years can). */
    public static boolean isSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    /**
     * The origins whose pages get the bridge, e.g. {@code https://k7qm.pocketmoneypal.app} and
     * {@code http://192.168.0.10:4789}. It applies to pages loaded after this call, so call it
     * before loading a new address.
     */
    public void setOrigins(Collection<String> next) {
        Set<String> wanted = new LinkedHashSet<>();
        for (String origin : next) {
            if (origin != null && !origin.isEmpty()) wanted.add(origin);
        }
        if (installed && wanted.equals(origins)) return;
        if (installed) {
            WebViewCompat.removeWebMessageListener(web, OBJECT);
            installed = false;
        }
        origins = wanted;
        if (wanted.isEmpty() || !isSupported()) return;
        try {
            WebViewCompat.addWebMessageListener(web, OBJECT, wanted, this::onMessage);
            installed = true;
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "not a valid origin among " + wanted, e);
        }
    }

    private void onMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame,
            JavaScriptReplyProxy proxy) {
        if (!isMainFrame || message.getData() == null) return;
        JSONObject request;
        String id;
        String type;
        try {
            request = new JSONObject(message.getData());
            id = request.getString("id");
            type = request.getString("type");
        } catch (JSONException e) {
            return; // nothing to answer to
        }
        Reply reply = new Reply(proxy, id);
        try {
            switch (type) {
                case "info":
                    reply.ok(new JSONObject()
                            .put("app", app)
                            .put("version", version)
                            .put("platform", "android")
                            .put("bridgeVersion", BRIDGE_VERSION)
                            .put("features", features));
                    return;
                case "openExternal":
                    openExternal(view.getContext(), request.optString("url"), reply);
                    return;
                default:
                    if (!handler.onRequest(type, request, reply)) reply.error("unsupported", null);
            }
        } catch (JSONException | RuntimeException e) {
            Log.w(TAG, "bridge request " + type + " failed", e);
            reply.error("failed", null);
        }
    }

    private static void openExternal(Context context, String url, Reply reply) throws JSONException {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) {
            reply.error("failed", "Only http and https links open outside the app.");
            return;
        }
        try {
            context.startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            reply.ok(new JSONObject());
        } catch (RuntimeException e) {
            reply.error("failed", "No app can open that link.");
        }
    }
}
