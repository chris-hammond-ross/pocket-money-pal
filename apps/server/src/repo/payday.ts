/**
 * Payday (spec 004, ADR 0010): which slot is waiting, running a payday (open envelopes,
 * then one `conversion` row per child with points to convert), the show's summary, and
 * each child's savings book. The scheduler and "Start payday now" both call `runPayday`.
 */
import {
  conversionFor,
  duePaydaySlot,
  manualPaydaySlot,
  nextPaydaySlot,
  paydayStats,
  zonedDateOf,
  type PaydayInfo,
  type PaydayState,
  type PaydaySummary,
  type SavingsBook,
  type SavingsRow,
} from '@pmp/shared';
import { and, asc, desc, eq, gt, inArray, lt, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { choreInstances, envelopes, goals, ledger, paydays } from '../db/schema';
import type { DbOrTx } from './db';
import { recordEvent } from './events';
import { appendLedger, EARNED_POINT_KINDS } from './ledger';
import {
  getActiveChild,
  liveGoalsOf,
  moneyRowsOf,
  moneyStateOf,
  MoneyConflictError,
  openEnvelope,
  unopenedEnvelopes,
} from './money';
import { getSettings, paydayChangedAt } from './settings';
import { streakOf } from './streaks';
import { FALLBACK_AVATAR, FALLBACK_COLOUR, listChildren, listParents } from './users';

export type Payday = typeof paydays.$inferSelect;

/** The latest payday (the one covering the latest slot), or null before the first. */
export function latestPayday(db: DbOrTx): Payday | null {
  return db.select().from(paydays).orderBy(desc(paydays.at)).limit(1).get() ?? null;
}

function paydayState(db: DbOrTx, now: number): PaydayState {
  const settings = getSettings(db);
  return {
    now,
    schedule: settings.payday,
    timeZone: settings.timezone,
    lastSlot: latestPayday(db)?.at ?? null,
    since: paydayChangedAt(db),
  };
}

/** Payday as every screen needs it: settings, the next slot, and whether one is waiting. */
export function paydayInfo(db: DbOrTx, now: number): PaydayInfo {
  const { payday } = getSettings(db);
  const state = paydayState(db, now);
  const latest = latestPayday(db);
  return {
    ...payday,
    nextAt: nextPaydaySlot(state),
    waitingSlot: payday.auto ? null : duePaydaySlot(state),
    latestId: latest?.id ?? null,
    latestRanAt: latest?.ranAt ?? null,
  };
}

export interface PaydayResult {
  paydayId: number;
  slot: number;
  children: { childId: number; points: number; cents: number; envelopes: number }[];
}

/**
 * Runs a payday for `slot`, in the caller's transaction: every active child's unopened
 * envelopes open, then their points since the last conversion become money, each row at
 * its own rate, when both come out above zero (ADR 0010). Refused if the slot is covered.
 */
export function runPayday(
  db: DbOrTx,
  args: { slot: number; startedBy: number | null; now: number },
): PaydayResult {
  if (db.select().from(paydays).where(eq(paydays.at, args.slot)).get()) {
    throw new MoneyConflictError('already-paid');
  }
  const payday = db
    .insert(paydays)
    .values({ at: args.slot, ranAt: args.now, startedBy: args.startedBy })
    .returning()
    .get();
  const { centsPerPoint } = getSettings(db);
  const children = listChildren(db).map((child) => {
    const opened = unopenedEnvelopes(db, child.id);
    for (const e of opened) openEnvelope(db, e.id, args.now, payday.id);
    const conversion = conversionFor(moneyRowsOf(db, child.id), centsPerPoint);
    if (conversion) {
      appendLedger(db, {
        childId: child.id,
        kind: 'conversion',
        points: -conversion.points,
        cents: conversion.cents,
        paydayId: payday.id,
        createdBy: args.startedBy,
        at: args.now,
      });
    }
    return {
      childId: child.id,
      points: conversion?.points ?? 0,
      cents: conversion?.cents ?? 0,
      envelopes: opened.length,
    };
  });
  recordEvent(db, {
    type: 'payday.ran',
    at: args.now,
    actorId: args.startedBy,
    data: { paydayId: payday.id, slot: args.slot, children },
  });
  return { paydayId: payday.id, slot: args.slot, children };
}

export interface PaydayCheck {
  /** A payday ran (automatic mode). */
  ran: PaydayResult | null;
  /** A slot is waiting for "Start payday now" (press mode). */
  waiting: number | null;
}

/**
 * The scheduler's check: runs the waiting slot in automatic mode, or reports it in press
 * mode. Nothing happens while setup is unfinished (no children).
 */
export function checkPayday(db: DbOrTx, now: number): PaydayCheck {
  if (listChildren(db).length === 0) return { ran: null, waiting: null };
  const slot = duePaydaySlot(paydayState(db, now));
  if (slot === null) return { ran: null, waiting: null };
  if (!getSettings(db).payday.auto) return { ran: null, waiting: slot };
  return { ran: runPayday(db, { slot, startedBy: null, now }), waiting: null };
}

/** "▶ Start payday now": covers the waiting slot, or the next one (ADR 0010). */
export function startPaydayNow(db: DbOrTx, parentId: number, now: number): PaydayResult {
  const slot = manualPaydaySlot(paydayState(db, now));
  if (slot === null) throw new MoneyConflictError('already-paid');
  return runPayday(db, { slot, startedBy: parentId, now });
}

// ---------------------------------------------------------------------------
// The show

/** Approved chores (not undone) in a time range, with their bonus flags. */
function questsBetween(db: DbOrTx, childId: number, from: number, to: number) {
  const reversal = alias(ledger, 'reversal');
  return db
    .select({
      id: ledger.id,
      reversedBy: reversal.id,
      early: choreInstances.awardedEarly,
      unprompted: choreInstances.awardedUnprompted,
    })
    .from(ledger)
    .leftJoin(reversal, eq(reversal.reversesId, ledger.id))
    .leftJoin(choreInstances, eq(choreInstances.id, ledger.instanceId))
    .where(
      and(
        eq(ledger.childId, childId),
        eq(ledger.kind, 'chore_points'),
        gt(ledger.at, from),
        lte(ledger.at, to),
      ),
    )
    .all()
    .filter((r) => r.reversedBy === null && r.id !== null)
    .map((r) => ({ early: (r.early ?? 0) > 0, unprompted: (r.unprompted ?? 0) > 0 }));
}

/** The show's summary for a payday (the latest when no id is given). */
export function paydaySummary(db: DbOrTx, id?: number): PaydaySummary | null {
  const payday =
    id === undefined
      ? latestPayday(db)
      : (db.select().from(paydays).where(eq(paydays.id, id)).get() ?? null);
  if (!payday) return null;
  const previous = db
    .select()
    .from(paydays)
    .where(lt(paydays.at, payday.at))
    .orderBy(desc(paydays.at))
    .limit(1)
    .get();
  const from = previous?.ranAt ?? -Infinity;
  const { centsPerPoint, currency, timezone } = getSettings(db);
  const parents = new Map(listParents(db).map((p) => [p.id, p.name]));

  const children = listChildren(db).map((child) => {
    const rows = db
      .select()
      .from(ledger)
      .where(and(eq(ledger.childId, child.id), eq(ledger.paydayId, payday.id)))
      .all();
    const conversion = rows.find((r) => r.kind === 'conversion');
    const openedIds = rows.filter((r) => r.kind === 'extra_income').map((r) => r.id);
    const opened =
      openedIds.length === 0
        ? []
        : db
            .select()
            .from(envelopes)
            .where(inArray(envelopes.ledgerId, openedIds))
            .orderBy(asc(envelopes.id))
            .all();
    const earned = db
      .select({ at: ledger.at, points: ledger.points })
      .from(ledger)
      .where(
        and(
          eq(ledger.childId, child.id),
          inArray(ledger.kind, EARNED_POINT_KINDS),
          gt(ledger.at, from),
          lte(ledger.at, payday.ranAt),
        ),
      )
      .all();
    return {
      childId: child.id,
      name: child.name,
      avatar: child.avatar ?? FALLBACK_AVATAR,
      colour: child.colour ?? FALLBACK_COLOUR,
      stats: paydayStats(
        { quests: questsBetween(db, child.id, from, payday.ranAt), earned },
        timezone,
      ),
      streak: streakOf(db, child.id, zonedDateOf(payday.ranAt, timezone)),
      points: conversion ? -conversion.points : 0,
      cents: conversion?.cents ?? 0,
      envelopes: opened.map((e) => ({
        id: e.id,
        fromName: e.fromName,
        note: e.note,
        cents: e.cents,
      })),
    };
  });

  return {
    id: payday.id,
    at: payday.at,
    ranAt: payday.ranAt,
    startedBy: payday.startedBy === null ? null : (parents.get(payday.startedBy) ?? null),
    centsPerPoint,
    currency,
    children,
  };
}

// ---------------------------------------------------------------------------
// The savings book

/**
 * A child's savings book (spec 004): every row that changes what's saved, newest first,
 * with the running balance, plus "this week so far" and where the money sits in jars.
 * Moves between "to sort" and jars aren't rows: they don't change what's saved.
 */
export function savingsBook(db: DbOrTx, childId: number): SavingsBook {
  getActiveChild(db, childId);
  const rows = db
    .select()
    .from(ledger)
    .where(eq(ledger.childId, childId))
    .orderBy(asc(ledger.id))
    .all();
  const paydayAt = new Map(
    db
      .select({ id: paydays.id, at: paydays.at })
      .from(paydays)
      .all()
      .map((p) => [p.id, p.at]),
  );
  const jarRows = db
    .select({ id: goals.id, name: goals.name, emoji: goals.emoji, boughtAt: goals.boughtAt })
    .from(goals)
    .where(eq(goals.childId, childId))
    .all();
  const jars = new Map(jarRows.map((g) => [g.id, g]));
  const parents = new Map(listParents(db).map((p) => [p.id, p.name]));

  const book: SavingsRow[] = [];
  let balance = 0;
  let quests = 0;
  for (const r of rows) {
    // Approvals (net of undos) since the last conversion: that payday's quests.
    if (r.kind === 'chore_points') quests += r.reversesId === null ? 1 : -1;
    if (r.kind === 'goal_allocation') continue;
    balance += r.cents;
    const jar = r.goalId === null ? null : (jars.get(r.goalId) ?? null);
    const by = r.createdBy === null ? null : (parents.get(r.createdBy) ?? null);
    const base = { id: r.id, at: r.at, dateAt: r.at, cents: r.cents, balanceCents: balance, by };
    if (r.kind === 'conversion') {
      book.push({
        ...base,
        kind: 'payday',
        dateAt: (r.paydayId !== null && paydayAt.get(r.paydayId)) || r.at,
        note: null,
        quests,
        points: -r.points,
        jar: null,
      });
      quests = 0;
    } else if (r.kind === 'extra_income') {
      book.push({ ...base, kind: 'gift', note: r.note, quests: null, points: null, jar: null });
    } else if (r.kind === 'spend') {
      const bought = jar !== null && jar.boughtAt === r.at;
      book.push({
        ...base,
        kind: bought ? 'bought' : 'spend',
        note: r.note,
        quests: null,
        points: null,
        jar: jar && { emoji: jar.emoji, name: jar.name },
      });
    }
  }

  const state = moneyStateOf(db, childId);
  return {
    childId,
    money: state.money,
    thisWeek: {
      quests,
      points: state.money.unconvertedPoints,
      cents: state.money.unconvertedCents,
    },
    jars: liveGoalsOf(db, childId).map((g) => ({
      id: g.id,
      emoji: g.emoji,
      name: g.name,
      inCents: state.jarCents.get(g.id) ?? 0,
    })),
    rows: book.reverse(),
  };
}

/** Every payday, oldest first. */
export function listPaydays(db: DbOrTx): Payday[] {
  return db.select().from(paydays).orderBy(asc(paydays.at)).all();
}
