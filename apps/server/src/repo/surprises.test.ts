import { addDays, zonedTimeToInstant } from '@pmp/shared';
import { and, eq, ne } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { choreInstances, streakDays, surpriseRuns } from '../db/schema';
import { ensureDay, startScheduler, type Scheduler } from '../scheduler';
import { addChild, addChore, testDb } from '../test-helpers';
import { setKv } from './kv';
import { decideStreaks, rebuildStreakDays } from './streaks';
import {
  advanceSurprises,
  endSurpriseDays,
  grabSurprise,
  kioskSurprise,
  nextSurpriseAt,
  sendSurprise,
  type SurpriseMove,
} from './surprises';
import { insertParent } from './users';

const TZ = 'Europe/London';
const DAY = '2026-10-01';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);
const MIN = 60_000;
const patio = { title: 'Sweep the patio', icon: '🧹', rewardPoints: 20 };

let db: Db;
let close: () => void;
let scheduler: Scheduler | undefined;

beforeEach(() => {
  ({ db, close } = testDb());
});
afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  close();
});

function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  return { mum, billy: addChild(db, 'Billy'), alice: addChild(db, 'Alice') };
}

const ctx = (parentId: number, now: number, date = DAY) => ({ parentId, now, today: date });

/** Sends a new quest (not saved) at `now`, right away or for `appearAt`. */
function sendAt(
  parentId: number,
  now: number,
  fields: { appearAt?: string; timeFrameMin?: number } = {},
) {
  return db.transaction((tx) =>
    sendSurprise(
      tx,
      {
        task: patio,
        who: 'all',
        timeFrameMin: fields.timeFrameMin ?? 10,
        appearAt: fields.appearAt,
      },
      ctx(parentId, now),
    ),
  ).run;
}

const statusOf = (id: number) =>
  db.select().from(surpriseRuns).where(eq(surpriseRuns.id, id)).get()!;
const moveTypes = (moves: SurpriseMove[]) => moves.map((m) => `${m.type} ${m.run.id}`);

describe('advanceSurprises', () => {
  it('expires a live run exactly when its time frame runs out, and puts the next up', () => {
    const { mum } = seed();
    const first = sendAt(mum.id, at('17:00'));
    const second = sendAt(mum.id, at('17:01'), { timeFrameMin: 5 });
    expect(advanceSurprises(db, at('17:10') - 1)).toEqual([]);
    const moves = advanceSurprises(db, at('17:10'));
    expect(moveTypes(moves)).toEqual([
      `surprise.expired ${first.id}`,
      `surprise.live ${second.id}`,
    ]);
    expect(statusOf(first.id)).toMatchObject({ status: 'expired', endedAt: at('17:10') });
    // Its time frame starts when it goes live, not when it was sent.
    expect(statusOf(second.id)).toMatchObject({ shownAt: at('17:10'), expiresAt: at('17:15') });
  });

  it('brings a scheduled run up at its time, with its full time frame', () => {
    const { mum } = seed();
    const run = sendAt(mum.id, at('17:00'), { appearAt: '17:30' });
    expect(advanceSurprises(db, at('17:29'))).toEqual([]);
    expect(moveTypes(advanceSurprises(db, at('17:30')))).toEqual([
      `surprise.queued ${run.id}`,
      `surprise.live ${run.id}`,
    ]);
    expect(statusOf(run.id)).toMatchObject({ expiresAt: at('17:40') });
  });

  it('queues a scheduled run behind a live one; it waits, oldest first', () => {
    const { mum } = seed();
    const scheduled = sendAt(mum.id, at('17:00'), { appearAt: '17:30' });
    const live = sendAt(mum.id, at('17:25'));
    expect(moveTypes(advanceSurprises(db, at('17:30')))).toEqual([
      `surprise.queued ${scheduled.id}`,
    ]);
    const later = sendAt(mum.id, at('17:32'));
    expect(moveTypes(advanceSurprises(db, at('17:35')))).toEqual([
      `surprise.expired ${live.id}`,
      `surprise.live ${scheduled.id}`,
    ]);
    expect(statusOf(later.id).status).toBe('queued');
  });

  it('still shows a run after a restart within its time frame, but not later', () => {
    const { mum } = seed();
    const inTime = sendAt(mum.id, at('17:00'), { appearAt: '17:30' });
    // The server was off from 5:20 and starts again at 5:38.
    expect(moveTypes(advanceSurprises(db, at('17:38')))).toEqual([
      `surprise.queued ${inTime.id}`,
      `surprise.live ${inTime.id}`,
    ]);
    expect(statusOf(inTime.id).expiresAt).toBe(at('17:48'));

    const tooLate = sendAt(mum.id, at('17:39'), { appearAt: '18:00' });
    expect(moveTypes(advanceSurprises(db, at('18:15')))).toEqual([
      `surprise.expired ${inTime.id}`,
      `surprise.expired ${tooLate.id}`,
    ]);
    expect(statusOf(tooLate.id).shownAt).toBeNull();
  });

  it("expires yesterday's leftovers at the new day", () => {
    const { mum } = seed();
    const scheduled = sendAt(mum.id, at('17:00'), { appearAt: '19:00' });
    const live = sendAt(mum.id, at('17:00'), { timeFrameMin: 60 });
    const queued = sendAt(mum.id, at('17:00'));
    const tomorrow = at('00:01', addDays(DAY, 1));
    // Pretend the server was off from 5pm until just after midnight.
    const moves = advanceSurprises(db, tomorrow);
    expect(moveTypes(moves).sort()).toEqual(
      [
        `surprise.expired ${scheduled.id}`,
        `surprise.expired ${live.id}`,
        `surprise.expired ${queued.id}`,
      ].sort(),
    );
  });

  it('knows when it next has something to do', () => {
    const { mum } = seed();
    expect(nextSurpriseAt(db)).toBeNull();
    sendAt(mum.id, at('17:00'), { appearAt: '18:00' });
    expect(nextSurpriseAt(db)).toBe(at('18:00'));
    sendAt(mum.id, at('17:00'), { timeFrameMin: 15 });
    expect(nextSurpriseAt(db)).toBe(at('17:15'));
  });

  it('hides a live run from the kiosk once its time is up, even before the scheduler runs', () => {
    const { mum } = seed();
    sendAt(mum.id, at('17:00'));
    expect(kioskSurprise(db, at('17:09'))).not.toBeNull();
    expect(kioskSurprise(db, at('17:10'))).toBeNull();
  });
});

describe('the scheduler', () => {
  it('wakes when a live surprise runs out, and reports the moves', () => {
    vi.useFakeTimers();
    const { mum } = seed();
    vi.setSystemTime(at('17:00'));
    const run = sendAt(mum.id, at('17:00'), { timeFrameMin: 2 });
    const moves: SurpriseMove[] = [];
    scheduler = startScheduler({ db, onSurprises: (m) => moves.push(...m) });
    vi.advanceTimersByTime(2 * MIN - 100);
    expect(moves).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(moveTypes(moves)).toEqual([`surprise.expired ${run.id}`]);
  });

  it('brings a scheduled surprise up at its time', () => {
    vi.useFakeTimers();
    const { mum } = seed();
    vi.setSystemTime(at('17:00'));
    const run = sendAt(mum.id, at('17:00'), { appearAt: '17:15' });
    const moves: SurpriseMove[] = [];
    scheduler = startScheduler({ db, onSurprises: (m) => moves.push(...m) });
    vi.advanceTimersByTime(15 * MIN);
    expect(moveTypes(moves)).toEqual([`surprise.queued ${run.id}`, `surprise.live ${run.id}`]);
  });

  it('skips a surprise quest left open at the new day; a claimed one stays for the tray', () => {
    vi.useFakeTimers();
    const { mum, billy, alice } = seed();
    vi.setSystemTime(at('17:00'));
    const run = sendAt(mum.id, at('17:00'));
    db.transaction((tx) => grabSurprise(tx, run.id, { all: true }, at('17:01')));
    const [billyQuest, aliceQuest] = db.select().from(choreInstances).all();
    db.update(choreInstances)
      .set({ status: 'claimed', claimedAt: at('18:00') })
      .where(eq(choreInstances.id, aliceQuest!.id))
      .run();
    vi.setSystemTime(at('23:59'));
    scheduler = startScheduler({ db });
    vi.advanceTimersByTime(2 * MIN);
    const status = (id: number) =>
      db.select().from(choreInstances).where(eq(choreInstances.id, id)).get()!.status;
    expect(billyQuest!.childId).toBe(billy.id);
    expect(status(billyQuest!.id)).toBe('skipped');
    expect(aliceQuest!.childId).toBe(alice.id);
    expect(status(aliceQuest!.id)).toBe('claimed');
    expect(endSurpriseDays(db, addDays(DAY, 1))).toBe(0);
  });
});

describe('streaks leave surprises out', () => {
  it("doesn't count an undone surprise against the day, nor a done one for it", () => {
    const { mum, billy, alice } = seed();
    setKv(db, 'streaks-built', '0');
    const bed = addChore(db, [billy.id, alice.id]);
    ensureDay(db, DAY, at('00:00'));
    const run = sendAt(mum.id, at('17:00'));
    db.transaction((tx) => grabSurprise(tx, run.id, { all: true }, at('17:01')));
    const set = (childId: number, isBed: boolean, status: 'approved' | 'open') =>
      db
        .update(choreInstances)
        .set({ status })
        .where(
          and(
            eq(choreInstances.childId, childId),
            isBed ? eq(choreInstances.choreId, bed.id) : ne(choreInstances.choreId, bed.id),
          ),
        )
        .run();
    // Billy made his bed but never did the surprise; Alice did the surprise but not her bed.
    set(billy.id, true, 'approved');
    set(alice.id, false, 'approved');
    const next = addDays(DAY, 1);
    decideStreaks(db, next, at('00:01', next));
    const result = (childId: number) =>
      db.select().from(streakDays).where(eq(streakDays.childId, childId)).get()?.result;
    expect(result(billy.id)).toBe('done');
    expect(result(alice.id)).toBe('missed');
  });

  it('rebuilds without tripping over a day that had only surprises', () => {
    const { mum } = seed();
    const run = sendAt(mum.id, at('17:00'));
    db.transaction((tx) => grabSurprise(tx, run.id, { all: true }, at('17:01')));
    expect(rebuildStreakDays(db, addDays(DAY, 1), at('00:01', addDays(DAY, 1)))).toBe(0);
  });
});
