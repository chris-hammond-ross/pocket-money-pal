/**
 * Streaks on the server (spec 005, ADR 0012). `streak_days` caches each child's result for
 * each past day with chores; streaks, bests and flame tiers are derived from it with the
 * `@pmp/shared` rules. Days are decided at each new day (the scheduler, with its catch-up)
 * and again whenever an action changes a past day's chores.
 */
import {
  bestStreak,
  currentStreak,
  flameTier,
  isReportWorthy,
  streakChange,
  streakDayResult,
  zonedDateOf,
  type Streak,
  type StreakDay,
  type StreakReport,
  type StreakResult,
} from '@pmp/shared';
import { and, asc, desc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { choreInstances, chores, events, streakDays } from '../db/schema';
import type { DbOrTx } from './db';
import { recordEvent } from './events';
import { getKv, setKv } from './kv';
import { getSettings } from './settings';
import { listChildren } from './users';

/** A report is only offered for this long, so a new kiosk doesn't replay an old one. */
export const REPORT_FRESH_MS = 24 * 60 * 60_000;

/** A child whose streak changed, and the report to play (null: nothing new to play). */
export interface StreakUpdate {
  childId: number;
  last: StreakReport | null;
}

function rowsOf(db: DbOrTx, childId: number): StreakDay[] {
  return db
    .select({ date: streakDays.date, result: streakDays.result })
    .from(streakDays)
    .where(eq(streakDays.childId, childId))
    .orderBy(asc(streakDays.date))
    .all();
}

/** A day's result from its instances now, or null when the child had no chores that day. */
function resultOf(db: DbOrTx, childId: number, date: string): StreakResult | null {
  const statuses = db
    .select({ status: choreInstances.status })
    .from(choreInstances)
    .where(and(eq(choreInstances.childId, childId), eq(choreInstances.date, date)))
    .all()
    .map((r) => r.status);
  return statuses.length === 0 ? null : streakDayResult(statuses);
}

/** The first quest left open on a missed day ("Feed the cat didn't get done"). */
function firstMissedQuest(db: DbOrTx, childId: number, date: string): string | null {
  return (
    db
      .select({ title: chores.title })
      .from(choreInstances)
      .innerJoin(chores, eq(chores.id, choreInstances.choreId))
      .where(
        and(
          eq(choreInstances.childId, childId),
          eq(choreInstances.date, date),
          eq(choreInstances.status, 'open'),
        ),
      )
      .orderBy(asc(choreInstances.dueBy), asc(choreInstances.id))
      .get()?.title ?? null
  );
}

/**
 * Decides `dates` (before `today`) for one child: writes each day's result where it
 * changed, and records `streak.decided` when days became done or missed. Returns null when
 * no row changed.
 */
function decideChildDays(
  db: DbOrTx,
  childId: number,
  dates: readonly string[],
  today: string,
  now: number,
): StreakUpdate | null {
  const before = rowsOf(db, childId);
  const known = new Map(before.map((d) => [d.date, d.result]));
  const changed: StreakDay[] = [];
  for (const date of new Set(dates)) {
    if (date >= today) continue;
    const result = resultOf(db, childId, date);
    if (result === known.get(date) || (result === null && !known.has(date))) continue;
    if (result === null) {
      // Its chores were removed (only possible by hand): the day is neutral again.
      db.delete(streakDays)
        .where(and(eq(streakDays.childId, childId), eq(streakDays.date, date)))
        .run();
      changed.push({ date, result: 'neutral' });
      continue;
    }
    db.insert(streakDays)
      .values({ childId, date, result, decidedAt: now })
      .onConflictDoUpdate({
        target: [streakDays.childId, streakDays.date],
        set: { result, decidedAt: now },
      })
      .run();
    changed.push({ date, result });
  }
  if (changed.length === 0) return null;

  const change = streakChange(before, rowsOf(db, childId), changed, today);
  if (!change) return { childId, last: null };
  const lastMissed = changed
    .filter((d) => d.result === 'missed')
    .map((d) => d.date)
    .sort()
    .pop();
  const missedQuest = lastMissed ? firstMissedQuest(db, childId, lastMissed) : null;
  const data = { ...change, missedQuest };
  const id = recordEvent(db, { type: 'streak.decided', at: now, childId, data });
  return { childId, last: isReportWorthy(change) ? { id, ...data, at: now } : null };
}

/**
 * Re-decides the days of these chore instances, after an approval, a send-back or an
 * undo. Today's instances are skipped: today is decided when it ends.
 */
export function refreshStreaksFor(
  db: DbOrTx,
  instanceIds: readonly number[],
  now: number,
): StreakUpdate[] {
  if (instanceIds.length === 0) return [];
  const today = zonedDateOf(now, getSettings(db).timezone);
  const rows = db
    .select({ childId: choreInstances.childId, date: choreInstances.date })
    .from(choreInstances)
    .where(and(inArray(choreInstances.id, [...instanceIds]), lt(choreInstances.date, today)))
    .all();
  const byChild = new Map<number, string[]>();
  for (const r of rows) byChild.set(r.childId, [...(byChild.get(r.childId) ?? []), r.date]);
  return [...byChild].flatMap(([childId, dates]) => {
    const update = decideChildDays(db, childId, dates, today, now);
    return update ? [update] : [];
  });
}

/** Builds every child's rows from scratch, silently (no events). Returns the rows written. */
export function rebuildStreakDays(db: DbOrTx, today: string, now: number): number {
  db.delete(streakDays).run();
  const rows = db
    .select({ childId: choreInstances.childId, date: choreInstances.date })
    .from(choreInstances)
    .where(lt(choreInstances.date, today))
    .groupBy(choreInstances.childId, choreInstances.date)
    .all();
  for (const { childId, date } of rows) {
    const result = resultOf(db, childId, date)!;
    db.insert(streakDays).values({ childId, date, result, decidedAt: now }).run();
  }
  return rows.length;
}

/**
 * The new-day run (spec 005): for each child, decides every past day after their newest
 * decided one (the catch-up after the PC was off), and re-checks pending days. The first
 * run on a database from before streaks builds the history silently instead.
 */
export function decideStreaks(db: DbOrTx, today: string, now: number): StreakUpdate[] {
  if (getKv(db, 'streaks-built') === null) {
    rebuildStreakDays(db, today, now);
    setKv(db, 'streaks-built', String(now));
    return [];
  }
  return listChildren(db).flatMap((child) => {
    const rows = rowsOf(db, child.id);
    const newest = rows.filter((r) => r.date < today).at(-1)?.date ?? '';
    const fresh = db
      .selectDistinct({ date: choreInstances.date })
      .from(choreInstances)
      .where(
        and(
          eq(choreInstances.childId, child.id),
          gt(choreInstances.date, newest),
          lt(choreInstances.date, today),
        ),
      )
      .all()
      .map((r) => r.date);
    const pending = rows.filter((r) => r.result === 'pending').map((r) => r.date);
    const update = decideChildDays(db, child.id, [...fresh, ...pending], today, now);
    return update ? [update] : [];
  });
}

/** The latest report worth playing for a child, if it's recent (ADR 0012). */
export function latestReport(db: DbOrTx, childId: number, now: number): StreakReport | null {
  const row = db
    .select({ id: events.id, at: events.at, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.type, 'streak.decided'),
        eq(events.childId, childId),
        gte(events.at, now - REPORT_FRESH_MS),
      ),
    )
    .orderBy(desc(events.id))
    .get();
  if (!row?.data) return null;
  const data = row.data as Omit<StreakReport, 'id' | 'at'>;
  return isReportWorthy(data) ? { ...data, id: row.id, at: row.at } : null;
}

/** A child's streak as of `today`: the current run, the best, and the flame's tier. */
export function streakOf(db: DbOrTx, childId: number, today: string): Streak {
  const rows = rowsOf(db, childId);
  const days = currentStreak(rows, today);
  return { days, best: bestStreak(rows, today), tier: flameTier(days) };
}
