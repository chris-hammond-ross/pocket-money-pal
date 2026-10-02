/**
 * Money and jars (spec 004, ADR 0010). Every balance is derived from the child's ledger
 * rows by `summariseMoney` in @pmp/shared; nothing here stores a balance. Jars are the
 * `goals` table; coins move between "to sort" and a jar as `goal_allocation` rows.
 */
import {
  earningAverages,
  envelopeSender,
  jarMilestones,
  jarProgress,
  jarStats,
  moveLimits,
  moveProblem,
  STATS_WINDOW_DAYS,
  summariseMoney,
  type ChildMoney,
  type EarningAverages,
  type Envelope,
  type EnvelopeCreate,
  type GoalCreate,
  type GoalMoveResult,
  type GoalPatch,
  type Jar,
  type MoneyLedgerRow,
  type SpendInput,
} from '@pmp/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, max, min, sql } from 'drizzle-orm';
import { envelopes, goals, ledger } from '../db/schema';
import { ConflictError, NotFoundError, type DbOrTx } from './db';
import { recordEvent } from './events';
import { appendLedger, EARNED_POINT_KINDS } from './ledger';
import { getSettings } from './settings';
import { FALLBACK_AVATAR, FALLBACK_COLOUR, listChildren, type User } from './users';

export type Goal = typeof goals.$inferSelect;
export type EnvelopeRow = typeof envelopes.$inferSelect;

const DAY_MS = 24 * 60 * 60_000;

/** A money request the rules refuse; the route answers 409 with the code. */
export class MoneyConflictError extends ConflictError {
  override name = 'MoneyConflictError';
  constructor(
    readonly code:
      | 'gone'
      | 'smashed'
      | 'not-smashed'
      | 'not-full'
      | 'too-much'
      | 'already-opened'
      | 'already-paid',
  ) {
    super(`Refused: ${code}`);
  }
}

/** Who is acting: a child on the kiosk, or a parent on a paired phone. */
export type Actor = { kind: 'child' } | { kind: 'parent'; parentId: number };

export function getActiveChild(db: DbOrTx, id: number): User {
  const child = listChildren(db).find((c) => c.id === id);
  if (!child) throw new NotFoundError(`Child ${id} not found`);
  return child;
}

// ---------------------------------------------------------------------------
// Balances

/** One child's ledger rows as the money rules need them, oldest first. */
export function moneyRowsOf(db: DbOrTx, childId: number): MoneyLedgerRow[] {
  return db
    .select({
      id: ledger.id,
      kind: ledger.kind,
      points: ledger.points,
      cents: ledger.cents,
      centsPerPoint: ledger.centsPerPoint,
      goalId: ledger.goalId,
    })
    .from(ledger)
    .where(eq(ledger.childId, childId))
    .orderBy(asc(ledger.id))
    .all();
}

/** The child's jars that aren't deleted or bought, in jar order. */
export function liveGoalsOf(db: DbOrTx, childId: number): Goal[] {
  return db
    .select()
    .from(goals)
    .where(and(eq(goals.childId, childId), isNull(goals.deletedAt), isNull(goals.boughtAt)))
    .orderBy(asc(goals.sortOrder), asc(goals.id))
    .all();
}

export interface ChildMoneyState {
  money: ChildMoney;
  goals: Goal[];
  jarCents: Map<number, number>;
}

/** A child's money and jars, from the ledger alone. */
export function moneyStateOf(db: DbOrTx, childId: number): ChildMoneyState {
  const live = liveGoalsOf(db, childId);
  const summary = summariseMoney(
    moneyRowsOf(db, childId),
    live.map((g) => g.id),
    getSettings(db).centsPerPoint,
  );
  return {
    goals: live,
    jarCents: summary.jarCents,
    money: {
      savedCents: summary.savedCents,
      toSortCents: summary.toSortCents,
      unconvertedPoints: summary.unconverted.points,
      unconvertedCents: summary.unconverted.cents,
    },
  };
}

/**
 * The child's 14-day earning averages for jar stats (ADR 0010): earned points, chore
 * points and approved quests (net of undos) since `now − 14 days`.
 */
export function averagesFor(db: DbOrTx, childId: number, now: number): EarningAverages | null {
  const since = now - STATS_WINDOW_DAYS * DAY_MS;
  const earned = and(eq(ledger.childId, childId), inArray(ledger.kind, EARNED_POINT_KINDS));
  const first = db
    .select({ at: min(ledger.at) })
    .from(ledger)
    .where(earned)
    .get();
  const window = db
    .select({
      earned: sql<number>`coalesce(sum(${ledger.points}), 0)`,
      chore: sql<number>`coalesce(sum(case when ${ledger.kind} = 'chore_points' then ${ledger.points} else 0 end), 0)`,
      quests: sql<number>`coalesce(sum(case when ${ledger.kind} = 'chore_points' then (case when ${ledger.reversesId} is null then 1 else -1 end) else 0 end), 0)`,
    })
    .from(ledger)
    .where(and(earned, gte(ledger.at, since)))
    .get();
  return earningAverages({
    earnedPoints: window?.earned ?? 0,
    chorePoints: window?.chore ?? 0,
    approvedQuests: window?.quests ?? 0,
    firstEarnedAt: first?.at ?? null,
    now,
  });
}

/** Where the phone and kiosk load a jar's picture. The query busts the cache on change. */
export function goalImageUrl(goal: Goal): string | null {
  return goal.imagePath
    ? `/api/goals/${goal.id}/image?v=${encodeURIComponent(goal.imagePath)}`
    : null;
}

export function jarView(
  goal: Goal,
  inCents: number,
  averages: EarningAverages | null,
  centsPerPoint: number,
): Jar {
  return {
    id: goal.id,
    childId: goal.childId,
    name: goal.name,
    emoji: goal.emoji,
    targetCents: goal.targetCents,
    inCents,
    shopUrl: goal.shopUrl,
    imageUrl: goalImageUrl(goal),
    madeByChild: goal.createdBy === goal.childId,
    priceChecked: goal.priceCheckedAt !== null,
    smashed: goal.smashedAt !== null,
    progress: {
      ...jarProgress(inCents, goal.targetCents),
      milestones: jarMilestones(goal.targetCents),
    },
    stats: jarStats({ inCents, targetCents: goal.targetCents, averages, centsPerPoint }),
  };
}

function envelopeView(e: EnvelopeRow): Envelope {
  return {
    id: e.id,
    childId: e.childId,
    cents: e.cents,
    note: e.note,
    fromName: e.fromName,
    createdAt: e.sentAt,
  };
}

/** Unopened envelopes for a child, oldest first. */
export function unopenedEnvelopes(db: DbOrTx, childId: number): EnvelopeRow[] {
  return db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.childId, childId), isNull(envelopes.openedAt)))
    .orderBy(asc(envelopes.id))
    .all();
}

export interface ChildMoneyView {
  money: ChildMoney;
  jars: Jar[];
  envelopes: Envelope[];
}

/** Everything a screen shows about a child's money: balances, jars and envelopes. */
export function childMoneyView(db: DbOrTx, childId: number, now: number): ChildMoneyView {
  const state = moneyStateOf(db, childId);
  const averages = averagesFor(db, childId, now);
  const { centsPerPoint } = getSettings(db);
  return {
    money: state.money,
    jars: state.goals.map((g) =>
      jarView(g, state.jarCents.get(g.id) ?? 0, averages, centsPerPoint),
    ),
    envelopes: unopenedEnvelopes(db, childId).map(envelopeView),
  };
}

/** Each active child's money view, with their look, in column order. */
export function familyMoney(db: DbOrTx, now: number) {
  return listChildren(db).map((c) => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar ?? FALLBACK_AVATAR,
    colour: c.colour ?? FALLBACK_COLOUR,
    ...childMoneyView(db, c.id, now),
  }));
}

// ---------------------------------------------------------------------------
// Jars

/** A jar that still exists (not deleted, not bought). */
function getLiveGoal(db: DbOrTx, id: number): Goal {
  const goal = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!goal) throw new NotFoundError(`Goal ${id} not found`);
  if (goal.deletedAt !== null || goal.boughtAt !== null) throw new MoneyConflictError('gone');
  return goal;
}

function jarCentsOf(db: DbOrTx, goal: Goal): number {
  return moneyStateOf(db, goal.childId).jarCents.get(goal.id) ?? 0;
}

const actorId = (actor: Actor, childId: number) =>
  actor.kind === 'parent' ? actor.parentId : childId;

/**
 * "✨ Make my jar" (kiosk) or "+ New" (phone). It goes last, empty. A kid-made jar's price
 * waits for a parent to check it; a parent's is checked from the start.
 */
export function createGoal(db: DbOrTx, input: GoalCreate, actor: Actor, now: number): Goal {
  getActiveChild(db, input.childId);
  const last = db
    .select({ n: max(goals.sortOrder) })
    .from(goals)
    .where(eq(goals.childId, input.childId))
    .get();
  const goal = db
    .insert(goals)
    .values({
      childId: input.childId,
      name: input.name,
      emoji: input.emoji,
      targetCents: input.targetCents,
      shopUrl: input.shopUrl ?? null,
      sortOrder: (last?.n ?? -1) + 1,
      createdBy: actorId(actor, input.childId),
      priceCheckedAt: actor.kind === 'parent' ? now : null,
    })
    .returning()
    .get();
  recordEvent(db, {
    type: 'goal.created',
    at: now,
    actorId: actorId(actor, input.childId),
    childId: input.childId,
    data: { goalId: goal.id, name: goal.name, targetCents: goal.targetCents },
  });
  return goal;
}

const GOAL_FIELDS = ['name', 'emoji', 'targetCents', 'shopUrl'] as const;

/**
 * The phone's jar sheet "Save": name, picture, price and link, and the price is checked.
 * A price below what's in the jar moves the extra back to "to sort". Returns the jar and
 * whether its shop link changed (so the route fetches the new picture).
 */
export function updateGoal(
  db: DbOrTx,
  id: number,
  patch: GoalPatch,
  parentId: number,
  now: number,
): { goal: Goal; linkChanged: boolean } {
  const goal = getLiveGoal(db, id);
  const changed = GOAL_FIELDS.filter((k) => patch[k] !== undefined && patch[k] !== goal[k]);
  const inCents = jarCentsOf(db, goal);
  const target = patch.targetCents ?? goal.targetCents;
  if (inCents > target) {
    appendLedger(db, {
      childId: goal.childId,
      kind: 'goal_allocation',
      cents: target - inCents,
      goalId: goal.id,
      note: 'Price lowered',
      createdBy: parentId,
      at: now,
    });
  }
  const linkChanged = changed.includes('shopUrl');
  const updated = db
    .update(goals)
    .set({
      ...patch,
      ...(linkChanged && { imagePath: null }),
      priceCheckedAt: goal.priceCheckedAt ?? now,
      updatedAt: new Date(now).toISOString(),
    })
    .where(eq(goals.id, id))
    .returning()
    .get();
  if (goal.priceCheckedAt === null) {
    recordEvent(db, {
      type: 'goal.price_checked',
      at: now,
      actorId: parentId,
      childId: goal.childId,
      data: { goalId: id, targetCents: updated.targetCents },
    });
  }
  if (changed.length > 0) {
    recordEvent(db, {
      type: 'goal.updated',
      at: now,
      actorId: parentId,
      childId: goal.childId,
      data: { goalId: id, changed },
    });
  }
  return { goal: updated, linkChanged };
}

/** Sets (or clears) a jar's picture after a background fetch. */
export function setGoalImage(db: DbOrTx, id: number, imagePath: string | null): void {
  db.update(goals).set({ imagePath }).where(eq(goals.id, id)).run();
}

/**
 * "🗑 Delete this jar": soft-deleted, and its money goes back to "to sort". The kiosk
 * can't delete a smashed jar; a phone can. Returns the jar and the money moved back.
 */
export function deleteGoal(
  db: DbOrTx,
  id: number,
  actor: Actor,
  now: number,
): { goal: Goal; cents: number } {
  const goal = getLiveGoal(db, id);
  if (actor.kind === 'child' && goal.smashedAt !== null) throw new MoneyConflictError('smashed');
  const inCents = jarCentsOf(db, goal);
  if (inCents !== 0) {
    appendLedger(db, {
      childId: goal.childId,
      kind: 'goal_allocation',
      cents: -inCents,
      goalId: goal.id,
      note: 'Jar deleted',
      createdBy: actorId(actor, goal.childId),
      at: now,
    });
  }
  db.update(goals)
    .set({ deletedAt: now, updatedAt: new Date(now).toISOString() })
    .where(eq(goals.id, id))
    .run();
  recordEvent(db, {
    type: 'goal.deleted',
    at: now,
    actorId: actorId(actor, goal.childId),
    childId: goal.childId,
    data: { goalId: id, name: goal.name, cents: inCents },
  });
  return { goal, cents: inCents };
}

/**
 * Coins between "to sort" and a jar (one call per hold or pop-up action): positive pours
 * in, negative takes out. A move that doesn't fit is refused, not clipped (ADR 0010).
 */
export function moveGoal(db: DbOrTx, id: number, cents: number, now: number): GoalMoveResult {
  const goal = getLiveGoal(db, id);
  if (goal.smashedAt !== null) throw new MoneyConflictError('smashed');
  const state = moneyStateOf(db, goal.childId);
  const inCents = state.jarCents.get(goal.id) ?? 0;
  const limits = moveLimits({
    toSortCents: state.money.toSortCents,
    inCents,
    targetCents: goal.targetCents,
    smashed: false,
  });
  if (moveProblem(cents, limits)) throw new MoneyConflictError('too-much');
  appendLedger(db, {
    childId: goal.childId,
    kind: 'goal_allocation',
    cents,
    goalId: goal.id,
    createdBy: goal.childId,
    at: now,
  });
  return {
    goalId: goal.id,
    childId: goal.childId,
    cents,
    inCents: inCents + cents,
    toSortCents: state.money.toSortCents - cents,
  };
}

/** "🔨 Hold to smash" a full jar: it waits for a grown-up to buy it. */
export function smashGoal(db: DbOrTx, id: number, now: number): Goal {
  const goal = getLiveGoal(db, id);
  if (goal.smashedAt !== null) throw new MoneyConflictError('smashed');
  if (jarCentsOf(db, goal) < goal.targetCents) throw new MoneyConflictError('not-full');
  const updated = db
    .update(goals)
    .set({ smashedAt: now, updatedAt: new Date(now).toISOString() })
    .where(eq(goals.id, id))
    .returning()
    .get();
  recordEvent(db, {
    type: 'goal.smashed',
    at: now,
    actorId: goal.childId,
    childId: goal.childId,
    data: { goalId: id, name: goal.name, cents: goal.targetCents },
  });
  return updated;
}

/** "↩ Put it back": un-smashes the jar; its money stays in it. */
export function unsmashGoal(db: DbOrTx, id: number, parentId: number, now: number): Goal {
  const goal = getLiveGoal(db, id);
  if (goal.smashedAt === null) throw new MoneyConflictError('not-smashed');
  const updated = db
    .update(goals)
    .set({ smashedAt: null, updatedAt: new Date(now).toISOString() })
    .where(eq(goals.id, id))
    .returning()
    .get();
  recordEvent(db, {
    type: 'goal.unsmashed',
    at: now,
    actorId: parentId,
    childId: goal.childId,
    data: { goalId: id, name: goal.name },
  });
  return updated;
}

/** "✓ Bought it": the smashed jar's money is spent, and the jar is finished. */
export function buyGoal(
  db: DbOrTx,
  id: number,
  parentId: number,
  now: number,
): { goal: Goal; cents: number } {
  const goal = getLiveGoal(db, id);
  if (goal.smashedAt === null) throw new MoneyConflictError('not-smashed');
  const inCents = jarCentsOf(db, goal);
  if (inCents !== 0) {
    appendLedger(db, {
      childId: goal.childId,
      kind: 'spend',
      cents: -inCents,
      goalId: goal.id,
      note: goal.name,
      createdBy: parentId,
      at: now,
    });
  }
  const updated = db
    .update(goals)
    .set({ boughtAt: now, updatedAt: new Date(now).toISOString() })
    .where(eq(goals.id, id))
    .returning()
    .get();
  recordEvent(db, {
    type: 'goal.bought',
    at: now,
    actorId: parentId,
    childId: goal.childId,
    data: { goalId: id, name: goal.name, cents: inCents },
  });
  return { goal: updated, cents: inCents };
}

// ---------------------------------------------------------------------------
// Money in and out

/** "✉️ Send the envelope": it waits on the kiosk until the child opens it. */
export function sendEnvelope(
  db: DbOrTx,
  childId: number,
  input: EnvelopeCreate,
  parent: User,
  now: number,
): EnvelopeRow {
  getActiveChild(db, childId);
  const row = db
    .insert(envelopes)
    .values({
      childId,
      cents: input.cents,
      note: input.note,
      fromName: envelopeSender(input.note, parent.name),
      createdBy: parent.id,
      sentAt: now,
    })
    .returning()
    .get();
  recordEvent(db, {
    type: 'envelope.sent',
    at: now,
    actorId: parent.id,
    childId,
    data: { envelopeId: row.id, cents: input.cents, note: input.note },
  });
  return row;
}

/**
 * Opens an envelope: its money arrives in "to sort" as an `extra_income` row. On the
 * kiosk, or by the server during a payday (then the row carries the payday).
 */
export function openEnvelope(
  db: DbOrTx,
  id: number,
  now: number,
  paydayId: number | null = null,
): EnvelopeRow {
  const envelope = db.select().from(envelopes).where(eq(envelopes.id, id)).get();
  if (!envelope) throw new NotFoundError(`Envelope ${id} not found`);
  if (envelope.openedAt !== null) throw new MoneyConflictError('already-opened');
  const entry = appendLedger(db, {
    childId: envelope.childId,
    kind: 'extra_income',
    cents: envelope.cents,
    note: envelope.note,
    paydayId,
    createdBy: envelope.createdBy,
    at: now,
  });
  const opened = db
    .update(envelopes)
    .set({ openedAt: now, ledgerId: entry.id, updatedAt: new Date(now).toISOString() })
    .where(eq(envelopes.id, id))
    .returning()
    .get();
  recordEvent(db, {
    type: 'envelope.opened',
    at: now,
    actorId: paydayId === null ? envelope.childId : null,
    childId: envelope.childId,
    data: { envelopeId: id, cents: envelope.cents, ...(paydayId !== null && { paydayId }) },
  });
  return opened;
}

/** "🛒 Spent": money out, from "to sort" or a jar, never more than is there. */
export function spendMoney(
  db: DbOrTx,
  childId: number,
  input: SpendInput,
  parentId: number,
  now: number,
): void {
  getActiveChild(db, childId);
  const state = moneyStateOf(db, childId);
  const goalId = input.goalId ?? null;
  if (goalId !== null) {
    const goal = getLiveGoal(db, goalId);
    if (goal.childId !== childId) throw new NotFoundError(`Goal ${goalId} isn't this child's`);
    if (goal.smashedAt !== null) throw new MoneyConflictError('smashed');
    if (input.cents > (state.jarCents.get(goalId) ?? 0)) throw new MoneyConflictError('too-much');
  } else if (input.cents > state.money.toSortCents) {
    throw new MoneyConflictError('too-much');
  }
  appendLedger(db, {
    childId,
    kind: 'spend',
    cents: -input.cents,
    goalId,
    note: input.note,
    createdBy: parentId,
    at: now,
  });
  recordEvent(db, {
    type: 'money.spent',
    at: now,
    actorId: parentId,
    childId,
    data: { cents: input.cents, note: input.note, ...(goalId !== null && { goalId }) },
  });
}

/** Jars that have a picture file (for tidying the images folder). */
export function goalImagePaths(db: DbOrTx): string[] {
  return db
    .select({ path: goals.imagePath })
    .from(goals)
    .where(isNotNull(goals.imagePath))
    .all()
    .map((g) => g.path!);
}
