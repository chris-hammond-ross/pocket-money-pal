/**
 * The phone's Players tab (spec 003, ADR 0009): player cards, adding, editing and removing
 * a child, game masters, and bonus points.
 */
import {
  zonedDateOf,
  type Adjustment,
  type ChildInput,
  type ChildPatch,
  type GameMasterList,
  type PlayerCard,
} from '@pmp/shared';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import { choreAssignments, chores, users } from '../db/schema';
import type { EditContext } from './chores';
import { ConflictError, NotFoundError, type DbOrTx } from './db';
import { listDevices } from './devices';
import { recordEvent } from './events';
import { appendLedger, balances, pointsToday } from './ledger';
import { getSettings } from './settings';
import { streakOf } from './streaks';
import { syncToday } from './today';
import {
  FALLBACK_AVATAR,
  FALLBACK_COLOUR,
  insertChild,
  listChildren,
  listParents,
  type User,
} from './users';

/** Another active child already has this name (names are unique, ignoring case). */
export class NameTakenError extends ConflictError {
  override name = 'NameTakenError';
}

function checkName(db: DbOrTx, name: string, exceptId?: number): void {
  const lower = name.toLocaleLowerCase();
  if (listChildren(db).some((c) => c.id !== exceptId && c.name.toLocaleLowerCase() === lower)) {
    throw new NameTakenError(`A player is already called ${name}`);
  }
}

function getActiveChild(db: DbOrTx, id: number): User {
  const child = listChildren(db).find((c) => c.id === id);
  if (!child) throw new NotFoundError(`Child ${id} not found`);
  return child;
}

/** Chores (not deleted) that `childId` is a player on, grabbed surprises included. */
function choresOf(db: DbOrTx, childId: number): number[] {
  return db
    .select({ id: chores.id })
    .from(choreAssignments)
    .innerJoin(chores, eq(chores.id, choreAssignments.choreId))
    .where(and(eq(choreAssignments.childId, childId), isNull(chores.deletedAt)))
    .all()
    .map((c) => c.id);
}

/** The player card's quest count: the family's quests, not grabbed surprises. */
function questCount(db: DbOrTx, childId: number): number {
  return db
    .select({ id: chores.id })
    .from(choreAssignments)
    .innerJoin(chores, eq(chores.id, choreAssignments.choreId))
    .where(
      and(
        eq(choreAssignments.childId, childId),
        isNull(chores.deletedAt),
        isNull(chores.surpriseRunId),
      ),
    )
    .all().length;
}

/** The PLAYERS cards, in kiosk column order. */
export function listPlayerCards(db: DbOrTx, now: number): PlayerCard[] {
  const { timezone } = getSettings(db);
  const today = pointsToday(db, now, timezone);
  const date = zonedDateOf(now, timezone);
  const money = balances(db);
  return listChildren(db).map((c) => ({
    id: c.id,
    name: c.name,
    age: c.age,
    avatar: c.avatar ?? FALLBACK_AVATAR,
    colour: c.colour ?? FALLBACK_COLOUR,
    streak: streakOf(db, c.id, date),
    sickToday: c.sickOn === date,
    quests: questCount(db, c.id),
    pointsToday: today.get(c.id) ?? 0,
    cents: money.get(c.id)?.cents ?? 0,
  }));
}

/** The GAME MASTERS rows: each grown-up and how many phones are paired to them. */
export function listGameMasters(db: DbOrTx): GameMasterList {
  const devices = listDevices(db);
  return listParents(db).map((p) => ({
    id: p.id,
    name: p.name,
    phones: devices.filter((d) => d.parent.id === p.id).length,
  }));
}

/** "+ New player": a new child, in the next kiosk column. No quests yet. */
export function createChild(db: DbOrTx, input: ChildInput, ctx: EditContext): User {
  checkName(db, input.name);
  const last = db
    .select({ n: max(users.sortOrder) })
    .from(users)
    .where(eq(users.role, 'child'))
    .get();
  const child = insertChild(db, { ...input, sortOrder: (last?.n ?? -1) + 1 });
  recordEvent(db, {
    type: 'child.created',
    at: ctx.now,
    actorId: ctx.parentId,
    childId: child.id,
    data: { name: child.name },
  });
  return child;
}

const CHILD_FIELDS = ['name', 'age', 'avatar', 'colour'] as const;

/** The player editor's "💾 Save". The audit event lists what changed. */
export function updateChild(db: DbOrTx, id: number, patch: ChildPatch, ctx: EditContext): User {
  const child = getActiveChild(db, id);
  if (patch.name !== undefined) checkName(db, patch.name, id);
  const changed = CHILD_FIELDS.filter((k) => patch[k] !== undefined && patch[k] !== child[k]);
  if (changed.length === 0) return child;
  const updated = db
    .update(users)
    .set({ ...patch, updatedAt: new Date(ctx.now).toISOString() })
    .where(eq(users.id, id))
    .returning()
    .get();
  recordEvent(db, {
    type: 'child.updated',
    at: ctx.now,
    actorId: ctx.parentId,
    childId: id,
    data: { changed },
  });
  return updated;
}

/**
 * "Remove player" (ADR 0009): the child is archived and taken off every quest, and each of
 * those quests syncs today, so open chores go and claims stay in the tray. A quest left
 * with no players is kept, and schedules nothing until someone is added. Ledger rows and
 * history stay. Returns the quests left with no players.
 */
export function removeChild(db: DbOrTx, id: number, ctx: EditContext): number[] {
  const child = getActiveChild(db, id);
  const choreIds = choresOf(db, id);
  db.update(users)
    .set({ archived: true, updatedAt: new Date(ctx.now).toISOString() })
    .where(eq(users.id, id))
    .run();
  db.delete(choreAssignments).where(eq(choreAssignments.childId, id)).run();
  for (const choreId of choreIds) syncToday(db, choreId, ctx.today);

  const stillPlayed = new Set(
    choreIds.length === 0
      ? []
      : db
          .select({ choreId: choreAssignments.choreId })
          .from(choreAssignments)
          .innerJoin(users, eq(users.id, choreAssignments.childId))
          .where(and(inArray(choreAssignments.choreId, choreIds), eq(users.archived, false)))
          .all()
          .map((a) => a.choreId),
  );
  const emptied = choreIds.filter((c) => !stillPlayed.has(c));
  recordEvent(db, {
    type: 'child.removed',
    at: ctx.now,
    actorId: ctx.parentId,
    childId: id,
    data: { name: child.name, quests: choreIds.length, questsLeftEmpty: emptied },
  });
  return emptied;
}

/**
 * "🤒 Sick day" (ADR 0012): every waiting quest the child has today is skipped, so the day
 * doesn't break their streak; claimed and approved ones stay. With `sick: false` it's the
 * undo, and they come back (except quests skipped for everyone today).
 */
export function setSickToday(db: DbOrTx, childId: number, sick: boolean, ctx: EditContext): void {
  const child = getActiveChild(db, childId);
  if ((child.sickOn === ctx.today) === sick) return;
  db.update(users)
    .set({ sickOn: sick ? ctx.today : null, updatedAt: new Date(ctx.now).toISOString() })
    .where(eq(users.id, childId))
    .run();
  for (const choreId of choresOf(db, childId)) syncToday(db, choreId, ctx.today);
  recordEvent(db, {
    type: sick ? 'child.sick_day' : 'child.sick_day_undone',
    at: ctx.now,
    actorId: ctx.parentId,
    childId,
    data: { date: ctx.today },
  });
}

/**
 * Bonus points from the Players tab: a `bonus` ledger row (or `penalty` for minus points)
 * by this parent, with the rate snapshot. Money is 0 until Phase 4 converts points.
 */
export function adjustPoints(
  db: DbOrTx,
  childId: number,
  points: number,
  note: string | undefined,
  ctx: EditContext,
): Adjustment {
  getActiveChild(db, childId);
  const { centsPerPoint, timezone } = getSettings(db);
  appendLedger(db, {
    childId,
    kind: points > 0 ? 'bonus' : 'penalty',
    points,
    cents: 0,
    centsPerPoint,
    note: note ?? null,
    createdBy: ctx.parentId,
    at: ctx.now,
  });
  recordEvent(db, {
    type: 'child.adjusted',
    at: ctx.now,
    actorId: ctx.parentId,
    childId,
    data: { points, ...(note && { note }) },
  });
  return { childId, points, pointsToday: pointsToday(db, ctx.now, timezone).get(childId) ?? 0 };
}
