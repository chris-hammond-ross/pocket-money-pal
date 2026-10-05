/**
 * The holiday pause (ADR 0004, ADR 0016), set from the Week tab on a phone. Paused dates
 * get no chores, so they're neutral for streaks; payday and surprises wait too. Today
 * follows a change at once: a pause that covers today takes today's waiting quests and
 * surprises off the kiosk, and resuming "right now" brings today's quests back.
 */
import { currentPause, isPausedOn, pauseProblem, type SchedulePause } from '@pmp/shared';
import { isNull } from 'drizzle-orm';
import { chores } from '../db/schema';
import type { EditContext } from './chores';
import { ValidationError, type DbOrTx } from './db';
import { recordEvent } from './events';
import { getSettings, updateSettings } from './settings';
import { cancelSurprisesForPause, type SurpriseMove } from './surprises';
import { syncToday } from './today';

export interface PauseChange {
  /** The pause going on or still to come, or null. */
  pause: SchedulePause | null;
  /** Surprises taken back because the pause covers today. */
  moves: SurpriseMove[];
}

/**
 * Sets the pause (a new one, or a new end for the one going on), or with `null` ends it
 * now. "Back tomorrow" is a pause that ends today. Call it inside a transaction.
 */
export function setPause(db: DbOrTx, next: SchedulePause | null, ctx: EditContext): PauseChange {
  const before = currentPause(getSettings(db).pause, ctx.today);
  if (next !== null) {
    const problem = pauseProblem(next, before, ctx.today);
    if (problem) throw new ValidationError([{ path: ['from'], message: problem }]);
  }
  updateSettings(db, { pause: next }, ctx.now);

  // Today follows: `syncToday` drops waiting quests on a paused day and makes them otherwise.
  const live = db.select({ id: chores.id }).from(chores).where(isNull(chores.deletedAt)).all();
  for (const { id } of live) syncToday(db, id, ctx.today);
  const moves = isPausedOn(next, ctx.today) ? cancelSurprisesForPause(db, ctx) : [];

  recordEvent(db, {
    type: next === null ? 'schedule.resumed' : 'schedule.paused',
    at: ctx.now,
    actorId: ctx.parentId,
    data: { pause: next, was: before },
  });
  return { pause: currentPause(next, ctx.today), moves };
}
