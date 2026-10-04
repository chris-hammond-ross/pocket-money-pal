import {
  choreInputSchema,
  type Chore as ChoreDto,
  type ChoreInput,
  type ChorePatch,
} from '@pmp/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { choreAssignments, choreInstances, chores, users } from '../db/schema';
import { NotFoundError, ValidationError, type DbOrTx } from './db';
import { recordEvent } from './events';
import { syncToday } from './today';
import { listChildren } from './users';

export type Chore = typeof chores.$inferSelect;
export type ChoreFields = Omit<ChoreInput, 'childIds'> & { libraryId?: string | null };

/** Inserts a validated chore and its assignments. Wrap in a transaction with other writes. */
export function insertChore(db: DbOrTx, fields: ChoreFields, childIds: readonly number[]): Chore {
  const chore = db
    .insert(chores)
    .values({
      title: fields.title,
      icon: fields.icon,
      libraryId: fields.libraryId ?? null,
      together: fields.together,
      bonusBefore: fields.bonusBefore,
      dueBy: fields.dueBy,
      lateAfter: fields.lateAfter,
      basePoints: fields.basePoints,
      earlyBonus: fields.earlyBonus,
      unpromptedBonus: fields.unpromptedBonus,
      latePenalty: fields.latePenalty,
      days: [...fields.days],
      oneOffDate: fields.oneOffDate,
    })
    .returning()
    .get();
  if (childIds.length > 0) {
    db.insert(choreAssignments)
      .values(childIds.map((childId) => ({ choreId: chore.id, childId })))
      .run();
  }
  return chore;
}

/**
 * Every (chore, child) pair the scheduler may create an instance for: chores that aren't
 * deleted, given to children who aren't archived.
 */
export function listActiveAssignments(db: DbOrTx): { chore: Chore; childId: number }[] {
  return db
    .select({ chore: chores, childId: choreAssignments.childId })
    .from(choreAssignments)
    .innerJoin(chores, eq(chores.id, choreAssignments.choreId))
    .innerJoin(users, eq(users.id, choreAssignments.childId))
    .where(and(isNull(chores.deletedAt), eq(users.role, 'child'), eq(users.archived, false)))
    .all();
}

/**
 * Soft delete (spec 003): the chore stops being scheduled, and `syncToday` removes today's
 * open chores. Claimed and approved ones, and the ledger, are kept.
 */
export function softDeleteChore(db: DbOrTx, choreId: number, today: string, now: number): void {
  db.update(chores)
    .set({ deletedAt: now, updatedAt: new Date(now).toISOString() })
    .where(and(eq(chores.id, choreId), isNull(chores.deletedAt)))
    .run();
  syncToday(db, choreId, today);
}

/** The chore as the phone sees it (`choreSchema`). */
export function toChoreDto(chore: Chore, childIds: readonly number[]): ChoreDto {
  return {
    id: chore.id,
    title: chore.title,
    icon: chore.icon,
    libraryId: chore.libraryId,
    together: chore.together,
    bonusBefore: chore.bonusBefore,
    dueBy: chore.dueBy,
    lateAfter: chore.lateAfter,
    basePoints: chore.basePoints,
    earlyBonus: chore.earlyBonus,
    unpromptedBonus: chore.unpromptedBonus,
    latePenalty: chore.latePenalty,
    days: chore.days,
    oneOffDate: chore.oneOffDate,
    childIds: [...childIds].sort((a, b) => a - b),
  };
}

/**
 * Chores that aren't deleted, oldest first, with their active players. A grabbed
 * surprise's one-off isn't one of the family's quests: its SURPRISES TODAY row stands for it.
 */
export function listChores(db: DbOrTx): ChoreDto[] {
  const active = new Set(listChildren(db).map((c) => c.id));
  const rows = db
    .select()
    .from(chores)
    .where(and(isNull(chores.deletedAt), isNull(chores.surpriseRunId)))
    .orderBy(asc(chores.id))
    .all();
  const assignments = db.select().from(choreAssignments).all();
  return rows.map((chore) =>
    toChoreDto(
      chore,
      assignments
        .filter((a) => a.choreId === chore.id && active.has(a.childId))
        .map((a) => a.childId),
    ),
  );
}

function getActiveChore(db: DbOrTx, id: number): Chore {
  const chore = db
    .select()
    .from(chores)
    .where(and(eq(chores.id, id), isNull(chores.deletedAt)))
    .get();
  if (!chore) throw new NotFoundError(`Chore ${id} not found`);
  return chore;
}

function checkPlayers(db: DbOrTx, childIds: readonly number[]): void {
  const active = new Set(listChildren(db).map((c) => c.id));
  if (childIds.some((id) => !active.has(id))) {
    throw new ValidationError([{ path: ['childIds'], message: 'Unknown player' }]);
  }
}

export interface EditContext {
  /** Today in the family time zone. */
  today: string;
  now: number;
  parentId: number;
}

/** A new quest from the phone, with today's instances if it runs today. */
export function createChore(
  db: DbOrTx,
  input: ChoreInput & { libraryId?: string | null },
  ctx: EditContext,
): ChoreDto {
  checkPlayers(db, input.childIds);
  const { childIds, ...fields } = input;
  const chore = insertChore(db, fields, childIds);
  syncToday(db, chore.id, ctx.today);
  recordEvent(db, {
    type: 'chore.created',
    at: ctx.now,
    actorId: ctx.parentId,
    choreId: chore.id,
    data: { title: chore.title, oneOff: chore.oneOffDate !== null },
  });
  return toChoreDto(chore, childIds);
}

const EDITABLE_FIELDS = [
  'title',
  'icon',
  'together',
  'bonusBefore',
  'dueBy',
  'lateAfter',
  'basePoints',
  'earlyBonus',
  'unpromptedBonus',
  'latePenalty',
  'days',
  'oneOffDate',
] as const;

/**
 * Edits a quest: the patch is merged onto the chore and must still pass
 * `choreInputSchema`. Players are replaced, today's instances follow `syncToday`, and the
 * audit event lists the fields that changed (a lone days change is `chore.day_toggled`).
 */
export function updateChore(db: DbOrTx, id: number, patch: ChorePatch, ctx: EditContext): ChoreDto {
  const chore = getActiveChore(db, id);
  // A grabbed surprise's quest can be deleted, but not edited into an ordinary quest.
  if (chore.surpriseRunId !== null) throw new NotFoundError(`Chore ${id} is a surprise`);
  const current = listChores(db).find((c) => c.id === id)!;
  // The schema drops `id` and `libraryId`, which a patch can't change.
  const merged = choreInputSchema.safeParse({ ...current, ...patch });
  if (!merged.success) throw new ValidationError(merged.error.issues);
  const { childIds, ...fields } = merged.data;
  checkPlayers(db, childIds);

  const changed: string[] = EDITABLE_FIELDS.filter(
    (k) => JSON.stringify(fields[k]) !== JSON.stringify(chore[k]),
  );
  const before = new Set(current.childIds);
  const playersChanged = before.size !== childIds.length || childIds.some((c) => !before.has(c));
  if (playersChanged) changed.push('childIds');

  const updated = db
    .update(chores)
    .set({ ...fields, days: [...fields.days], updatedAt: new Date(ctx.now).toISOString() })
    .where(eq(chores.id, id))
    .returning()
    .get();
  if (playersChanged) {
    db.delete(choreAssignments).where(eq(choreAssignments.choreId, id)).run();
    db.insert(choreAssignments)
      .values(childIds.map((childId) => ({ choreId: id, childId })))
      .run();
  }
  syncToday(db, id, ctx.today);
  if (changed.length > 0) {
    recordEvent(db, {
      type: changed.length === 1 && changed[0] === 'days' ? 'chore.day_toggled' : 'chore.updated',
      at: ctx.now,
      actorId: ctx.parentId,
      choreId: id,
      data: { changed },
    });
  }
  return toChoreDto(updated, childIds);
}

/** Deletes a quest (soft), with its audit event. */
export function deleteChore(db: DbOrTx, id: number, ctx: EditContext): void {
  const chore = getActiveChore(db, id);
  softDeleteChore(db, id, ctx.today, ctx.now);
  recordEvent(db, {
    type: 'chore.deleted',
    at: ctx.now,
    actorId: ctx.parentId,
    choreId: id,
    data: { title: chore.title },
  });
}

/**
 * "Skip today only" (spec 003): the quest is marked skipped today, so `syncToday` makes its
 * open chores skipped and they leave the kiosk. With `skip: false` it's "Put back". Claimed
 * and approved ones stay as they are. Returns how many instances moved.
 */
export function setSkippedToday(db: DbOrTx, id: number, skip: boolean, ctx: EditContext): number {
  getActiveChore(db, id);
  const onToday = and(eq(choreInstances.choreId, id), eq(choreInstances.date, ctx.today));
  const statuses = () =>
    new Map(
      db
        .select()
        .from(choreInstances)
        .where(onToday)
        .all()
        .map((i) => [i.id, i.status]),
    );
  const before = statuses();
  db.update(chores)
    .set({ skippedOn: skip ? ctx.today : null, updatedAt: new Date(ctx.now).toISOString() })
    .where(eq(chores.id, id))
    .run();
  syncToday(db, id, ctx.today);
  const after = statuses();
  const moved = [...after].filter(([i, status]) => before.get(i) !== status).length;
  recordEvent(db, {
    type: skip ? 'chore.skipped' : 'chore.restored',
    at: ctx.now,
    actorId: ctx.parentId,
    choreId: id,
    data: { date: ctx.today, instances: moved },
  });
  return moved;
}
