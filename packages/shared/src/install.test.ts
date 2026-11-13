import { describe, expect, it } from 'vitest';
import {
  asksPushHere,
  finishSetupShows,
  installDeviceOf,
  installRouteOf,
  safariVersionOf,
  type FinishSetupState,
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

describe('installRouteOf', () => {
  it('uses our button when Chrome offers its prompt, and its menu when it does not', () => {
    expect(installRouteOf(UA.androidChrome, 5, true)).toBe('prompt');
    expect(installRouteOf(UA.androidChrome, 5, false)).toBe('menu');
    expect(installRouteOf(UA.androidFirefox, 5, false)).toBe('menu');
  });

  it('sends Safari 26+ on iPhone through ⋯, and older Safari straight to Share', () => {
    expect(installRouteOf(UA.iphoneSafari26, 5, false)).toBe('ios-more');
    expect(installRouteOf(UA.iphoneSafari18, 5, false)).toBe('ios-share-bottom');
    expect(safariVersionOf(UA.iphoneSafari26)).toBe(26);
  });

  it('gives iPads and other iOS browsers the general Share steps', () => {
    expect(installRouteOf(UA.iphoneChrome, 5, false)).toBe('ios-share');
    expect(installRouteOf(UA.ipadDesktopMode, 5, false)).toBe('ios-share');
  });

  it('never offers a prompt route on iOS, whatever it is told', () => {
    expect(installRouteOf(UA.iphoneSafari26, 5, true)).toBe('ios-more');
  });
});

describe('finishSetupShows', () => {
  const ready: FinishSetupState = {
    pending: true,
    secure: true,
    standalone: false,
    installed: false,
    device: 'android',
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
});

describe('asksPushHere', () => {
  const fresh = { asked: false, finishSetupShowing: false, standalone: false, installed: false };

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
});
