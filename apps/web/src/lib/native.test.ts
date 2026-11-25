import { NATIVE_BRIDGE_OBJECT, NATIVE_BRIDGE_VERSION, type NativeRequest } from '@pmp/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Native = typeof import('./native');

const info = {
  app: 'parent',
  version: '1.0.0',
  platform: 'android',
  bridgeVersion: NATIVE_BRIDGE_VERSION,
  features: ['scanQr', 'openExternal', 'from-the-future'],
};

/** A pretend shell: `answer` decides each reply (a string is sent as is; undefined: no reply). */
function fakeShell(answer: (request: NativeRequest) => unknown) {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const sent: NativeRequest[] = [];
  const shell = {
    sent,
    postMessage(message: string) {
      const request = JSON.parse(message) as NativeRequest;
      sent.push(request);
      const reply = answer(request);
      if (reply === undefined) return;
      const data = typeof reply === 'string' ? reply : JSON.stringify(reply);
      queueMicrotask(() => listeners.forEach((l) => l({ data })));
    },
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      listeners.push(listener);
    },
    /** Sends a message nobody asked for. */
    push(data: unknown) {
      listeners.forEach((l) => l({ data }));
    },
  };
  vi.stubGlobal(NATIVE_BRIDGE_OBJECT, shell);
  return shell;
}

let native: Native;

beforeEach(async () => {
  vi.resetModules();
  native = await import('./native');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('in a browser', () => {
  it('is not in the app, and says so', async () => {
    expect(native.isNativeShell()).toBe(false);
    await expect(native.nativeInfo()).resolves.toBeNull();
    await expect(native.nativeRequest('scanQr')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('ignores a global of the same name that is not a bridge', () => {
    vi.stubGlobal(NATIVE_BRIDGE_OBJECT, { hello: true });
    expect(native.isNativeShell()).toBe(false);
  });
});

describe('in the app', () => {
  it('asks what the app is once, and drops features it does not know', async () => {
    const shell = fakeShell((r) => ({ id: r.id, ok: true, result: info }));
    expect(native.isNativeShell()).toBe(true);
    const first = await native.nativeInfo();
    expect(first).toEqual({ ...info, features: ['scanQr', 'openExternal'] });
    await native.nativeInfo();
    expect(shell.sent).toHaveLength(1);
    expect(shell.sent[0]).toMatchObject({ type: 'info' });
  });

  it('sends the payload, and returns the checked result', async () => {
    const shell = fakeShell((r) =>
      r.type === 'openExternal' ? { id: r.id, ok: true, result: {} } : undefined,
    );
    await expect(
      native.nativeRequest('openExternal', { url: 'https://pocketmoneypal.com/help' }),
    ).resolves.toEqual({});
    expect(shell.sent[0]).toMatchObject({
      type: 'openExternal',
      url: 'https://pocketmoneypal.com/help',
    });
  });

  it('passes on what the shell says went wrong', async () => {
    fakeShell((r) => ({ id: r.id, ok: false, error: { code: 'cancelled', message: 'Closed' } }));
    const error = await native.nativeRequest('scanQr').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(native.NativeError);
    expect(error).toMatchObject({ code: 'cancelled', message: 'Closed' });
  });

  it('fails when the result does not fit the request', async () => {
    fakeShell((r) => ({ id: r.id, ok: true, result: { nope: 1 } }));
    await expect(native.nativeRequest('scanQr')).rejects.toMatchObject({ code: 'failed' });
  });

  it('does not send a request the contract refuses', async () => {
    const shell = fakeShell(() => undefined);
    await expect(
      native.nativeRequest('openExternal', { url: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(shell.sent).toHaveLength(0);
  });

  it('ignores replies it cannot read or did not ask for', async () => {
    const shell = fakeShell(() => undefined);
    const answer = native.nativeRequest('scanQr');
    shell.push('not json');
    shell.push({ not: 'a string' });
    shell.push(JSON.stringify({ id: 'someone-else', ok: true, result: { text: 'x' } }));
    shell.push(JSON.stringify({ id: shell.sent[0]!.id, ok: true, result: { text: 'mine' } }));
    await expect(answer).resolves.toEqual({ text: 'mine' });
  });

  it('gives up when the app does not answer', async () => {
    vi.useFakeTimers();
    fakeShell(() => undefined);
    const answer = native.nativeRequest('info', {}, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(answer).rejects.toMatchObject({ code: 'failed' });
  });

  it('asks again next time when the app could not say what it is', async () => {
    let calls = 0;
    const shell = fakeShell((r) =>
      ++calls === 1
        ? { id: r.id, ok: false, error: { code: 'failed' } }
        : { id: r.id, ok: true, result: info },
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(native.nativeInfo()).resolves.toBeNull();
    await expect(native.nativeInfo()).resolves.toMatchObject({ app: 'parent' });
    expect(shell.sent).toHaveLength(2);
  });
});

describe('tellShell', () => {
  it('sends the session to an app that takes it', async () => {
    const shell = fakeShell((r) =>
      r.type === 'info'
        ? { id: r.id, ok: true, result: { ...info, features: ['session'] } }
        : { id: r.id, ok: true, result: {} },
    );
    await native.tellShell({ paired: true, secureUrl: null, lanUrl: 'http://192.168.0.10:4789' });
    expect(shell.sent.map((r) => r.type)).toEqual(['info', 'session']);
    expect(shell.sent[1]).toMatchObject({ paired: true, lanUrl: 'http://192.168.0.10:4789' });
  });

  it('sends nothing to an app without session, or in a browser', async () => {
    const shell = fakeShell((r) => ({ id: r.id, ok: true, result: info }));
    await native.tellShell({ paired: false });
    expect(shell.sent.map((r) => r.type)).toEqual(['info']);
    vi.unstubAllGlobals();
    vi.resetModules();
    const browser = await import('./native');
    await expect(browser.tellShell({ paired: false })).resolves.toBeUndefined();
  });
});
