package com.pocketmoneypal.shell;

import android.annotation.SuppressLint;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * The WebView setup every app shares (ADR 0034). The apps show the server's pages; these
 * settings make them behave as they do in Electron on the PC.
 */
public final class ShellWebView {
    private ShellWebView() {}

    @SuppressLint("SetJavaScriptEnabled")
    public static void configure(WebView web) {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Sounds are part of the game; don't wait for a tap before playing them (as Electron).
        settings.setMediaPlaybackRequiresUserGesture(false);
        // The pages set their own sizes; Android's font-size setting would break their layout.
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
    }

    /**
     * Adds the app to the WebView's user agent, {@code PocketMoneyPal/<version> (android; <app>)},
     * so the server can tell the parents' app from a browser (ADR 0033, {@code deviceClientOf}).
     * The page itself goes by the bridge, not this.
     */
    public static void markUserAgent(WebView web, String version, String app) {
        WebSettings settings = web.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " PocketMoneyPal/" + version + " (android; " + app + ")");
    }
}
