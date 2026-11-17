package com.pocketmoneypal.kiosk;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The kids' screen: {@code /kiosk} from the server on this device, full screen like a game
 * (ADR 0001, ADR 0029). It holds no business logic. It starts the server, waits for it, and asks
 * once each for notifications and the battery-optimisation exemption. It's an ordinary app on a
 * family tablet, not a locked kiosk (ADR 0032): Back leaves it, the screen sleeps as usual, and
 * the server carries on in its service.
 */
public final class MainActivity extends Activity {
    static final String BASE_URL = "http://localhost:" + ServerService.PORT;
    private static final String KIOSK_URL = BASE_URL + "/kiosk";
    private static final long START_TIMEOUT_MS = 45_000;

    private static final String PREFS = "shell";
    private static final String ASKED_NOTIFICATIONS = "askedNotifications";
    private static final String ASKED_BATTERY = "askedBattery";

    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private LinearLayout status;
    private TextView statusText;
    private Button retry;
    private SharedPreferences prefs;
    /** Bumped on each wait, so an older wait's result is ignored. */
    private int waitId;
    /** The kiosk page failed to load; the error page that follows mustn't be shown. */
    private boolean pageFailed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildViews();
        startServerAndWait();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        waitId++;
        web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------------
    // Views: the WebView, and a status message (starting / couldn't start) over it.

    @SuppressLint("SetJavaScriptEnabled")
    private void buildViews() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Sounds are part of the game; don't wait for a tap before playing them (as Electron).
        settings.setMediaPlaybackRequiresUserGesture(false);
        // The kiosk sets its own sizes; Android's font-size setting would break its layout.
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        web.setWebViewClient(new KioskClient());
        web.setVisibility(View.INVISIBLE);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        status = new LinearLayout(this);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setGravity(Gravity.CENTER);
        int pad = dp(32);
        status.setPadding(pad, pad, pad, pad);
        statusText = new TextView(this);
        statusText.setTextSize(22);
        statusText.setTextColor(Color.rgb(0x16, 0x15, 0x25));
        statusText.setGravity(Gravity.CENTER);
        status.addView(statusText);
        retry = new Button(this);
        retry.setText(R.string.try_again);
        retry.setOnClickListener(v -> startServerAndWait());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        retryParams.topMargin = dp(24);
        status.addView(retry, retryParams);
        root.addView(status, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void showStatus(int text, boolean canRetry) {
        statusText.setText(text);
        retry.setVisibility(canRetry ? View.VISIBLE : View.GONE);
        status.setVisibility(View.VISIBLE);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ---------------------------------------------------------------------------------------
    // The server: start it (a no-op if it's running) and wait for /api/health.

    private void startServerAndWait() {
        showStatus(R.string.starting, false);
        try {
            ServerService.start(this);
        } catch (RuntimeException e) {
            Log.e(ServerService.TAG, "couldn't start the server service", e);
        }
        int id = ++waitId;
        new Thread(() -> {
            boolean up = waitForHealth(id);
            main.post(() -> {
                if (id != waitId) return;
                if (up) {
                    pageFailed = false;
                    web.loadUrl(KIOSK_URL);
                } else showStatus(R.string.start_failed, true);
            });
        }, "wait-for-server").start();
    }

    private boolean waitForHealth(int id) {
        long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline && id == waitId) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(BASE_URL + "/api/health").openConnection();
                c.setConnectTimeout(1000);
                c.setReadTimeout(2000);
                int code = c.getResponseCode();
                c.disconnect();
                if (code == 200) return true;
            } catch (Exception e) {
                // not up yet
            }
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return false;
    }

    private final class KioskClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isServer(url)) return false;
            // Anything else (a help link) opens in the browser, not in the kiosk.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (RuntimeException e) {
                Log.w(ServerService.TAG, "no app to open " + url);
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!pageFailed && web.getVisibility() != View.VISIBLE && isServer(Uri.parse(url))) {
                web.setVisibility(View.VISIBLE);
                status.setVisibility(View.GONE);
                main.postDelayed(MainActivity.this::askOnce, 1500);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // The page itself failed: the server has stopped. Start it again and reload.
            if (request.isForMainFrame()) {
                pageFailed = true;
                Log.w(ServerService.TAG, "kiosk didn't load: " + error.getDescription());
                web.setVisibility(View.INVISIBLE);
                startServerAndWait();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The WebView's renderer crashed or was killed for memory: start the screen afresh.
            Log.w(ServerService.TAG, "WebView renderer gone; recreating");
            root.removeView(web);
            web.destroy();
            recreate();
            return true;
        }
    }

    private static boolean isServer(Uri url) {
        String host = url.getHost();
        return "http".equals(url.getScheme())
                && ("localhost".equals(host) || "127.0.0.1".equals(host))
                && url.getPort() == ServerService.PORT;
    }

    // ---------------------------------------------------------------------------------------
    // Full screen: the system bars hidden (a swipe shows them for a moment).

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Asked once each, after the kiosk first shows: notifications (so the server's notification
    // shows), then the battery exemption (ADR 0029).

    private void askOnce() {
        if (isFinishing()) return;
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean(ASKED_NOTIFICATIONS, false)) {
            prefs.edit().putBoolean(ASKED_NOTIFICATIONS, true).apply();
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
                return; // onRequestPermissionsResult comes back here
            }
        }
        if (!prefs.getBoolean(ASKED_BATTERY, false)) {
            prefs.edit().putBoolean(ASKED_BATTERY, true).apply();
            askForBatteryExemption();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        main.postDelayed(this::askOnce, 300);
    }

    /** Android's own "let it run in the background?" dialog, unless it's already allowed. */
    @SuppressLint("BatteryLife")
    private void askForBatteryExemption() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power.isIgnoringBatteryOptimizations(getPackageName())) return;
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            Log.w(ServerService.TAG, "no battery-optimisation dialog", e);
        }
    }
}
