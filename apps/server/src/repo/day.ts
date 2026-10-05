import {
  choreRunsOn,
  choreWindow,
  claimPoints,
  isPausedOn,
  plannedQuests,
  sendBackReasonSchema,
  zonedDateOf,
  type DayInstance,
  type DayPlan,
  type DayQuest,
} from '@pmp/shared';
import { eq } from 'drizzle-orm';
import { choreInstances, chores as choreTable } from '../db/schema';
import { listChores } from './chores';
import type { DbOrTx } from './db';
import { getSettings } from './settings';
import { FALLBACK_AVATAR, FALLBACK_COLOUR, listChildren, listParents } from './users';

/**
 * The phone's Day tab (spec 003). Any date shows what's scheduled from the current plan;
 * today also has each child's instance with its status, and chores whose day or player
 * was removed after a claim still show while that claim waits.
 */
export function dayPlan(db: DbOrTx, date: string, now: number): DayPlan {
  const settings = getSettings(db);
  const today = zonedDateOf(now, settings.timezone);
  const chores = listChores(db);
  const parentNames = new Map(listParents(db).map((p) => [p.id, p.name]));

  let quests: DayQuest[];
  if (date !== today) {
    quests = plannedQuests(chores, date);
  } else {
    const instances = db.select().from(choreInstances).where(eq(choreInstances.date, date)).all();
    const skippedToday = new Set(
      db
        .select({ id: choreTable.id })
        .from(choreTable)
        .where(eq(choreTable.skippedOn, date))
        .all()
        .map((c) => c.id),
    );
    quests = chores
      .map((chore): DayQuest => {
        // A skipped row of a child who's no longer on the quest is parked (`syncToday`).
        const mine = instances.filter(
          (i) =>
            i.choreId === chore.id &&
            (i.status !== 'skipped' || chore.childIds.includes(i.childId)),
        );
        return {
          chore,
          skipped: skippedToday.has(chore.id),
          instances: mine.map((i): DayInstance => {
            const reason = sendBackReasonSchema.safeParse(i.sendBackReason);
            const window = choreWindow(date, i, settings.timezone);
            return {
              id: i.id,
              childId: i.childId,
              status: i.status,
              claimedAt: i.claimedAt,
              unprompted: i.unprompted,
              points:
                i.status === 'claimed'
                  ? claimPoints(i, window, i.claimedAt ?? now, i.unprompted ?? false).total
                  : i.status === 'approved'
                    ? i.awardedTotal
                    : null,
              sentBack:
                i.status === 'open' && reason.success
                  ? {
                      reason: reason.data,
                      by: i.sentBackBy === null ? null : (parentNames.get(i.sentBackBy) ?? null),
                    }
                  : null,
            };
          }),
        };
      })
      .filter((q) => choreRunsOn(q.chore, date) || q.instances.some((i) => i.status !== 'skipped'));
  }
  quests.sort(
    (a, b) =>
      a.chore.dueBy.localeCompare(b.chore.dueBy) || a.chore.title.localeCompare(b.chore.title),
  );

  return {
    date,
    today,
    serverNow: now,
    timezone: settings.timezone,
    centsPerPoint: settings.centsPerPoint,
    currency: settings.currency,
    children: listChildren(db).map((c) => ({
      id: c.id,
      name: c.name,
      avatar: c.avatar ?? FALLBACK_AVATAR,
      colour: c.colour ?? FALLBACK_COLOUR,
    })),
    quests,
    paused: isPausedOn(settings.pause, date),
  };
}
