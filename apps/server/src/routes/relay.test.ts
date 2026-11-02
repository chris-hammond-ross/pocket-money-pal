/**
 * `/api/relay` (spec 008, ADR 0025) against the fake relay: connecting with a licence key,
 * the relay's refusals, taking a licence over, the Problem state, and Disconnect (from the
 * LAN, from a phone on the relay address itself, and with the relay out of reach).
 */
import {
  TUNNEL_PROTOCOL_VERSION,
  type PairingInvite,
  type RelayInfo,
  type ServerEvent,
} from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { events, serverKv } from '../db/schema';
import type { TunnelTiming } from '../relay/client';
import { FakeRelay } from '../relay/fake-relay';
import { getRelayRecord, setRelayRecord } from '../relay/record';
import { insertParent } from '../repo/users';
import { pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const FAST: Partial<TunnelTiming> = {
  baseMs: 20,
  maxMs: 400,
  pingEveryMs: 40,
  silenceLimitMs: 150,
  handshakeMs: 2_000,
};

let db: Db;
let closeDb: () => void;
let app: FastifyInstance;
let relay: FakeRelay;
let cookie: string;
let mumId: number;
let broadcasts: ServerEvent[];

async function start({
  registered = false,
  relayUrl,
}: { registered?: boolean; relayUrl?: string | null } = {}) {
  if (registered) setRelayRecord(db, relay.record);
  app = await buildApp({
    db,
    webDist: null,
    relayUrl: relayUrl === undefined ? relay.url : relayUrl,
    relayTiming: FAST,
  });
  const broadcast = app.hub.broadcast.bind(app.hub);
  vi.spyOn(app.hub, 'broadcast').mockImplementation((event) => {
    broadcasts.push(event);
    broadcast(event);
  });
  await app.ready();
}

beforeEach(async () => {
  relay = await new FakeRelay().start();
  ({ db, close: closeDb } = testDb());
  const mum = insertParent(db, { name: 'Mum' });
  mumId = mum.id;
  cookie = pairedCookie(db, mum.id);
  broadcasts = [];
});

afterEach(async () => {
  await app?.close();
  await relay.close();
  closeDb();
});

/** Mum's phone on the home Wi-Fi. */
function lan(options: InjectOptions) {
  return app.inject({
    remoteAddress: PHONE_IP,
    ...options,
    headers: { cookie, ...options.headers },
  });
}

const connect = (body: object) => lan({ method: 'POST', url: '/api/relay', payload: body });

function relayEvents(type: 'relay.connected' | 'relay.disconnected') {
  return db.select().from(events).where(eq(events.type, type)).all();
}

describe('GET /api/relay', () => {
  it('is off without a registration, and parent-only', async () => {
    await start();
    expect((await app.inject({ url: '/api/relay', remoteAddress: PHONE_IP })).statusCode).toBe(401);
    const res = await lan({ url: '/api/relay' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'off',
      url: null,
      problem: null,
      licenceHint: null,
    });
  });

  it('shows the address and the key’s last four while connected, never the secret', async () => {
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
    const res = await lan({ url: '/api/relay' });
    expect(res.json()).toMatchObject({
      state: 'connected',
      url: relay.familyUrl,
      licenceHint: 'FAKE',
    });
    expect(res.body).not.toContain(relay.secret);
    expect(res.body).not.toContain(relay.kioskId + '"');
  });
});

describe('POST /api/relay', () => {
  it('registers with the key, keeps only its last four, and connects', async () => {
    await start();
    const res = await connect({ licenceKey: ' pmp-fake2-fake3-fake4-fake5 ' });
    expect(res.statusCode).toBe(200);
    expect(res.json<RelayInfo>()).toMatchObject({
      state: 'connected',
      url: relay.familyUrl,
      licenceHint: 'AKE5',
    });
    expect(relay.registered).toEqual([
      { licenceKey: ' pmp-fake2-fake3-fake4-fake5 ', version: String(TUNNEL_PROTOCOL_VERSION) },
    ]);
    expect(getRelayRecord(db)).toEqual({ ...relay.record, licenceHint: 'AKE5' });
    // The key itself is stored nowhere.
    const kv = db.select().from(serverKv).all();
    expect(JSON.stringify(kv).toUpperCase()).not.toContain('FAKE2FAKE3');

    const [event] = relayEvents('relay.connected');
    expect(event).toMatchObject({ actorId: mumId });
    expect(event!.data).toEqual({
      url: relay.familyUrl,
      licenceHint: 'AKE5',
      tookOver: false,
    });
    const changes = broadcasts.filter((e) => e.type === 'relay.changed');
    expect(changes.at(-1)).toMatchObject({ relay: { state: 'connected', url: relay.familyUrl } });
    expect(JSON.stringify(changes)).not.toContain(relay.secret);
  });

  it('makes the relay address the secure one, and puts it in pairing invites', async () => {
    await start();
    await connect({ licenceKey: relay.licenceKey });
    expect((await lan({ url: '/api/access' })).json()).toEqual({ secureUrl: relay.familyUrl });
    const invite = await lan({ method: 'POST', url: '/api/devices/invites', payload: {} });
    expect(invite.json<PairingInvite>().secureUrl).toBe(relay.familyUrl);
  });

  it('puts it in the kiosk’s setup QR info too', async () => {
    // Before setup: no grown-ups yet (a factory reset keeps the relay, ADR 0022).
    closeDb();
    ({ db, close: closeDb } = testDb());
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
    const res = await app.inject({ url: '/api/setup/kiosk', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ secureUrl: relay.familyUrl });
  });

  it('leaves invites alone for a hands-on HTTPS address (ADR 0025)', async () => {
    app = await buildApp({ db, webDist: null, secureUrl: 'https://pc.tail1234.ts.net' });
    await app.ready();
    expect((await lan({ url: '/api/access' })).json()).toEqual({
      secureUrl: 'https://pc.tail1234.ts.net',
    });
    const invite = await lan({ method: 'POST', url: '/api/devices/invites', payload: {} });
    expect(invite.json<PairingInvite>().secureUrl).toBeNull();
  });

  it('asks before taking a licence over from another PC', async () => {
    await start();
    relay.inUse = true;
    const asked = await connect({ licenceKey: relay.licenceKey });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual({ error: 'licence-in-use' });
    expect(getRelayRecord(db)).toBeNull();
    expect(app.relay.status().state).toBe('off');

    const moved = await connect({ licenceKey: relay.licenceKey, takeOver: true });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ state: 'connected' });
    expect(relay.registered.at(-1)).toMatchObject({ takeOver: true });
    expect(relayEvents('relay.connected')[0]!.data).toMatchObject({ tookOver: true });
  });

  it.each([
    [404, 'unknown-licence', 400],
    [402, 'licence-expired', 402],
    [403, 'licence-revoked', 403],
    [426, 'update-needed', 426],
    [429, 'rate-limited', 429],
  ])('passes on the relay’s %i %s', async (status, error, ours) => {
    await start();
    relay.registerAnswer = { status, error };
    const res = await connect({ licenceKey: relay.licenceKey });
    expect(res.statusCode).toBe(ours);
    expect(res.json()).toEqual({ error });
    expect(getRelayRecord(db)).toBeNull();
    expect(relayEvents('relay.connected')).toHaveLength(0);
  });

  it('says unknown-licence for a key the relay doesn’t know', async () => {
    await start();
    const res = await connect({ licenceKey: 'PMP-WRONG-WRONG-WRONG-WRONG' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown-licence' });
  });

  it.each([
    ['a 500', { status: 500, error: 'boom' }],
    ['a 200 that isn’t a registration', { status: 200, error: null }],
    ['an unexpected error code', { status: 400, error: 'something-new' }],
  ])('answers 424 relay-unreachable (never a 5xx) for %s', async (_name, answer) => {
    await start();
    relay.registerAnswer = answer;
    const res = await connect({ licenceKey: relay.licenceKey });
    expect(res.statusCode).toBe(424);
    expect(res.json()).toEqual({ error: 'relay-unreachable' });
  });

  it('answers 424 when the relay can’t be reached, or none is configured', async () => {
    await start({ relayUrl: 'http://127.0.0.1:1' });
    expect((await connect({ licenceKey: relay.licenceKey })).statusCode).toBe(424);
    await app.close();
    await start({ relayUrl: null });
    expect((await connect({ licenceKey: relay.licenceKey })).statusCode).toBe(424);
  });

  it('refuses a missing or blank key, and unpaired phones', async () => {
    await start();
    expect((await connect({})).statusCode).toBe(400);
    expect((await connect({ licenceKey: ' -- ' })).statusCode).toBe(400);
    const unpaired = await app.inject({
      method: 'POST',
      url: '/api/relay',
      remoteAddress: PHONE_IP,
      payload: { licenceKey: relay.licenceKey },
    });
    expect(unpaired.statusCode).toBe(401);
    expect(relay.registered).toHaveLength(0);
  });

  it('lets an old registration go first, so its own licence isn’t “in use”', async () => {
    relay.inUse = true; // this PC's own earlier registration
    relay.refuseWith = 402;
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('problem'));
    relay.refuseWith = null;
    const res = await connect({ licenceKey: relay.licenceKey });
    expect(relay.unregistered).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'connected' });
  });
});

describe('the Problem state', () => {
  it('shows why, drops the relay from the secure address, and Try again reconnects', async () => {
    relay.refuseWith = 402;
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('problem'));
    expect((await lan({ url: '/api/relay' })).json()).toMatchObject({
      state: 'problem',
      problem: 'licence-expired',
      url: relay.familyUrl,
    });
    expect((await lan({ url: '/api/access' })).json()).toEqual({ secureUrl: null });
    const invite = await lan({ method: 'POST', url: '/api/devices/invites', payload: {} });
    expect(invite.json<PairingInvite>().secureUrl).toBeNull();
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'relay.changed',
      relay: { state: 'problem', problem: 'licence-expired' },
    });

    relay.refuseWith = null; // renewed
    const retried = await lan({ method: 'POST', url: '/api/relay/retry' });
    expect(retried.json()).toMatchObject({ state: 'connected', problem: null });
  });

  it('has nothing to try again without a registration', async () => {
    await start();
    expect((await lan({ method: 'POST', url: '/api/relay/retry' })).statusCode).toBe(409);
  });
});

describe('DELETE /api/relay', () => {
  it('forgets the secret, frees the licence, and turns off', async () => {
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
    relay.inUse = true;
    const res = await lan({ method: 'DELETE', url: '/api/relay' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'off', url: null, licenceHint: null });
    expect(getRelayRecord(db)).toBeNull();
    expect(await app.relay.lettingGo).toBe(true);
    expect(relay.unregistered).toBe(1);
    expect(relay.inUse).toBe(false);
    expect(app.relay.status().state).toBe('off');
    expect(app.relay.url()).toBeNull();
    expect(relayEvents('relay.disconnected')[0]!.data).toEqual({
      url: relay.familyUrl,
    });
    expect(broadcasts.at(-1)).toMatchObject({ type: 'relay.changed', relay: { state: 'off' } });
    // It never flickered through a Problem on the way out.
    expect(JSON.stringify(broadcasts)).not.toContain('bad-secret');
  });

  it('forgets anyway when the relay can’t be reached (ADR 0025)', async () => {
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
    await relay.close();
    const res = await lan({ method: 'DELETE', url: '/api/relay' });
    expect(res.statusCode).toBe(200);
    expect(await app.relay.lettingGo).toBe(false);
    expect(getRelayRecord(db)).toBeNull();
    expect(app.relay.status().state).toBe('off');
    relay = await new FakeRelay().start(); // for afterEach
  });

  it('answers a phone on the relay address before letting go of the tunnel', async () => {
    await start({ registered: true });
    await vi.waitFor(() => expect(app.relay.status().state).toBe('connected'));
    const res = await fetch(`${relay.url}/api/relay`, {
      method: 'DELETE',
      headers: { cookie, origin: relay.familyUrl },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'off' });
    expect(await app.relay.lettingGo).toBe(true);
    expect(relay.connected).toBe(false);
  });

  it('is fine with nothing to disconnect', async () => {
    await start();
    const res = await lan({ method: 'DELETE', url: '/api/relay' });
    expect(res.statusCode).toBe(200);
    expect(relay.unregistered).toBe(0);
    expect(relayEvents('relay.disconnected')).toHaveLength(0);
  });
});
