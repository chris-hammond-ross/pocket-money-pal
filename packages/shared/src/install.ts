/**
 * Installing the parent app straight after pairing (spec 009, ADR 0028): when the
 * "finish setting up" screen shows, how this browser installs, and where the push opt-in
 * is asked. Pure functions: the web client passes in what the browser tells it.
 */

/** What kind of device the browser runs on, from its user agent. */
export type InstallDevice = 'android' | 'iphone' | 'ipad' | 'desktop';

/**
 * iPadOS Safari says "Macintosh" by default; only touch tells it apart from a Mac.
 * `maxTouchPoints` is `navigator.maxTouchPoints`.
 */
export function installDeviceOf(userAgent: string, maxTouchPoints: number): InstallDevice {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPod/.test(userAgent)) return 'iphone';
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) {
    return 'ipad';
  }
  return 'desktop';
}

/** Safari itself, not another browser on iOS (which all run WebKit but brand themselves). */
function isIosSafari(userAgent: string): boolean {
  return (
    /Safari\//.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo|YaBrowser/.test(userAgent)
  );
}

/** Safari's own version ("Version/26.1"), or null when the user agent doesn't say. */
export function safariVersionOf(userAgent: string): number | null {
  const m = /Version\/(\d+)/.exec(userAgent);
  return m ? Number(m[1]) : null;
}

/** From Safari 26, the iPhone's compact tab bar keeps Share behind ⋯. */
export const SAFARI_SHARE_IN_MORE_MENU = 26;

/**
 * Which browser this is, for installing (Android and iOS). Most Android browsers copy
 * Chrome's user agent, and DuckDuckGo sends exactly Chrome's reduced one
 * (`Linux; Android 10; K … Chrome/N.0.0.0 Mobile Safari`). So the user agent alone can't
 * say "this is Chrome": `navigator.userAgentData.brands` can. Real Chrome, Edge, Samsung
 * Internet and Opera always list their brand there (on HTTPS, where this screen shows);
 * a WebView browser like DuckDuckGo lists "Android WebView", or has no `userAgentData`.
 * - `chrome` / `samsung` / `edge`: install from the ⋮ menu, or Chrome's prompt;
 * - `firefox` / `opera`: install from their own menus;
 * - `in-app`: an app's built-in browser (Facebook, Instagram, the Google app, a WebView);
 * - `other`: anything else that can't install, DuckDuckGo included.
 */
export type InstallBrowser =
  'safari' | 'chrome' | 'samsung' | 'edge' | 'firefox' | 'opera' | 'in-app' | 'other';

/** What the browser tells the page. */
export interface InstallHints {
  userAgent: string;
  /** `navigator.maxTouchPoints`, to tell an iPad from a Mac. */
  maxTouchPoints: number;
  /** Chrome's `beforeinstallprompt` is waiting to be used. */
  hasPrompt: boolean;
  /** `navigator.userAgentData.brands`' names, or null when the browser has none. */
  brands: readonly string[] | null;
  /** DuckDuckGo's own `navigator.duckduckgo` is there (it hides from the user agent). */
  duckDuckGo: boolean;
}

/** Apps' built-in browsers, by what they add to the user agent. `; wv)` is any Android WebView. */
const IN_APP =
  /FBAN\/|FBAV\/|FB_IAB\/|FB4A|FBIOS|Instagram|GSA\/|; wv\)|LinkedInApp|Line\/|Snapchat|musical_ly|BytedanceWebview|Twitter/;

export function installBrowserOf(h: Omit<InstallHints, 'hasPrompt'>): InstallBrowser {
  const ua = h.userAgent;
  if (IN_APP.test(ua)) return 'in-app';
  if (h.duckDuckGo || /DuckDuckGo|Ddg\//.test(ua)) return 'other';
  const device = installDeviceOf(ua, h.maxTouchPoints);
  if (device === 'iphone' || device === 'ipad') {
    if (isIosSafari(ua)) return 'safari';
    if (/CriOS/.test(ua)) return 'chrome';
    if (/EdgiOS/.test(ua)) return 'edge';
    if (/FxiOS/.test(ua)) return 'firefox';
    return 'other';
  }
  if (/Opera Mini|OPiOS|UCBrowser|YaBrowser|MiuiBrowser|HeyTapBrowser|Focus\//.test(ua)) {
    return 'other';
  }
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/OPR\//.test(ua) || h.brands?.includes('Opera')) return 'opera';
  if (/SamsungBrowser\//.test(ua) || h.brands?.includes('Samsung Internet')) return 'samsung';
  if (/EdgA\/|Edg\//.test(ua) || h.brands?.includes('Microsoft Edge')) return 'edge';
  // Chrome says so in its brands; a browser merely copying Chrome's user agent doesn't.
  if (h.brands?.includes('Google Chrome')) return 'chrome';
  return 'other';
}

/**
 * How this browser installs the app:
 * - `prompt`: Chrome is offering its install box, so our button opens it;
 * - `menu`: Chrome, Samsung Internet or Edge with no prompt yet: ⋮ → Install app;
 * - `firefox-menu` / `opera-menu`: their own menus;
 * - `ios-more`: Safari 26+ on iPhone: ⋯ → Share → Add to Home Screen → Add;
 * - `ios-share-bottom`: older iPhone Safari, Share in the bottom bar;
 * - `ios-share`: iPad, or Chrome / Edge / Firefox on iOS: Share → Add to Home Screen;
 * - `open-in-chrome`: this Android browser can't install (DuckDuckGo, an app's browser):
 *   carry the pairing over to Chrome;
 * - `open-in-safari`: an app's browser on iOS: carry it over to Safari.
 */
export type InstallRoute =
  | 'prompt'
  | 'menu'
  | 'firefox-menu'
  | 'opera-menu'
  | 'ios-more'
  | 'ios-share-bottom'
  | 'ios-share'
  | 'open-in-chrome'
  | 'open-in-safari';

/** The routes for a browser that can't install, where the screen offers a way out. */
export const CANT_INSTALL: readonly InstallRoute[] = ['open-in-chrome', 'open-in-safari'];

export function installRouteOf(h: InstallHints): InstallRoute {
  const device = installDeviceOf(h.userAgent, h.maxTouchPoints);
  const browser = installBrowserOf(h);
  if (device === 'iphone' || device === 'ipad') {
    if (browser === 'in-app') return 'open-in-safari';
    if (device === 'iphone' && browser === 'safari') {
      return (safariVersionOf(h.userAgent) ?? 0) >= SAFARI_SHARE_IN_MORE_MENU
        ? 'ios-more'
        : 'ios-share-bottom';
    }
    // iPad Safari, and the other iOS browsers that can Add to Home Screen (iOS 16.4+).
    return 'ios-share';
  }
  // Any browser offering the prompt can install, whatever it calls itself.
  if (h.hasPrompt) return 'prompt';
  if (device === 'desktop') return 'menu'; // the screen never shows there
  switch (browser) {
    case 'chrome':
    case 'samsung':
    case 'edge':
      return 'menu';
    case 'firefox':
      return 'firefox-menu';
    case 'opera':
      return 'opera-menu';
    default:
      return 'open-in-chrome';
  }
}

/**
 * Chrome on Android opens this `intent:` link even from another browser, and Android
 * offers to install Chrome if it's missing. The scheme is kept (`https`, or `http` for
 * `localhost` in development).
 */
export function chromeIntentUrl(url: string): string {
  const m = /^([a-z]+):\/\/(.*)$/i.exec(url);
  const [scheme, rest] = m ? [m[1], m[2]] : ['https', url];
  return `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;end`;
}

export interface FinishSetupState {
  /** Pairing (or a move) set the flag on this phone, and it hasn't been finished. */
  pending: boolean;
  /** HTTPS or localhost: the browser can install here. */
  secure: boolean;
  /** Running as the installed app. */
  standalone: boolean;
  /** Installed from this browser already. */
  installed: boolean;
  device: InstallDevice;
}

/**
 * The full-screen "Install the app" screen shows only where installing can work, and only
 * on phones and tablets: it has no way out, and some desktop browsers can't install.
 */
export function finishSetupShows(s: FinishSetupState): boolean {
  return s.pending && s.secure && !s.standalone && !s.installed && s.device !== 'desktop';
}

/**
 * Notifications are asked in the installed app (spec 009): not while the install screen
 * is up, and not in a browser tab on a phone where the app is installed.
 */
export function asksPushHere(s: {
  asked: boolean;
  finishSetupShowing: boolean;
  standalone: boolean;
  installed: boolean;
}): boolean {
  if (s.asked || s.finishSetupShowing) return false;
  return s.standalone || !s.installed;
}
