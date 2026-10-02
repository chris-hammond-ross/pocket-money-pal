import {
  choreStage,
  choreWindow,
  claimPoints,
  claimProblem,
  defaultChips,
  scorePoints,
  zonedDateOf,
  type Approval,
  type ClaimProblem,
  type ClaimResult,
  type PointChips,
  type PointsBreakdown,
  type SendBackReason,
  type TrayItem,
} from '@pmp/shared';
import { and, asc, eq } from 'drizzle-orm';
import { choreInstances, chores, ledger, users } from '../db/schema';
import { ConflictError, NotFoundError, type DbOrTx } from './db';
import { recordEvent } from './events';
import { appendLedger, lifetimeXp, reverseLedgerEntry } from './ledger';
import { getSettings } from './settings';
import { syncToday } from './today';
import { FALLBACK_AVATAR, FALLBACK_COLOUR } from './users';

/** A claim the rules refuse (`claimProblem` in @pmp/shared); the route maps it to a status. */
export class ClaimRefusedError extends ConflictError {
  override name = 'ClaimRefusedError';
  constructor(readonly problem: ClaimProblem) {
    super(`Claim refused: ${problem}`);
  }
}

export type ChoreInstance = typeof choreInstances.$inferSelect;

export function listInstancesForDate(db: DbOrTx, date: string): ChoreInstance[] {
  return db
    .select()
    .from(choreInstances)
    .where(eq(choreInstances.date, date))
    .orderBy(asc(choreInstances.id))
    .all();
}

export function getInstance(db: DbOrTx, id: number): ChoreInstance {
  const row = db.select().from(choreInstances).where(eq(choreInstances.id, id)).get();
  if (!row) throw new NotFoundError(`Chore instance ${id} not found`);
  return row;
}

function awardedColumns(points: PointsBreakdown | null) {
  return {
    awardedBase: points?.base ?? null,
    awardedEarly: points?.early ?? null,
    awardedUnprompted: points?.unprompted ?? null,
    awardedLate: points?.late ?? null,
    awardedExtra: points?.extra ?? null,
    awardedTotal: points?.total ?? null,
  };
}

/** The itemised points stored on an approved instance, or null. */
export function awardedPoints(instance: ChoreInstance): PointsBreakdown | null {
  if (instance.awardedTotal === null) return null;
  return {
    base: instance.awardedBase!,
    early: instance.awardedEarly!,
    unprompted: instance.awardedUnprompted!,
    late: instance.awardedLate!,
    extra: instance.awardedExtra!,
    total: instance.awardedTotal,
  };
}

/**
 * A child claims a quest on the kiosk (spec 001): the instance becomes claimed at `now`,
 * with what the child said about being asked, and any send-back note is cleared. The
 * points aren't in the ledger until a parent approves; the result carries the points
 * worked out now, for "+N pending" and the kiosk's animation. Call it inside a transaction.
 */
export function claimInstance(
  db: DbOrTx,
  args: {
    instanceId: number;
    childId: number;
    unprompted: boolean;
    now: number;
  },
): ClaimResult {
  const instance = getInstance(db, args.instanceId);
  const { timezone } = getSettings(db);
  const problem = claimProblem(instance, {
    childId: args.childId,
    today: zonedDateOf(args.now, timezone),
  });
  if (problem) throw new ClaimRefusedError(problem);

  const window = choreWindow(instance.date, instance, timezone);
  db.update(choreInstances)
    .set({
      status: 'claimed',
      claimedAt: args.now,
      unprompted: args.unprompted,
      sendBackReason: null,
      sentBackBy: null,
      updatedAt: new Date(args.now).toISOString(),
    })
    .where(eq(choreInstances.id, instance.id))
    .run();
  recordEvent(db, {
    type: 'instance.claimed',
    at: args.now,
    actorId: instance.childId,
    childId: instance.childId,
    choreId: instance.choreId,
    instanceId: instance.id,
    data: { unprompted: args.unprompted },
  });
  return {
    instanceId: instance.id,
    childId: instance.childId,
    claimedAt: args.now,
    unprompted: args.unprompted,
    stage: choreStage(window, args.now),
    points: claimPoints(instance, window, args.now, args.unprompted),
  };
}

/**
 * Approves a claimed chore with the parent's chips (spec 002): stores the itemised points
 * on the instance and appends a `chore_points` ledger row at the current rate. Call it
 * inside a transaction; a batch approve is one transaction around several calls.
 */
export function approveInstance(
  db: DbOrTx,
  args: { instanceId: number; chips: PointChips; parentId: number; now: number },
): PointsBreakdown {
  const instance = getInstance(db, args.instanceId);
  if (instance.status !== 'claimed') {
    throw new ConflictError(`Chore instance ${instance.id} is ${instance.status}, not claimed`);
  }
  const points = scorePoints(instance, args.chips);
  db.update(choreInstances)
    .set({
      status: 'approved',
      approvedAt: args.now,
      approvedBy: args.parentId,
      ...awardedColumns(points),
      updatedAt: new Date(args.now).toISOString(),
    })
    .where(eq(choreInstances.id, instance.id))
    .run();
  appendLedger(db, {
    childId: instance.childId,
    kind: 'chore_points',
    points: points.total,
    centsPerPoint: getSettings(db).centsPerPoint,
    instanceId: instance.id,
    createdBy: args.parentId,
    at: args.now,
  });
  return points;
}

/**
 * Undoes an approval (spec 002): a reversing ledger row, and the chore goes back to
 * claimed with its awarded points cleared. The original ledger row stays.
 */
export function undoApproval(
  db: DbOrTx,
  args: { instanceId: number; parentId: number; now: number },
): void {
  const instance = getInstance(db, args.instanceId);
  if (instance.status !== 'approved') {
    throw new ConflictError(`Chore instance ${instance.id} is ${instance.status}, not approved`);
  }
  const entries = db
    .select()
    .from(ledger)
    .where(and(eq(ledger.instanceId, instance.id), eq(ledger.kind, 'chore_points')))
    .all();
  const reversed = new Set(entries.map((e) => e.reversesId));
  for (const entry of entries) {
    if (entry.reversesId === null && !reversed.has(entry.id)) {
      reverseLedgerEntry(db, entry, { createdBy: args.parentId, at: args.now });
    }
  }
  db.update(choreInstances)
    .set({
      status: 'claimed',
      approvedAt: null,
      approvedBy: null,
      ...awardedColumns(null),
      updatedAt: new Date(args.now).toISOString(),
    })
    .where(eq(choreInstances.id, instance.id))
    .run();
}

/** The stage a claimed instance was claimed in, and the chips that gives by default. */
function claimDefaults(instance: ChoreInstance, timezone: string) {
  const window = choreWindow(instance.date, instance, timezone);
  const stage = choreStage(window, instance.claimedAt ?? window.lateAfter);
  return { stage, chips: defaultChips(stage, instance.unprompted ?? false) };
}

/** Parent chips for one approval; each one left out takes the claim's default. */
export type ChipChoice = Partial<Omit<PointChips, 'extra'>> & { extra?: number };

/**
 * A parent approves a claimed chore (spec 002, from the phone since ADR 0008): the chips
 * default from the claim time and what the child said, the points and a ledger row are
 * written, and the audit event is recorded. Returns what every screen celebrates. Call it
 * inside a transaction (a batch is one transaction around several calls).
 */
export function approveClaim(
  db: DbOrTx,
  args: {
    instanceId: number;
    chips?: ChipChoice;
    parentId: number;
    now: number;
    markedDone?: boolean;
  },
): Approval {
  const instance = getInstance(db, args.instanceId);
  if (instance.status !== 'claimed') {
    throw new ConflictError(`Chore instance ${instance.id} is ${instance.status}, not claimed`);
  }
  const { chips: defaults } = claimDefaults(instance, getSettings(db).timezone);
  const chips: PointChips = {
    early: args.chips?.early ?? defaults.early,
    unprompted: args.chips?.unprompted ?? defaults.unprompted,
    late: args.chips?.late ?? defaults.late,
    extra: args.chips?.extra ?? 0,
  };
  const xpBefore = lifetimeXp(db).get(instance.childId) ?? 0;
  const points = approveInstance(db, {
    instanceId: instance.id,
    chips,
    parentId: args.parentId,
    now: args.now,
  });
  recordEvent(db, {
    type: args.markedDone ? 'instance.marked_done' : 'instance.approved',
    at: args.now,
    actorId: args.parentId,
    childId: instance.childId,
    choreId: instance.choreId,
    instanceId: instance.id,
    data: { chips, points },
  });
  return {
    instanceId: instance.id,
    childId: instance.childId,
    points,
    xpBefore,
    xpAfter: lifetimeXp(db).get(instance.childId) ?? 0,
    markedDone: args.markedDone ?? false,
  };
}

/**
 * Sends a claimed chore back (spec 002): open again, the claim cleared, with the parent's
 * reason for the kiosk's note. If it's today's, `syncToday` then decides where it goes: a
 * chore whose child, day or quest was removed while it waited in the tray leaves instead
 * of reopening, and one skipped today stays skipped. Call it inside a transaction.
 */
export function sendBackInstance(
  db: DbOrTx,
  args: { instanceId: number; reason: SendBackReason; parentId: number; now: number },
): ChoreInstance {
  const instance = getInstance(db, args.instanceId);
  if (instance.status !== 'claimed') {
    throw new ConflictError(`Chore instance ${instance.id} is ${instance.status}, not claimed`);
  }
  const updated = db
    .update(choreInstances)
    .set({
      status: 'open',
      claimedAt: null,
      unprompted: null,
      sendBackReason: args.reason,
      sentBackBy: args.parentId,
      updatedAt: new Date(args.now).toISOString(),
    })
    .where(eq(choreInstances.id, instance.id))
    .returning()
    .get();
  const today = zonedDateOf(args.now, getSettings(db).timezone);
  if (instance.date === today) syncToday(db, instance.choreId, today);
  recordEvent(db, {
    type: 'instance.sent_back',
    at: args.now,
    actorId: args.parentId,
    childId: instance.childId,
    choreId: instance.choreId,
    instanceId: instance.id,
    data: { reason: args.reason },
  });
  return updated;
}

/**
 * Mark done (spec 002): a parent saw it done, so it's claimed for the child now, with "not
 * asked" off, and approved straight away with the normal timing bonus or penalty. Only
 * today's open chores. Call it inside a transaction.
 */
export function markDone(
  db: DbOrTx,
  args: { instanceId: number; parentId: number; now: number },
): Approval {
  const instance = getInstance(db, args.instanceId);
  const today = zonedDateOf(args.now, getSettings(db).timezone);
  if (instance.status !== 'open') {
    throw new ConflictError(`Chore instance ${instance.id} is ${instance.status}, not open`);
  }
  if (instance.date !== today)
    throw new ConflictError(`Chore instance ${instance.id} isn't today's`);
  db.update(choreInstances)
    .set({
      status: 'claimed',
      claimedAt: args.now,
      unprompted: false,
      sendBackReason: null,
      sentBackBy: null,
    })
    .where(eq(choreInstances.id, instance.id))
    .run();
  return approveClaim(db, { ...args, markedDone: true });
}

/** Undo (spec 002) with its audit event: a reversing ledger row, back to claimed. */
export function undoApprovalBy(
  db: DbOrTx,
  args: { instanceId: number; parentId: number; now: number },
): ChoreInstance {
  undoApproval(db, args);
  const instance = getInstance(db, args.instanceId);
  recordEvent(db, {
    type: 'instance.undone',
    at: args.now,
    actorId: args.parentId,
    childId: instance.childId,
    choreId: instance.choreId,
    instanceId: instance.id,
  });
  return instance;
}

/** The to-check tray (spec 003): every claimed chore, any day, oldest claim first. */
export function listClaimed(db: DbOrTx): TrayItem[] {
  const { timezone } = getSettings(db);
  return db
    .select({ instance: choreInstances, title: chores.title, icon: chores.icon, child: users })
    .from(choreInstances)
    .innerJoin(chores, eq(chores.id, choreInstances.choreId))
    .innerJoin(users, eq(users.id, choreInstances.childId))
    .where(eq(choreInstances.status, 'claimed'))
    .orderBy(asc(choreInstances.claimedAt), asc(choreInstances.id))
    .all()
    .map(({ instance, title, icon, child }) => {
      const { stage, chips } = claimDefaults(instance, timezone);
      return {
        instanceId: instance.id,
        childId: instance.childId,
        child: {
          name: child.name,
          avatar: child.avatar ?? FALLBACK_AVATAR,
          colour: child.colour ?? FALLBACK_COLOUR,
        },
        choreId: instance.choreId,
        title,
        icon,
        date: instance.date,
        claimedAt: instance.claimedAt ?? 0,
        unprompted: instance.unprompted ?? false,
        stage,
        points: scorePoints(instance, chips),
      };
    });
}
