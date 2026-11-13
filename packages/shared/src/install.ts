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
 * How this browser installs the app:
 * - `prompt`: Chrome is offering its install box, so our button opens it;
 * - `menu`: no prompt yet: the browser's ⋮ menu → Install app;
 * - `ios-more`: Safari 26+ on iPhone: ⋯ → Share → Add to Home Screen → Add;
 * - `ios-share-bottom`: older iPhone Safari, Share in the bottom bar;
 * - `ios-share`: iPad, or another browser on iOS: its Share button → Add to Home Screen.
 */
export type InstallRoute = 'prompt' | 'menu' | 'ios-more' | 'ios-share-bottom' | 'ios-share';

export function installRouteOf(
  userAgent: string,
  maxTouchPoints: number,
  hasPrompt: boolean,
): InstallRoute {
  const device = installDeviceOf(userAgent, maxTouchPoints);
  if (device === 'iphone' && isIosSafari(userAgent)) {
    return (safariVersionOf(userAgent) ?? 0) >= SAFARI_SHARE_IN_MORE_MENU
      ? 'ios-more'
      : 'ios-share-bottom';
  }
  if (device === 'iphone' || device === 'ipad') return 'ios-share';
  return hasPrompt ? 'prompt' : 'menu';
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
