import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  kioskTodaySchema,
  moneyOverviewSchema,
  paydaySummarySchema,
  savingsBookSchema,
  serverEventSchema,
  zonedTimeToInstant,
  type MoneyOverview,
  type ServerEvent,
} from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { devices, events, familySettings, goals, ledger } from '../db/schema';
import type { ImageFetcher } from '../goal-image';
import { listInstancesForDate, markDone, undoApprovalBy } from '../repo/instances';
import { appendLedger } from '../repo/ledger';
import { listPaydays } from '../repo/payday';
import { insertParent } from '../repo/users';
import { setPushSubscription } from '../push';
import { ensureDay } from '../scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const TZ = 'Europe/London';
const DAY = '2026-09-30'; // a Wednesday; payday is Sunday 6pm by default
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let cookie: string;
let sent: ServerEvent[];
let pushed: { title: string; body: string; tag: string; url: string }[];
let imagesDir: string;
let fetchImage: ReturnType<typeof vi.fn<ImageFetcher>>;
let scheduleChanged: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('16:00');
  imagesDir = mkdtempSync(join(tmpdir(), 'pmp-money-'));
  fetchImage = vi.fn<ImageFetcher>(async () => ({ bytes: PNG, ext: 'png' }));
  scheduleChanged = vi.fn<() => void>();
  pushed = [];
  app = await buildApp({
    db,
    webDist: null,
    now: () => now,
    imagesDir,
    imageFetcher: fetchImage,
    onScheduleChanged: scheduleChanged,
    pushSender: async (_sub, message) => {
      pushed.push(message);
      return { gone: false };
    },
  });
  sent = [];
  const broadcast = app.hub.broadcast.bind(app.hub);
  app.hub.broadcast = (event) => {
    sent.push(serverEventSchema.parse(event));
    broadcast(event);
  };
});
afterEach(async () => {
  await app.close();
  close();
  rmSync(imagesDir, { recursive: true, force: true });
});

/** Mum (paired, push on) and Dad; Billy and Alice, each with a daily bed. */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const dad = insertParent(db, { name: 'Dad' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  addChore(db, [billy.id]);
  addChore(db, [alice.id]);
  ensureDay(db, DAY, at('00:00'));
  cookie = pairedCookie(db, mum.id);
  const device = db.select().from(devices).get()!;
  setPushSubscription(db, device.id, {
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'p', auth: 'a' },
  });
  return { mum, dad, billy, alice };
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });
const asKiosk = (opts: InjectOptions) => app.inject({ ...opts, remoteAddress: PHONE_IP });

/** Bonus points from Mum (so the amounts are exact), at the current rate. */
function givePoints(childId: number, points: number, rate = 5) {
  appendLedger(db, { childId, kind: 'bonus', points, centsPerPoint: rate, at: now });
}

/** Money straight into "to sort", as an opened gift would. */
function giveMoney(childId: number, cents: number) {
  appendLedger(db, { childId, kind: 'extra_income', cents, note: 'Test', at: now });
}

async function overview(): Promise<MoneyOverview> {
  const res = await asPhone({ method: 'GET', url: '/api/money' });
  expect(res.statusCode).toBe(200);
  return moneyOverviewSchema.parse(res.json());
}
async function moneyOf(childId: number) {
  return (await overview()).children.find((c) => c.id === childId)!;
}
async function makeJar(
  childId: number,
  fields: Partial<{ name: string; emoji: string; targetCents: number; shopUrl: string }> = {},
  as: 'kiosk' | 'phone' = 'kiosk',
) {
  const send = as === 'kiosk' ? asKiosk : asPhone;
  const res = await send({
    method: 'POST',
    url: '/api/goals',
    payload: { childId, name: 'Basketball', emoji: '🏀', targetCents: 2499, ...fields },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: number }).id;
}
const move = (goalId: number, cents: number) =>
  asKiosk({ method: 'POST', url: `/api/goals/${goalId}/move`, payload: { cents } });

describe('parent-only calls', () => {
  it('refuses every phone call without a paired phone', async () => {
    seed();
    const calls: InjectOptions[] = [
      { method: 'GET', url: '/api/money' },
      { method: 'PATCH', url: '/api/goals/1', payload: { name: 'x' } },
      { method: 'DELETE', url: '/api/goals/1/smash' },
      { method: 'POST', url: '/api/goals/1/bought' },
      { method: 'POST', url: '/api/children/1/envelopes', payload: { cents: 100, note: 'x' } },
      { method: 'POST', url: '/api/children/1/spend', payload: { cents: 100, note: 'x' } },
      { method: 'POST', url: '/api/paydays' },
    ];
    for (const call of calls) {
      const res = await asKiosk(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });
});

describe('making jars', () => {
  it('from the kiosk: last in order, price not checked, and the phones are told', async () => {
    const { billy } = seed();
    const first = await makeJar(billy.id, {
      name: 'PlayStation 5',
      emoji: '🎮',
      targetCents: 47_999,
    });
    const second = await makeJar(billy.id);
    const jars = (await moneyOf(billy.id)).jars;
    expect(jars.map((j) => j.id)).toEqual([first, second]);
    expect(jars[1]).toMatchObject({
      name: 'Basketball',
      emoji: '🏀',
      targetCents: 2499,
      inCents: 0,
      madeByChild: true,
      priceChecked: false,
      smashed: false,
      stats: null, // no history yet
    });
    expect(jars[0]!.progress).toMatchObject({ big: true, fillToCents: 1000 });
    expect(sent).toContainEqual({
      type: 'goal.created',
      goalId: second,
      childId: billy.id,
      byChild: true,
    });
    const event = db.select().from(events).where(eq(events.type, 'goal.created')).all().at(-1);
    expect(event).toMatchObject({ actorId: billy.id, childId: billy.id });
  });

  it('from a phone: checked from the start', async () => {
    const { billy, mum } = seed();
    const id = await makeJar(billy.id, { name: 'Lego set', emoji: '🧱' }, 'phone');
    expect((await moneyOf(billy.id)).jars[0]).toMatchObject({
      id,
      madeByChild: false,
      priceChecked: true,
    });
    expect(db.select().from(goals).where(eq(goals.id, id)).get()!.createdBy).toBe(mum.id);
    expect(sent.at(-1)).toMatchObject({ type: 'goal.created', byChild: false });
  });

  it.each([
    ['an unknown picture', { emoji: '🍕' }],
    ['no name', { name: '  ' }],
    ['a name over 28 characters', { name: 'x'.repeat(29) }],
    ['a price under £1', { targetCents: 99 }],
    ['a price over £1,000', { targetCents: 100_001 }],
    ['pence as a fraction', { targetCents: 24.5 }],
    ['a link that is not http(s)', { shopUrl: 'javascript:alert(1)' }],
  ])('refuses %s', async (_label, fields) => {
    const { billy } = seed();
    const res = await asKiosk({
      method: 'POST',
      url: '/api/goals',
      payload: { childId: billy.id, name: 'Ball', emoji: '🏀', targetCents: 1000, ...fields },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a child who is not playing', async () => {
    seed();
    const res = await asKiosk({
      method: 'POST',
      url: '/api/goals',
      payload: { childId: 999, name: 'Ball', emoji: '🏀', targetCents: 1000 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('moving coins', () => {
  it('pours in from "to sort" and takes out again, without changing what is saved', async () => {
    const { billy } = seed();
    giveMoney(billy.id, 825);
    const jar = await makeJar(billy.id, { targetCents: 1000 });

    const res = await move(jar, 500);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      goalId: jar,
      childId: billy.id,
      cents: 500,
      inCents: 500,
      toSortCents: 325,
    });
    expect(sent.at(-1)).toEqual({ type: 'goal.moved', move: res.json() });
    expect((await move(jar, -200)).statusCode).toBe(200);

    const m = await moneyOf(billy.id);
    expect(m.money).toMatchObject({ savedCents: 825, toSortCents: 525 });
    expect(m.jars[0]!.inCents).toBe(300);
  });

  it('refuses more than "to sort", more than the room left, or more than the jar holds', async () => {
    const { billy } = seed();
    giveMoney(billy.id, 2000);
    const jar = await makeJar(billy.id, { targetCents: 1000 });
    expect((await move(jar, 1001)).json()).toEqual({ error: 'too-much' });
    expect((await move(jar, 1000)).statusCode).toBe(200);
    expect((await move(jar, 10)).statusCode).toBe(409); // full
    expect((await move(jar, -1010)).statusCode).toBe(409);

    const other = await makeJar(billy.id, { targetCents: 5000 });
    expect((await move(other, 1001)).statusCode).toBe(409); // only £10 left to sort
  });

  it('refuses zero, and an unknown jar', async () => {
    const { billy } = seed();
    const jar = await makeJar(billy.id);
    expect((await move(jar, 0)).statusCode).toBe(400);
    expect((await move(jar, 1.5)).statusCode).toBe(400);
    expect((await move(9999, 10)).statusCode).toBe(404);
  });
});

describe('deleting a jar', () => {
  it('moves its money back to "to sort", and tells the phones it was the child', async () => {
    const { billy } = seed();
    giveMoney(billy.id, 1500);
    const jar = await makeJar(billy.id);
    await move(jar, 1200);
    const res = await asKiosk({ method: 'DELETE', url: `/api/goals/${jar}` });
    expect(res.statusCode).toBe(204);
    const m = await moneyOf(billy.id);
    expect(m.jars).toEqual([]);
    expect(m.money).toMatchObject({ savedCents: 1500, toSortCents: 1500 });
    expect(sent.at(-1)).toEqual({
      type: 'goal.deleted',
      goalId: jar,
      childId: billy.id,
      byChild: true,
    });
    expect(db.select().from(goals).where(eq(goals.id, jar)).get()!.deletedAt).toBe(now);
    // Gone: it can't be moved into or deleted again.
    expect((await move(jar, 10)).json()).toEqual({ error: 'gone' });
    expect((await asKiosk({ method: 'DELETE', url: `/api/goals/${jar}` })).statusCode).toBe(409);
  });
});

describe('smashing, buying and putting back', () => {
  async function fullJar(childId: number) {
    giveMoney(childId, 3000);
    const jar = await makeJar(childId);
    await move(jar, 2499);
    return jar;
  }

  it('refuses to smash a jar that is not full', async () => {
    const { billy } = seed();
    giveMoney(billy.id, 3000);
    const jar = await makeJar(billy.id);
    await move(jar, 2000);
    const res = await asKiosk({ method: 'POST', url: `/api/goals/${jar}/smash` });
    expect(res.json()).toEqual({ error: 'not-full' });
  });

  it('smashes a full jar, pushes to the phones, and locks its money', async () => {
    const { billy } = seed();
    const jar = await fullJar(billy.id);
    const res = await asKiosk({ method: 'POST', url: `/api/goals/${jar}/smash` });
    expect(res.statusCode).toBe(204);
    expect(sent.at(-1)).toEqual({
      type: 'goal.smashed',
      goalId: jar,
      childId: billy.id,
      byChild: true,
    });
    await app.notifier.settle();
    expect(pushed).toEqual([
      {
        title: '🔨 Billy smashed the Basketball jar',
        body: '£24.99 ready · needs buying',
        tag: 'smash',
        url: '/parent?tab=payday',
      },
    ]);
    expect((await moneyOf(billy.id)).jars[0]).toMatchObject({ smashed: true, inCents: 2499 });

    expect((await move(jar, -100)).json()).toEqual({ error: 'smashed' });
    expect((await asKiosk({ method: 'POST', url: `/api/goals/${jar}/smash` })).statusCode).toBe(
      409,
    );
    // The kiosk can't delete it, and no money can be spent from it.
    expect((await asKiosk({ method: 'DELETE', url: `/api/goals/${jar}` })).json()).toEqual({
      error: 'smashed',
    });
    const spend = await asPhone({
      method: 'POST',
      url: `/api/children/${billy.id}/spend`,
      payload: { cents: 100, note: '🍬 Sweets', goalId: jar },
    });
    expect(spend.json()).toEqual({ error: 'smashed' });
  });

  it('puts a smashed jar back', async () => {
    const { billy } = seed();
    const jar = await fullJar(billy.id);
    expect((await asPhone({ method: 'DELETE', url: `/api/goals/${jar}/smash` })).statusCode).toBe(
      409,
    );
    await asKiosk({ method: 'POST', url: `/api/goals/${jar}/smash` });
    const res = await asPhone({ method: 'DELETE', url: `/api/goals/${jar}/smash` });
    expect(res.statusCode).toBe(204);
    expect((await moneyOf(billy.id)).jars[0]).toMatchObject({ smashed: false, inCents: 2499 });
    expect(db.select().from(events).where(eq(events.type, 'goal.unsmashed')).all()).toHaveLength(1);
  });

  it('buys a smashed jar: its money is spent and the jar is finished', async () => {
    const { billy } = seed();
    const jar = await fullJar(billy.id);
    expect((await asPhone({ method: 'POST', url: `/api/goals/${jar}/bought` })).json()).toEqual({
      error: 'not-smashed',
    });
    await asKiosk({ method: 'POST', url: `/api/goals/${jar}/smash` });
    const res = await asPhone({ method: 'POST', url: `/api/goals/${jar}/bought` });
    expect(res.statusCode).toBe(204);
    expect(sent.at(-1)).toMatchObject({ type: 'goal.bought', goalId: jar });

    const m = await moneyOf(billy.id);
    expect(m.jars).toEqual([]);
    expect(m.money).toMatchObject({ savedCents: 501, toSortCents: 501 });
    const book = savingsBookSchema.parse(
      (await asKiosk({ method: 'GET', url: `/api/children/${billy.id}/savings` })).json(),
    );
    expect(book.rows[0]).toMatchObject({
      kind: 'bought',
      cents: -2499,
      balanceCents: 501,
      by: 'Mum',
      jar: { emoji: '🏀', name: 'Basketball' },
    });
  });

  it('lets a phone delete a smashed jar', async () => {
    const { billy } = seed();
    const jar = await fullJar(billy.id);
    await asKiosk({ method: 'POST', url: `/api/goals/${jar}/smash` });
    expect((await asPhone({ method: 'DELETE', url: `/api/goals/${jar}` })).statusCode).toBe(204);
    expect((await moneyOf(billy.id)).money.toSortCents).toBe(3000);
    expect(sent.at(-1)).toMatchObject({ type: 'goal.deleted', byChild: false });
  });
});

describe('editing a jar on the phone', () => {
  it('checks the price, and moves money over a lowered price back to "to sort"', async () => {
    const { billy } = seed();
    giveMoney(billy.id, 2000);
    const jar = await makeJar(billy.id, { name: 'Pony ride', emoji: '🐴', targetCents: 3200 });
    await move(jar, 2000);

    const res = await asPhone({
      method: 'PATCH',
      url: `/api/goals/${jar}`,
      payload: { name: 'Pony riding lesson', targetCents: 1500 },
    });
    expect(res.statusCode).toBe(204);
    const m = await moneyOf(billy.id);
    expect(m.jars[0]).toMatchObject({
      name: 'Pony riding lesson',
      targetCents: 1500,
      inCents: 1500,
      priceChecked: true,
      madeByChild: true,
    });
    expect(m.money).toMatchObject({ savedCents: 2000, toSortCents: 500 });
    const types = db
      .select()
      .from(events)
      .all()
      .map((e) => e.type);
    expect(types).toContain('goal.price_checked');
    expect(types).toContain('goal.updated');
    expect(sent.at(-1)).toEqual({
      type: 'goal.updated',
      goalId: jar,
      childId: billy.id,
      byChild: false,
    });
  });

  it('marks the price checked even when nothing else changes', async () => {
    const { billy } = seed();
    const jar = await makeJar(billy.id);
    expect(
      (await asPhone({ method: 'PATCH', url: `/api/goals/${jar}`, payload: {} })).statusCode,
    ).toBe(204);
    expect((await moneyOf(billy.id)).jars[0]!.priceChecked).toBe(true);
  });

  it('refuses bad fields and unknown jars', async () => {
    const { billy } = seed();
    const jar = await makeJar(billy.id);
    const bad = await asPhone({
      method: 'PATCH',
      url: `/api/goals/${jar}`,
      payload: { targetCents: 50 },
    });
    expect(bad.statusCode).toBe(400);
    const extra = await asPhone({
      method: 'PATCH',
      url: `/api/goals/${jar}`,
      payload: { inCents: 5 },
    });
    expect(extra.statusCode).toBe(400);
    expect(
      (await asPhone({ method: 'PATCH', url: '/api/goals/999', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(404);
  });
});

describe("a shop link's picture", () => {
  it('is fetched in the background and served by the PC', async () => {
    const { billy } = seed();
    const jar = await makeJar(
      billy.id,
      {
        name: 'PlayStation 5',
        emoji: '🎮',
        targetCents: 47_999,
        shopUrl: 'https://shop.example/ps5',
      },
      'phone',
    );
    await vi.waitFor(async () =>
      expect((await moneyOf(billy.id)).jars[0]!.imageUrl).not.toBeNull(),
    );
    expect(fetchImage).toHaveBeenCalledWith('https://shop.example/ps5');
    expect(sent.at(-1)).toMatchObject({ type: 'goal.updated', goalId: jar });

    const url = (await moneyOf(billy.id)).jars[0]!.imageUrl!;
    const image = await asKiosk({ method: 'GET', url });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload).toEqual(PNG);
  });

  it('leaves the jar saved without a picture when the fetch fails', async () => {
    const { billy } = seed();
    fetchImage.mockRejectedValueOnce(new Error('timeout'));
    const res = await asPhone({
      method: 'POST',
      url: '/api/goals',
      payload: {
        childId: billy.id,
        name: 'Kite',
        emoji: '🪁',
        targetCents: 1200,
        shopUrl: 'https://shop.example/kite',
      },
    });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect((await moneyOf(billy.id)).jars[0]).toMatchObject({ name: 'Kite', imageUrl: null });
    expect(
      (
        await asKiosk({
          method: 'GET',
          url: `/api/goals/${(res.json() as { id: number }).id}/image`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('is fetched again when the link changes, and dropped when it is removed', async () => {
    const { billy } = seed();
    const jar = await makeJar(billy.id, {}, 'phone');
    expect(fetchImage).not.toHaveBeenCalled();
    await asPhone({
      method: 'PATCH',
      url: `/api/goals/${jar}`,
      payload: { shopUrl: 'https://shop.example/ball' },
    });
    await vi.waitFor(async () =>
      expect((await moneyOf(billy.id)).jars[0]!.imageUrl).not.toBeNull(),
    );
    await asPhone({ method: 'PATCH', url: `/api/goals/${jar}`, payload: { shopUrl: null } });
    expect((await moneyOf(billy.id)).jars[0]).toMatchObject({ shopUrl: null, imageUrl: null });
  });
});

describe('envelopes', () => {
  it('waits on the kiosk until opened, then lands in "to sort"', async () => {
    const { billy } = seed();
    const res = await asPhone({
      method: 'POST',
      url: `/api/children/${billy.id}/envelopes`,
      payload: { cents: 2000, note: '👵 From Grandma' },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: number }).id;
    expect(sent.at(-1)).toEqual({ type: 'envelope.created', envelopeId: id, childId: billy.id });

    const board = kioskTodaySchema.parse(
      (await asKiosk({ method: 'GET', url: '/api/kiosk/today' })).json(),
    );
    const kioskBilly = board.children.find((c) => c.id === billy.id)!;
    expect(kioskBilly.envelopes).toEqual([
      {
        id,
        childId: billy.id,
        cents: 2000,
        note: '👵 From Grandma',
        fromName: 'Grandma',
        createdAt: now,
      },
    ]);
    expect(kioskBilly.money.savedCents).toBe(0); // not until it's opened

    const open = await asKiosk({ method: 'POST', url: `/api/envelopes/${id}/open` });
    expect(open.json()).toEqual({ id, cents: 2000 });
    expect(sent.at(-1)).toEqual({ type: 'envelope.opened', envelopeId: id, childId: billy.id });
    const m = await moneyOf(billy.id);
    expect(m.envelopes).toEqual([]);
    expect(m.money).toMatchObject({ savedCents: 2000, toSortCents: 2000 });
    expect((await asKiosk({ method: 'POST', url: `/api/envelopes/${id}/open` })).json()).toEqual({
      error: 'already-opened',
    });
  });

  it('comes from the parent unless the note names someone', async () => {
    const { billy } = seed();
    await asPhone({
      method: 'POST',
      url: `/api/children/${billy.id}/envelopes`,
      payload: { cents: 500, note: '🧹 Extra job' },
    });
    expect((await moneyOf(billy.id)).envelopes[0]!.fromName).toBe('Mum');
  });

  it('refuses bad amounts and notes', async () => {
    const { billy } = seed();
    for (const payload of [
      { cents: 0, note: 'x' },
      { cents: 10.5, note: 'x' },
      { cents: 100, note: '' },
      { cents: 100, note: 'x'.repeat(41) },
      { cents: 100_001, note: 'x' },
    ]) {
      const res = await asPhone({
        method: 'POST',
        url: `/api/children/${billy.id}/envelopes`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(
      (
        await asPhone({
          method: 'POST',
          url: '/api/children/999/envelopes',
          payload: { cents: 1, note: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await asKiosk({ method: 'POST', url: '/api/envelopes/999/open' })).statusCode).toBe(
      404,
    );
  });
});

describe('spending', () => {
  it('takes money from "to sort" or from a jar, never more than is there', async () => {
    const { billy, alice } = seed();
    giveMoney(billy.id, 1000);
    const jar = await makeJar(billy.id);
    await move(jar, 600);
    const spend = (payload: object, childId = billy.id) =>
      asPhone({ method: 'POST', url: `/api/children/${childId}/spend`, payload });

    expect((await spend({ cents: 401, note: '🍬 Sweets' })).json()).toEqual({ error: 'too-much' });
    expect((await spend({ cents: 300, note: '🍬 Sweets' })).statusCode).toBe(204);
    expect(sent.at(-1)).toEqual({ type: 'money.spent', childId: billy.id, cents: 300 });
    expect((await spend({ cents: 601, note: '🎮 Game', goalId: jar })).statusCode).toBe(409);
    expect((await spend({ cents: 250, note: '🎮 Game', goalId: jar })).statusCode).toBe(204);
    // Alice can't spend from Billy's jar.
    expect((await spend({ cents: 1, note: 'x', goalId: jar }, alice.id)).statusCode).toBe(404);

    const m = await moneyOf(billy.id);
    expect(m.money).toMatchObject({ savedCents: 450, toSortCents: 100 });
    expect(m.jars[0]!.inCents).toBe(350);

    const book = savingsBookSchema.parse(
      (await asKiosk({ method: 'GET', url: `/api/children/${billy.id}/savings` })).json(),
    );
    expect(book.rows.slice(0, 2)).toMatchObject([
      { kind: 'spend', note: '🎮 Game', cents: -250, by: 'Mum', jar: { name: 'Basketball' } },
      { kind: 'spend', note: '🍬 Sweets', cents: -300, jar: null },
    ]);
  });
});

describe('payday', () => {
  it('converts points at their own rates, opens envelopes, and every kiosk plays the show', async () => {
    const { billy, alice, mum } = seed();
    givePoints(billy.id, 60, 5);
    // The rate goes up to 10p mid-week: it applies from then on.
    const rate = await asPhone({
      method: 'PATCH',
      url: '/api/settings',
      payload: { centsPerPoint: 10 },
    });
    expect(rate.statusCode).toBe(200);
    givePoints(billy.id, 20, 10);
    await asPhone({
      method: 'POST',
      url: `/api/children/${alice.id}/envelopes`,
      payload: { cents: 2000, note: '👵 From Grandma' },
    });
    expect((await moneyOf(billy.id)).money).toMatchObject({
      unconvertedPoints: 80,
      unconvertedCents: 500,
    });

    const res = await asPhone({ method: 'POST', url: '/api/paydays' });
    expect(res.statusCode).toBe(201);
    const { paydayId } = res.json() as { paydayId: number };
    expect(sent.at(-1)).toEqual({ type: 'payday.done', paydayId });

    const billyMoney = await moneyOf(billy.id);
    expect(billyMoney.money).toEqual({
      savedCents: 500,
      toSortCents: 500,
      unconvertedPoints: 0,
      unconvertedCents: 0,
    });
    expect((await moneyOf(alice.id)).money.savedCents).toBe(2000);

    const summary = paydaySummarySchema.parse(
      (await asKiosk({ method: 'GET', url: '/api/paydays/latest' })).json(),
    );
    expect(summary).toMatchObject({
      id: paydayId,
      at: at('18:00', '2026-09-27'),
      ranAt: now,
      startedBy: 'Mum',
      centsPerPoint: 10,
    });
    expect(summary.children.find((c) => c.childId === billy.id)).toMatchObject({
      points: 80,
      cents: 500,
      envelopes: [],
      stats: { bestDay: { date: DAY, points: 80 } },
      streak: { days: 0, best: 0, tier: 0 },
    });
    expect(summary.children.find((c) => c.childId === alice.id)).toMatchObject({
      points: 0,
      cents: 0,
      envelopes: [{ fromName: 'Grandma', cents: 2000 }],
    });
    expect(db.select().from(events).where(eq(events.type, 'payday.ran')).get()).toMatchObject({
      actorId: mum.id,
    });
  });

  it("counts the week's quests for the show and the savings book", async () => {
    const { billy, mum } = seed();
    const bed = listInstancesForDate(db, DAY).find((i) => i.childId === billy.id)!;
    db.transaction((tx) =>
      markDone(tx, { instanceId: bed.id, parentId: mum.id, now: at('07:30') }),
    );
    now = at('19:00');
    await asPhone({ method: 'POST', url: '/api/paydays' });
    const summary = paydaySummarySchema.parse(
      (await asKiosk({ method: 'GET', url: '/api/paydays/latest' })).json(),
    );
    const stats = summary.children.find((c) => c.childId === billy.id)!;
    expect(stats.stats).toMatchObject({ questsDone: 1, earlyBonuses: 1 });
    const book = savingsBookSchema.parse(
      (await asKiosk({ method: 'GET', url: `/api/children/${billy.id}/savings` })).json(),
    );
    expect(book.rows[0]).toMatchObject({
      kind: 'payday',
      quests: 1,
      points: stats.points,
      dateAt: at('18:00', '2026-09-27'),
    });
    expect(book.thisWeek).toEqual({ quests: 0, points: 0, cents: 0 });
  });

  it('takes an undo after payday off the next pot, and never takes paid money back', async () => {
    const { billy, mum } = seed();
    const bed = listInstancesForDate(db, DAY).find((i) => i.childId === billy.id)!;
    const approval = db.transaction((tx) =>
      markDone(tx, { instanceId: bed.id, parentId: mum.id, now: at('10:00') }),
    );
    await asPhone({ method: 'POST', url: '/api/paydays' });
    const paid = approval.points.total * 5;
    expect((await moneyOf(billy.id)).money.savedCents).toBe(paid);

    db.transaction((tx) => undoApprovalBy(tx, { instanceId: bed.id, parentId: mum.id, now }));
    const after = (await moneyOf(billy.id)).money;
    expect(after.savedCents).toBe(paid);
    expect(after.unconvertedPoints).toBe(-approval.points.total);

    // Next payday: still negative, so nothing is converted and it carries over.
    now = at('19:00', '2026-10-04');
    await asPhone({ method: 'POST', url: '/api/paydays' });
    expect((await moneyOf(billy.id)).money).toMatchObject({
      savedCents: paid,
      unconvertedPoints: -approval.points.total,
    });
  });

  it('covers the next slot when started early, and refuses a third', async () => {
    seed();
    expect((await asPhone({ method: 'POST', url: '/api/paydays' })).statusCode).toBe(201); // Sun 27th
    expect((await asPhone({ method: 'POST', url: '/api/paydays' })).statusCode).toBe(201); // Sun 4th
    const third = await asPhone({ method: 'POST', url: '/api/paydays' });
    expect(third.json()).toEqual({ error: 'already-paid' });
    expect(listPaydays(db).map((p) => p.at)).toEqual([
      at('18:00', '2026-09-27'),
      at('18:00', '2026-10-04'),
    ]);
    // The board counts down to the payday after.
    expect((await overview()).payday.nextAt).toBe(at('18:00', '2026-10-11'));
  });

  it('has no show before the first payday', async () => {
    seed();
    expect((await asKiosk({ method: 'GET', url: '/api/paydays/latest' })).statusCode).toBe(404);
  });

  it('saves the payday settings and restarts the schedule', async () => {
    seed();
    const res = await asPhone({
      method: 'PATCH',
      url: '/api/settings',
      payload: { paydayDay: 5, paydayTime: '17:00', paydayAuto: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payday: { day: 5, time: '17:00', auto: false } });
    expect(db.select().from(familySettings).get()!.paydayChangedAt).toBe(now);
    expect(scheduleChanged).toHaveBeenCalledTimes(1);
    const p = (await overview()).payday;
    expect(p).toMatchObject({ day: 5, time: '17:00', auto: false, waitingSlot: null });
    expect(p.nextAt).toBe(at('17:00', '2026-10-02'));

    // Only "how it starts" changing doesn't restart the schedule.
    now += 1000;
    await asPhone({ method: 'PATCH', url: '/api/settings', payload: { paydayAuto: true } });
    expect(db.select().from(familySettings).get()!.paydayChangedAt).toBe(now - 1000);
  });

  it.each([
    [{ paydayDay: 7 }],
    [{ paydayDay: -1 }],
    [{ paydayTime: '18:30' }],
    [{ paydayTime: '6pm' }],
    [{ paydayAuto: 'yes' }],
  ])('refuses payday settings %j', async (payload) => {
    seed();
    expect((await asPhone({ method: 'PATCH', url: '/api/settings', payload })).statusCode).toBe(
      400,
    );
  });
});

describe('the savings book', () => {
  it('lists what changed the savings, newest first, with the running balance', async () => {
    const { billy } = seed();
    givePoints(billy.id, 40);
    await asPhone({ method: 'POST', url: '/api/paydays' }); // +£2.00
    const env = await asPhone({
      method: 'POST',
      url: `/api/children/${billy.id}/envelopes`,
      payload: { cents: 2000, note: '🎂 Birthday money' },
    });
    await asKiosk({
      method: 'POST',
      url: `/api/envelopes/${(env.json() as { id: number }).id}/open`,
    });
    const jar = await makeJar(billy.id);
    await move(jar, 1500); // not a row: it doesn't change what's saved
    await asPhone({
      method: 'POST',
      url: `/api/children/${billy.id}/spend`,
      payload: { cents: 300, note: '🍬 Sweets' },
    });
    givePoints(billy.id, 12);

    const res = await asKiosk({ method: 'GET', url: `/api/children/${billy.id}/savings` });
    const book = savingsBookSchema.parse(res.json());
    expect(book.money).toMatchObject({ savedCents: 1900, toSortCents: 400 });
    expect(book.thisWeek).toEqual({ quests: 0, points: 12, cents: 60 });
    expect(book.jars).toEqual([{ id: jar, emoji: '🏀', name: 'Basketball', inCents: 1500 }]);
    expect(book.rows.map((r) => [r.kind, r.cents, r.balanceCents])).toEqual([
      ['spend', -300, 1900],
      ['gift', 2000, 2200],
      ['payday', 200, 200],
    ]);
    expect(book.rows[1]).toMatchObject({ note: '🎂 Birthday money', by: 'Mum' });
  });

  it('is empty for a child with no history yet, and 404 for an unknown child', async () => {
    const { alice } = seed();
    const book = savingsBookSchema.parse(
      (await asKiosk({ method: 'GET', url: `/api/children/${alice.id}/savings` })).json(),
    );
    expect(book.rows).toEqual([]);
    expect(book.money).toEqual({
      savedCents: 0,
      toSortCents: 0,
      unconvertedPoints: 0,
      unconvertedCents: 0,
    });
    expect((await asKiosk({ method: 'GET', url: '/api/children/999/savings' })).statusCode).toBe(
      404,
    );
  });
});

describe('jar stats on the board', () => {
  it('come from the last 14 days once there is history', async () => {
    const { billy, mum } = seed();
    const bed = listInstancesForDate(db, DAY).find((i) => i.childId === billy.id)!;
    db.transaction((tx) =>
      markDone(tx, { instanceId: bed.id, parentId: mum.id, now: at('07:30') }),
    );
    giveMoney(billy.id, 100);
    await makeJar(billy.id, { targetCents: 2499 });
    await makeJar(billy.id, { name: 'PS5', emoji: '🎮', targetCents: 47_999 });
    const [normal, big] = (await moneyOf(billy.id)).jars;
    expect(normal!.stats).toMatchObject({ kind: 'paydays' });
    expect(big!.stats).toMatchObject({ kind: 'quests', milestoneCents: 1000 });
  });
});

describe('the ledger', () => {
  it('rebuilds every balance from its rows alone', async () => {
    const { billy } = seed();
    givePoints(billy.id, 100);
    await asPhone({ method: 'POST', url: '/api/paydays' });
    const jar = await makeJar(billy.id);
    await move(jar, 300);
    givePoints(billy.id, 7);
    const rows = db.select().from(ledger).where(eq(ledger.childId, billy.id)).all();
    const saved = rows.filter((r) => r.kind !== 'goal_allocation').reduce((s, r) => s + r.cents, 0);
    const inJar = rows.filter((r) => r.goalId === jar).reduce((s, r) => s + r.cents, 0);
    const m = await moneyOf(billy.id);
    expect(m.money.savedCents).toBe(saved);
    expect(m.jars[0]!.inCents).toBe(inJar);
    expect(m.money.toSortCents).toBe(saved - inJar);
    expect(m.money.unconvertedPoints).toBe(7);
  });
});
