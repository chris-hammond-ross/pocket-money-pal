import { describe, expect, it } from 'vitest';
import {
  NATIVE_BRIDGE_VERSION,
  nativeCan,
  nativeInfoSchema,
  nativeRequestSchema,
  nativeResponseSchema,
  nativeResultSchemas,
  type NativeInfo,
} from './native-bridge';

const info: NativeInfo = {
  app: 'parent',
  version: '1.0.0',
  platform: 'android',
  bridgeVersion: NATIVE_BRIDGE_VERSION,
  features: ['scanQr', 'openExternal'],
};

describe('nativeRequestSchema', () => {
  it('accepts every request type', () => {
    const requests = [
      { id: '1', type: 'info' },
      { id: '2', type: 'scanQr' },
      { id: '3', type: 'openExternal', url: 'https://pocketmoneypal.com/help' },
      { id: '4', type: 'openExternal', url: 'http://192.168.0.10:4789/parent' },
      { id: '5', type: 'push.permission' },
      { id: '6', type: 'push.permission', ask: true },
      { id: '7', type: 'push.subscribe', applicationServerKey: 'BKx-abc_123' },
      { id: '8', type: 'push.unsubscribe' },
    ];
    for (const request of requests) {
      expect(nativeRequestSchema.safeParse(request).success, request.type).toBe(true);
    }
  });

  it('rejects an unknown type, a missing id and a missing payload', () => {
    expect(nativeRequestSchema.safeParse({ id: '1', type: 'reboot' }).success).toBe(false);
    expect(nativeRequestSchema.safeParse({ type: 'info' }).success).toBe(false);
    expect(nativeRequestSchema.safeParse({ id: '', type: 'info' }).success).toBe(false);
    expect(nativeRequestSchema.safeParse({ id: '1', type: 'openExternal' }).success).toBe(false);
    expect(nativeRequestSchema.safeParse({ id: '1', type: 'push.subscribe' }).success).toBe(false);
  });

  it('opens only web links outside the app', () => {
    for (const url of [
      'javascript:alert(1)',
      'intent://scan#Intent;end',
      'file:///sdcard/x',
      'nope',
    ]) {
      expect(
        nativeRequestSchema.safeParse({ id: '1', type: 'openExternal', url }).success,
        url,
      ).toBe(false);
    }
  });
});

describe('nativeInfoSchema', () => {
  it('reads what a shell says about itself', () => {
    expect(nativeInfoSchema.parse(info)).toEqual(info);
  });

  it('ignores features this page does not know', () => {
    const parsed = nativeInfoSchema.parse({ ...info, features: ['scanQr', 'teleport', 'push'] });
    expect(parsed.features).toEqual(['scanQr', 'push']);
  });

  it('rejects an unknown app or platform, and a bridge version below 1', () => {
    expect(nativeInfoSchema.safeParse({ ...info, app: 'toaster' }).success).toBe(false);
    expect(nativeInfoSchema.safeParse({ ...info, platform: 'windows' }).success).toBe(false);
    expect(nativeInfoSchema.safeParse({ ...info, bridgeVersion: 0 }).success).toBe(false);
    expect(nativeInfoSchema.safeParse({ ...info, bridgeVersion: 1.5 }).success).toBe(false);
  });
});

describe('nativeResultSchemas', () => {
  it('checks each answer against its request type', () => {
    expect(
      nativeResultSchemas.scanQr.safeParse({ text: 'http://pc/parent/pair?code=X' }).success,
    ).toBe(true);
    expect(nativeResultSchemas.scanQr.safeParse({}).success).toBe(false);
    expect(nativeResultSchemas.openExternal.safeParse({}).success).toBe(true);
    expect(nativeResultSchemas['push.permission'].safeParse({ state: 'granted' }).success).toBe(
      true,
    );
    expect(nativeResultSchemas['push.permission'].safeParse({ state: 'maybe' }).success).toBe(
      false,
    );
    expect(nativeResultSchemas['push.unsubscribe'].safeParse({}).success).toBe(true);
  });

  it('expects a push subscription the server accepts, on the gateway', () => {
    const subscription = {
      endpoint: 'https://push.pocketmoneypal.app/v1/fcm/token123',
      keys: { p256dh: 'BPk', auth: 'aGk' },
    };
    expect(nativeResultSchemas['push.subscribe'].safeParse(subscription).success).toBe(true);
    expect(
      nativeResultSchemas['push.subscribe'].safeParse({ ...subscription, endpoint: 'http://x/y' })
        .success,
    ).toBe(false);
  });
});

describe('nativeResponseSchema', () => {
  it('reads a success and a failure', () => {
    expect(nativeResponseSchema.parse({ id: '1', ok: true, result: { text: 'x' } })).toEqual({
      id: '1',
      ok: true,
      result: { text: 'x' },
    });
    expect(
      nativeResponseSchema.parse({ id: '2', ok: false, error: { code: 'cancelled' } }),
    ).toEqual({ id: '2', ok: false, error: { code: 'cancelled' } });
  });

  it("reads a newer shell's unknown error code as a plain failure", () => {
    const parsed = nativeResponseSchema.parse({
      id: '3',
      ok: false,
      error: { code: 'on-fire', message: 'Hot' },
    });
    expect(parsed).toEqual({ id: '3', ok: false, error: { code: 'failed', message: 'Hot' } });
  });

  it('rejects an answer without an id or an ok', () => {
    expect(nativeResponseSchema.safeParse({ ok: true, result: {} }).success).toBe(false);
    expect(nativeResponseSchema.safeParse({ id: '1', result: {} }).success).toBe(false);
    expect(nativeResponseSchema.safeParse({ id: '1', ok: false }).success).toBe(false);
  });
});

describe('nativeCan', () => {
  it('is false outside an app', () => {
    expect(nativeCan(null, 'scanQr')).toBe(false);
  });

  it('follows the features the shell lists', () => {
    expect(nativeCan(info, 'scanQr')).toBe(true);
    expect(nativeCan(info, 'openExternal')).toBe(true);
    expect(nativeCan(info, 'push')).toBe(false);
  });
});
