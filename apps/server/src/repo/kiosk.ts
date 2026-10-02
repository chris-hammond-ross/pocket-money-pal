import {
  choreStage,
  choreWindow,
  claimPoints,
  levelProgress,
  maxPointsNow,
  orderKioskQuests,
  startOfZonedDay,
  zonedDateOf,
  type KioskChild,
  type KioskQuest,
  sendBackReasonSchema,
  type KioskToday,
} from '@pmp/shared';
import { and, eq, ne } from 'drizzle-orm';
import { choreInstances, chores } from '../db/schema';
import type { DbOrTx } from './db';
import { lifetimeXp, pointsToday } from './ledger';
import { childMoneyView } from './money';
import { paydayInfo } from './payday';
import { getSettings } from './settings';
import { FALLBACK_AVATAR, FALLBACK_COLOUR, listChildren, listParents } from './users';

/**
 * Everything the kiosk board shows for today (spec 001), worked out at `now` with the
 * `@pmp/shared` rules. The kiosk ticks on from `serverNow` with the same rules.
 */
export function kioskToday(db: DbOrTx, now: number, opts: { devClock: boolean }): KioskToday {
  const { timezone, currency, centsPerPoint } = getSettings(db);
  const date = zonedDateOf(now, timezone);
  const rows = db
    .select({
      instance: choreInstances,
      title: chores.title,
      icon: chores.icon,
      together: chores.together,
    })
    .from(choreInstances)
    .innerJoin(chores, eq(chores.id, choreInstances.choreId))
    .where(and(eq(choreInstances.date, date), ne(choreInstances.status, 'skipped')))
    .all();
  const xp = lifetimeXp(db);
  const today = pointsToday(db, now, timezone);
  const parentNames = new Map(listParents(db).map((p) => [p.id, p.name]));

  const questsByChild = new Map<number, KioskQuest[]>();
  for (const { instance: i, title, icon, together } of rows) {
    if (i.status === 'skipped') continue; // filtered in SQL; this narrows the type
    const window = choreWindow(date, i, timezone);
    const open = i.status === 'open';
    // Only a known reason makes a note (the column may have been edited by hand).
    const reason = sendBackReasonSchema.safeParse(i.sendBackReason);
    const quest: KioskQuest = {
      id: i.id,
      choreId: i.choreId,
      title,
      icon,
      shared: together,
      status: i.status,
      times: { bonusBefore: i.bonusBefore, dueBy: i.dueBy, lateAfter: i.lateAfter },
      window,
      loot: {
        basePoints: i.basePoints,
        earlyBonus: i.earlyBonus,
        unpromptedBonus: i.unpromptedBonus,
        latePenalty: i.latePenalty,
      },
      stage: open ? choreStage(window, now) : null,
      maxPoints: open ? maxPointsNow(i, window, now) : null,
      claimedAt: i.claimedAt,
      pendingPoints:
        i.status === 'claimed'
          ? claimPoints(i, window, i.claimedAt ?? now, i.unprompted ?? false).total
          : null,
      approvedAt: i.approvedAt,
      awardedPoints: i.status === 'approved' ? i.awardedTotal : null,
      sentBack:
        open && reason.success
          ? {
              reason: reason.data,
              by: i.sentBackBy === null ? null : (parentNames.get(i.sentBackBy) ?? null),
            }
          : null,
    };
    questsByChild.set(i.childId, [...(questsByChild.get(i.childId) ?? []), quest]);
  }

  const children = listChildren(db).map((child): KioskChild => {
    const quests = orderKioskQuests(questsByChild.get(child.id) ?? [], now);
    const childXp = xp.get(child.id) ?? 0;
    return {
      id: child.id,
      name: child.name,
      avatar: child.avatar ?? FALLBACK_AVATAR,
      colour: child.colour ?? FALLBACK_COLOUR,
      xp: childXp,
      level: levelProgress(childXp),
      pointsToday: today.get(child.id) ?? 0,
      streakDays: 0,
      ...childMoneyView(db, child.id, now),
      nextUpId: quests[0]?.status === 'open' ? quests[0].id : null,
      quests,
    };
  });

  return {
    serverNow: now,
    date,
    timezone,
    dayStart: startOfZonedDay(date, timezone),
    devClock: opts.devClock,
    currency,
    centsPerPoint,
    payday: paydayInfo(db, now),
    children,
  };
}
