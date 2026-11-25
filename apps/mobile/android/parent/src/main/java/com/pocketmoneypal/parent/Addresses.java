package com.pocketmoneypal.parent;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.CookieManager;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The family's addresses, and this phone's pairing on them (ADR 0035).
 *
 * <ul>
 *   <li><b>secure</b>: the relay (or a hands-on HTTPS address), from the paired page's
 *       {@code session} report. Opened first.
 *   <li><b>lan</b>: the home address, opened when the secure one can't be reached.
 *   <li><b>current</b>: the address the app is on. Before pairing it's the one scanned or typed.
 * </ul>
 *
 * <p>The pairing is the server's {@code pmp_device} cookie, which the WebView keeps per address.
 * The same device token works on every address of the same server, so the app copies it between
 * them ({@link #shareToken}): the phone stays one paired device, whichever address it opens.
 */
final class Addresses {
    static final String COOKIE = "pmp_device";
    /** As the server's own cookie: 400 days, refreshed by the server as the phone is used. */
    private static final int COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
    private static final int TIMEOUT_MS = 3000;
    private static final int DEFAULT_PORT = 4789;
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    private static final String PREFS = "addresses";
    private static final String SECURE = "secure";
    private static final String LAN = "lan";
    private static final String CURRENT = "current";
    private static final String PAIRED = "paired";

    private final SharedPreferences prefs;

    Addresses(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    String secure() { return prefs.getString(SECURE, null); }
    String lan() { return prefs.getString(LAN, null); }
    String current() { return prefs.getString(CURRENT, null); }
    /** The paired page has reported in since the last unpairing. */
    boolean paired() { return prefs.getBoolean(PAIRED, false); }

    /** Nothing to open: first run, or unpaired. */
    boolean isEmpty() { return candidates().isEmpty(); }

    /** The address to be on when it answers: the secure one, else the home one, else current. */
    String preferred() {
        List<String> all = candidates();
        return all.isEmpty() ? null : all.get(0);
    }

    /** Every known address, best first. */
    List<String> candidates() {
        Set<String> all = new LinkedHashSet<>();
        for (String origin : new String[] {secure(), lan(), current()}) {
            if (origin != null) all.add(origin);
        }
        return new ArrayList<>(all);
    }

    boolean isKnown(String origin) {
        return origin != null && candidates().contains(origin);
    }

    void setCurrent(String origin) {
        prefs.edit().putString(CURRENT, origin).apply();
    }

    /** The paired page's report: remember its addresses (null forgets one). */
    void setPaired(String secure, String lan) {
        prefs.edit().putString(SECURE, secure).putString(LAN, lan).putBoolean(PAIRED, true).apply();
    }

    /** Unpaired: forget every address and the pairing on all of them. */
    void clear() {
        prefs.edit().clear().apply();
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(null);
        cookies.flush();
    }

    // ---------------------------------------------------------------------------------------
    // The device token, shared between the addresses.

    /** This phone's device token: the one on the current address, else any address's. */
    String token() {
        String here = tokenAt(current());
        if (here != null) return here;
        for (String origin : candidates()) {
            String token = tokenAt(origin);
            if (token != null) return token;
        }
        return null;
    }

    /** Puts this phone's device token on every known address that lacks it or has another. */
    void shareToken() {
        String token = token();
        if (token == null) return;
        CookieManager cookies = CookieManager.getInstance();
        boolean changed = false;
        for (String origin : candidates()) {
            if (token.equals(tokenAt(origin))) continue;
            String secure = origin.startsWith("https:") ? "; Secure" : "";
            cookies.setCookie(origin, COOKIE + "=" + token + "; Path=/; Max-Age=" + COOKIE_MAX_AGE
                    + "; HttpOnly; SameSite=Lax" + secure);
            changed = true;
        }
        if (changed) cookies.flush();
    }

    private static String tokenAt(String origin) {
        if (origin == null) return null;
        String header = CookieManager.getInstance().getCookie(origin);
        if (header == null) return null;
        for (String part : header.split(";")) {
            String pair = part.trim();
            if (pair.startsWith(COOKIE + "=")) {
                String value = pair.substring(COOKIE.length() + 1);
                return value.isEmpty() ? null : value;
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------
    // Asking the server. Network: call these off the main thread.

    /** The family server answers {@code /api/health} at this address. */
    static boolean healthy(String origin) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(false);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /** What the server says about this token: 200 paired, 401 not paired, -1 couldn't ask. */
    static int pairingStatus(String origin, String token) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/devices/me").openConnection();
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(false);
            if (token != null) c.setRequestProperty("Cookie", COOKIE + "=" + token);
            int code = c.getResponseCode();
            c.disconnect();
            return code;
        } catch (Exception e) {
            return -1;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Reading addresses.

    /** {@code scheme://host[:port]} as a browser's {@code location.origin}, or null. */
    static String originOf(Uri url) {
        if (url == null) return null;
        String scheme = url.getScheme();
        String host = url.getHost();
        if (host == null || !("http".equals(scheme) || "https".equals(scheme))) return null;
        int port = url.getPort();
        boolean defaultPort = port == -1 || ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }

    /**
     * A link the kiosk's QR codes hold: a pairing link ({@code /parent/pair?code=…}) or the setup
     * link ({@code /setup?token=…}), on any http(s) address. As {@code scannedPairingOf} in
     * {@code @pmp/shared}, which the page uses for the same codes.
     */
    static boolean isPairingLink(Uri url) {
        if (originOf(url) == null) return false;
        String path = url.getPath() == null ? "" : url.getPath();
        if (path.equals("/setup") || path.startsWith("/setup/")) return true;
        String code = url.getQueryParameter("code");
        return path.equals("/parent/pair") && code != null && !code.trim().isEmpty();
    }

    /**
     * A typed address as an origin: {@code 192.168.1.20} → {@code http://192.168.1.20:4789}, a
     * relay or Tailscale name → {@code https://…}. Null when it isn't an address.
     */
    static String typedOrigin(String text) {
        String typed = text == null ? "" : text.trim();
        if (typed.isEmpty() || typed.contains(" ")) return null;
        if (!typed.contains("://")) {
            String lower = typed.toLowerCase(Locale.ROOT);
            boolean https = lower.contains("pocketmoneypal.app") || lower.contains(".ts.net");
            typed = (https ? "https://" : "http://") + typed;
        }
        Uri url = Uri.parse(typed);
        String origin = originOf(url);
        if (origin == null) return null;
        if (url.getPort() == -1 && "http".equals(url.getScheme()) && IPV4.matcher(url.getHost()).matches()) {
            origin += ":" + DEFAULT_PORT;
        }
        return origin;
    }
}
