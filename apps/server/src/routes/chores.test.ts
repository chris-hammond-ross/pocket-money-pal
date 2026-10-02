import { choreListSchema, dayPlanSchema, zonedTimeToInstant, type ChoreInput } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { choreInstances, events, ledger } from '../db/schema';
import { approveInstance, getInstance, listInstancesForDate } from '../repo/instances';
import { kioskToday } from '../repo/kiosk';
import { updateSettings } from '../repo/settings';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const TZ = 'Europe/London';
const DAY = '2026-09-30'; // a Wednesday
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let cookie: string;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('16:00');
  app = await buildApp({ db, webDist: null, now: () => now });
});
afterEach(async () => {
  await app.close();
  close();
});

/** Billy and Alice both make their beds daily; Mum's phone is paired. */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id, alice.id], {
    bonusBefore: '17:00',
    dueBy: '18:00',
    lateAfter: '19:00',
  });
  ensureDay(db, DAY, at('00:00'));
  cookie = pairedCookie(db, mum.id);
  const today = (childId: number, choreId = bed.id) =>
    listInstancesForDate(db, DAY).find((i) => i.choreId === choreId && i.childId === childId);
  return { mum, billy, alice, bed, today };
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });
const patch = (id: number, payload: Record<string, unknown>) =>
  asPhone({ method: 'PATCH', url: `/api/chores/${id}`, payload });

function claim(id: number, time = '16:30') {
  db.update(choreInstances)
    .set({ status: 'claimed', claimedAt: at(time), unprompted: false })
    .where(eq(choreInstances.id, id))
    .run();
}

function newQuest(childIds: number[], fields: Partial<ChoreInput> = {}): ChoreInput {
  return {
    title: 'Feed the cat',
    icon: '🐱',
    together: false,
    bonusBefore: '17:00',
    dueBy: '17:30',
    lateAfter: '18:00',
    basePoints: 5,
    earlyBonus: 2,
    unpromptedBonus: 2,
    latePenalty: 1,
    days: [...ALL_DAYS],
    oneOffDate: null,
    childIds,
    ...fields,
  };
}

describe('POST /api/chores', () => {
  it("creates a quest with today's chores, and tells every screen", async () => {
    const f = seed();
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await asPhone({
      method: 'POST',
      url: '/api/chores',
      payload: { ...newQuest([f.billy.id]), libraryId: 'feed-pet' },
    });
    expect(res.statusCode).toBe(201);
    const chore = res.json();
    expect(chore).toMatchObject({
      title: 'Feed the cat',
      libraryId: 'feed-pet',
      childIds: [f.billy.id],
    });
    expect(f.today(f.billy.id, chore.id)).toMatchObject({ status: 'open', dueBy: '17:30' });
    expect(f.today(f.alice.id, chore.id)).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith({ type: 'chore.created', choreId: chore.id });
    expect(db.select().from(events).where(eq(events.type, 'chore.created')).get()).toMatchObject({
      actorId: f.mum.id,
    });
  });

  it('makes a one-off for today, which runs only today', async () => {
    const f = seed();
    const res = await asPhone({
      method: 'POST',
      url: '/api/chores',
      payload: newQuest([f.alice.id], { days: [], oneOffDate: DAY }),
    });
    const { id } = res.json();
    expect(f.today(f.alice.id, id)).toMatchObject({ status: 'open' });
    ensureDay(db, '2026-10-01', at('00:00', '2026-10-01'));
    expect(listInstancesForDate(db, '2026-10-01').some((i) => i.choreId === id)).toBe(false);
  });

  it("doesn't make today's chores for a quest that doesn't run today", async () => {
    const f = seed();
    const res = await asPhone({
      method: 'POST',
      url: '/api/chores',
      payload: newQuest([f.billy.id], { days: ['sat'] }),
    });
    expect(f.today(f.billy.id, res.json().id)).toBeUndefined();
  });

  it('refuses a bad quest or an unknown player', async () => {
    const f = seed();
    const post = (payload: object) => asPhone({ method: 'POST', url: '/api/chores', payload });
    expect((await post(newQuest([f.billy.id], { title: '' }))).statusCode).toBe(400);
    expect((await post(newQuest([f.billy.id], { dueBy: '16:00' }))).statusCode).toBe(400);
    expect((await post(newQuest([]))).statusCode).toBe(400);
    expect((await post(newQuest([999]))).statusCode).toBe(400);
  });
});

describe('PATCH /api/chores/:id: edits apply to today', () => {
  it("moves today's open chores to the new times and loot; a claimed one keeps its own", async () => {
    const f = seed();
    claim(f.today(f.billy.id)!.id);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await patch(f.bed.id, { dueBy: '18:30', lateAfter: '20:00', basePoints: 10 });
    expect(res.statusCode).toBe(200);
    expect(f.today(f.alice.id)).toMatchObject({
      dueBy: '18:30',
      lateAfter: '20:00',
      basePoints: 10,
    });
    expect(f.today(f.billy.id)).toMatchObject({
      status: 'claimed',
      dueBy: '18:00',
      lateAfter: '19:00',
      basePoints: 5,
    });
    expect(broadcast).toHaveBeenCalledWith({ type: 'chore.updated', choreId: f.bed.id });
    // The kiosk shows the new window straight away.
    const alice = kioskToday(db, now, { devClock: false }).children.find(
      (c) => c.id === f.alice.id,
    )!;
    expect(alice.quests[0]!.times.dueBy).toBe('18:30');
    const audit = db.select().from(events).where(eq(events.type, 'chore.updated')).get();
    expect(audit?.data).toEqual({ changed: ['dueBy', 'lateAfter', 'basePoints'] });
  });

  it('removing a player with a claimed chore keeps the claim in the tray', async () => {
    const f = seed();
    const billys = f.today(f.billy.id)!;
    claim(billys.id);
    const res = await patch(f.bed.id, { childIds: [f.alice.id] });
    expect(res.json().childIds).toEqual([f.alice.id]);
    expect(getInstance(db, billys.id).status).toBe('claimed');
    const tray = (await asPhone({ method: 'GET', url: '/api/instances/claimed' })).json();
    expect(tray.map((t: { instanceId: number }) => t.instanceId)).toEqual([billys.id]);
  });

  it('removing a player deletes their open chore today, and adding one creates it', async () => {
    const f = seed();
    await patch(f.bed.id, { childIds: [f.alice.id] });
    expect(f.today(f.billy.id)).toBeUndefined();
    await patch(f.bed.id, { childIds: [f.alice.id, f.billy.id] });
    expect(f.today(f.billy.id)).toMatchObject({ status: 'open' });
  });

  it('a player added while the quest is skipped today joins it skipped', async () => {
    const f = seed();
    await patch(f.bed.id, { childIds: [f.alice.id] });
    await asPhone({ method: 'POST', url: `/api/chores/${f.bed.id}/skip-today` });
    await patch(f.bed.id, { childIds: [f.alice.id, f.billy.id] });
    expect(f.today(f.billy.id)!.status).toBe('skipped');
  });

  it('switching today off removes open chores only; switching it on brings them back', async () => {
    const f = seed();
    const billys = f.today(f.billy.id)!;
    claim(billys.id);
    const off = await patch(f.bed.id, { days: ['mon', 'tue', 'thu'] });
    expect(off.statusCode).toBe(200);
    expect(f.today(f.alice.id)).toBeUndefined();
    expect(getInstance(db, billys.id).status).toBe('claimed');
    expect(db.select().from(events).where(eq(events.type, 'chore.day_toggled')).get()).toBeTruthy();

    await patch(f.bed.id, { days: ['mon', 'tue', 'wed', 'thu'] });
    expect(f.today(f.alice.id)).toMatchObject({ status: 'open' });
  });

  it('an approved-then-undone-then-sent-back chore with ledger history is skipped, not deleted', async () => {
    const f = seed();
    const alices = f.today(f.alice.id)!;
    claim(alices.id);
    approveInstance(db, {
      instanceId: alices.id,
      chips: { early: true, unprompted: false, late: false },
      parentId: f.mum.id,
      now,
    });
    db.update(choreInstances).set({ status: 'open' }).where(eq(choreInstances.id, alices.id)).run();
    await patch(f.bed.id, { childIds: [f.billy.id] });
    expect(getInstance(db, alices.id).status).toBe('skipped');
    expect(db.select().from(ledger).all()).toHaveLength(1);
  });

  it('refuses a patch that breaks the rules, unknown fields, and unknown chores', async () => {
    const f = seed();
    expect((await patch(f.bed.id, { bonusBefore: '18:30' })).statusCode).toBe(400);
    expect((await patch(f.bed.id, { childIds: [] })).statusCode).toBe(400);
    expect((await patch(f.bed.id, { childIds: [999] })).statusCode).toBe(400);
    expect((await patch(f.bed.id, { colour: 'red' })).statusCode).toBe(400);
    expect((await patch(f.bed.id, { together: true, childIds: [f.billy.id] })).statusCode).toBe(
      400,
    );
    expect((await patch(999, { title: 'x' })).statusCode).toBe(404);
    expect(f.today(f.alice.id)!.dueBy).toBe('18:00');
  });

  it('leaves out fields that were not sent (no defaults sneak in)', async () => {
    const f = seed();
    await patch(f.bed.id, { together: true });
    const res = await patch(f.bed.id, { title: 'Make the bed' });
    expect(res.json()).toMatchObject({ title: 'Make the bed', together: true });
  });
});

describe('DELETE /api/chores/:id', () => {
  it("keeps today's approved chore and its ledger row, and removes the open one", async () => {
    const f = seed();
    const billys = f.today(f.billy.id)!;
    claim(billys.id);
    approveInstance(db, {
      instanceId: billys.id,
      chips: { early: true, unprompted: false, late: false },
      parentId: f.mum.id,
      now,
    });
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await asPhone({ method: 'DELETE', url: `/api/chores/${f.bed.id}` });
    expect(res.statusCode).toBe(204);
    expect(broadcast).toHaveBeenCalledWith({ type: 'chore.deleted', choreId: f.bed.id });
    expect(getInstance(db, billys.id).status).toBe('approved');
    expect(f.today(f.alice.id)).toBeUndefined();
    expect(db.select().from(ledger).all()).toHaveLength(1);

    const list = choreListSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/chores' })).json(),
    );
    expect(list).toEqual([]);
    expect((await asPhone({ method: 'DELETE', url: `/api/chores/${f.bed.id}` })).statusCode).toBe(
      404,
    );
  });
});

describe('skip today', () => {
  it('skips the open chores (off the kiosk), leaves a claimed one, and puts them back', async () => {
    const f = seed();
    const billys = f.today(f.billy.id)!;
    claim(billys.id);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const skip = await asPhone({ method: 'POST', url: `/api/chores/${f.bed.id}/skip-today` });
    expect(skip.statusCode).toBe(204);
    expect(broadcast).toHaveBeenCalledWith({ type: 'day.changed', date: DAY });
    expect(f.today(f.alice.id)!.status).toBe('skipped');
    expect(getInstance(db, billys.id).status).toBe('claimed');
    const alice = kioskToday(db, now, { devClock: false }).children.find(
      (c) => c.id === f.alice.id,
    )!;
    expect(alice.quests).toEqual([]);

    const back = await asPhone({ method: 'DELETE', url: `/api/chores/${f.bed.id}/skip-today` });
    expect(back.statusCode).toBe(204);
    expect(f.today(f.alice.id)!.status).toBe('open');
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.type),
    ).toEqual(expect.arrayContaining(['chore.skipped', 'chore.restored']));
  });
});

describe('GET /api/day/:date', () => {
  it("today: each child's instance with its status, sorted by due time", async () => {
    const f = seed();
    addChore(db, [f.billy.id], {
      title: 'Early one',
      bonusBefore: '07:00',
      dueBy: '07:30',
      lateAfter: '08:00',
    });
    ensureDay(db, DAY, at('00:00'));
    claim(f.today(f.billy.id)!.id);
    const res = await asPhone({ method: 'GET', url: `/api/day/${DAY}` });
    const plan = dayPlanSchema.parse(res.json());
    expect(plan).toMatchObject({ date: DAY, today: DAY, centsPerPoint: 5 });
    const alias = await asPhone({ method: 'GET', url: '/api/day/today' });
    expect(alias.json()).toEqual(res.json());
    expect(plan.quests.map((q) => q.chore.title)).toEqual(['Early one', 'Make your bed']);
    const bed = plan.quests[1]!;
    expect(bed.instances.map((i) => [i.childId, i.status, i.points])).toEqual([
      [f.billy.id, 'claimed', 8],
      [f.alice.id, 'open', null],
    ]);
  });

  it('marks a quest skipped today, and still shows one whose day went while a claim waits', async () => {
    const f = seed();
    await asPhone({ method: 'POST', url: `/api/chores/${f.bed.id}/skip-today` });
    let plan = dayPlanSchema.parse(
      (await asPhone({ method: 'GET', url: `/api/day/${DAY}` })).json(),
    );
    expect(plan.quests[0]!.skipped).toBe(true);

    await asPhone({ method: 'DELETE', url: `/api/chores/${f.bed.id}/skip-today` });
    claim(f.today(f.billy.id)!.id);
    await patch(f.bed.id, { days: ['mon'] });
    plan = dayPlanSchema.parse((await asPhone({ method: 'GET', url: `/api/day/${DAY}` })).json());
    expect(plan.quests[0]!.instances.map((i) => i.status)).toEqual(['claimed']);
  });

  it("another day: what's scheduled, with no statuses", async () => {
    const f = seed();
    addChore(db, [f.alice.id], { title: 'Bins', days: ['sun'] });
    const res = await asPhone({ method: 'GET', url: '/api/day/2026-10-04' });
    const plan = dayPlanSchema.parse(res.json());
    expect(plan.quests.map((q) => [q.chore.title, q.instances.length])).toEqual([
      ['Bins', 0],
      ['Make your bed', 0],
    ]);
    expect((await asPhone({ method: 'GET', url: '/api/day/2026-02-30' })).statusCode).toBe(400);
  });

  it('shows the family rate for the earnings line', async () => {
    seed();
    updateSettings(db, { centsPerPoint: 10 });
    const plan = (await asPhone({ method: 'GET', url: `/api/day/${DAY}` })).json();
    expect(plan.centsPerPoint).toBe(10);
  });
});
