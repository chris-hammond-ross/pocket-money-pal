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
}
