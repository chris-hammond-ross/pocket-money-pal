import { describe, expect, it } from 'vitest';
import {
  asksPushHere,
  finishSetupShows,
  installDeviceOf,
  chromeIntentUrl,
  installBrowserOf,
  installRouteOf,
  safariVersionOf,
  type FinishSetupState,
  type InstallHints,
} from './install';

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  iphoneSafari26:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
  iphoneSafari18:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  // Real user agents, as sent in 2026. Chrome's is reduced to "Android 10; K", and
  // DuckDuckGo sends exactly the same one (its source: RealUserAgentProvider).
  androidChromeReduced:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidEdge:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 EdgA/142.0.0.0',
  androidOpera:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/91.0.0.0',
  androidFacebook:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/489.0.0.66.81;]',
  androidInstagram:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36 Instagram 357.0.0.25.101 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; en_GB; 658440174)',
  // Gmail opens links in a plain WebView (or a Chrome Custom Tab, which is Chrome).
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36',
  androidGoogleApp:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36 GSA/15.45.36.29.arm64',
  iphoneFacebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/489.0.0.40.110;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBID/phone;FBLC/en_GB;FBOP/5]',
  iphoneInstagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.18.88 (iPhone15,2; iOS 18_6; en_GB; en-GB; scale=3.00; 1179x2556; 660417318)',
  iphoneGoogleApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/360.0.712233540 Mobile/15E148 Safari/604.1',
  iphoneDuckDuckGo:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

describe('installDeviceOf', () => {
  it('tells phones, tablets and desktops apart', () => {
    expect(installDeviceOf(UA.androidChrome, 5)).toBe('android');
    expect(installDeviceOf(UA.androidFirefox, 5)).toBe('android');
    expect(installDeviceOf(UA.iphoneSafari26, 5)).toBe('iphone');
    expect(installDeviceOf(UA.iphoneChrome, 5)).toBe('iphone');
    expect(installDeviceOf(UA.windowsChrome, 0)).toBe('desktop');
  });

  it('spots an iPad that says it is a Mac, by its touch screen', () => {
    expect(installDeviceOf(UA.ipadDesktopMode, 5)).toBe('ipad');
    expect(installDeviceOf(UA.macSafari, 0)).toBe('desktop');
  });
});

const CHROME = ['Google Chrome', 'Chromium', 'Not_A Brand'];
const WEBVIEW = ['Android WebView', 'Chromium', 'Not_A Brand'];

/** A phone's hints: a touch screen, no prompt, no brands, not DuckDuckGo, unless given. */
const hints = (userAgent: string, more: Partial<InstallHints> = {}): InstallHints => ({
  userAgent,
  maxTouchPoints: 5,
  hasPrompt: false,
  brands: null,
  duckDuckGo: false,
  ...more,
});
const route = (userAgent: string, more?: Partial<InstallHints>) =>
  installRouteOf(hints(userAgent, more));

describe('installBrowserOf', () => {
  it('trusts Chrome only when its brands say so, since others copy its user agent', () => {
    expect(installBrowserOf(hints(UA.androidChromeReduced, { brands: CHROME }))).toBe('chrome');
    // DuckDuckGo: the same user agent, a WebView's brands (or none), and its own object.
    expect(installBrowserOf(hints(UA.androidChromeReduced, { brands: WEBVIEW }))).toBe('other');
    expect(installBrowserOf(hints(UA.androidChromeReduced))).toBe('other');
    expect(
      installBrowserOf(hints(UA.androidChromeReduced, { brands: CHROME, duckDuckGo: true })),
    ).toBe('other');
  });

  it('knows Samsung Internet, Edge, Firefox and Opera by their own tokens', () => {
    expect(installBrowserOf(hints(UA.androidSamsung))).toBe('samsung');
    expect(installBrowserOf(hints(UA.androidEdge))).toBe('edge');
    expect(installBrowserOf(hints(UA.androidFirefox))).toBe('firefox');
    expect(installBrowserOf(hints(UA.androidOpera))).toBe('opera');
  });

  it('spots apps’ built-in browsers, whatever brands their WebView claims', () => {
    for (const ua of [
      UA.androidFacebook,
      UA.androidInstagram,
      UA.androidWebView,
      UA.androidGoogleApp,
      UA.iphoneFacebook,
      UA.iphoneInstagram,
      UA.iphoneGoogleApp,
    ]) {
      expect(installBrowserOf(hints(ua, { brands: CHROME })), ua).toBe('in-app');
    }
  });
});

describe('installRouteOf', () => {
  it('uses our button when Chrome offers its prompt, and its menu when it does not', () => {
    expect(route(UA.androidChromeReduced, { brands: CHROME, hasPrompt: true })).toBe('prompt');
    expect(route(UA.androidChromeReduced, { brands: CHROME })).toBe('menu');
    expect(route(UA.androidChrome, { brands: CHROME })).toBe('menu');
    expect(route(UA.androidSamsung)).toBe('menu');
    expect(route(UA.androidEdge)).toBe('menu');
  });

  it('gives Firefox and Opera their own menu steps', () => {
    expect(route(UA.androidFirefox)).toBe('firefox-menu');
    expect(route(UA.androidOpera)).toBe('opera-menu');
  });

  it('sends a browser that can’t install to Chrome: DuckDuckGo and apps’ browsers', () => {
    expect(route(UA.androidChromeReduced, { duckDuckGo: true })).toBe('open-in-chrome');
    expect(route(UA.androidChromeReduced, { brands: WEBVIEW })).toBe('open-in-chrome');
    expect(route(UA.androidFacebook, { brands: WEBVIEW })).toBe('open-in-chrome');
    expect(route(UA.androidInstagram)).toBe('open-in-chrome');
    expect(route(UA.androidWebView)).toBe('open-in-chrome');
    expect(route(UA.androidGoogleApp)).toBe('open-in-chrome');
  });

  it('believes any browser that offers the prompt', () => {
    expect(route(UA.androidChromeReduced, { hasPrompt: true })).toBe('prompt');
  });

  it('sends Safari 26+ on iPhone through ⋯, and older Safari straight to Share', () => {
    expect(route(UA.iphoneSafari26)).toBe('ios-more');
    expect(route(UA.iphoneSafari18)).toBe('ios-share-bottom');
    expect(safariVersionOf(UA.iphoneSafari26)).toBe(26);
  });

  it('gives iPads and the other iOS browsers the general Share steps', () => {
    expect(route(UA.iphoneChrome)).toBe('ios-share');
    expect(route(UA.iphoneDuckDuckGo)).toBe('ios-share');
    expect(route(UA.ipadDesktopMode)).toBe('ios-share');
  });

  it('sends apps’ browsers on iOS to Safari', () => {
    expect(route(UA.iphoneFacebook)).toBe('open-in-safari');
    expect(route(UA.iphoneInstagram)).toBe('open-in-safari');
    expect(route(UA.iphoneGoogleApp)).toBe('open-in-safari');
  });

  it('never offers a prompt route on iOS, whatever it is told', () => {
    expect(route(UA.iphoneSafari26, { hasPrompt: true })).toBe('ios-more');
  });
});

describe('chromeIntentUrl', () => {
  it('opens the same https address in Chrome', () => {
    expect(
      chromeIntentUrl('https://abc.pocketmoneypal.app/parent/pair?code=K7QM4PXD&moved=1'),
    ).toBe(
      'intent://abc.pocketmoneypal.app/parent/pair?code=K7QM4PXD&moved=1#Intent;scheme=https;package=com.android.chrome;end',
    );
  });
});

describe('finishSetupShows', () => {
  const ready: FinishSetupState = {
    pending: true,
    secure: true,
    standalone: false,
    installed: false,
    device: 'android',
    inApp: false,
  };

  it('shows on a phone just paired over HTTPS', () => {
    expect(finishSetupShows(ready)).toBe(true);
    expect(finishSetupShows({ ...ready, device: 'iphone' })).toBe(true);
    expect(finishSetupShows({ ...ready, device: 'ipad' })).toBe(true);
  });

  it('needs the flag that pairing or a move sets', () => {
    expect(finishSetupShows({ ...ready, pending: false })).toBe(false);
  });

  it('never shows over plain HTTP, where the browser cannot install', () => {
    expect(finishSetupShows({ ...ready, secure: false })).toBe(false);
  });

  it('never shows in the installed app, or once installed from this browser', () => {
    expect(finishSetupShows({ ...ready, standalone: true })).toBe(false);
    expect(finishSetupShows({ ...ready, installed: true })).toBe(false);
  });

  it('never shows on a desktop browser', () => {
    expect(finishSetupShows({ ...ready, device: 'desktop' })).toBe(false);
  });

  it('never shows inside the native parents’ app', () => {
    expect(finishSetupShows({ ...ready, inApp: true })).toBe(false);
  });
});

describe('asksPushHere', () => {
  const fresh = {
    asked: false,
    finishSetupShowing: false,
    standalone: false,
    installed: false,
    inApp: false,
  };

  it('asks in the installed app on its first open', () => {
    expect(asksPushHere({ ...fresh, standalone: true, installed: true })).toBe(true);
  });

  it('does not ask while the install screen is up', () => {
    expect(asksPushHere({ ...fresh, finishSetupShowing: true })).toBe(false);
  });

  it('does not ask in a browser tab when the app is installed', () => {
    expect(asksPushHere({ ...fresh, installed: true })).toBe(false);
  });

  it('still asks in a tab that cannot install (no install screen)', () => {
    expect(asksPushHere(fresh)).toBe(true);
  });

  it('asks only once', () => {
    expect(asksPushHere({ ...fresh, asked: true, standalone: true })).toBe(false);
  });

  it('asks once inside the native app, through its bridge', () => {
    expect(asksPushHere({ ...fresh, inApp: true })).toBe(true);
    expect(asksPushHere({ ...fresh, inApp: true, installed: true })).toBe(true);
    expect(asksPushHere({ ...fresh, inApp: true, asked: true })).toBe(false);
  });
});
