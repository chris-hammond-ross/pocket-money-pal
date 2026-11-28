package com.pocketmoneypal.parent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.pocketmoneypal.shell.NativeBridge;
import com.pocketmoneypal.shell.ShellWebView;
import com.pocketmoneypal.shell.ShellWebViewClient;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.List;

/**
 * The parents' app (ADR 0033, ADR 0035): the family server's {@code /parent} in a WebView, as
 * an ordinary portrait app with the status bar and navigation showing. Every screen and rule is
 * the server's; the app only does what a page can't:
 *
 * <ul>
 *   <li><b>First run</b> (and after unpairing): "Scan the code on the family screen" with
 *       Google's code scanner, or type the address. The scanned link opens in the WebView and
 *       pairing is the normal web flow.
 *   <li><b>Addresses</b> ({@link Addresses}): opens the secure address (the relay) when it
 *       answers, the home address when it doesn't, and carries the device token between them.
 *       Turning on remote access switches the app over by itself.
 *   <li><b>Offline</b>: HTTPS has the page's service worker (ADR 0017). On plain HTTP the page is
 *       retried from the WebView's own cache; with nothing cached, "Can't reach the family PC".
 *   <li><b>The bridge</b> ({@link NativeBridge}): {@code info}, {@code scanQr},
 *       {@code openExternal}, {@code session} and {@code push.*}, for the family's own
 *       addresses only.
 *   <li><b>Notifications</b> ({@link Push}, ADR 0037): Android's question, the subscription the
 *       page stores, and a tapped notification opening its page (in place, when it's open).
 * </ul>
 */
public final class MainActivity extends Activity implements NativeBridge.Handler {
    private static final String TAG = "PmpParent";
    private static final String HOME_PATH = "/parent";
    /** Back from the background after this long: check the app is on the best address. */
    private static final long RECHECK_AFTER_MS = 60_000;
    private static final List<String> FEATURES = Arrays.asList("scanQr", "openExternal", "session", "push");
    private static final int ASK_NOTIFICATIONS = 1;
    /** {@code NATIVE_OPEN_EVENT} in @pmp/shared. */
    private static final String OPEN_EVENT = "pmp:open";

    private final Handler main = new Handler(Looper.getMainLooper());
    private Addresses addresses;
    private FrameLayout content;
    private WebView web;
    private NativeBridge bridge;
    private LinearLayout firstRun;
    private LinearLayout status;
    private TextView statusTitle;
    private TextView statusText;
    private Button retry;
    /** Bumped on each attempt to open the app, so an older attempt's result is ignored. */
    private int openId;
    /** The page being loaded comes from the WebView's cache (offline on plain HTTP). */
    private boolean fromCache;
    /** The main page failed: the error page that follows mustn't be shown. */
    private boolean pageFailed;
    /** Main-page failures in a row: after a few, stop trying and say so. */
    private int failures;
    private static final int MAX_FAILURES = 3;
    private long pausedAt;
    /** The page's push.permission waiting on Android's question. */
    private NativeBridge.Reply askingNotifications;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        addresses = new Addresses(this);
        Notifications.createChannel(this);
        buildViews();
        if (addresses.isEmpty()) showFirstRun();
        else open(tappedPath(getIntent()));
    }

    /** A notification tapped while the app is running (ADR 0037). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String path = intent.getStringExtra(Notifications.EXTRA_URL);
        if (path == null || !Notifications.isParentPath(path) || addresses.isEmpty()) return;
        String url = web.getUrl();
        boolean pageOpen = web.getVisibility() == View.VISIBLE && url != null
                && addresses.isKnown(Addresses.originOf(Uri.parse(url)));
        if (pageOpen) {
            // The page opens the tray or tab in place, keeping whatever the parent had open.
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent(" + JSONObject.quote(OPEN_EVENT)
                    + ", { detail: " + JSONObject.quote(path) + " }))", null);
        } else {
            open(path);
        }
    }

    /** Where to open: a tapped notification's page, else the app's home. */
    private static String tappedPath(Intent intent) {
        String path = intent == null ? null : intent.getStringExtra(Notifications.EXTRA_URL);
        return Notifications.isParentPath(path) ? path : HOME_PATH;
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        boolean away = pausedAt > 0 && SystemClock.elapsedRealtime() - pausedAt > RECHECK_AFTER_MS;
        pausedAt = 0;
        if (status.getVisibility() == View.VISIBLE && retry.getVisibility() == View.VISIBLE) {
            open(HOME_PATH); // was "Can't reach": try again by itself
        } else if (away) {
            switchToPreferred();
        }
    }

    @Override
    protected void onPause() {
        pausedAt = SystemClock.elapsedRealtime();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        openId++;
        web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------------
    // Views: the WebView, the first-run screen, and a status screen (connecting / can't reach).

    private void buildViews() {
        content = new FrameLayout(this);
        content.setBackgroundColor(getColor(R.color.parent_background));
        fitBetweenSystemBars(content);

        web = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        // JavaScript, storage, sounds without a tap, the text size fixed at 100% (as every app).
        ShellWebView.configure(web);
        ShellWebView.markUserAgent(web, BuildConfig.VERSION_NAME, "parent");
        web.setBackgroundColor(getColor(R.color.parent_background));
        web.setWebViewClient(new ParentClient());
        web.setVisibility(View.INVISIBLE);
        bridge = new NativeBridge(web, "parent", BuildConfig.VERSION_NAME, FEATURES, this);
        content.addView(web, matchParent());

        firstRun = column();
        firstRun.addView(text("🐷", 64, false));
        firstRun.addView(text(getString(R.string.first_run_title), 26, true));
        firstRun.addView(text(getString(R.string.first_run_text), 18, false), spaced(16));
        firstRun.addView(button(getString(R.string.scan), true, v -> scanFirstRun()), spaced(32));
        firstRun.addView(button(getString(R.string.type_address), false, v -> askForAddress()), spaced(12));
        TextView hint = text(getString(R.string.first_run_hint), 14, false);
        hint.setTextColor(getColor(R.color.parent_dim_text));
        firstRun.addView(hint, spaced(32));
        firstRun.setVisibility(View.GONE);
        content.addView(firstRun, matchParent());

        status = column();
        statusTitle = text("", 22, true);
        status.addView(statusTitle);
        statusText = text("", 16, false);
        statusText.setTextColor(getColor(R.color.parent_dim_text));
        status.addView(statusText, spaced(12));
        retry = button(getString(R.string.try_again), true, v -> open(HOME_PATH));
        status.addView(retry, spaced(24));
        status.setVisibility(View.GONE);
        content.addView(status, matchParent());

        setContentView(content);
    }

    /**
     * A standard app: the status bar and navigation show, with the page's navy behind them.
     * Android 15+ draws every app edge to edge, so the content is padded by the bars (and by the
     * keyboard, so it never covers a text box). Older versions are put edge to edge the same way,
     * so it behaves alike everywhere.
     */
    @SuppressWarnings("deprecation")
    private void fitBetweenSystemBars(View view) {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            view.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        } else {
            view.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            view.setOnApplyWindowInsetsListener((v, insets) -> {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            });
        }
    }

    private void showFirstRun() {
        openId++;
        web.setVisibility(View.INVISIBLE);
        status.setVisibility(View.GONE);
        firstRun.setVisibility(View.VISIBLE);
    }

    private void showStatus(int title, Integer text, boolean canRetry) {
        firstRun.setVisibility(View.GONE);
        statusTitle.setText(title);
        statusText.setText(text == null ? "" : getString(text));
        statusText.setVisibility(text == null ? View.GONE : View.VISIBLE);
        retry.setVisibility(canRetry ? View.VISIBLE : View.GONE);
        status.setVisibility(View.VISIBLE);
    }

    private void showPage() {
        firstRun.setVisibility(View.GONE);
        status.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
    }

    private LinearLayout column() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        int pad = dp(32);
        column.setPadding(pad, pad, pad, pad);
        column.setBackgroundColor(getColor(R.color.parent_background));
        return column;
    }

    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(getColor(R.color.parent_text));
        view.setGravity(Gravity.CENTER);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private Button button(String label, boolean primary, View.OnClickListener onClick) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, primary ? 18 : 15);
        if (primary) {
            button.setBackgroundColor(getColor(R.color.parent_button));
            button.setTextColor(getColor(R.color.parent_button_text));
            button.setTypeface(Typeface.DEFAULT_BOLD);
            int pad = dp(16);
            button.setPadding(dp(28), pad, dp(28), pad);
        } else {
            button.setBackgroundColor(android.graphics.Color.TRANSPARENT);
            button.setTextColor(getColor(R.color.parent_text));
        }
        button.setOnClickListener(onClick);
        return button;
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
    }

    private LinearLayout.LayoutParams spaced(int topDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(topDp);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ---------------------------------------------------------------------------------------
    // Opening the app: the best address that answers, else the last page from the cache.

    /** Opens {@code path} on the first known address that answers. */
    private void open(String path) {
        List<String> candidates = addresses.candidates();
        if (candidates.isEmpty()) {
            showFirstRun();
            return;
        }
        if (web.getVisibility() != View.VISIBLE) showStatus(R.string.connecting, null, false);
        int id = ++openId;
        new Thread(() -> {
            String found = null;
            for (String origin : candidates) {
                if (id != openId) return;
                if (Addresses.healthy(origin)) {
                    found = origin;
                    break;
                }
            }
            String answering = found;
            main.post(() -> {
                if (id != openId) return;
                if (answering != null) load(answering, answering + path, false);
                else {
                    // Nothing answers: the last page from the cache (plain HTTP), or the service
                    // worker's copy (HTTPS). Failing that, "Can't reach" (onReceivedError).
                    String last = addresses.current() != null ? addresses.current() : candidates.get(0);
                    load(last, last + path, true);
                }
            });
        }, "open-family-pc").start();
    }

    /** Loads {@code url} on {@code origin}, which becomes the current address. */
    private void load(String origin, String url, boolean cacheOnly) {
        addresses.setCurrent(origin);
        addresses.shareToken();
        bridge.setOrigins(addresses.candidates());
        fromCache = cacheOnly;
        pageFailed = false;
        // The cache-only mode lasts for this page's own loading; onPageFinished puts it back, so
        // the page's requests to the PC go to the network again.
        web.getSettings().setCacheMode(cacheOnly ? WebSettings.LOAD_CACHE_ONLY : WebSettings.LOAD_DEFAULT);
        web.loadUrl(url);
    }

    /** Moves to the preferred address (the relay) when the app isn't on it and it answers. */
    private void switchToPreferred() {
        String preferred = addresses.preferred();
        String current = addresses.current();
        if (preferred == null || preferred.equals(current) || !addresses.paired()) return;
        int id = ++openId;
        new Thread(() -> {
            if (!Addresses.healthy(preferred)) return;
            main.post(() -> {
                if (id == openId) load(preferred, preferred + HOME_PATH, false);
            });
        }, "switch-address").start();
    }

    private void showUnreachable() {
        web.setVisibility(View.INVISIBLE);
        showStatus(R.string.unreachable_title, R.string.unreachable_text, true);
    }

    /** The family's pages stay in the app; other links open in the browser. */
    private final class ParentClient extends ShellWebViewClient {
        @Override
        protected boolean isOwnOrigin(Uri url) {
            return addresses.isKnown(Addresses.originOf(url));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            // A pairing link for another address (a code scanned from the page's Pair screen):
            // the app moves there, as when it's scanned on the first-run screen.
            if (!isOwnOrigin(url) && Addresses.isPairingLink(url) && request.isForMainFrame()) {
                String origin = Addresses.originOf(url);
                addresses.setCurrent(origin);
                bridge.setOrigins(addresses.candidates());
                return false;
            }
            return super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (fromCache) {
                fromCache = false;
                web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            }
            if (!pageFailed && isOwnOrigin(Uri.parse(url))) {
                failures = 0;
                showPage();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Log.w(TAG, "page didn't load: " + error.getDescription());
            failed(request.getUrl());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            // The relay answers 502–504 while the PC is off. A service worker's copy never gets here.
            int code = response.getStatusCode();
            if (request.isForMainFrame() && code >= 502 && code <= 504) failed(request.getUrl());
        }

        private void failed(Uri url) {
            pageFailed = true;
            web.setVisibility(View.INVISIBLE);
            if (fromCache || ++failures >= MAX_FAILURES) {
                fromCache = false;
                failures = 0;
                web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
                showUnreachable();
                return;
            }
            String origin = Addresses.originOf(url);
            if (origin == null) {
                showUnreachable();
                return;
            }
            // Try every address again; with none answering, the page from the cache.
            String path = url.getEncodedPath() == null ? HOME_PATH : url.getEncodedPath();
            if (url.getEncodedQuery() != null) path += "?" + url.getEncodedQuery();
            open(path);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "WebView renderer gone; recreating");
            content.removeView(web);
            web.destroy();
            recreate();
            return true;
        }
    }

    // ---------------------------------------------------------------------------------------
    // First run: scan the kiosk's code, or type the address.

    private void scanFirstRun() {
        scan(text -> {
            Uri url = Uri.parse(text.trim());
            if (!Addresses.isPairingLink(url)) {
                Toast.makeText(this, R.string.not_a_code, Toast.LENGTH_LONG).show();
                return;
            }
            String origin = Addresses.originOf(url);
            showStatus(R.string.connecting, null, false);
            load(origin, url.toString(), false);
        }, () -> { /* closed the scanner */ }, error -> Toast.makeText(this, R.string.scanner_failed, Toast.LENGTH_LONG).show());
    }

    private void askForAddress() {
        EditText input = new EditText(this);
        input.setHint(R.string.address_hint);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        FrameLayout box = new FrameLayout(this);
        int pad = dp(20);
        box.setPadding(pad, dp(8), pad, 0);
        box.addView(input);
        new AlertDialog.Builder(this)
                .setTitle(R.string.address_title)
                .setMessage(R.string.address_message)
                .setView(box)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.address_go, (dialog, which) -> openTyped(input.getText().toString()))
                .show();
    }

    private void openTyped(String typed) {
        String origin = Addresses.typedOrigin(typed);
        if (origin == null) {
            Toast.makeText(this, R.string.address_bad, Toast.LENGTH_LONG).show();
            return;
        }
        showStatus(R.string.connecting, null, false);
        int id = ++openId;
        new Thread(() -> {
            boolean up = Addresses.healthy(origin);
            main.post(() -> {
                if (id != openId) return;
                if (up) load(origin, origin + HOME_PATH, false);
                else {
                    showFirstRun();
                    Toast.makeText(this, getString(R.string.address_unreachable, origin), Toast.LENGTH_LONG).show();
                }
            });
        }, "typed-address").start();
    }

    // ---------------------------------------------------------------------------------------
    // The code scanner (Google Play services: no camera permission, its own screen).

    private interface Got<T> {
        void accept(T value);
    }

    private void scan(Got<String> onCode, Runnable onCancel, Got<Exception> onError) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        scanner.startScan()
                .addOnSuccessListener(code -> {
                    String text = code.getRawValue();
                    if (text == null) onError.accept(new IllegalStateException("no text in the code"));
                    else onCode.accept(text);
                })
                .addOnCanceledListener(onCancel::run)
                .addOnFailureListener(e -> {
                    Log.w(TAG, "scanner failed", e);
                    onError.accept(e);
                });
    }

    // ---------------------------------------------------------------------------------------
    // The bridge: what the page asks of the app (besides info and openExternal, in the shell).

    @Override
    public boolean onRequest(String type, JSONObject request, NativeBridge.Reply reply) {
        switch (type) {
            case "scanQr":
                scan(text -> {
                    try {
                        reply.ok(new JSONObject().put("text", text));
                    } catch (org.json.JSONException e) {
                        reply.error("failed", null);
                    }
                }, () -> reply.error("cancelled", null), e -> reply.error("failed", e.getMessage()));
                return true;
            case "session":
                onSession(request);
                reply.ok(null);
                return true;
            case "push.permission":
                onPushPermission(request.optBoolean("ask"), reply);
                return true;
            case "push.subscribe":
                if (!"granted".equals(notificationPermission())) {
                    reply.error("denied", null);
                    return true;
                }
                new Thread(() -> {
                    try {
                        reply.ok(Push.subscribe(getApplicationContext()));
                    } catch (Exception e) {
                        Log.w(TAG, "push subscribe failed", e);
                        reply.error("failed", "Couldn't set up notifications. Check this phone is online.");
                    }
                }, "push-subscribe").start();
                return true;
            case "push.unsubscribe":
                new Thread(() -> {
                    Push.unsubscribe(getApplicationContext());
                    reply.ok(null);
                }, "push-unsubscribe").start();
                return true;
            default:
                return false;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Notifications: Android's question (13+), asked from the page's opt-in or Setup switch.

    private void onPushPermission(boolean ask, NativeBridge.Reply reply) {
        String state = notificationPermission();
        if (ask && "prompt".equals(state) && Build.VERSION.SDK_INT >= 33) {
            if (askingNotifications != null) askingNotifications.error("cancelled", null);
            askingNotifications = reply;
            Push.markAskedPermission(this);
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, ASK_NOTIFICATIONS);
            return;
        }
        replyPermission(reply, state);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != ASK_NOTIFICATIONS || askingNotifications == null) return;
        NativeBridge.Reply reply = askingNotifications;
        askingNotifications = null;
        replyPermission(reply, notificationPermission());
    }

    private void replyPermission(NativeBridge.Reply reply, String state) {
        try {
            reply.ok(new JSONObject().put("state", state).put("subscribed", Push.enabled(this)));
        } catch (org.json.JSONException e) {
            reply.error("failed", null);
        }
    }

    /**
     * {@code granted}, {@code prompt} (Android can still ask) or {@code denied} (turned off in
     * Android's settings, or refused for good). Android 13+ asks; older versions allow
     * notifications unless they're switched off in settings.
     */
    @SuppressWarnings("InlinedApi")
    private String notificationPermission() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(Notifications.CHANNEL);
        boolean channelOff = channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE;
        if (manager.areNotificationsEnabled()) return channelOff ? "denied" : "granted";
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && (!Push.askedPermission(this)
                        || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            return "prompt";
        }
        return "denied";
    }

    private void onSession(JSONObject session) {
        if (session.optBoolean("paired")) {
            addresses.setPaired(originOrNull(session, "secureUrl"), originOrNull(session, "lanUrl"));
            addresses.shareToken();
            bridge.setOrigins(addresses.candidates());
            switchToPreferred();
        } else if (addresses.paired()) {
            checkUnpaired();
        }
    }

    private static String originOrNull(JSONObject session, String key) {
        if (session.isNull(key)) return null;
        return Addresses.originOf(Uri.parse(session.optString(key)));
    }

    /**
     * The page says this phone isn't paired. Before forgetting everything, ask the server with
     * the token the app knows: the token may just be missing on this address (a fallback the
     * copy didn't reach), and then it's copied again rather than unpairing the phone.
     */
    private void checkUnpaired() {
        String origin = addresses.current();
        String token = addresses.token();
        // No token anywhere the app can read: nothing to check it with, so leave the page's
        // own Pair screen rather than forgetting the family's addresses.
        if (origin == null || token == null) return;
        new Thread(() -> {
            int code = Addresses.pairingStatus(origin, token);
            main.post(() -> {
                if (code == 200) {
                    addresses.shareToken();
                    open(HOME_PATH);
                } else if (code == 401) {
                    forgetPairing();
                }
                // Couldn't ask: leave things be; the page will say again.
            });
        }, "check-unpaired").start();
    }

    /** Unpaired from another phone, or Unpair all: back to the first-run scanner. */
    private void forgetPairing() {
        Log.i(TAG, "unpaired: back to the first-run screen");
        addresses.clear();
        Push.forget(this);
        WebStorage.getInstance().deleteAllData();
        web.clearCache(true);
        bridge.setOrigins(addresses.candidates());
        web.loadUrl("about:blank");
        showFirstRun();
    }
}
