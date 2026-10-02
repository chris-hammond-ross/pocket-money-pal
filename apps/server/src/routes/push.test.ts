import { PUSH_BATCH_MS, zonedTimeToInstant, type PushSubscriptionInput } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { choreInstances, devices, events } from '../db/schema';
import type { PushMessage } from '../push';
import { listInstancesForDate } from '../repo/instances';
import { getKv } from '../repo/kv';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const TZ = 'Europe/London';
const DAY = '2026-09-30';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let pushed: { endpoint: string; message: PushMessage }[];
/** Endpoints the fake push service says are gone (410). */
let gone: Set<string>;

const sub = (name: string): PushSubscriptionInput => ({
  endpoint: `https://push.example/${name}`,
  expirationTime: null,
  keys: { p256dh: `p256-${name}`, auth: `auth-${name}` },
});

async function start(options: { secureUrl?: string } = {}) {
  app = await buildApp({
    db,
    webDist: null,
    now: () => now,
    secureUrl: options.secureUrl ?? null,
    pushSender: async (subscription, message) => {
      pushed.push({ endpoint: subscription.endpoint, message });
      return { gone: gone.has(subscription.endpoint) };
    },
  });
}

beforeEach(() => {
  ({ db, close } = testDb());
  now = at('16:00');
  pushed = [];
  gone = new Set();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  close();
});

/** Mum's and Dad's phones (both paired); Billy and Alice, each with their bed and dishes. */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const dad = insertParent(db, { name: 'Dad' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id, alice.id]);
  const dishes = addChore(db, [billy.id, alice.id], { title: 'Dishes', icon: '🍽️' });
  ensureDay(db, DAY, at('00:00'));
  const find = (choreId: number, childId: number) =>
    listInstancesForDate(db, DAY).find((i) => i.choreId === choreId && i.childId === childId)!.id;
  return {
    mum: pairedCookie(db, mum.id),
    dad: pairedCookie(db, dad.id),
    billyBed: find(bed.id, billy.id),
    aliceBed: find(bed.id, alice.id),
    billyDishes: find(dishes.id, billy.id),
    aliceDishes: find(dishes.id, alice.id),
    billy,
    alice,
  };
}

const phone = (cookie: string, opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });

const subscribe = (cookie: string, name: string) =>
  phone(cookie, {
    method: 'POST',
    url: '/api/devices/me/push-subscription',
    payload: sub(name),
  });

const claim = (instanceId: number, childId: number) =>
  app.inject({
    method: 'POST',
    url: `/api/instances/${instanceId}/claim`,
    payload: { childId, unprompted: false },
  });

describe('push subscriptions', () => {
  it('gives the VAPID public key to paired phones only, and keeps it across restarts', async () => {
    await start();
    const f = seed();
    expect((await app.inject({ method: 'GET', url: '/api/push/key' })).statusCode).toBe(401);
    const key = (await phone(f.mum, { method: 'GET', url: '/api/push/key' })).json().publicKey;
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    await app.close();
    await start();
    expect((await phone(f.mum, { method: 'GET', url: '/api/push/key' })).json().publicKey).toBe(
      key,
    );
  });

  it('stores and clears a phone’s subscription on its own device', async () => {
    await start();
    const f = seed();
    expect((await subscribe(f.mum, 'mum')).statusCode).toBe(204);
    const stored = () =>
      db
        .select()
        .from(devices)
        .all()
        .map((d) => d.pushSubscription);
    expect(stored()).toEqual([sub('mum'), null]);
    const del = await phone(f.mum, { method: 'DELETE', url: '/api/devices/me/push-subscription' });
    expect(del.statusCode).toBe(204);
    expect(stored()).toEqual([null, null]);
  });

  it('refuses a subscription that isn’t one, and an unpaired phone', async () => {
    await start();
    const f = seed();
    for (const payload of [
      {},
      { ...sub('x'), endpoint: 'http://push.example/x' },
      { endpoint: 'https://a.b' },
    ]) {
      const res = await phone(f.mum, {
        method: 'POST',
        url: '/api/devices/me/push-subscription',
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    const anon = await app.inject({
      method: 'POST',
      url: '/api/devices/me/push-subscription',
      remoteAddress: PHONE_IP,
      payload: sub('x'),
    });
    expect(anon.statusCode).toBe(401);
  });

  it('sends a test notification to this phone only', async () => {
    await start();
    const f = seed();
    const none = await phone(f.mum, { method: 'POST', url: '/api/devices/me/push-test' });
    expect(none.statusCode).toBe(409);
    await subscribe(f.mum, 'mum');
    await subscribe(f.dad, 'dad');
    const res = await phone(f.mum, { method: 'POST', url: '/api/devices/me/push-test' });
    expect(res.statusCode).toBe(204);
    expect(pushed.map((p) => [p.endpoint, p.message.tag])).toEqual([
      ['https://push.example/mum', 'test'],
    ]);
  });

  it('can delay the test notification, so the phone can be locked first', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const res = await phone(f.mum, {
      method: 'POST',
      url: '/api/devices/me/push-test',
      payload: { delaySeconds: 60 },
    });
    expect(res.statusCode).toBe(202);
    expect(pushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pushed).toHaveLength(1);
  });
});

describe('claim notifications', () => {
  it('pushes the first claim at once to every subscribed phone', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    await subscribe(f.dad, 'dad');
    await claim(f.billyBed, f.billy.id);
    await app.notifier.settle();
    expect(pushed.map((p) => p.endpoint).sort()).toEqual([
      'https://push.example/dad',
      'https://push.example/mum',
    ]);
    expect(pushed[0]!.message).toEqual({
      title: 'Billy claimed ‘Make your bed’',
      body: '1 to check · tap to approve',
      tag: 'claims',
      url: '/parent?tray=1',
    });
  });

  it('batches claims within 2 minutes into one replacing notification', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await claim(f.billyBed, f.billy.id);
    await app.notifier.settle();
    await claim(f.aliceBed, f.alice.id);
    await claim(f.aliceDishes, f.alice.id);
    await app.notifier.settle();
    expect(pushed).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PUSH_BATCH_MS);
    await app.notifier.settle();
    expect(pushed.map((p) => p.message.title)).toEqual([
      'Billy claimed ‘Make your bed’',
      'Alice claimed 2 quests',
    ]);
    expect(pushed[1]!.message).toMatchObject({
      body: '3 to check · tap to approve',
      tag: 'claims',
    });

    // A quiet window closes without sending; the next claim pushes at once again.
    await vi.advanceTimersByTimeAsync(PUSH_BATCH_MS);
    await claim(f.billyDishes, f.billy.id);
    await app.notifier.settle();
    expect(pushed).toHaveLength(3);
  });

  it('drops claims already handled on a phone, and sends nothing if none are left', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await claim(f.billyBed, f.billy.id);
    await claim(f.aliceBed, f.alice.id);
    await phone(f.dad, {
      method: 'POST',
      url: '/api/instances/approve',
      payload: { items: [{ id: f.aliceBed }] },
    });
    await vi.advanceTimersByTimeAsync(PUSH_BATCH_MS);
    await app.notifier.settle();
    expect(pushed).toHaveLength(1);

    await claim(f.aliceDishes, f.alice.id); // a new window: pushed at once
    await claim(f.billyDishes, f.billy.id);
    await phone(f.dad, {
      method: 'POST',
      url: `/api/instances/${f.billyDishes}/send-back`,
      payload: { reason: 'not_finished' },
    });
    await vi.advanceTimersByTimeAsync(PUSH_BATCH_MS);
    await app.notifier.settle();
    expect(pushed.map((p) => p.message.title)).toEqual([
      'Billy claimed ‘Make your bed’',
      'Alice claimed ‘Dishes’',
    ]);
  });

  it('is silent in quiet hours, and doesn’t catch up afterwards', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    now = at('20:30'); // the default quiet hours are 20:00–07:00
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await claim(f.billyBed, f.billy.id);
    await vi.advanceTimersByTimeAsync(PUSH_BATCH_MS);
    await app.notifier.settle();
    expect(pushed).toEqual([]);

    await phone(f.mum, { method: 'PATCH', url: '/api/settings', payload: { quietHours: null } });
    await claim(f.aliceBed, f.alice.id);
    await app.notifier.settle();
    expect(pushed.map((p) => p.message)).toMatchObject([
      { title: 'Alice claimed ‘Make your bed’', body: '2 to check · tap to approve' },
    ]);
  });

  it('pushes nothing to revoked phones, or phones without a subscription', async () => {
    await start();
    const f = seed();
    await subscribe(f.dad, 'dad');
    const dadId = db.select().from(devices).all()[1]!.id;
    await phone(f.mum, { method: 'DELETE', url: `/api/devices/${dadId}` });
    await claim(f.billyBed, f.billy.id);
    await app.notifier.settle();
    expect(pushed).toEqual([]);
  });

  it('forgets a subscription the push service says is gone', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    await subscribe(f.dad, 'dad');
    gone.add('https://push.example/mum');
    await claim(f.billyBed, f.billy.id);
    await app.notifier.settle();
    expect(
      db
        .select()
        .from(devices)
        .all()
        .map((d) => d.pushSubscription),
    ).toEqual([null, sub('dad')]);
  });

  it('doesn’t push when a parent marks a chore done', async () => {
    await start();
    const f = seed();
    await subscribe(f.mum, 'mum');
    await phone(f.mum, { method: 'POST', url: `/api/instances/${f.billyBed}/mark-done` });
    await app.notifier.settle();
    expect(pushed).toEqual([]);
    expect(
      db.select().from(choreInstances).where(eq(choreInstances.id, f.billyBed)).get()?.status,
    ).toBe('approved');
  });
});

describe('the HTTPS address', () => {
  const overHttps = (opts: InjectOptions) =>
    app.inject({
      ...opts,
      remoteAddress: '127.0.0.1', // `tailscale serve` on the PC
      headers: {
        'x-forwarded-for': PHONE_IP,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'family-pc.tail1234.ts.net',
        ...opts.headers,
      },
    });

  it('is null until known, and PMP_SECURE_URL sets it', async () => {
    await start();
    expect((await app.inject({ method: 'GET', url: '/api/access' })).json()).toEqual({
      secureUrl: null,
    });
    await app.close();
    await start({ secureUrl: 'https://pmp.example.com' });
    expect((await app.inject({ method: 'GET', url: '/api/access' })).json()).toEqual({
      secureUrl: 'https://pmp.example.com',
    });
  });

  it('is learned from a paired phone over HTTPS, and remembered', async () => {
    await start();
    const f = seed();
    await overHttps({ method: 'GET', url: '/api/devices/me', headers: { cookie: f.mum } });
    expect((await app.inject({ method: 'GET', url: '/api/access' })).json()).toEqual({
      secureUrl: 'https://family-pc.tail1234.ts.net',
    });
    expect(getKv(db, 'secure_url')).toBe('https://family-pc.tail1234.ts.net');
  });

  it('is learned from the PC over HTTPS', async () => {
    await start();
    await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'family-pc.tail1234.ts.net' },
    });
    expect(getKv(db, 'secure_url')).toBe('https://family-pc.tail1234.ts.net');
  });

  it('isn’t learned from a stranger, over plain HTTP, or from headers a phone sends itself', async () => {
    await start();
    const f = seed();
    await overHttps({ method: 'GET', url: '/api/health' }); // unpaired phone
    await app.inject({
      method: 'GET',
      url: '/api/devices/me',
      remoteAddress: PHONE_IP,
      headers: { cookie: f.mum, host: 'evil.example' },
    });
    await app.inject({
      method: 'GET',
      url: '/api/devices/me',
      remoteAddress: PHONE_IP, // not a loopback proxy: its forwarded headers aren't trusted
      headers: {
        cookie: f.mum,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
      },
    });
    expect(getKv(db, 'secure_url')).toBeNull();
  });
});

describe('moving a phone to HTTPS', () => {
  it('a move code pairs the HTTPS side and unpairs the phone that asked', async () => {
    await start();
    const f = seed();
    const mumId = db.select().from(devices).all()[0]!.id;
    const invite = await phone(f.mum, {
      method: 'POST',
      url: '/api/devices/invites',
      payload: { move: true },
    });
    expect(invite.statusCode).toBe(201);
    const { code } = invite.json();
    const parentId = (
      await app.inject({
        method: 'POST',
        url: '/api/devices/pair/check',
        remoteAddress: PHONE_IP,
        payload: { code },
      })
    ).json().parents[0].id;
    const paired = await app.inject({
      method: 'POST',
      url: '/api/devices/pair',
      remoteAddress: PHONE_IP,
      payload: { code, parentId },
    });
    expect(paired.statusCode).toBe(201);
    // The old (http) pairing is gone; the new one works.
    expect((await phone(f.mum, { method: 'GET', url: '/api/devices/me' })).statusCode).toBe(401);
    const revoked = db.select().from(events).where(eq(events.type, 'device.revoked')).get();
    expect(revoked?.data).toMatchObject({ deviceId: mumId, movedTo: paired.json().deviceId });
    const pairedEvent = db.select().from(events).where(eq(events.type, 'device.paired')).all();
    expect(pairedEvent.at(-1)?.data).toMatchObject({ via: 'move' });
  });

  it('a normal invite leaves the inviting phone paired', async () => {
    await start();
    const f = seed();
    const { code } = (await phone(f.mum, { method: 'POST', url: '/api/devices/invites' })).json();
    await app.inject({
      method: 'POST',
      url: '/api/devices/pair',
      remoteAddress: PHONE_IP,
      payload: { code, parentId: 1 },
    });
    expect((await phone(f.mum, { method: 'GET', url: '/api/devices/me' })).statusCode).toBe(200);
  });

  it('refuses a malformed invite request', async () => {
    await start();
    const f = seed();
    const res = await phone(f.mum, {
      method: 'POST',
      url: '/api/devices/invites',
      payload: { move: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});
