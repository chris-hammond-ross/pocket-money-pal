import { addDays, zonedTimeToInstant } from '@pmp/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { choreInstances, chores, events, serverKv, streakDays } from '../db/schema';
import { ensureDay } from '../scheduler';
import { addChild, addChore, testDb } from '../test-helpers';
import { approveClaim, sendBackInstance, undoApprovalBy } from './instances';
import { setKv } from './kv';
import { setSickToday } from './players';
import { setSkippedToday } from './chores';
import {
  decideStreaks,
  latestReport,
  rebuildStreakDays,
  REPORT_FRESH_MS,
  refreshStreaksFor,
  streakOf,
} from './streaks';
import { insertParent } from './users';

const TZ = 'Europe/London';
const at = (date: string, time = '12:00') => zonedTimeToInstant(date, time, TZ);
const D1 = '2026-09-21';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = testDb());
  // A database that has had streaks from the start: no silent first build.
  setKv(db, 'streaks-built', '0');
});
afterEach(() => close());

function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id, alice.id]);
  const cat = addChore(db, [billy.id], { title: 'Feed the cat', icon: '🐱', dueBy: '08:30' });
  return { mum, billy, alice, bed, cat };
}

function instancesOf(childId: number, date: string) {
  return db
    .select()
    .from(choreInstances)
    .where(and(eq(choreInstances.childId, childId), eq(choreInstances.date, date)))
    .orderBy(asc(choreInstances.id))
    .all();
}

function setStatus(childId: number, date: string, status: 'claimed' | 'approved' | 'skipped') {
  db.update(choreInstances)
    .set({ status, ...(status !== 'skipped' && { claimedAt: at(date, '07:00') }) })
    .where(and(eq(choreInstances.childId, childId), eq(choreInstances.date, date)))
    .run();
}

/** Creates `date`'s chores, and marks every one of `childId`'s as `status`. */
function day(date: string, childId: number, status: 'open' | 'claimed' | 'approved' | 'skipped') {
  ensureDay(db, date, at(date, '00:00'));
  if (status !== 'open') setStatus(childId, date, status);
}

/** Runs the new-day decision for the day after `date`, just after midnight. */
function midnightAfter(date: string) {
  const next = addDays(date, 1);
  return decideStreaks(db, next, at(next, '00:01'));
}

function rows(childId: number) {
  return db
    .select({ date: streakDays.date, result: streakDays.result })
    .from(streakDays)
    .where(eq(streakDays.childId, childId))
    .orderBy(asc(streakDays.date))
    .all();
}

const decided = () => db.select().from(events).where(eq(events.type, 'streak.decided')).all();

describe('decideStreaks', () => {
  it('decides yesterday at midnight and records a report', () => {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    const updates = midnightAfter(D1);

    expect(rows(f.billy.id)).toEqual([{ date: D1, result: 'done' }]);
    // Alice left her bed open: missed, but her streak was already 0, so nothing plays.
    expect(rows(f.alice.id)).toEqual([{ date: D1, result: 'missed' }]);
    expect(updates).toEqual([
      {
        childId: f.billy.id,
        last: expect.objectContaining({
          dates: [D1],
          result: 'done',
          before: 0,
          after: 1,
          bestBefore: 0,
          best: 1,
          missedQuest: null,
        }),
      },
      { childId: f.alice.id, last: null },
    ]);
    expect(decided()).toHaveLength(2);
    expect(streakOf(db, f.billy.id, addDays(D1, 1))).toEqual({ days: 1, best: 1, tier: 1 });
  });

  it('names the first quest left open on a missed day', () => {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    midnightAfter(D1);
    const d2 = addDays(D1, 1);
    day(d2, f.billy.id, 'open');
    const [update] = midnightAfter(d2);
    expect(update!.last).toMatchObject({
      result: 'missed',
      before: 1,
      after: 0,
      missedQuest: 'Feed the cat', // due 08:30, before the bed's 09:00
    });
  });

  it('is idempotent: a second run decides nothing new', () => {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    midnightAfter(D1);
    expect(midnightAfter(D1)).toEqual([]);
    expect(decided()).toHaveLength(2);
  });

  it('catches up on several days at once after the PC was off', () => {
    const f = seed();
    for (const d of [D1, addDays(D1, 1), addDays(D1, 2)]) day(d, f.billy.id, 'approved');
    // Nobody ran the midnight check until three days later.
    const [billy] = midnightAfter(addDays(D1, 2));
    expect(billy!.last).toMatchObject({
      dates: [D1, addDays(D1, 1), addDays(D1, 2)],
      result: 'done',
      before: 0,
      after: 3,
    });
  });

  it('keeps a day with every chore skipped neutral, and a day with no chores has no row', () => {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    midnightAfter(D1);
    const d3 = addDays(D1, 2); // D1 + 1 had no chores (the PC was off)
    day(d3, f.billy.id, 'skipped');
    const updates = midnightAfter(d3);
    expect(rows(f.billy.id)).toEqual([
      { date: D1, result: 'done' },
      { date: d3, result: 'neutral' },
    ]);
    expect(updates.find((u) => u.childId === f.billy.id)).toEqual({
      childId: f.billy.id,
      last: null,
    });
    expect(streakOf(db, f.billy.id, addDays(d3, 1)).days).toBe(1);
  });

  it('holds a pending day without breaking or growing the streak', () => {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    midnightAfter(D1);
    const d2 = addDays(D1, 1);
    day(d2, f.billy.id, 'claimed');
    const updates = midnightAfter(d2);
    expect(rows(f.billy.id).at(-1)).toEqual({ date: d2, result: 'pending' });
    expect(updates.find((u) => u.childId === f.billy.id)?.last).toBeNull();
    expect(streakOf(db, f.billy.id, addDays(d2, 1)).days).toBe(1);
  });

  it('builds the history silently the first time, on a database from before streaks', () => {
    const f = seed();
    // An older database has no 'streaks-built' key.
    db.delete(serverKv).run();
    day(D1, f.billy.id, 'approved');
    day(addDays(D1, 1), f.billy.id, 'approved');
    expect(decideStreaks(db, addDays(D1, 2), at(addDays(D1, 2)))).toEqual([]);
    expect(rows(f.billy.id)).toHaveLength(2);
    expect(decided()).toHaveLength(0);
    expect(streakOf(db, f.billy.id, addDays(D1, 2)).days).toBe(2);
  });
});

describe('refreshStreaksFor (a past day changes)', () => {
  function pendingYesterday() {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    midnightAfter(D1);
    const d2 = addDays(D1, 1);
    day(d2, f.billy.id, 'claimed');
    midnightAfter(d2);
    const ids = instancesOf(f.billy.id, d2).map((i) => i.id);
    return { ...f, d2, ids, today: addDays(d2, 1) };
  }

  it('plays the report when the last claim of a pending day is approved', () => {
    const f = pendingYesterday();
    const now = at(f.today, '08:00');
    approveClaim(db, { instanceId: f.ids[0]!, parentId: f.mum.id, now });
    expect(refreshStreaksFor(db, [f.ids[0]!], now)).toEqual([]); // still one waiting
    approveClaim(db, { instanceId: f.ids[1]!, parentId: f.mum.id, now });
    const [update] = refreshStreaksFor(db, [f.ids[1]!], now);
    expect(update).toMatchObject({
      childId: f.billy.id,
      last: { dates: [f.d2], result: 'done', before: 1, after: 2 },
    });
  });

  it('ends the streak when a pending day is sent back', () => {
    const f = pendingYesterday();
    const now = at(f.today, '08:00');
    sendBackInstance(db, { instanceId: f.ids[0]!, reason: 'needs_redo', parentId: f.mum.id, now });
    const [update] = refreshStreaksFor(db, [f.ids[0]!], now);
    expect(update!.last).toMatchObject({ result: 'missed', before: 1, after: 0 });
  });

  it('follows an undo quietly: the number drops, but no report plays', () => {
    const f = pendingYesterday();
    const now = at(f.today, '08:00');
    for (const id of f.ids) approveClaim(db, { instanceId: id, parentId: f.mum.id, now });
    refreshStreaksFor(db, f.ids, now);
    expect(streakOf(db, f.billy.id, f.today).days).toBe(2);
    const events = decided().length;

    undoApprovalBy(db, { instanceId: f.ids[0]!, parentId: f.mum.id, now: now + 1000 });
    expect(refreshStreaksFor(db, [f.ids[0]!], now + 1000)).toEqual([
      { childId: f.billy.id, last: null },
    ]);
    expect(streakOf(db, f.billy.id, f.today).days).toBe(1);
    expect(decided()).toHaveLength(events);
  });

  it("ignores today's chores: today is decided when it ends", () => {
    const f = seed();
    day(D1, f.billy.id, 'claimed');
    const [id] = instancesOf(f.billy.id, D1).map((i) => i.id);
    approveClaim(db, { instanceId: id!, parentId: f.mum.id, now: at(D1, '18:00') });
    expect(refreshStreaksFor(db, [id!], at(D1, '18:00'))).toEqual([]);
    expect(rows(f.billy.id)).toEqual([]);
  });
});

describe('rebuildStreakDays', () => {
  it('gives the same rows as deciding day by day', () => {
    const f = seed();
    const results = ['approved', 'open', 'skipped', 'claimed', 'approved'] as const;
    results.forEach((status, i) => {
      const date = addDays(D1, i);
      day(date, f.billy.id, status);
      midnightAfter(date);
    });
    const incremental = [rows(f.billy.id), rows(f.alice.id)];
    expect(rebuildStreakDays(db, addDays(D1, 5), at(addDays(D1, 5)))).toBe(10);
    expect([rows(f.billy.id), rows(f.alice.id)]).toEqual(incremental);
    expect(incremental[0]!.map((r) => r.result)).toEqual([
      'done',
      'missed',
      'neutral',
      'pending',
      'done',
    ]);
  });
});

describe('latestReport', () => {
  it('offers the newest report for a day, then nothing', () => {
    const f = seed();
    day(D1, f.billy.id, 'approved');
    const decidedAt = at(addDays(D1, 1), '00:01');
    midnightAfter(D1);
    expect(latestReport(db, f.billy.id, decidedAt + 1000)).toMatchObject({
      result: 'done',
      after: 1,
      at: decidedAt,
    });
    expect(latestReport(db, f.billy.id, decidedAt + REPORT_FRESH_MS + 1)).toBeNull();
  });

  it("isn't offered for a change that moved nothing", () => {
    const f = seed();
    day(D1, f.alice.id, 'open');
    midnightAfter(D1);
    expect(latestReport(db, f.alice.id, at(addDays(D1, 1)))).toBeNull();
  });
});

describe('setSickToday', () => {
  const ctx = (mumId: number) => ({ now: at(D1, '09:30'), today: D1, parentId: mumId });

  it("skips the child's waiting quests, leaves claims alone, and undoes", () => {
    const f = seed();
    ensureDay(db, D1, at(D1, '00:00'));
    const [bed] = instancesOf(f.billy.id, D1);
    db.update(choreInstances)
      .set({ status: 'claimed', claimedAt: at(D1, '07:00') })
      .where(eq(choreInstances.id, bed!.id))
      .run();

    setSickToday(db, f.billy.id, true, ctx(f.mum.id));
    expect(instancesOf(f.billy.id, D1).map((i) => i.status)).toEqual(['claimed', 'skipped']);
    expect(instancesOf(f.alice.id, D1).map((i) => i.status)).toEqual(['open']);

    setSickToday(db, f.billy.id, false, ctx(f.mum.id));
    expect(instancesOf(f.billy.id, D1).map((i) => i.status)).toEqual(['claimed', 'open']);
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.type)
        .filter((t) => t.startsWith('child.')),
    ).toEqual(['child.sick_day', 'child.sick_day_undone']);
  });

  it('starts a quest added later that day skipped', () => {
    const f = seed();
    ensureDay(db, D1, at(D1, '00:00'));
    setSickToday(db, f.billy.id, true, ctx(f.mum.id));
    addChore(db, [f.billy.id], { title: 'Water the plants' });
    // A new quest isn't on today's board until something syncs it; the scheduler's run does.
    ensureDay(db, D1, at(D1, '10:00'));
    expect(instancesOf(f.billy.id, D1).every((i) => i.status === 'skipped')).toBe(true);
  });

  it('keeps a quest skipped for everyone skipped after the undo', () => {
    const f = seed();
    ensureDay(db, D1, at(D1, '00:00'));
    setSickToday(db, f.billy.id, true, ctx(f.mum.id));
    setSkippedToday(db, f.cat.id, true, ctx(f.mum.id));
    setSickToday(db, f.billy.id, false, ctx(f.mum.id));
    const byChore = new Map(instancesOf(f.billy.id, D1).map((i) => [i.choreId, i.status]));
    expect(byChore.get(f.bed.id)).toBe('open');
    expect(byChore.get(f.cat.id)).toBe('skipped');
  });

  it('makes the day neutral for the streak', () => {
    const f = seed();
    ensureDay(db, D1, at(D1, '00:00'));
    setSickToday(db, f.billy.id, true, ctx(f.mum.id));
    midnightAfter(D1);
    expect(rows(f.billy.id)).toEqual([{ date: D1, result: 'neutral' }]);
  });

  it('is only for active children', () => {
    const f = seed();
    expect(() => setSickToday(db, f.mum.id, true, ctx(f.mum.id))).toThrow(/not found/);
    expect(db.select().from(chores).all()).toHaveLength(2);
  });
});
