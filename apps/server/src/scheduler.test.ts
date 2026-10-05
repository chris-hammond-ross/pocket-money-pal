import { zonedTimeToInstant } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './db/client';
import { choreInstances, chores, events, users } from './db/schema';
import { listInstancesForDate } from './repo/instances';
import { appendLedger } from './repo/ledger';
import { moneyStateOf } from './repo/money';
import { listPaydays, startPaydayNow, type PaydayResult } from './repo/payday';
import { setKv } from './repo/kv';
import { restartPaydaySchedule, updateSettings } from './repo/settings';
import type { StreakUpdate } from './repo/streaks';
import { insertParent } from './repo/users';
import {
  ensureDay,
  MAX_SLEEP_MS,
  startScheduler,
  type EnsureDayResult,
  type Scheduler,
} from './scheduler';
import { addChild, addChore, testDb } from './test-helpers';

const TZ = 'Europe/London';
const london = (date: string, time: string) => zonedTimeToInstant(date, time, TZ);
const SEC = 1_000;
const HOUR = 3_600_000;

let db: Db;
let close: () => void;
let scheduler: Scheduler | undefined;
let newDays: EnsureDayResult[];

beforeEach(() => {
  ({ db, close } = testDb());
  newDays = [];
  vi.useFakeTimers();
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  close();
});

/** Starts the scheduler with the fake clock at `instant`. */
function startAt(instant: number) {
  vi.setSystemTime(instant);
  scheduler = startScheduler({ db, onNewDay: (r) => newDays.push(r) });
}

const count = (date: string) => listInstancesForDate(db, date).length;

describe('ensureDay', () => {
  it('creates one instance per assigned child, copying the chore times and loot', () => {
    const [billy, alice] = [addChild(db, 'Billy'), addChild(db, 'Alice')];
    const bed = addChore(db, [billy.id, alice.id]);

    expect(ensureDay(db, '2026-09-30', 0)).toEqual({
      date: '2026-09-30',
      created: 2,
      paused: false,
    });
    expect(listInstancesForDate(db, '2026-09-30')).toEqual([
      expect.objectContaining({
        choreId: bed.id,
        childId: billy.id,
        status: 'open',
        bonusBefore: '08:00',
        dueBy: '09:00',
        lateAfter: '12:00',
        basePoints: 5,
        earlyBonus: 3,
        unpromptedBonus: 2,
        latePenalty: 2,
      }),
      expect.objectContaining({ choreId: bed.id, childId: alice.id, status: 'open' }),
    ]);

    // Editing the chore later doesn't rewrite the snapshot.
    db.update(chores).set({ basePoints: 50, dueBy: '10:00' }).run();
    expect(listInstancesForDate(db, '2026-09-30')[0]).toMatchObject({
      basePoints: 5,
      dueBy: '09:00',
    });
  });

  it('is idempotent: running twice creates nothing new and leaves state alone', () => {
    const child = addChild(db);
    addChore(db, [child.id]);
    ensureDay(db, '2026-09-30', 0);
    db.update(choreInstances).set({ status: 'skipped' }).run();

    expect(ensureDay(db, '2026-09-30', 1).created).toBe(0);
    expect(listInstancesForDate(db, '2026-09-30').map((i) => i.status)).toEqual(['skipped']);
    // Only the first run is recorded.
    expect(db.select().from(events).all()).toEqual([
      expect.objectContaining({
        type: 'day.scheduled',
        at: 0,
        data: { date: '2026-09-30', created: 1 },
      }),
    ]);
  });

  it('follows the weekdays', () => {
    const child = addChild(db);
    addChore(db, [child.id], { days: ['mon', 'wed', 'fri'] });
    // 2026-09-28 is a Monday.
    const created = [
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ].map((d) => ensureDay(db, d, 0).created);
    expect(created).toEqual([1, 0, 1, 0, 1, 0, 0]);
  });

  it('creates a one-off chore on its date only', () => {
    const child = addChild(db);
    addChore(db, [child.id], { days: [], oneOffDate: '2026-09-30' });
    expect(ensureDay(db, '2026-09-29', 0).created).toBe(0);
    expect(ensureDay(db, '2026-09-30', 0).created).toBe(1);
    expect(ensureDay(db, '2026-10-01', 0).created).toBe(0);
    expect(ensureDay(db, '2026-10-07', 0).created).toBe(0);
  });

  it('skips soft-deleted chores and archived children', () => {
    const [billy, alice] = [addChild(db, 'Billy'), addChild(db, 'Alice')];
    const gone = addChore(db, [billy.id], { title: 'Gone' });
    addChore(db, [billy.id, alice.id], { title: 'Kept' });
    db.update(chores).set({ deletedAt: 1 }).where(eq(chores.id, gone.id)).run();
    db.update(users).set({ archived: true }).where(eq(users.id, alice.id)).run();

    expect(ensureDay(db, '2026-09-30', 0).created).toBe(1);
    expect(listInstancesForDate(db, '2026-09-30')).toEqual([
      expect.objectContaining({ childId: billy.id, choreId: gone.id + 1 }),
    ]);
  });

  it('creates nothing on paused dates', () => {
    const child = addChild(db);
    addChore(db, [child.id]);
    updateSettings(db, { pause: { from: '2026-10-20', until: '2026-10-22' } });
    expect(
      ['2026-10-19', '2026-10-20', '2026-10-22', '2026-10-23'].map((d) => ensureDay(db, d, 0)),
    ).toMatchObject([
      { created: 1, paused: false },
      { created: 0, paused: true },
      { created: 0, paused: true },
      { created: 1, paused: false },
    ]);
  });
});

describe('startScheduler (fake clock)', () => {
  beforeEach(() => {
    const child = addChild(db);
    addChore(db, [child.id]);
  });

  it("creates today's chores at startup, in the family time zone", () => {
    // 23:30 UTC on the 29th is already 00:30 on the 30th in London (BST).
    startAt(Date.UTC(2026, 8, 29, 23, 30));
    expect(count('2026-09-29')).toBe(0);
    expect(count('2026-09-30')).toBe(1);
    expect(newDays).toEqual([{ date: '2026-09-30', created: 1, paused: false }]);
  });

  it('handles a restart mid-day without duplicating or resetting chores', () => {
    startAt(london('2026-09-30', '07:00'));
    const [instance] = listInstancesForDate(db, '2026-09-30');
    db.update(choreInstances)
      .set({ status: 'claimed', claimedAt: london('2026-09-30', '07:30') })
      .run();
    scheduler!.stop();

    startAt(london('2026-09-30', '14:00'));
    expect(listInstancesForDate(db, '2026-09-30')).toEqual([
      expect.objectContaining({ id: instance!.id, status: 'claimed' }),
    ]);
  });

  it('creates the next day just after midnight, and not before', () => {
    startAt(london('2026-09-30', '21:00'));
    vi.advanceTimersByTime(3 * HOUR - SEC); // 23:59:59
    expect(count('2026-10-01')).toBe(0);
    vi.advanceTimersByTime(2 * SEC);
    expect(count('2026-10-01')).toBe(1);
    expect(newDays.map((d) => d.date)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('keeps going day after day, and wakes at least every 15 minutes', () => {
    startAt(london('2026-09-30', '12:00'));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(MAX_SLEEP_MS);
    expect(newDays).toHaveLength(1);
    vi.advanceTimersByTime(3 * 24 * HOUR);
    expect(newDays.map((d) => d.date)).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(['2026-10-01', '2026-10-02', '2026-10-03'].map(count)).toEqual([1, 1, 1]);
  });

  it('notices the day changed after the PC slept through midnight', () => {
    startAt(london('2026-09-30', '22:00'));
    // Asleep: the clock jumps 10 hours with no timers firing, then the next wake-up runs.
    vi.setSystemTime(london('2026-10-01', '08:00'));
    vi.advanceTimersByTime(MAX_SLEEP_MS);
    expect(count('2026-10-01')).toBe(1);
  });

  it('spring forward: the 23-hour day ends at 23:00 UTC', () => {
    // Clocks go forward at 01:00 GMT on Sunday 29 March 2026.
    startAt(london('2026-03-28', '22:00'));
    vi.advanceTimersByTime(2 * HOUR + SEC); // 00:00:01 GMT on the 29th
    expect(count('2026-03-29')).toBe(1);

    // Midnight on the 30th is 23:00 UTC on the 29th, 23 hours later.
    expect(london('2026-03-30', '00:00')).toBe(Date.UTC(2026, 2, 29, 23));
    vi.advanceTimersByTime(23 * HOUR - 2 * SEC);
    expect(count('2026-03-30')).toBe(0);
    vi.advanceTimersByTime(2 * SEC);
    expect(count('2026-03-30')).toBe(1);
  });

  it('fall back: the 25-hour day does not start the next day an hour early', () => {
    // Clocks go back at 02:00 BST on Sunday 25 October 2026.
    startAt(london('2026-10-25', '00:30'));
    expect(count('2026-10-25')).toBe(1);
    vi.advanceTimersByTime(24 * HOUR); // 23:30 GMT: 24 hours later, still the 25th
    expect(count('2026-10-26')).toBe(0);
    vi.advanceTimersByTime(30 * 60_000 + SEC);
    expect(count('2026-10-26')).toBe(1);
    expect(newDays.map((d) => d.date)).toEqual(['2026-10-25', '2026-10-26']);
  });

  it('uses the family time zone from settings', () => {
    updateSettings(db, { timezone: 'America/New_York' });
    startAt(Date.UTC(2026, 8, 30, 3, 59)); // 23:59 on the 29th in New York
    expect(newDays.map((d) => d.date)).toEqual(['2026-09-29']);
    vi.advanceTimersByTime(2 * 60_000);
    expect(newDays.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('reports a new day even when it is paused, so screens still roll over', () => {
    updateSettings(db, { pause: { from: '2026-10-01', until: null } });
    startAt(london('2026-09-30', '23:00'));
    vi.advanceTimersByTime(HOUR + SEC);
    expect(newDays).toEqual([
      { date: '2026-09-30', created: 1, paused: false },
      { date: '2026-10-01', created: 0, paused: true },
    ]);
  });

  it('retries after an error and stops cleanly', () => {
    const errors: unknown[] = [];
    vi.setSystemTime(london('2026-09-30', '12:00'));
    close(); // the DB is gone: every run fails
    scheduler = startScheduler({ db, onError: (e) => errors.push(e) });
    expect(errors).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(errors).toHaveLength(2);
    scheduler.stop();
    vi.advanceTimersByTime(HOUR);
    expect(errors).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    ({ db, close } = testDb()); // for afterEach
  });
});

describe('streaks at midnight (spec 005)', () => {
  it('decides yesterday just after midnight and reports it', () => {
    const child = addChild(db, 'Billy');
    addChore(db, [child.id]);
    const streaks: StreakUpdate[][] = [];
    vi.setSystemTime(london('2026-09-30', '21:00'));
    scheduler = startScheduler({ db, onStreaks: (u) => streaks.push(u) });
    // The first run on a new database builds the (empty) history silently.
    expect(streaks).toEqual([]);
    db.update(choreInstances).set({ status: 'approved' }).run();

    vi.advanceTimersByTime(3 * HOUR - SEC); // 23:59:59
    expect(streaks).toEqual([]);
    vi.advanceTimersByTime(2 * SEC);
    expect(streaks).toEqual([
      [
        {
          childId: child.id,
          last: expect.objectContaining({ dates: ['2026-09-30'], result: 'done', after: 1 }),
        },
      ],
    ]);
  });

  it('catches up at start-up on the days that ended while the PC was off', () => {
    const child = addChild(db, 'Billy');
    addChore(db, [child.id]);
    setKv(db, 'streaks-built', '0');
    ensureDay(db, '2026-09-28', 0);
    ensureDay(db, '2026-09-29', 0);
    db.update(choreInstances).set({ status: 'approved' }).run();
    const streaks: StreakUpdate[][] = [];
    vi.setSystemTime(london('2026-10-01', '07:00'));
    scheduler = startScheduler({ db, onStreaks: (u) => streaks.push(u) });
    expect(streaks).toEqual([
      [
        {
          childId: child.id,
          last: expect.objectContaining({ dates: ['2026-09-28', '2026-09-29'], after: 2 }),
        },
      ],
    ]);
  });
});

describe('payday', () => {
  let paid: PaydayResult[];
  let waiting: number[];
  const SUN = (date: string) => london(date, '18:00');

  beforeEach(() => {
    paid = [];
    waiting = [];
  });

  function start(instant: number) {
    vi.setSystemTime(instant);
    scheduler = startScheduler({
      db,
      onPayday: (r) => paid.push(r),
      onPaydayWaiting: (slot) => waiting.push(slot),
    });
  }

  /** Billy with 40 points (£2.00 at 5p), and paydays counted from `since`. */
  function family(since: number) {
    const billy = addChild(db, 'Billy');
    addChore(db, [billy.id]);
    appendLedger(db, { childId: billy.id, kind: 'bonus', points: 40, centsPerPoint: 5, at: since });
    restartPaydaySchedule(db, since);
    return billy;
  }

  it('runs at the payday time by itself, not up to 15 minutes late', () => {
    const billy = family(london('2026-09-28', '09:00'));
    start(london('2026-10-04', '17:50'));
    expect(paid).toEqual([]);
    vi.advanceTimersByTime(10 * 60_000 - SEC);
    expect(paid).toEqual([]);
    vi.advanceTimersByTime(2 * SEC);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      slot: SUN('2026-10-04'),
      children: [{ childId: billy.id, points: 40, cents: 200, envelopes: 0 }],
    });
    expect(moneyStateOf(db, billy.id).money).toMatchObject({
      savedCents: 200,
      unconvertedPoints: 0,
    });
    // A week later, the next one (with nothing to convert, but the show still plays).
    vi.advanceTimersByTime(7 * 24 * HOUR);
    expect(paid.map((p) => p.slot)).toEqual([SUN('2026-10-04'), SUN('2026-10-11')]);
    expect(paid[1]!.children).toEqual([{ childId: billy.id, points: 0, cents: 0, envelopes: 0 }]);
  });

  it('catches up a missed payday once, dated at the payday time', () => {
    // The PC was off from Saturday 12 September until Thursday 1 October.
    const billy = family(london('2026-09-01', '09:00'));
    start(london('2026-10-01', '08:00'));
    expect(listPaydays(db).map((p) => [p.at, p.ranAt])).toEqual([
      [SUN('2026-09-27'), london('2026-10-01', '08:00')],
    ]);
    expect(moneyStateOf(db, billy.id).money.savedCents).toBe(200);
    // Restarting doesn't run it again.
    scheduler!.stop();
    start(london('2026-10-01', '09:00'));
    expect(listPaydays(db)).toHaveLength(1);
  });

  it('never runs a slot from before the schedule started', () => {
    family(london('2026-09-30', '12:00')); // set up on Wednesday
    start(london('2026-10-01', '08:00'));
    expect(paid).toEqual([]);
  });

  it('waits for a grown-up in "When I press start" mode, and tells the phones once', () => {
    const billy = family(london('2026-09-28', '09:00'));
    updateSettings(db, { paydayAuto: false });
    start(london('2026-10-04', '17:59'));
    vi.advanceTimersByTime(60_000 + SEC);
    expect(waiting).toEqual([SUN('2026-10-04')]);
    vi.advanceTimersByTime(2 * HOUR);
    expect(waiting).toEqual([SUN('2026-10-04')]); // once per slot, even across restarts
    scheduler!.stop();
    start(london('2026-10-04', '20:30'));
    expect(waiting).toEqual([SUN('2026-10-04')]);
    expect(paid).toEqual([]);
    expect(moneyStateOf(db, billy.id).money.unconvertedPoints).toBe(40); // still building up

    const mum = insertParent(db, { name: 'Mum' });
    startPaydayNow(db, mum.id, Date.now());
    expect(listPaydays(db).map((p) => p.at)).toEqual([SUN('2026-10-04')]);
    expect(moneyStateOf(db, billy.id).money.savedCents).toBe(200);
  });

  it('has no payday before setup (no players)', () => {
    restartPaydaySchedule(db, london('2026-09-01', '09:00'));
    start(london('2026-10-01', '08:00'));
    expect(listPaydays(db)).toEqual([]);
  });

  it('re-plans when the payday settings change', () => {
    family(london('2026-09-28', '09:00'));
    start(london('2026-10-01', '16:00'));
    // Moved to today, Thursday at 5pm: the timer wakes for it.
    updateSettings(db, { paydayDay: 4, paydayTime: '17:00' }, london('2026-10-01', '16:00'));
    scheduler!.runNow();
    vi.advanceTimersByTime(HOUR + SEC);
    expect(paid.map((p) => p.slot)).toEqual([london('2026-10-01', '17:00')]);
  });

  describe('holiday pause (ADR 0016)', () => {
    it('skips a payday on a paused date, and the points carry over to the next one', () => {
      const billy = family(london('2026-09-28', '09:00'));
      updateSettings(db, { pause: { from: '2026-10-03', until: '2026-10-06' } });
      start(london('2026-10-04', '17:50'));
      vi.advanceTimersByTime(HOUR);
      expect(paid).toEqual([]);
      expect(moneyStateOf(db, billy.id).money.unconvertedPoints).toBe(40);
      const skipped = db.select().from(events).where(eq(events.type, 'payday.skipped')).all();
      expect(skipped.map((e) => e.data)).toEqual([{ slot: SUN('2026-10-04') }]);

      // Ending the pause (or replacing it) never brings the skipped slot back.
      updateSettings(db, { pause: null });
      scheduler!.runNow();
      expect(paid).toEqual([]);
      vi.advanceTimersByTime(7 * 24 * HOUR);
      expect(paid.map((p) => p.slot)).toEqual([SUN('2026-10-11')]);
      expect(paid[0]!.children).toEqual([
        { childId: billy.id, points: 40, cents: 200, envelopes: 0 },
      ]);
    });

    it('skips a payday missed while the PC was off for the holiday', () => {
      family(london('2026-09-28', '09:00'));
      updateSettings(db, { pause: { from: '2026-10-02', until: '2026-10-07' } });
      start(london('2026-10-08', '08:00'));
      expect(paid).toEqual([]);
      expect(listPaydays(db)).toEqual([]);
    });

    it('is not offered to press while paused', () => {
      family(london('2026-09-28', '09:00'));
      updateSettings(db, { paydayAuto: false, pause: { from: '2026-10-04', until: null } });
      start(london('2026-10-04', '17:59'));
      vi.advanceTimersByTime(HOUR);
      expect(waiting).toEqual([]);
    });
  });
});

describe('streaks across a holiday pause (ADR 0016)', () => {
  it('keeps the streak: paused days have no chores, so they are neutral', () => {
    const child = addChild(db, 'Billy');
    addChore(db, [child.id]);
    setKv(db, 'streaks-built', '0');
    ensureDay(db, '2026-09-27', 0);
    ensureDay(db, '2026-09-28', 0);
    db.update(choreInstances).set({ status: 'approved' }).run();
    updateSettings(db, { pause: { from: '2026-09-29', until: '2026-10-02' } });
    const streaks: StreakUpdate[][] = [];
    vi.setSystemTime(london('2026-09-29', '07:00'));
    scheduler = startScheduler({ db, onStreaks: (u) => streaks.push(u) });
    expect(streaks.at(-1)?.[0]?.last).toMatchObject({ after: 2 });

    // Four paused days go by: no chores, no reports.
    vi.advanceTimersByTime(4 * 24 * HOUR);
    expect(count('2026-10-01')).toBe(0);
    expect(streaks).toHaveLength(1);
    expect(count('2026-10-03')).toBe(1);

    // Back on Saturday: done, and the streak goes on from 2 to 3.
    db.update(choreInstances).set({ status: 'approved' }).run();
    vi.advanceTimersByTime(24 * HOUR);
    expect(streaks.at(-1)?.[0]?.last).toMatchObject({ before: 2, after: 3 });
  });
});
