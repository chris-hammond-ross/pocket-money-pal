/**
 * The scheduler: creates each day's chore instances in the family time zone, and runs
 * payday. It runs at startup, just after each midnight and at each payday slot. Running it
 * any number of times is safe: the unique (chore, child, date) index makes the day
 * idempotent, and a payday slot can only be covered once (ADR 0010).
 *
 * Only the current day is created. Days the PC was off are not backfilled; they have no
 * chores, which keeps them neutral for streaks (ADR 0004). Paused dates get none either.
 * A payday missed while the PC was off runs once at startup (the catch-up).
 */
import { addDays, choreRunsOn, isPausedOn, startOfZonedDay, zonedDateOf } from '@pmp/shared';
import type { Db } from './db/client';
import { choreInstances } from './db/schema';
import { listActiveAssignments } from './repo/chores';
import type { DbOrTx } from './repo/db';
import { recordEvent } from './repo/events';
import { getKv, setKv } from './repo/kv';
import { checkPayday, paydayInfo, type PaydayResult } from './repo/payday';
import { snapshotOf, waitingStatus } from './repo/today';
import { getSettings } from './repo/settings';

export interface EnsureDayResult {
  date: string;
  created: number;
  paused: boolean;
}

/**
 * Creates any missing instances for `date`. Existing instances (claimed, skipped, or
 * removed-then-not-recreated because their chore no longer runs) are left alone.
 */
export function ensureDay(db: Db, date: string, now: number): EnsureDayResult {
  return db.transaction((tx) => ensureDayIn(tx, date, now));
}

export function ensureDayIn(db: DbOrTx, date: string, now: number): EnsureDayResult {
  const settings = getSettings(db);
  if (isPausedOn(settings.pause, date)) return { date, created: 0, paused: true };

  let created = 0;
  for (const { chore, childId } of listActiveAssignments(db)) {
    if (!choreRunsOn({ days: chore.days, oneOffDate: chore.oneOffDate }, date)) continue;
    const result = db
      .insert(choreInstances)
      .values({
        choreId: chore.id,
        childId,
        date,
        status: waitingStatus(chore, date),
        ...snapshotOf(chore),
      })
      .onConflictDoNothing()
      .run();
    created += result.changes;
  }
  if (created > 0) recordEvent(db, { type: 'day.scheduled', at: now, data: { date, created } });
  return { date, created, paused: false };
}

/** Longest the timer sleeps, so a sleeping PC or a changed clock is noticed soon after. */
export const MAX_SLEEP_MS = 15 * 60_000;
/** Retry delay after a failed run (e.g. the DB was busy). */
export const RETRY_MS = 60_000;

export interface SchedulerOptions {
  db: Db;
  now?: () => number;
  /** Called when the family's date changes (including the first run at startup). */
  onNewDay?: (result: EnsureDayResult) => void;
  /** A payday ran by itself (automatic mode, or the catch-up). */
  onPayday?: (result: PaydayResult) => void;
  /** A payday slot passed in "When I press start" mode. Called once per slot. */
  onPaydayWaiting?: (slot: number) => void;
  onError?: (err: unknown) => void;
}

export interface Scheduler {
  /**
   * Runs now: today's chores (whether or not it has run today) and any waiting payday.
   * Also re-plans the timer, e.g. after the payday settings or the dev clock changed.
   */
  runNow(): EnsureDayResult;
  stop(): void;
}

/** `server_kv` key: the press-mode slot the phones were last told about. */
const NOTIFIED_KEY = 'payday-notified';

/** Runs a waiting payday (automatic mode), or reports a waiting slot once (press mode). */
export function paydayTick(
  db: Db,
  now: number,
  on: Pick<SchedulerOptions, 'onPayday' | 'onPaydayWaiting'>,
): void {
  const result = db.transaction((tx) => checkPayday(tx, now));
  if (result.ran) on.onPayday?.(result.ran);
  if (result.waiting !== null && getKv(db, NOTIFIED_KEY) !== String(result.waiting)) {
    setKv(db, NOTIFIED_KEY, String(result.waiting));
    on.onPaydayWaiting?.(result.waiting);
  }
}

export function startScheduler({
  db,
  now = Date.now,
  onNewDay,
  onPayday,
  onPaydayWaiting,
  onError,
}: SchedulerOptions): Scheduler {
  let lastDate: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const run = (): EnsureDayResult => {
    const t = now();
    const date = zonedDateOf(t, getSettings(db).timezone);
    const result = ensureDay(db, date, t);
    if (date !== lastDate) {
      lastDate = date;
      onNewDay?.(result);
    }
    return result;
  };

  const tick = () => {
    if (stopped) return;
    clearTimeout(timer);
    let delay = RETRY_MS;
    try {
      const t = now();
      const { timezone } = getSettings(db);
      if (zonedDateOf(t, timezone) !== lastDate) run();
      paydayTick(db, t, { onPayday, onPaydayWaiting });
      // Wake just after the next midnight or at the next payday, but never sleep longer
      // than MAX_SLEEP_MS.
      const nextMidnight = startOfZonedDay(addDays(lastDate!, 1), timezone);
      const nextPayday = paydayInfo(db, t).nextAt;
      delay = Math.min(Math.max(Math.min(nextMidnight, nextPayday) - t, 1_000), MAX_SLEEP_MS);
    } catch (err) {
      onError?.(err);
    }
    timer = setTimeout(tick, delay);
  };

  tick();

  return {
    runNow() {
      const result = run();
      tick();
      return result;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
