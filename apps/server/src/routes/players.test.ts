import {
  adjustmentSchema,
  gameMasterListSchema,
  playerListSchema,
  serverEventSchema,
  trayListSchema,
  zonedTimeToInstant,
  type ServerEvent,
} from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { choreAssignments, choreInstances, events, ledger, users } from '../db/schema';
import { listChores } from '../repo/chores';
import { listInstancesForDate } from '../repo/instances';
import { kioskToday } from '../repo/kiosk';
import { getSettings } from '../repo/settings';
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
let cookie: string;
let sent: ServerEvent[];

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('16:00');
  app = await buildApp({ db, webDist: null, now: () => now });
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
});

/** Mum (paired) and Dad; Billy and Alice; Billy's bed, a shared tidy-up, Alice's dishes. */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const dad = insertParent(db, { name: 'Dad' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id]);
  const tidy = addChore(db, [billy.id, alice.id], { title: 'Tidy up', icon: '🧸' });
  const dishes = addChore(db, [alice.id], { title: 'Dishes', icon: '🍽️' });
  ensureDay(db, DAY, at('00:00'));
  cookie = pairedCookie(db, mum.id);
  return { mum, dad, billy, alice, bed, tidy, dishes };
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });

const instanceOf = (choreId: number, childId: number) =>
  listInstancesForDate(db, DAY).find((i) => i.choreId === choreId && i.childId === childId);

describe('parent-only', () => {
  it('refuses every Players endpoint without a paired phone', async () => {
    seed();
    const calls: InjectOptions[] = [
      { method: 'GET', url: '/api/children' },
      { method: 'GET', url: '/api/parents' },
      { method: 'POST', url: '/api/children', payload: {} },
      { method: 'PATCH', url: '/api/children/1', payload: {} },
      { method: 'DELETE', url: '/api/children/1' },
      { method: 'POST', url: '/api/children/1/adjust', payload: { points: 5 } },
      { method: 'PATCH', url: '/api/settings', payload: { centsPerPoint: 7 } },
    ];
    for (const call of calls) {
      const res = await app.inject({ ...call, remoteAddress: PHONE_IP });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });
});

describe('GET /api/children and /api/parents', () => {
  it('gives a card per child: quests, points today and money', async () => {
    const f = seed();
    db.insert(ledger)
      .values([
        { childId: f.billy.id, kind: 'chore_points', points: 8, cents: 40, at: at('09:00') },
        { childId: f.billy.id, kind: 'bonus', points: 5, at: at('10:00') },
        {
          childId: f.billy.id,
          kind: 'chore_points',
          points: 20,
          cents: 100,
          at: at('09:00', '2026-09-29'),
        },
      ])
      .run();
    const res = await asPhone({ method: 'GET', url: '/api/children' });
    expect(res.statusCode).toBe(200);
    const cards = playerListSchema.parse(res.json());
    expect(cards.map((c) => [c.name, c.quests, c.pointsToday, c.cents, c.streakDays])).toEqual([
      ['Billy', 2, 13, 140, 0],
      ['Alice', 2, 0, 0, 0],
    ]);
    expect(cards[0]).toMatchObject({ age: 9, avatar: '🦖', colour: '#228be6' });
  });

  it('lists the game masters with their phone counts', async () => {
    const f = seed();
    pairedCookie(db, f.mum.id);
    const res = await asPhone({ method: 'GET', url: '/api/parents' });
    expect(gameMasterListSchema.parse(res.json())).toEqual([
      { id: f.mum.id, name: 'Mum', phones: 2 },
      { id: f.dad.id, name: 'Dad', phones: 0 },
    ]);
  });
});

describe('POST /api/children', () => {
  const cara = { name: 'Cara', age: 6, avatar: '🦄', colour: '#e64980' };

  it('adds a player in the next column, records it and tells every screen', async () => {
    const f = seed();
    const res = await asPhone({ method: 'POST', url: '/api/children', payload: cara });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Cara', quests: 0, pointsToday: 0 });
    const kiosk = kioskToday(db, now, { devClock: false });
    expect(kiosk.children.map((c) => c.name)).toEqual(['Billy', 'Alice', 'Cara']);
    const event = db.select().from(events).where(eq(events.type, 'child.created')).get();
    expect(event).toMatchObject({ actorId: f.mum.id, childId: res.json().id });
    expect(sent).toContainEqual({ type: 'child.created', childId: res.json().id });
  });

  it('refuses a name another player has (any case), and bad input', async () => {
    seed();
    const taken = await asPhone({
      method: 'POST',
      url: '/api/children',
      payload: { ...cara, name: 'billy' },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'name-taken' });
    for (const payload of [
      { ...cara, name: '' },
      { ...cara, name: 'A very long name indeed' },
      { ...cara, age: 2 },
      { ...cara, age: 18 },
      { ...cara, colour: 'pink' },
    ]) {
      const res = await asPhone({ method: 'POST', url: '/api/children', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('allows the name of a removed player', async () => {
    const f = seed();
    await asPhone({ method: 'DELETE', url: `/api/children/${f.alice.id}` });
    const res = await asPhone({
      method: 'POST',
      url: '/api/children',
      payload: { ...cara, name: 'Alice' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('PATCH /api/children/:id', () => {
  it('saves the editor, records what changed and tells every screen', async () => {
    const f = seed();
    const res = await asPhone({
      method: 'PATCH',
      url: `/api/children/${f.billy.id}`,
      payload: { name: 'William', age: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: f.billy.id, name: 'William', age: 10 });
    const event = db.select().from(events).where(eq(events.type, 'child.updated')).get();
    expect(event?.data).toEqual({ changed: ['name', 'age'] });
    expect(sent).toContainEqual({ type: 'child.updated', childId: f.billy.id });
  });

  it('keeps a player’s own name, but not another’s', async () => {
    const f = seed();
    const same = await asPhone({
      method: 'PATCH',
      url: `/api/children/${f.billy.id}`,
      payload: { name: 'BILLY' },
    });
    expect(same.statusCode).toBe(200);
    const other = await asPhone({
      method: 'PATCH',
      url: `/api/children/${f.billy.id}`,
      payload: { name: 'Alice' },
    });
    expect(other.statusCode).toBe(409);
  });

  it('refuses unknown fields, unknown and removed players', async () => {
    const f = seed();
    const extra = await asPhone({
      method: 'PATCH',
      url: `/api/children/${f.billy.id}`,
      payload: { archived: false },
    });
    expect(extra.statusCode).toBe(400);
    expect(
      (await asPhone({ method: 'PATCH', url: '/api/children/999', payload: { age: 5 } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await asPhone({ method: 'PATCH', url: `/api/children/${f.mum.id}`, payload: { age: 5 } }))
        .statusCode,
    ).toBe(404);
    await asPhone({ method: 'DELETE', url: `/api/children/${f.alice.id}` });
    expect(
      (await asPhone({ method: 'PATCH', url: `/api/children/${f.alice.id}`, payload: { age: 5 } }))
        .statusCode,
    ).toBe(404);
  });
});

describe('DELETE /api/children/:id', () => {
  it('archives the child, takes them off every quest and their open chores off the board', async () => {
    const f = seed();
    const res = await asPhone({ method: 'DELETE', url: `/api/children/${f.billy.id}` });
    expect(res.statusCode).toBe(200);
    // The bed had only Billy: it stays, with no players. The tidy-up keeps Alice.
    expect(res.json()).toEqual({ questsLeftEmpty: [f.bed.id] });
    const chores = listChores(db);
    expect(chores.find((c) => c.id === f.bed.id)?.childIds).toEqual([]);
    expect(chores.find((c) => c.id === f.tidy.id)?.childIds).toEqual([f.alice.id]);
    expect(instanceOf(f.bed.id, f.billy.id)).toBeUndefined();
    expect(instanceOf(f.tidy.id, f.billy.id)).toBeUndefined();
    expect(instanceOf(f.tidy.id, f.alice.id)?.status).toBe('open');
    expect(db.select().from(users).where(eq(users.id, f.billy.id)).get()?.archived).toBe(true);
    const kiosk = kioskToday(db, now, { devClock: false });
    expect(kiosk.children.map((c) => c.name)).toEqual(['Alice']);
    const event = db.select().from(events).where(eq(events.type, 'child.removed')).get();
    expect(event).toMatchObject({ actorId: f.mum.id, childId: f.billy.id });
    expect(sent).toContainEqual({ type: 'child.removed', childId: f.billy.id });
  });

  it('keeps a claim in the tray, with the child’s look, until it’s handled', async () => {
    const f = seed();
    const bed = instanceOf(f.bed.id, f.billy.id)!;
    db.update(choreInstances)
      .set({ status: 'claimed', claimedAt: at('07:30'), unprompted: true })
      .where(eq(choreInstances.id, bed.id))
      .run();
    await asPhone({ method: 'DELETE', url: `/api/children/${f.billy.id}` });

    const tray = trayListSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/instances/claimed' })).json(),
    );
    expect(tray.map((t) => [t.instanceId, t.child.name])).toEqual([[bed.id, 'Billy']]);

    // Sending it back takes it off the board; it doesn't reopen.
    const back = await asPhone({
      method: 'POST',
      url: `/api/instances/${bed.id}/send-back`,
      payload: { reason: 'needs_redo' },
    });
    expect(back.statusCode).toBe(204);
    expect(instanceOf(f.bed.id, f.billy.id)).toBeUndefined();
  });

  it('keeps ledger history', async () => {
    const f = seed();
    db.insert(ledger)
      .values({ childId: f.billy.id, kind: 'chore_points', points: 8, at: at('09:00') })
      .run();
    await asPhone({ method: 'DELETE', url: `/api/children/${f.billy.id}` });
    expect(db.select().from(ledger).where(eq(ledger.childId, f.billy.id)).all()).toHaveLength(1);
  });

  it('a quest left with no players schedules nothing, and comes back with a player', async () => {
    const f = seed();
    await asPhone({ method: 'DELETE', url: `/api/children/${f.billy.id}` });
    const nextDay = '2026-10-01';
    ensureDay(db, nextDay, at('00:00', nextDay));
    expect(listInstancesForDate(db, nextDay).filter((i) => i.choreId === f.bed.id)).toEqual([]);

    // Editing it without adding a player is refused; adding one brings today's chore back.
    const titleOnly = await asPhone({
      method: 'PATCH',
      url: `/api/chores/${f.bed.id}`,
      payload: { title: 'Bed' },
    });
    expect(titleOnly.statusCode).toBe(400);
    const withAlice = await asPhone({
      method: 'PATCH',
      url: `/api/chores/${f.bed.id}`,
      payload: { childIds: [f.alice.id] },
    });
    expect(withAlice.statusCode).toBe(200);
    expect(instanceOf(f.bed.id, f.alice.id)?.status).toBe('open');
  });

  it('is 404 for an unknown, removed or grown-up id', async () => {
    const f = seed();
    await asPhone({ method: 'DELETE', url: `/api/children/${f.alice.id}` });
    for (const id of [999, f.alice.id, f.mum.id]) {
      const res = await asPhone({ method: 'DELETE', url: `/api/children/${id}` });
      expect(res.statusCode, String(id)).toBe(404);
    }
    expect(db.select().from(choreAssignments).all().length).toBeGreaterThan(0);
  });
});

describe('POST /api/children/:id/adjust', () => {
  it('a bonus is a ledger row by this parent that counts today, but not as XP', async () => {
    const f = seed();
    const res = await asPhone({
      method: 'POST',
      url: `/api/children/${f.billy.id}/adjust`,
      payload: { points: 10 },
    });
    expect(res.statusCode).toBe(201);
    const adjustment = adjustmentSchema.parse(res.json());
    expect(adjustment).toEqual({ childId: f.billy.id, points: 10, pointsToday: 10 });
    const row = db.select().from(ledger).get();
    expect(row).toMatchObject({
      childId: f.billy.id,
      kind: 'bonus',
      points: 10,
      cents: 0,
      centsPerPoint: 5,
      createdBy: f.mum.id,
      at: now,
    });
    const kiosk = kioskToday(db, now, { devClock: false });
    const billy = kiosk.children.find((c) => c.id === f.billy.id)!;
    expect([billy.pointsToday, billy.xp]).toEqual([10, 0]);
    const event = db.select().from(events).where(eq(events.type, 'child.adjusted')).get();
    expect(event).toMatchObject({ actorId: f.mum.id, childId: f.billy.id, data: { points: 10 } });
    expect(sent).toContainEqual({ type: 'child.adjusted', adjustment });
  });

  it('minus points are a penalty row', async () => {
    const f = seed();
    await asPhone({
      method: 'POST',
      url: `/api/children/${f.billy.id}/adjust`,
      payload: { points: 10 },
    });
    const res = await asPhone({
      method: 'POST',
      url: `/api/children/${f.billy.id}/adjust`,
      payload: { points: -5 },
    });
    expect(res.json()).toMatchObject({ points: -5, pointsToday: 5 });
    expect(
      db
        .select()
        .from(ledger)
        .all()
        .map((r) => [r.kind, r.points]),
    ).toEqual([
      ['bonus', 10],
      ['penalty', -5],
    ]);
  });

  it('refuses zero, fractions, big numbers, and unknown or removed players', async () => {
    const f = seed();
    for (const points of [0, 2.5, 1001, -1001]) {
      const res = await asPhone({
        method: 'POST',
        url: `/api/children/${f.billy.id}/adjust`,
        payload: { points },
      });
      expect(res.statusCode, String(points)).toBe(400);
    }
    await asPhone({ method: 'DELETE', url: `/api/children/${f.alice.id}` });
    for (const id of [999, f.alice.id]) {
      const res = await asPhone({
        method: 'POST',
        url: `/api/children/${id}/adjust`,
        payload: { points: 5 },
      });
      expect(res.statusCode).toBe(404);
    }
    expect(db.select().from(ledger).all()).toEqual([]);
  });
});

describe('PATCH /api/settings', () => {
  it('changes the rate from now on: earlier rows keep theirs', async () => {
    const f = seed();
    await asPhone({
      method: 'POST',
      url: `/api/children/${f.billy.id}/adjust`,
      payload: { points: 5 },
    });
    const res = await asPhone({
      method: 'PATCH',
      url: '/api/settings',
      payload: { centsPerPoint: 8 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ centsPerPoint: 8 });
    await asPhone({
      method: 'POST',
      url: `/api/children/${f.billy.id}/adjust`,
      payload: { points: 5 },
    });
    expect(
      db
        .select()
        .from(ledger)
        .all()
        .map((r) => r.centsPerPoint),
    ).toEqual([5, 8]);
    const event = db.select().from(events).where(eq(events.type, 'settings.updated')).get();
    expect(event).toMatchObject({
      actorId: f.mum.id,
      data: { centsPerPoint: { from: 5, to: 8 } },
    });
    expect(sent).toContainEqual({ type: 'settings.updated' });
  });

  it('sets and clears quiet hours', async () => {
    seed();
    const set = await asPhone({
      method: 'PATCH',
      url: '/api/settings',
      payload: { quietHours: { from: '21:30', until: '06:30' } },
    });
    expect(set.json().quietHours).toEqual({ from: '21:30', until: '06:30' });
    await asPhone({ method: 'PATCH', url: '/api/settings', payload: { quietHours: null } });
    expect(getSettings(db).quietHours).toBeNull();
  });

  it('refuses other settings, a zero rate and odd quiet hours', async () => {
    seed();
    for (const payload of [
      {},
      { timezone: 'Europe/Paris' },
      { centsPerPoint: 0 },
      { centsPerPoint: 2.5 },
      { quietHours: { from: '21:10', until: '06:30' } },
      { quietHours: { from: '07:00', until: '07:00' } },
    ]) {
      const res = await asPhone({ method: 'PATCH', url: '/api/settings', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(getSettings(db)).toMatchObject({ centsPerPoint: 5, timezone: TZ });
  });
});
