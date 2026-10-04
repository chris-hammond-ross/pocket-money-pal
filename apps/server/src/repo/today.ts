/**
 * "Edits apply to today" (spec 003, "Rules and data"). `syncToday` is the one place these
 * rules live: creating, editing, deleting, skipping and putting back a quest, and sending a
 * claim back, all end by calling it.
 */
import { choreRunsOn, isPausedOn } from '@pmp/shared';
import { and, eq, inArray, notExists, notInArray, type SQL } from 'drizzle-orm';
import { choreAssignments, choreInstances, chores, ledger, users } from '../db/schema';
import { NotFoundError, type DbOrTx } from './db';
import { getSettings } from './settings';
import { listChildren } from './users';

type Chore = typeof chores.$inferSelect;

/** The times and loot an instance copies from its chore (ADR 0004). */
export function snapshotOf(chore: Chore) {
  return {
    bonusBefore: chore.bonusBefore,
    dueBy: chore.dueBy,
    lateAfter: chore.lateAfter,
    basePoints: chore.basePoints,
    earlyBonus: chore.earlyBonus,
    unpromptedBonus: chore.unpromptedBonus,
    latePenalty: chore.latePenalty,
  };
}

/**
 * What an instance that's waiting for the child is on `date`: open, or skipped because the
 * quest is skipped today or it's the child's sick day (ADR 0012).
 */
export function waitingStatus(chore: Chore, date: string, sick = false): 'open' | 'skipped' {
  return chore.skippedOn === date || sick ? 'skipped' : 'open';
}

/** Children whose sick day is `date`. */
export function sickChildren(db: DbOrTx, date: string): Set<number> {
  return new Set(
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.sickOn, date))
      .all()
      .map((u) => u.id),
  );
}

/**
 * Removes the open (and skipped) instances matching `where`. Claimed and approved ones are
 * never touched. One with ledger rows (approved, undone, then sent back) can't be deleted,
 * so it's parked as `skipped` instead: off the kiosk, and hidden on the Day tab while its
 * child isn't on the quest. Returns how many were removed or parked.
 */
export function removeOpenInstances(db: DbOrTx, where: SQL): number {
  const removable = and(where, inArray(choreInstances.status, ['open', 'skipped']));
  const hasLedger = db
    .select({ id: ledger.id })
    .from(ledger)
    .where(eq(ledger.instanceId, choreInstances.id));
  const deleted = db
    .delete(choreInstances)
    .where(and(removable, notExists(hasLedger)))
    .run();
  const parked = db
    .update(choreInstances)
    .set({ status: 'skipped' })
    .where(and(removable, eq(choreInstances.status, 'open')))
    .run();
  return deleted.changes + parked.changes;
}

/** The chore's players who aren't archived. */
function activePlayers(db: DbOrTx, choreId: number): number[] {
  const active = new Set(listChildren(db).map((c) => c.id));
  return db
    .select({ childId: choreAssignments.childId })
    .from(choreAssignments)
    .where(eq(choreAssignments.choreId, choreId))
    .all()
    .map((a) => a.childId)
    .filter((id) => active.has(id));
}

/**
 * Brings one chore's instances on `today` in line with the chore as it is now:
 *
 * - A **waiting** instance (open or skipped) of a current player takes the chore's times
 *   and loot, so the kiosk's bars and countdowns move, and is skipped exactly when the
 *   quest is skipped today (`chores.skipped_on`) or it's the child's sick day.
 * - **Claimed and approved** instances are never changed: they keep the window the child
 *   claimed in, their claim time and awarded points, and stay in the tray until a parent
 *   handles them. Once handled (sent back), the next sync applies the rules above to them.
 * - A child who is no longer a player, or a quest that is deleted, paused or no longer
 *   runs today, loses today's waiting instances (`removeOpenInstances`).
 * - A player with no instance today gets one, if the quest runs today.
 *
 * Idempotent, and only ever touches this chore on this date. Call it inside the
 * transaction that changed the chore.
 */
export function syncToday(db: DbOrTx, choreId: number, today: string): void {
  const chore = db.select().from(chores).where(eq(chores.id, choreId)).get();
  if (!chore) throw new NotFoundError(`Chore ${choreId} not found`);
  // A grabbed surprise (spec 006) was taken on today, holiday pause or not.
  const runs =
    chore.deletedAt === null &&
    choreRunsOn({ days: chore.days, oneOffDate: chore.oneOffDate }, today) &&
    (chore.surpriseRunId !== null || !isPausedOn(getSettings(db).pause, today));
  const players = runs ? activePlayers(db, chore.id) : [];
  const onChore = and(eq(choreInstances.choreId, chore.id), eq(choreInstances.date, today))!;

  removeOpenInstances(
    db,
    players.length > 0 ? and(onChore, notInArray(choreInstances.childId, players))! : onChore,
  );
  if (players.length === 0) return;

  const sick = sickChildren(db, today);
  for (const childId of players) {
    const status = waitingStatus(chore, today, sick.has(childId));
    db.update(choreInstances)
      .set({ ...snapshotOf(chore), status })
      .where(
        and(
          onChore,
          eq(choreInstances.childId, childId),
          inArray(choreInstances.status, ['open', 'skipped']),
        ),
      )
      .run();
    db.insert(choreInstances)
      .values({ choreId: chore.id, childId, date: today, status, ...snapshotOf(chore) })
      .onConflictDoNothing()
      .run();
  }
}
