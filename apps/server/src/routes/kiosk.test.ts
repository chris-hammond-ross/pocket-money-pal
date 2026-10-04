import { kioskTodaySchema, zonedTimeToInstant, type KioskToday } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { ServerClock } from '../clock';
import type { Db } from '../db/client';
import { choreInstances, chores, users } from '../db/schema';
import { approveInstance, listInstancesForDate } from '../repo/instances';
import { appendLedger } from '../repo/ledger';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, testDb } from '../test-helpers';

const TZ = 'Europe/London';
const DAY = '2026-09-30';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;

beforeEach(() => {
  ({ db, close } = testDb());
  now = at('16:40');
});
afterEach(async () => {
  await app?.close();
  close();
});

async function start(opts: { devClock?: ServerClock } = {}) {
  app = await buildApp({ db, webDist: null, now: opts.devClock ? undefined : () => now, ...opts });
  return app;
}

async function board(): Promise<KioskToday> {
  const res = await app.inject({ method: 'GET', url: '/api/kiosk/today' });
  expect(res.statusCode).toBe(200);
  return kioskTodaySchema.parse(res.json());
}

function instanceOf(choreId: number, childId: number, date = DAY) {
  return listInstancesForDate(db, date).find(
    (i) => i.choreId === choreId && i.childId === childId,
  )!;
}

function setInstance(id: number, fields: Partial<typeof choreInstances.$inferInsert>) {
  db.update(choreInstances).set(fields).where(eq(choreInstances.id, id)).run();
}

/** Billy and Alice (in that column order) with the prototype's afternoon chores. */
function seedFamily() {
  const alice = addChild(db, 'Alice');
  const billy = addChild(db, 'Billy');
  db.update(users).set({ sortOrder: 1 }).where(eq(users.id, alice.id)).run();
  const parent = insertParent(db, { name: 'Mum' });
  const loot = { basePoints: 10, earlyBonus: 5, unpromptedBonus: 5, latePenalty: 3 };
  const tidy = addChore(db, [billy.id, alice.id], {
    title: 'Tidy shared bedroom',
    icon: '🧸',
    together: true,
    bonusBefore: '17:00',
    dueBy: '18:30',
    lateAfter: '19:30',
    ...loot,
  });
  const dishes = addChore(db, [billy.id], {
    title: 'Empty the dishwasher',
    icon: '🍽️',
    bonusBefore: '16:30',
    dueBy: '17:30',
    lateAfter: '19:00',
    ...loot,
  });
  const reading = addChore(db, [billy.id], {
    title: 'Homework reading',
    icon: '📚',
    bonusBefore: '17:00',
    dueBy: '19:00',
    lateAfter: '20:00',
    ...loot,
  });
  const cat = addChore(db, [billy.id], { title: 'Feed the cat', icon: '🐈' });
  const bed = addChore(db, [billy.id], { title: 'Make your bed', icon: '🛏️' });
  const plants = addChore(db, [billy.id], { title: 'Water the plants', icon: '🪴' });
  ensureDay(db, DAY, at('00:00'));

  setInstance(instanceOf(cat.id, billy.id).id, {
    status: 'claimed',
    claimedAt: at('07:50'), // bonus time (bed-style chore: bonus before 08:00)
    unprompted: true,
  });
  const bedInstance = instanceOf(bed.id, billy.id);
  setInstance(bedInstance.id, { status: 'claimed', claimedAt: at('07:30'), unprompted: false });
  approveInstance(db, {
    instanceId: bedInstance.id,
    chips: { early: true, unprompted: false, late: false },
    parentId: parent.id,
    now: at('08:10'),
  });
  setInstance(instanceOf(plants.id, billy.id).id, { status: 'skipped' });

  return { alice, billy, parent, tidy, dishes, reading, cat, bed };
}

describe('GET /api/kiosk/today', () => {
  it('answers an empty board before setup', async () => {
    await start();
    const body = await board();
    expect(body).toMatchObject({
      serverNow: now,
      date: DAY,
      timezone: TZ,
      dayStart: at('00:00'),
      devClock: false,
      children: [],
    });
  });

  it('lists children in column order with their quests in spec order', async () => {
    const f = seedFamily();
    await start();
    const body = await board();

    expect(body.children.map((c) => c.name)).toEqual(['Billy', 'Alice']);
    const billy = body.children[0]!;
    // 16:40: dishes are due (bonus ended 16:30), tidy and reading are in bonus time; tidy's
    // bonus ends first, ties are broken by due time. Then the claimed cat, then the bed.
    expect(billy.quests.map((q) => [q.title, q.status, q.stage])).toEqual([
      ['Tidy shared bedroom', 'open', 'bonus'],
      ['Homework reading', 'open', 'bonus'],
      ['Empty the dishwasher', 'open', 'due'],
      ['Feed the cat', 'claimed', null],
      ['Make your bed', 'approved', null],
    ]);
    expect(billy.nextUpId).toBe(instanceOf(f.tidy.id, f.billy.id).id);
  });

  it('works out the points each card shows', async () => {
    seedFamily();
    await start();
    const billy = (await board()).children[0]!;
    const byTitle = Object.fromEntries(billy.quests.map((q) => [q.title, q]));

    // Open: base + early (if still bonus) + unprompted.
    expect(byTitle['Tidy shared bedroom']!.maxPoints).toBe(20);
    expect(byTitle['Empty the dishwasher']!.maxPoints).toBe(15);
    // Claimed at 07:50, unprompted, in bonus time: 5 + 3 + 2.
    expect(byTitle['Feed the cat']).toMatchObject({ pendingPoints: 10, maxPoints: null });
    // Approved with the early chip only: 5 + 3.
    expect(byTitle['Make your bed']).toMatchObject({ awardedPoints: 8, pendingPoints: null });
  });

  it('includes the times, their instants, the loot and the Shared tag', async () => {
    seedFamily();
    await start();
    const tidy = (await board()).children[0]!.quests[0]!;
    expect(tidy).toMatchObject({
      icon: '🧸',
      shared: true,
      times: { bonusBefore: '17:00', dueBy: '18:30', lateAfter: '19:30' },
      window: { bonusBefore: at('17:00'), dueBy: at('18:30'), lateAfter: at('19:30') },
      loot: { basePoints: 10, earlyBonus: 5, unpromptedBonus: 5, latePenalty: 3 },
      claimedAt: null,
      approvedAt: null,
    });
  });

  it('derives level, XP and points today from the ledger, with no streak yet', async () => {
    const f = seedFamily();
    appendLedger(db, {
      childId: f.alice.id,
      kind: 'chore_points',
      points: 60,
      at: at('10:00', '2026-09-20'),
    });
    appendLedger(db, { childId: f.alice.id, kind: 'bonus', points: 4, at: at('12:00') });
    await start();
    const [billy, alice] = (await board()).children;

    expect(billy).toMatchObject({
      xp: 8,
      pointsToday: 8,
      streak: { days: 0, best: 0, tier: 0, last: null },
      sickToday: false,
      money: { savedCents: 0, toSortCents: 0, unconvertedPoints: 8, unconvertedCents: 40 },
      jars: [],
      envelopes: [],
    });
    expect(billy!.level).toEqual({ level: 1, xpIntoLevel: 8, xpForThisLevel: 50, xpToNext: 42 });
    // 60 lifetime XP (the bonus doesn't count), but only the bonus was today.
    expect(alice).toMatchObject({ xp: 60, pointsToday: 4 });
    expect(alice!.level).toMatchObject({ level: 2, xpIntoLevel: 10, xpForThisLevel: 60 });
  });

  it.each([
    ['16:00', 'bonus', 20],
    ['17:00', 'bonus', 20], // exactly at bonus_before: the bonus still counts
    ['17:01', 'due', 15],
    ['18:30', 'due', 15],
    ['18:31', 'overdue', 15],
    ['19:30', 'overdue', 15],
    ['19:31', 'late', 12],
  ] as const)('at %s the shared tidy-up is %s, up to +%i', async (time, stage, points) => {
    const f = seedFamily();
    now = at(time);
    await start();
    const alice = (await board()).children[1]!;
    expect(alice.quests[0]).toMatchObject({ choreId: f.tidy.id, stage, maxPoints: points });
  });

  it('ranks overdue first and late last for the Next-up countdown', async () => {
    const f = seedFamily();
    now = at('19:10');
    await start();
    const billy = (await board()).children[0]!;
    expect(billy.quests.slice(0, 3).map((q) => [q.choreId, q.stage])).toEqual([
      [f.tidy.id, 'overdue'], // 20 min before points drop
      [f.reading.id, 'overdue'], // 50 min
      [f.dishes.id, 'late'], // late since 19:00
    ]);
    expect(billy.nextUpId).toBe(instanceOf(f.tidy.id, f.billy.id).id);
  });

  it('has no Next-up quest once everything is claimed or approved', async () => {
    const f = seedFamily();
    for (const i of listInstancesForDate(db, DAY)) {
      if (i.status === 'open')
        setInstance(i.id, { status: 'claimed', claimedAt: at('16:00'), unprompted: false });
    }
    await start();
    const billy = (await board()).children[0]!;
    expect(billy.nextUpId).toBeNull();
    expect(billy.quests.map((q) => q.status)).toEqual([
      ...Array<string>(4).fill('claimed'),
      'approved',
    ]);
    expect(billy.quests[0]!.choreId).toBe(f.cat.id); // claimed at 07:50, the earliest
  });

  it("shows only today's quests, and leaves out archived children", async () => {
    const f = seedFamily();
    ensureDay(db, '2026-10-01', at('00:00', '2026-10-01'));
    db.update(users).set({ archived: true }).where(eq(users.id, f.alice.id)).run();
    await start();
    const body = await board();
    expect(body.children.map((c) => c.name)).toEqual(['Billy']);
    expect(body.children[0]!.quests).toHaveLength(5);
  });

  it('puts the send-back note, with the parent who wrote it, on an open card', async () => {
    const f = seedFamily();
    const tidy = instanceOf(f.tidy.id, f.billy.id);
    const reading = instanceOf(f.reading.id, f.billy.id);
    setInstance(tidy.id, { sendBackReason: 'needs_redo', sentBackBy: f.parent.id });
    setInstance(reading.id, { sendBackReason: 'not_finished' });
    // A reason typed into the DB by hand, which the kiosk wouldn't understand.
    setInstance(instanceOf(f.dishes.id, f.billy.id).id, { sendBackReason: 'meh' });
    await start();
    const billy = (await board()).children[0]!;
    const byId = new Map(billy.quests.map((q) => [q.id, q]));

    expect(byId.get(tidy.id)!.sentBack).toEqual({ reason: 'needs_redo', by: 'Mum' });
    expect(byId.get(reading.id)!.sentBack).toEqual({ reason: 'not_finished', by: null });
    expect(billy.quests.filter((q) => q.sentBack).map((q) => q.id)).toEqual([tidy.id, reading.id]);
  });

  it("uses the instance's snapshot for times, and the chore for its title and icon", async () => {
    const f = seedFamily();
    db.update(chores)
      .set({ title: 'Tidy your room', icon: '🧹', bonusBefore: '12:00' })
      .where(eq(chores.id, f.tidy.id))
      .run();
    await start();
    const tidy = (await board()).children[0]!.quests.find((q) => q.choreId === f.tidy.id)!;
    expect(tidy).toMatchObject({
      title: 'Tidy your room',
      icon: '🧹',
      times: { bonusBefore: '17:00' },
    });
  });
});

describe('development clock', () => {
  it('has no /api/dev routes unless the dev clock is on', async () => {
    await start();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/dev/clock',
      payload: { at: '18:40' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('moves the whole server to a time today, and back', async () => {
    seedFamily();
    const clock = new ServerClock(() => now);
    await start({ devClock: clock });
    const broadcast = vi.spyOn(app.hub, 'broadcast');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/dev/clock',
      payload: { at: '18:40' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ offsetMs: 2 * 3_600_000, now: at('18:40') });
    expect(broadcast).toHaveBeenCalledWith({ type: 'clock.changed' });

    let body = await board();
    expect(body).toMatchObject({ serverNow: at('18:40'), devClock: true });
    expect(body.children[1]!.quests[0]!.stage).toBe('overdue');

    // It keeps ticking from there.
    now += 60_000;
    expect((await board()).serverNow).toBe(at('18:41'));

    await app.inject({ method: 'PUT', url: '/api/dev/clock', payload: { at: null } });
    body = await board();
    expect(body).toMatchObject({ serverNow: now, devClock: false });
  });

  it('accepts a date and time, in the family time zone', async () => {
    const clock = new ServerClock(() => now);
    await start({ devClock: clock });
    await app.inject({ method: 'PUT', url: '/api/dev/clock', payload: { at: '2026-10-25T07:05' } });
    const body = await board();
    // 25 October is the day London's clocks go back.
    expect(body).toMatchObject({ date: '2026-10-25', serverNow: at('07:05', '2026-10-25') });
    expect((await app.inject({ method: 'GET', url: '/api/dev/clock' })).json()).toMatchObject({
      now: at('07:05', '2026-10-25'),
    });
  });

  it.each([{ at: '6:40' }, { at: '25:00' }, { at: 1840 }, {}, { at: '2026-02-30T10:00' }])(
    'refuses %j',
    async (payload) => {
      const clock = new ServerClock(() => now);
      await start({ devClock: clock });
      const res = await app.inject({ method: 'PUT', url: '/api/dev/clock', payload });
      expect(res.statusCode).toBe(400);
      expect(clock.offsetMs).toBe(0);
    },
  );
});
