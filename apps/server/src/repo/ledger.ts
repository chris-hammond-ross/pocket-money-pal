/**
 * The ledger is append-only: this module only ever inserts, and triggers in the migration
 * refuse UPDATE and DELETE. Every balance is a sum over it.
 */
import { addDays, startOfZonedDay, zonedDateOf } from '@pmp/shared';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { ledger, type LedgerKind } from '../db/schema';
import type { DbOrTx } from './db';

export type LedgerEntry = typeof ledger.$inferSelect;
export type LedgerInput = Omit<typeof ledger.$inferInsert, 'id'>;

/** Point kinds that count as earned (or lost) on the day, for "points today". */
export const EARNED_POINT_KINDS: LedgerKind[] = ['chore_points', 'bonus', 'penalty', 'adjustment'];

export function appendLedger(db: DbOrTx, entry: LedgerInput): LedgerEntry {
  for (const [name, value] of Object.entries({ points: entry.points, cents: entry.cents })) {
    if (value !== undefined && !Number.isInteger(value)) {
      throw new TypeError(`Ledger ${name} must be an integer, got ${value}`);
    }
  }
  return db.insert(ledger).values(entry).returning().get();
}

/** Appends the opposite of `entry` (same kind), linked by `reversesId`. */
export function reverseLedgerEntry(
  db: DbOrTx,
  entry: LedgerEntry,
  by: { createdBy: number | null; at: number; note?: string },
): LedgerEntry {
  return appendLedger(db, {
    childId: entry.childId,
    kind: entry.kind,
    points: -entry.points,
    cents: -entry.cents,
    centsPerPoint: entry.centsPerPoint,
    instanceId: entry.instanceId,
    reversesId: entry.id,
    note: by.note ?? null,
    createdBy: by.createdBy,
    at: by.at,
  });
}

export interface Balance {
  points: number;
  cents: number;
}

/** Each child's all-time point and money balance. Children with no rows are absent. */
export function balances(db: DbOrTx): Map<number, Balance> {
  const rows = db
    .select({
      childId: ledger.childId,
      points: sql<number>`coalesce(sum(${ledger.points}), 0)`,
      cents: sql<number>`coalesce(sum(${ledger.cents}), 0)`,
    })
    .from(ledger)
    .groupBy(ledger.childId)
    .all();
  return new Map(rows.map((r) => [r.childId, { points: r.points, cents: r.cents }]));
}

/**
 * Points each child earned today in the family time zone (ADR 0004): approved chores,
 * bonus and minus points, and undo reversals made today.
 */
export function pointsToday(db: DbOrTx, now: number, timeZone: string): Map<number, number> {
  const today = zonedDateOf(now, timeZone);
  const start = startOfZonedDay(today, timeZone);
  const end = startOfZonedDay(addDays(today, 1), timeZone);
  const rows = db
    .select({ childId: ledger.childId, points: sql<number>`sum(${ledger.points})` })
    .from(ledger)
    .where(and(inArray(ledger.kind, EARNED_POINT_KINDS), gte(ledger.at, start), lt(ledger.at, end)))
    .groupBy(ledger.childId)
    .all();
  return new Map(rows.map((r) => [r.childId, r.points]));
}

/** Lifetime XP for levels (ADR 0003): approved chore points, net of undo reversals. */
export function lifetimeXp(db: DbOrTx): Map<number, number> {
  const rows = db
    .select({ childId: ledger.childId, xp: sql<number>`sum(${ledger.points})` })
    .from(ledger)
    .where(eq(ledger.kind, 'chore_points'))
    .groupBy(ledger.childId)
    .all();
  return new Map(rows.map((r) => [r.childId, r.xp]));
}
