/**
 * The tunnel client against a fake relay (a real local `ws` server speaking the protocol):
 * phones' requests arrive remote and go through the remote guard (ADR 0022), the WS bridge
 * carries hub events, big bodies respect the credit window, and the PC copes with the
 * relay going away, refusing it, or going silent.
 */
import { once } from 'node:events';
import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_KIOSK_HEADER,
  TUNNEL_PROBLEM_CLOSE,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_VERSION_HEADER,
  TUNNEL_WINDOW_BYTES,
  type TunnelFrame,
  type TunnelFrameOf,
} from '@pmp/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { insertParent } from '../repo/users';
import { addChild, pairedCookie, testDb } from '../test-helpers';
import type { TunnelTiming } from './client';
import { FakeRelay } from './fake-relay';
import { clearRelayRecord, setRelayRecord } from './record';

const FAST: Partial<TunnelTiming> = {
  baseMs: 20,
  maxMs: 400,
  pingEveryMs: 40,
  silenceLimitMs: 150,
  handshakeMs: 2_000,
};

/** 3 MiB of patterned bytes: three windows' worth. */
const BIG = Buffer.from(new Uint8Array(3 * TUNNEL_WINDOW_BYTES).map((_, i) => i % 253));

let db: Db;
let closeDb: () => void;
let app: FastifyInstance;
let relay: FakeRelay;
const extraRelays: FakeRelay[] = [];

/** A PC registered with a fake relay, connected and ready. */
async function start(timing: Partial<TunnelTiming> = FAST) {
  relay = await new FakeRelay().start();
  ({ db, close: closeDb } = testDb());
  setRelayRecord(db, relay.record);
  app = await buildApp({ db, webDist: null, relayUrl: relay.url, relayTiming: timing });
  // Not API routes, so the guard lets anyone through: for the streaming tests.
  app.get('/test/big', async (_req, reply) => reply.type('application/octet-stream').send(BIG));
  // Never gets round to reading its body.
  app.post('/test/stall', { onRequest: () => new Promise(() => undefined) }, async () => 'never');
  app.get('/test/cookies', async (_req, reply) =>
    reply.header('set-cookie', ['a=1; Path=/', 'b=2; Path=/']).send('ok'),
  );
  const ready = once(relay, 'pc');
  await app.ready();
  await ready;
  await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
}

afterEach(async () => {
  await app?.close();
  await relay?.close();
  for (const r of extraRelays.splice(0)) await r.close();
  closeDb?.();
});

function family() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  return { mum, billy, cookie: pairedCookie(db, mum.id) };
}

/** A phone's request to the family's address, through the relay. */
function phone(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    origin?: string | null;
    body?: Buffer | string;
    type?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  const origin = init.origin === undefined ? relay.familyUrl : init.origin;
  if (origin) headers.origin = origin;
  if (init.type) headers['content-type'] = init.type;
  return fetch(`${relay.url}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  });
}

/** A phone's WebSocket, with every message it gets queued from the start. */
interface PhoneSocket {
  ws: WebSocket;
  next: () => Promise<{ type: string }>;
}

/** A phone's WebSocket to the family's address. Resolves open, or rejects with the status. */
function phoneSocket(headers: Record<string, string>): Promise<PhoneSocket> {
  const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/ws`, { headers });
  const queue: { type: string }[] = [];
  const waiting: ((m: { type: string }) => void)[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { type: string };
    const resolve = waiting.shift();
    if (resolve) resolve(msg);
    else queue.push(msg);
  });
  const next = () =>
    new Promise<{ type: string }>((resolve) => {
      const msg = queue.shift();
      if (msg) resolve(msg);
      else waiting.push(resolve);
    });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('connecting', () => {
  it('sends its secret, kiosk id and protocol version, then says hello', async () => {
    const connects: Record<string, unknown>[] = [];
    relay = await new FakeRelay().start();
    relay.on('connect', (headers) => connects.push(headers));
    ({ db, close: closeDb } = testDb());
    setRelayRecord(db, relay.record);
    app = await buildApp({ db, webDist: null, relayUrl: relay.url, relayTiming: FAST });
    const ready = once(relay, 'pc');
    await app.ready();
    await ready;

    expect(connects[0]).toMatchObject({
      authorization: `Bearer ${relay.secret}`,
      [TUNNEL_KIOSK_HEADER]: relay.kioskId,
      [TUNNEL_VERSION_HEADER]: String(TUNNEL_PROTOCOL_VERSION),
    });
    expect(relay.hello).toEqual({
      type: 'hello',
      version: TUNNEL_PROTOCOL_VERSION,
      appVersion: expect.any(String),
    });
  });

  it('is off without a registration, and with no relay URL', async () => {
    ({ db, close: closeDb } = testDb());
    app = await buildApp({ db, webDist: null, relayUrl: 'http://127.0.0.1:1' });
    await app.ready();
    expect(app.relay.status().state).toBe('off');
    expect(app.relay.tunnel).toBeNull();
    await app.close();

    setRelayRecord(db, {
      kioskId: 'x',
      secret: 'y',
      url: 'https://x.pocketmoneypal.app',
      licenceHint: 'ABCD',
    });
    app = await buildApp({ db, webDist: null });
    await app.ready();
    expect(app.relay.tunnel).toBeNull();
    expect(app.relay.url()).toBeNull();
  });

  it('makes the relay address the secure address', async () => {
    await start();
    const res = await app.inject({ url: '/api/access' });
    expect(res.json()).toEqual({ secureUrl: relay.familyUrl });
  });

  it('lets go when the registration is removed', async () => {
    await start();
    const gone = once(relay, 'pc-gone');
    clearRelayRecord(db);
    app.relay.reload();
    await gone;
    expect(app.relay.status().state).toBe('off');
    expect((await app.inject({ url: '/api/access' })).json()).toEqual({ secureUrl: null });
  });

  it('reload changes nothing when the registration is the same', async () => {
    await start();
    const before = app.relay.tunnel;
    app.relay.reload();
    expect(app.relay.tunnel).toBe(before);
  });
});

describe('requests through the tunnel', () => {
  it('answers the bootstrap routes to anyone', async () => {
    await start();
    const res = await phone('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('are remote whatever address the relay reports: unpaired gets 401', async () => {
    await start();
    // The fake relay reports 127.0.0.1, the PC's own address. It's still remote.
    const res = await phone('/api/children');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not-paired' });
    // The same route on the PC itself.
    expect((await app.inject({ url: '/api/kiosk/today' })).statusCode).toBe(200);
    expect((await phone('/api/kiosk/today')).status).toBe(401);
  });

  it('a paired phone reads and writes, with its own Origin', async () => {
    await start();
    const { billy, cookie } = family();
    const list = await phone('/api/children', { cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);

    const adjust = (origin: string | null) =>
      phone(`/api/children/${billy.id}/adjust`, {
        method: 'POST',
        cookie,
        origin,
        type: 'application/json',
        body: JSON.stringify({ points: 3, reason: 'Helping' }),
      });
    expect((await adjust(relay.familyUrl)).status).toBeLessThan(300);
    // Another family's page, or none at all (ADR 0022).
    const elsewhere = relay.familyUrl.replace(relay.kioskId, 'otherfamily');
    expect((await adjust(elsewhere)).status).toBe(403);
    expect((await adjust(null)).status).toBe(403);
  });

  it('keeps repeated response headers apart', async () => {
    await start();
    const res = await phone('/test/cookies');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('streams a body bigger than the window both ways', async () => {
    await start();
    const down = await phone('/test/big');
    expect(down.status).toBe(200);
    expect(Buffer.from(await down.arrayBuffer()).equals(BIG)).toBe(true);

    // 3 MiB up: the backup check reads all of it, and says it isn't a backup.
    const { cookie } = family();
    const up = await phone('/api/backup/inspect', {
      method: 'POST',
      cookie,
      type: 'application/octet-stream',
      body: BIG,
    });
    expect(up.status).toBe(400);
  });

  it('a response never runs ahead of its credit', async () => {
    await start();
    const stream = relay.openStream();
    let received = 0;
    const chunks: Uint8Array[] = [];
    relay.on('frame', (f: TunnelFrame) => {
      if (f.type === 'data' && f.stream === stream) {
        received += f.data.length;
        chunks.push(f.data);
      }
    });
    relay.sendToPc({
      type: 'req',
      stream,
      method: 'GET',
      path: '/test/big',
      headers: [],
      clientIp: '203.0.113.9',
      end: true,
    });
    await vi.waitFor(() => expect(received).toBe(TUNNEL_WINDOW_BYTES));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(TUNNEL_WINDOW_BYTES);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(TUNNEL_CHUNK_BYTES);

    const ended = relay.nextFrame((f) => f.type === 'end' && f.stream === stream);
    relay.sendToPc({ type: 'credit', stream, bytes: TUNNEL_WINDOW_BYTES });
    relay.sendToPc({ type: 'credit', stream, bytes: TUNNEL_WINDOW_BYTES });
    await ended;
    expect(Buffer.concat(chunks).equals(BIG)).toBe(true);
  });

  it('a request past its window, or on a stream already open, is refused', async () => {
    await start();
    const stream = relay.openStream();
    const req: TunnelFrameOf<'req'> = {
      type: 'req',
      stream,
      method: 'POST',
      path: '/test/stall',
      headers: [
        ['content-type', 'application/octet-stream'],
        ['origin', relay.familyUrl],
      ],
      clientIp: '203.0.113.9',
      end: false,
    };
    relay.sendToPc(req);
    const reset = relay.nextFrame((f) => f.type === 'reset' && f.stream === stream);
    const chunk = new Uint8Array(TUNNEL_CHUNK_BYTES);
    for (let sent = 0; sent <= TUNNEL_WINDOW_BYTES; sent += chunk.length) {
      relay.sendToPc({ type: 'data', stream, data: chunk });
    }
    expect(await reset).toMatchObject({ code: 'protocol' });

    // A second `req` on a live stream breaks the protocol: the PC hangs up and redials.
    const second = relay.openStream();
    relay.sendToPc({ ...req, stream: second });
    const redialled = once(relay, 'pc');
    relay.sendToPc({ ...req, stream: second });
    await redialled;
  });

  it('a phone that gives up cancels its request', async () => {
    await start();
    const stream = relay.openStream();
    relay.autoCredit = false;
    relay.sendToPc({
      type: 'req',
      stream,
      method: 'GET',
      path: '/test/big',
      headers: [],
      clientIp: '203.0.113.9',
      end: true,
    });
    await relay.nextFrame((f) => f.type === 'res' && f.stream === stream);
    relay.sendToPc({ type: 'reset', stream, code: 'cancelled' });
    await vi.waitFor(() => expect(app.relay.tunnel?.openStreams).toBe(0));
  });
});

describe('the WebSocket bridge', () => {
  it('carries hub events to a paired phone, and lets go when it closes', async () => {
    await start();
    const { cookie } = family();
    const { ws, next } = await phoneSocket({ cookie, origin: relay.familyUrl });
    expect(await next()).toMatchObject({ type: 'hello' });
    expect(await next()).toMatchObject({ type: 'presence', clients: 1 });
    expect(app.hub.size).toBe(1);

    app.hub.broadcast({ type: 'data.changed' });
    expect(await next()).toEqual({ type: 'data.changed' });

    ws.close();
    await vi.waitFor(() => expect(app.hub.size).toBe(0));
  });

  it('refuses an unpaired phone, and another family’s page', async () => {
    await start();
    await expect(phoneSocket({ origin: relay.familyUrl })).rejects.toThrow('status 401');
    const { cookie } = family();
    const elsewhere = relay.familyUrl.replace(relay.kioskId, 'otherfamily');
    await expect(phoneSocket({ cookie, origin: elsewhere })).rejects.toThrow('status 403');
    expect(app.hub.size).toBe(0);
  });

  it('closes bridged sockets when the tunnel drops', async () => {
    await start();
    const { cookie } = family();
    const { next } = await phoneSocket({ cookie, origin: relay.familyUrl });
    await next();
    expect(app.hub.size).toBe(1);
    relay.dropPc(1001);
    await vi.waitFor(() => expect(app.hub.size).toBe(0));
  });
});

describe('staying connected', () => {
  it('pings, and redials a relay that has gone silent', async () => {
    await start();
    await vi.waitFor(() => expect(relay.pings).toBeGreaterThan(1));
    relay.answerPings = false;
    const redialled = once(relay, 'connect');
    await redialled;
    relay.answerPings = true;
    await once(relay, 'pc');
  });

  it('backs off further each time the relay refuses, then reconnects', async () => {
    await start();
    const times: number[] = [];
    relay.on('connect', () => times.push(Date.now()));
    relay.refuseWith = 503;
    relay.dropPc(1001);
    await vi.waitFor(() => expect(times.length).toBeGreaterThanOrEqual(5), { timeout: 5_000 });
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    // The drop's own redial was attempt 0; then waits of 20·2ⁿ ms, between half and all of
    // it: 20-40, 40-80, 80-160, 160-320 (and a little for each attempt itself).
    expect(gaps[0]).toBeGreaterThanOrEqual(18);
    expect(gaps[1]).toBeGreaterThanOrEqual(38);
    expect(gaps[2]).toBeGreaterThanOrEqual(78);
    expect(gaps[3]).toBeGreaterThanOrEqual(158);
    expect(app.relay.status()).toMatchObject({
      state: 'connecting',
      lastError: 'The relay answered 503',
    });

    relay.refuseWith = null;
    await once(relay, 'pc');
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
  });

  it('comes back after the relay restarts', async () => {
    await start();
    const port = new URL(relay.url).port;
    await relay.close();
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connecting'));
    const again = new FakeRelay({ port: Number(port) });
    extraRelays.push(again);
    const back = once(again, 'pc');
    await again.start();
    await back;
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
  });

  it.each([
    ['a refused upgrade', 'licence-expired', (): void => void (relay.refuseWith = 402)],
    ['a close code', 'moved', (): void => undefined],
  ] as const)('stops for good on a problem: %s', async (_how, problem, refuse) => {
    await start();
    let attempts = 0;
    relay.on('connect', () => attempts++);
    refuse();
    relay.dropPc(relay.refuseWith ? 1001 : TUNNEL_PROBLEM_CLOSE.moved);
    await vi.waitFor(() => expect(app.relay.status()).toMatchObject({ state: 'problem', problem }));
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toBe(relay.refuseWith ? 1 : 0);
  });

  it('a changed registration replaces the connection', async () => {
    await start();
    const before = app.relay.tunnel;
    setRelayRecord(db, { ...relay.record, secret: 'rotated' });
    const refused = once(relay, 'connect');
    app.relay.reload();
    expect(app.relay.tunnel).not.toBe(before);
    await refused;
    await vi.waitFor(() =>
      expect(app.relay.status()).toMatchObject({ state: 'problem', problem: 'bad-secret' }),
    );
  });
});
