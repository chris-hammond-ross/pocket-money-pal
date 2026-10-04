/**
 * Surprise quests on the server (spec 006, ADR 0013): the saved list, sending and
 * scheduling, the queue (one on the kiosk at a time), expiry, and the claim race.
 *
 * A run goes `scheduled` → `queued` → `live` → `grabbed` | `expired` | `cancelled`. The
 * grab makes a one-off chore for today (`chores.surprise_run_id`) with an open instance per
 * taker, so claiming, the tray, approving, undo and the ledger all work unchanged.
 *
 * Every function that moves runs returns its `SurpriseMove`s, which the caller broadcasts
 * after the transaction commits.
 */
import {
  canGrabTogether,
  dueRunFate,
  grabProblem,
  queueOrder,
  setTimeProblem,
  SURPRISE_CHORE_TIME,
  surpriseEligible,
  zonedDateOf,
  zonedTimeToInstant,
  type Grab,
  type GrabProblem,
  type KioskSurprise,
  type ServerEvent,
  type SurpriseRun,
  type SurpriseSend,
  type SurpriseTask,
  type SurpriseTaskInput,
  type SurpriseTaskPatch,
  type SurpriseWho,
} from '@pmp/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { choreInstances, chores, surpriseRuns, surpriseTasks } from '../db/schema';
import { insertChore, type EditContext } from './chores';
import { ConflictError, NotFoundError, ValidationError, type DbOrTx } from './db';
import { recordEvent } from './events';
import { getSettings } from './settings';
import { syncToday } from './today';
import { listChildren } from './users';

type RunRow = typeof surpriseRuns.$inferSelect;
type TaskRow = typeof surpriseTasks.$inferSelect;

/** A run's move, as the WebSocket event every screen hears. */
export type SurpriseMove = Extract<ServerEvent, { type: `surprise.${string}` }>;

/** A grab the rules refuse; the route maps it to a status. */
export class GrabRefusedError extends ConflictError {
  override name = 'GrabRefusedError';
  constructor(readonly problem: GrabProblem) {
    super(`Grab refused: ${problem}`);
  }
}

const whoOf = (childId: number | null): SurpriseWho => childId ?? 'all';
const childIdOf = (who: SurpriseWho): number | null => (who === 'all' ? null : who);
const MINUTE_MS = 60_000;

function todayOf(db: DbOrTx, now: number): string {
  return zonedDateOf(now, getSettings(db).timezone);
}

/** A named child must be an active player, and not on a sick day (ADR 0013). */
function checkWho(db: DbOrTx, who: SurpriseWho, today: string | null): void {
  if (who === 'all') return;
  const child = listChildren(db).find((c) => c.id === who);
  if (!child) throw new ValidationError([{ path: ['who'], message: 'Unknown player' }]);
  if (today !== null && child.sickOn === today) {
    throw new ValidationError([{ path: ['who'], message: 'It’s their sick day' }]);
  }
}

// ---------------------------------------------------------------------------
// The saved list

function toTaskDto(row: TaskRow): SurpriseTask {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    rewardPoints: row.rewardPoints,
    timeFrameMin: row.timeFrameMin,
    who: whoOf(row.childId),
  };
}

function getActiveTask(db: DbOrTx, id: number): TaskRow {
  const row = db
    .select()
    .from(surpriseTasks)
    .where(and(eq(surpriseTasks.id, id), isNull(surpriseTasks.deletedAt)))
    .get();
  if (!row) throw new NotFoundError(`Surprise quest ${id} not found`);
  return row;
}

/** The saved surprise quests, oldest first. One for a removed child now goes to everyone. */
export function listSurpriseTasks(db: DbOrTx): SurpriseTask[] {
  const active = new Set(listChildren(db).map((c) => c.id));
  return db
    .select()
    .from(surpriseTasks)
    .where(isNull(surpriseTasks.deletedAt))
    .orderBy(asc(surpriseTasks.id))
    .all()
    .map((row) =>
      toTaskDto(row.childId === null || active.has(row.childId) ? row : { ...row, childId: null }),
    );
}

function insertTask(db: DbOrTx, input: SurpriseTaskInput, ctx: EditContext): TaskRow {
  checkWho(db, input.who, null);
  const row = db
    .insert(surpriseTasks)
    .values({
      title: input.title,
      icon: input.icon,
      rewardPoints: input.rewardPoints,
      timeFrameMin: input.timeFrameMin,
      childId: childIdOf(input.who),
    })
    .returning()
    .get();
  recordEvent(db, {
    type: 'surprise_task.created',
    at: ctx.now,
    actorId: ctx.parentId,
    data: { taskId: row.id, title: row.title },
  });
  return row;
}

export function createSurpriseTask(
  db: DbOrTx,
  input: SurpriseTaskInput,
  ctx: EditContext,
): SurpriseTask {
  return toTaskDto(insertTask(db, input, ctx));
}

/** Edits a saved quest. Runs already sent or scheduled keep their own copy. */
export function updateSurpriseTask(
  db: DbOrTx,
  id: number,
  patch: SurpriseTaskPatch,
  ctx: EditContext,
): SurpriseTask {
  const before = getActiveTask(db, id);
  if (patch.who !== undefined) checkWho(db, patch.who, null);
  const row = db
    .update(surpriseTasks)
    .set({
      title: patch.title,
      icon: patch.icon,
      rewardPoints: patch.rewardPoints,
      timeFrameMin: patch.timeFrameMin,
      ...(patch.who !== undefined && { childId: childIdOf(patch.who) }),
      updatedAt: new Date(ctx.now).toISOString(),
    })
    .where(eq(surpriseTasks.id, id))
    .returning()
    .get();
  const changed = (['title', 'icon', 'rewardPoints', 'timeFrameMin', 'childId'] as const).filter(
    (k) => before[k] !== row[k],
  );
  recordEvent(db, {
    type: 'surprise_task.updated',
    at: ctx.now,
    actorId: ctx.parentId,
    data: { taskId: id, changed },
  });
  return toTaskDto(row);
}

/** Soft delete: it leaves the list; runs already sent or scheduled are untouched. */
export function deleteSurpriseTask(db: DbOrTx, id: number, ctx: EditContext): void {
  const task = getActiveTask(db, id);
  db.update(surpriseTasks)
    .set({ deletedAt: ctx.now, updatedAt: new Date(ctx.now).toISOString() })
    .where(eq(surpriseTasks.id, id))
    .run();
  recordEvent(db, {
    type: 'surprise_task.deleted',
    at: ctx.now,
    actorId: ctx.parentId,
    data: { taskId: id, title: task.title },
  });
}

// ---------------------------------------------------------------------------
// Runs as screens see them

/** Who can accept a run now: its child or every child, but nobody on a sick day. */
function eligibleOf(db: DbOrTx, childId: number | null, today: string): number[] {
  return surpriseEligible(
    childId,
    listChildren(db).map((c) => ({ id: c.id, sick: c.sickOn === today })),
  );
}

function getRun(db: DbOrTx, id: number): RunRow {
  const row = db.select().from(surpriseRuns).where(eq(surpriseRuns.id, id)).get();
  if (!row) throw new NotFoundError(`Surprise ${id} not found`);
  return row;
}

function toRunDto(db: DbOrTx, row: RunRow, today: string): SurpriseRun {
  const takers =
    row.choreId === null
      ? []
      : db
          .select()
          .from(choreInstances)
          .where(eq(choreInstances.choreId, row.choreId))
          .orderBy(asc(choreInstances.id))
          .all()
          .map((i) => ({
            childId: i.childId,
            instanceId: i.id,
            status: i.status,
            claimedAt: i.claimedAt,
          }));
  return {
    id: row.id,
    taskId: row.taskId,
    title: row.title,
    icon: row.icon,
    rewardPoints: row.rewardPoints,
    timeFrameMin: row.timeFrameMin,
    who: whoOf(row.childId),
    status: row.status,
    appearAt: row.appearAt,
    sentAt: row.sentAt,
    shownAt: row.shownAt,
    expiresAt: row.expiresAt,
    grabbedAt: row.grabbedAt,
    endedAt: row.endedAt,
    team: row.team,
    eligibleIds: eligibleOf(db, row.childId, today),
    takers,
  };
}

/** The run as it is now, for the move that just happened to it. */
function moved(db: DbOrTx, type: SurpriseMove['type'], id: number, now: number): SurpriseMove {
  const run = toRunDto(db, getRun(db, id), todayOf(db, now));
  if (type === 'surprise.grabbed') {
    return { type, run, childIds: run.takers.map((t) => t.childId), team: run.team };
  }
  return { type, run };
}

/** The Day tab's SURPRISES TODAY: today's runs that weren't taken back, in sending order. */
export function todaySurprises(db: DbOrTx, now: number): SurpriseRun[] {
  const today = todayOf(db, now);
  return db
    .select()
    .from(surpriseRuns)
    .where(and(eq(surpriseRuns.date, today), ne(surpriseRuns.status, 'cancelled')))
    .orderBy(asc(surpriseRuns.id))
    .all()
    .map((row) => toRunDto(db, row, today));
}

/** The surprise up on the kiosk now, if its time frame hasn't run out. */
export function kioskSurprise(db: DbOrTx, now: number): KioskSurprise | null {
  const live = db.select().from(surpriseRuns).where(eq(surpriseRuns.status, 'live')).get();
  if (!live || live.expiresAt === null || live.expiresAt <= now) return null;
  const run = toRunDto(db, live, todayOf(db, now));
  const queued = db
    .select({ id: surpriseRuns.id })
    .from(surpriseRuns)
    .where(eq(surpriseRuns.status, 'queued'))
    .all().length;
  return { run, canTeam: canGrabTogether(live.childId, run.eligibleIds), queued };
}

// ---------------------------------------------------------------------------
// The queue and expiry

/**
 * Moves every run whose moment has come, at `now` (spec 006, "Rules and data"):
 *
 * - a live run whose time frame ran out expires;
 * - a scheduled run that's due is queued, or expires unseen if it's already past its time
 *   frame (the server was down); one left from an earlier day expires too, as does a queued
 *   one that never got its turn;
 * - with nothing live, the oldest queued run goes live, its time frame starting now.
 *
 * Idempotent: the scheduler calls it at each wake, and every action that frees the kiosk
 * calls it in its own transaction.
 */
export function advanceSurprises(db: DbOrTx, now: number): SurpriseMove[] {
  const today = todayOf(db, now);
  const moves: SurpriseMove[] = [];
  const expire = (row: RunRow, endedAt: number) => {
    db.update(surpriseRuns)
      .set({ status: 'expired', endedAt, updatedAt: new Date(now).toISOString() })
      .where(eq(surpriseRuns.id, row.id))
      .run();
    recordEvent(db, {
      type: 'surprise.expired',
      at: now,
      data: { runId: row.id, title: row.title, shown: row.shownAt !== null },
    });
    moves.push(moved(db, 'surprise.expired', row.id, now));
  };

  const waiting = db
    .select()
    .from(surpriseRuns)
    .where(inArray(surpriseRuns.status, ['live', 'scheduled', 'queued']))
    .orderBy(asc(surpriseRuns.id))
    .all();
  for (const row of waiting) {
    if (row.status === 'live') {
      if (row.expiresAt !== null && row.expiresAt <= now) expire(row, row.expiresAt);
    } else if (row.date < today) {
      expire(row, now);
    } else if (row.status === 'scheduled' && row.appearAt !== null) {
      const fate = dueRunFate(row.appearAt, row.timeFrameMin, now);
      if (fate === 'expire') expire(row, now);
      if (fate === 'appear') {
        db.update(surpriseRuns)
          .set({ status: 'queued', updatedAt: new Date(now).toISOString() })
          .where(eq(surpriseRuns.id, row.id))
          .run();
        moves.push(moved(db, 'surprise.queued', row.id, now));
      }
    }
  }

  const live = db.select().from(surpriseRuns).where(eq(surpriseRuns.status, 'live')).get();
  if (!live) {
    const queued = db.select().from(surpriseRuns).where(eq(surpriseRuns.status, 'queued')).all();
    const next = queueOrder(queued)[0];
    if (next) {
      db.update(surpriseRuns)
        .set({
          status: 'live',
          shownAt: now,
          expiresAt: now + next.timeFrameMin * MINUTE_MS,
          updatedAt: new Date(now).toISOString(),
        })
        .where(eq(surpriseRuns.id, next.id))
        .run();
      moves.push(moved(db, 'surprise.live', next.id, now));
    }
  }
  return moves;
}

/** When `advanceSurprises` next has something to do: an expiry or a set time. */
export function nextSurpriseAt(db: DbOrTx): number | null {
  const times = db
    .select({
      status: surpriseRuns.status,
      appearAt: surpriseRuns.appearAt,
      expiresAt: surpriseRuns.expiresAt,
    })
    .from(surpriseRuns)
    .where(inArray(surpriseRuns.status, ['live', 'scheduled']))
    .all()
    .map((r) => (r.status === 'live' ? r.expiresAt : r.appearAt))
    .filter((t): t is number => t !== null);
  return times.length === 0 ? null : Math.min(...times);
}

/**
 * The new-day run (spec 006, "End of day"): a surprise quest still open from an earlier day
 * is skipped. A claimed one stays in the tray.
 */
export function endSurpriseDays(db: DbOrTx, today: string): number {
  const surpriseChores = db
    .select({ id: chores.id })
    .from(chores)
    .where(isNotNull(chores.surpriseRunId));
  return db
    .update(choreInstances)
    .set({ status: 'skipped' })
    .where(
      and(
        eq(choreInstances.status, 'open'),
        lt(choreInstances.date, today),
        inArray(choreInstances.choreId, surpriseChores),
      ),
    )
    .run().changes;
}

// ---------------------------------------------------------------------------
// Sending, changing and taking back

interface RunFields {
  taskId: number | null;
  title: string;
  icon: string;
  rewardPoints: number;
  timeFrameMin: number;
  childId: number | null;
  appearAt: number | null;
}

/**
 * The run a panel asks for: a saved quest (its defaults fill what's left out), or a new
 * one, kept for next time when `save` is on. Checks who and the set time.
 */
function resolveSend(db: DbOrTx, input: SurpriseSend, ctx: EditContext): RunFields {
  const settings = getSettings(db);
  let fields: Omit<RunFields, 'appearAt'>;
  if (input.taskId !== undefined) {
    const task = getActiveTask(db, input.taskId);
    const who = input.who ?? whoOf(task.childId);
    checkWho(db, who, ctx.today);
    fields = {
      taskId: task.id,
      title: task.title,
      icon: task.icon,
      rewardPoints: task.rewardPoints,
      timeFrameMin: input.timeFrameMin ?? task.timeFrameMin,
      childId: childIdOf(who),
    };
  } else {
    const task = input.task!;
    const who = input.who!;
    checkWho(db, who, ctx.today);
    const saved = input.save
      ? insertTask(db, { ...task, who, timeFrameMin: input.timeFrameMin! }, ctx).id
      : null;
    fields = { ...task, taskId: saved, timeFrameMin: input.timeFrameMin!, childId: childIdOf(who) };
  }
  if (input.appearAt === undefined) return { ...fields, appearAt: null };
  const problem = setTimeProblem(
    input.appearAt,
    ctx.today,
    ctx.now,
    settings.timezone,
    settings.quietHours,
  );
  if (problem) throw new ValidationError([{ path: ['appearAt'], message: problem }]);
  return { ...fields, appearAt: zonedTimeToInstant(ctx.today, input.appearAt, settings.timezone) };
}

/**
 * Sends a surprise right away (it queues, and goes live if the kiosk is free), or
 * schedules it for a set time today.
 */
export function sendSurprise(
  db: DbOrTx,
  input: SurpriseSend,
  ctx: EditContext,
): { run: SurpriseRun; moves: SurpriseMove[] } {
  const fields = resolveSend(db, input, ctx);
  const scheduled = fields.appearAt !== null;
  const row = db
    .insert(surpriseRuns)
    .values({
      ...fields,
      status: scheduled ? 'scheduled' : 'queued',
      date: ctx.today,
      sentAt: ctx.now,
      source: 'phone',
      sentBy: ctx.parentId,
    })
    .returning()
    .get();
  recordEvent(db, {
    type: scheduled ? 'surprise.scheduled' : 'surprise.sent',
    at: ctx.now,
    actorId: ctx.parentId,
    childId: row.childId,
    data: { runId: row.id, title: row.title, appearAt: row.appearAt },
  });
  const moves = [
    moved(db, scheduled ? 'surprise.scheduled' : 'surprise.queued', row.id, ctx.now),
    ...advanceSurprises(db, ctx.now),
  ];
  return { run: toRunDto(db, getRun(db, row.id), ctx.today), moves };
}

/**
 * Changes a scheduled run (spec 006, "Scheduled" row): the panel sends its whole state
 * again. Only this run changes, never its saved quest; with no set time it goes now.
 */
export function updateScheduledSurprise(
  db: DbOrTx,
  id: number,
  input: SurpriseSend,
  ctx: EditContext,
): { run: SurpriseRun; moves: SurpriseMove[] } {
  const before = getRun(db, id);
  if (before.status !== 'scheduled') {
    throw new ConflictError(`Surprise ${id} is ${before.status}, not scheduled`);
  }
  const fields = resolveSend(db, input, ctx);
  const scheduled = fields.appearAt !== null;
  db.update(surpriseRuns)
    .set({
      ...fields,
      status: scheduled ? 'scheduled' : 'queued',
      sentAt: ctx.now,
      updatedAt: new Date(ctx.now).toISOString(),
    })
    .where(eq(surpriseRuns.id, id))
    .run();
  recordEvent(db, {
    type: 'surprise.updated',
    at: ctx.now,
    actorId: ctx.parentId,
    childId: fields.childId,
    data: { runId: id, title: fields.title, appearAt: fields.appearAt },
  });
  const moves = [moved(db, 'surprise.updated', id, ctx.now)];
  if (!scheduled) moves.push(moved(db, 'surprise.queued', id, ctx.now));
  moves.push(...advanceSurprises(db, ctx.now));
  return { run: toRunDto(db, getRun(db, id), ctx.today), moves };
}

/**
 * Takes back a scheduled, queued or live run. A live one closes on every kiosk, and the
 * next one in the queue goes up. A grabbed one is a normal quest by then.
 */
export function cancelSurprise(db: DbOrTx, id: number, ctx: EditContext): SurpriseMove[] {
  const run = getRun(db, id);
  if (!['scheduled', 'queued', 'live'].includes(run.status)) {
    throw new ConflictError(`Surprise ${id} is ${run.status}: too late to take it back`);
  }
  db.update(surpriseRuns)
    .set({
      status: 'cancelled',
      cancelledBy: ctx.parentId,
      endedAt: ctx.now,
      updatedAt: new Date(ctx.now).toISOString(),
    })
    .where(eq(surpriseRuns.id, id))
    .run();
  recordEvent(db, {
    type: 'surprise.cancelled',
    at: ctx.now,
    actorId: ctx.parentId,
    data: { runId: id, title: run.title, was: run.status },
  });
  return [moved(db, 'surprise.cancelled', id, ctx.now), ...advanceSurprises(db, ctx.now)];
}

// ---------------------------------------------------------------------------
// The claim race

/**
 * A child (or every child, "We'll all do it!") grabs the live surprise (spec 006, "The
 * claim race"). Call it inside a transaction: the conditional update is what settles the
 * race, so a second tap, or a tap after the countdown, is refused. The grab makes the
 * one-off chore, an open quest per taker, and puts the next surprise up.
 */
export function grabSurprise(
  db: DbOrTx,
  id: number,
  grab: Grab,
  now: number,
): { grabbed: SurpriseMove; moves: SurpriseMove[] } {
  const row = getRun(db, id);
  const today = todayOf(db, now);
  const eligible = eligibleOf(db, row.childId, today);
  const problem = grabProblem(row, grab, eligible, now);
  if (problem) throw new GrabRefusedError(problem);

  const team = 'all' in grab;
  const takers = team ? eligible : [grab.childId];
  const won = db
    .update(surpriseRuns)
    .set({
      status: 'grabbed',
      grabbedAt: now,
      endedAt: now,
      team,
      updatedAt: new Date(now).toISOString(),
    })
    .where(
      and(
        eq(surpriseRuns.id, id),
        eq(surpriseRuns.status, 'live'),
        gt(surpriseRuns.expiresAt, now),
      ),
    )
    .run();
  if (won.changes !== 1) throw new GrabRefusedError('already-grabbed');

  const chore = insertChore(
    db,
    {
      title: row.title,
      icon: row.icon,
      together: team,
      bonusBefore: SURPRISE_CHORE_TIME,
      dueBy: SURPRISE_CHORE_TIME,
      lateAfter: SURPRISE_CHORE_TIME,
      basePoints: row.rewardPoints,
      earlyBonus: 0,
      unpromptedBonus: 0,
      latePenalty: 0,
      days: [],
      oneOffDate: today,
    },
    takers,
  );
  db.update(chores).set({ surpriseRunId: id }).where(eq(chores.id, chore.id)).run();
  db.update(surpriseRuns).set({ choreId: chore.id }).where(eq(surpriseRuns.id, id)).run();
  syncToday(db, chore.id, today);
  recordEvent(db, {
    type: 'surprise.grabbed',
    at: now,
    actorId: takers.length === 1 ? takers[0] : null,
    childId: takers.length === 1 ? takers[0] : null,
    choreId: chore.id,
    data: {
      runId: id,
      title: row.title,
      childIds: takers,
      team,
      ms: row.shownAt === null ? null : now - row.shownAt,
    },
  });
  return { grabbed: moved(db, 'surprise.grabbed', id, now), moves: advanceSurprises(db, now) };
}

/**
 * A team surprise's other quests (spec 006, "Team claim and approval"): claimed, approved
 * and sent back together. Empty for anything else.
 */
export function teamSiblings(
  db: DbOrTx,
  instanceId: number,
  statuses: readonly ('open' | 'claimed')[],
): number[] {
  const row = db
    .select({ choreId: choreInstances.choreId, date: choreInstances.date, team: surpriseRuns.team })
    .from(choreInstances)
    .innerJoin(chores, eq(chores.id, choreInstances.choreId))
    .innerJoin(surpriseRuns, eq(surpriseRuns.id, chores.surpriseRunId))
    .where(eq(choreInstances.id, instanceId))
    .get();
  if (!row?.team) return [];
  return db
    .select({ id: choreInstances.id })
    .from(choreInstances)
    .where(
      and(
        eq(choreInstances.choreId, row.choreId),
        eq(choreInstances.date, row.date),
        ne(choreInstances.id, instanceId),
        inArray(choreInstances.status, [...statuses]),
      ),
    )
    .orderBy(asc(choreInstances.id))
    .all()
    .map((r) => r.id);
}
