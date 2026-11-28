import {
  NATIVE_BRIDGE_OBJECT,
  NATIVE_BRIDGE_VERSION,
  NATIVE_OPEN_EVENT,
  type NativeRequest,
  type PushSubscriptionInput,
} from '@pmp/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type NativePush = typeof import('./native-push');
type Native = typeof import('./native');

const subscription: PushSubscriptionInput = {
  endpoint: 'https://push.pocketmoneypal.app/v1/fcm/token-1',
  expirationTime: null,
  keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
};

interface App {
  features?: string[];
  permission?: 'granted' | 'denied' | 'prompt';
  /** What asking turns `permission` into. */
  answer?: 'granted' | 'denied' | 'prompt';
  subscribed?: boolean;
}

/** A pretend parents' app that answers the push messages like MainActivity. */
function fakeApp(app: App) {
  const sent: NativeRequest[] = [];
  const listeners: ((event: { data: unknown }) => void)[] = [];
  let permission = app.permission ?? 'prompt';
  let subscribed = app.subscribed ?? false;
  const resultOf = (r: NativeRequest): unknown => {
    switch (r.type) {
      case 'info':
        return {
          app: 'parent',
          version: '1.0.0',
          platform: 'android',
          bridgeVersion: NATIVE_BRIDGE_VERSION,
          features: app.features ?? ['scanQr', 'openExternal', 'session', 'push'],
        };
      case 'push.permission':
        if (r.ask && permission === 'prompt') permission = app.answer ?? 'granted';
        return { state: permission, subscribed };
      case 'push.subscribe':
        subscribed = true;
        return subscription;
      case 'push.unsubscribe':
        subscribed = false;
        return {};
      default:
        return {};
    }
  };
  vi.stubGlobal(NATIVE_BRIDGE_OBJECT, {
    postMessage(message: string) {
      const request = JSON.parse(message) as NativeRequest;
      sent.push(request);
      const data = JSON.stringify({ id: request.id, ok: true, result: resultOf(request) });
      queueMicrotask(() => listeners.forEach((l) => l({ data })));
    },
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      listeners.push(listener);
    },
  });
  return { sent, types: () => sent.map((r) => r.type), isSubscribed: () => subscribed };
}

function fakeServer(options: { saveFails?: boolean } = {}) {
  return {
    saved: [] as PushSubscriptionInput[],
    deleted: 0,
    pushKey: vi.fn(async () => ({ publicKey: 'BServerKey_123' })),
    async savePushSubscription(sub: PushSubscriptionInput) {
      if (options.saveFails) throw new Error('offline');
      this.saved.push(sub);
    },
    async deletePushSubscription() {
      this.deleted++;
    },
  };
}

let push: NativePush;
let native: Native;

beforeEach(async () => {
  vi.resetModules();
  native = await import('./native');
  push = await import('./native-push');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('push in the parents’ app', () => {
  it('is unavailable in an app from before notifications', async () => {
    fakeApp({ features: ['scanQr', 'openExternal', 'session'] });
    const server = fakeServer();
    expect(await push.nativePushState()).toBe('unavailable');
    expect(await push.nativeEnablePush(server)).toBe('unavailable');
    expect(server.pushKey).not.toHaveBeenCalled();
  });

  it('reads on, off and denied from the app', async () => {
    fakeApp({ permission: 'granted', subscribed: true });
    expect(await push.nativePushState()).toBe('on');
    vi.resetModules();
    push = await import('./native-push');
    fakeApp({ permission: 'granted', subscribed: false });
    expect(await push.nativePushState()).toBe('off');
    vi.resetModules();
    push = await import('./native-push');
    fakeApp({ permission: 'denied' });
    expect(await push.nativePushState()).toBe('denied');
  });

  it('asks, subscribes with the server’s key, and stores the subscription', async () => {
    const app = fakeApp({ permission: 'prompt', answer: 'granted' });
    const server = fakeServer();
    expect(await push.nativeEnablePush(server)).toBe('on');
    expect(app.sent.find((r) => r.type === 'push.permission')).toMatchObject({ ask: true });
    expect(app.sent.find((r) => r.type === 'push.subscribe')).toMatchObject({
      applicationServerKey: 'BServerKey_123',
    });
    expect(server.saved).toEqual([subscription]);
    expect(await push.nativePushState()).toBe('on');
  });

  it('stops at Android’s no, without subscribing', async () => {
    const app = fakeApp({ permission: 'prompt', answer: 'denied' });
    const server = fakeServer();
    expect(await push.nativeEnablePush(server)).toBe('denied');
    expect(app.types()).not.toContain('push.subscribe');
    expect(server.saved).toEqual([]);
  });

  it('drops the subscription again when the PC can’t store it', async () => {
    const app = fakeApp({ permission: 'granted' });
    await expect(push.nativeEnablePush(fakeServer({ saveFails: true }))).rejects.toThrow('offline');
    expect(app.isSubscribed()).toBe(false);
  });

  it('turns off in the app and on the server', async () => {
    const app = fakeApp({ permission: 'granted', subscribed: true });
    const server = fakeServer();
    expect(await push.nativeDisablePush(server)).toBe('off');
    expect(app.isSubscribed()).toBe(false);
    expect(server.deleted).toBe(1);
  });

  it('stores the subscription again on start-up when on, and does nothing when off', async () => {
    fakeApp({ permission: 'granted', subscribed: true });
    const server = fakeServer();
    await push.nativeResyncPush(server);
    expect(server.saved).toEqual([subscription]);

    vi.resetModules();
    push = await import('./native-push');
    const off = fakeApp({ permission: 'granted', subscribed: false });
    const idle = fakeServer();
    await push.nativeResyncPush(idle);
    expect(idle.saved).toEqual([]);
    expect(off.types()).not.toContain('push.subscribe');
  });
});

describe('onNativeOpen', () => {
  it('passes on /parent paths from the app, and nothing else', () => {
    vi.stubGlobal('window', new EventTarget());
    const opened: string[] = [];
    const stop = native.onNativeOpen((url) => opened.push(url));
    const send = (detail: unknown) =>
      window.dispatchEvent(new CustomEvent(NATIVE_OPEN_EVENT, { detail }));
    send('/parent?tray=1');
    send('https://evil.example/parent');
    send(42);
    stop();
    send('/parent?tab=payday');
    expect(opened).toEqual(['/parent?tray=1']);
  });
});
