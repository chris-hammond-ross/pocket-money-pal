package com.pocketmoneypal.shell;

import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Keeps the app on its own server's pages: a link anywhere else (a help page) opens in the
 * browser instead (ADR 0034). Each app says which addresses are its own.
 */
public abstract class ShellWebViewClient extends WebViewClient {
    private static final String TAG = "PmpShell";

    /** The address is one of this app's own pages, shown in the app. */
    protected abstract boolean isOwnOrigin(Uri url);

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (isOwnOrigin(url)) return false;
        try {
            view.getContext().startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (RuntimeException e) {
            Log.w(TAG, "no app to open " + url);
        }
        return true;
    }
}
