import type { ActivityType, ReplacedChange } from '@pmp/shared';
import { and, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import { events, users } from '../db/schema';
import type { DbOrTx } from './db';

export interface EventInput {
  type: ActivityType;
  at: number;
  /** The parent (or child) who acted; omit for the system. */
  actorId?: number | null;
  childId?: number | null;
  choreId?: number | null;
  instanceId?: number | null;
  data?: Record<string, unknown> | null;
}

/** Writes one row to the audit trail. Call it inside the action's transaction. */
export function recordEvent(db: DbOrTx, event: EventInput): number {
  const row = db
    .insert(events)
    .values({
      type: event.type,
      at: event.at,
      actorId: event.actorId ?? null,
      childId: event.childId ?? null,
      choreId: event.choreId ?? null,
      instanceId: event.instanceId ?? null,
      data: event.data ?? null,
    })
    .returning({ id: events.id })
    .get();
  return row.id;
}

/** Changes to a quest's plan, or to the holiday, that a queued change can replace. */
const PLAN_CHANGES = {
  chore: ['chore.updated', 'chore.day_toggled', 'chore.deleted'],
  pause: ['schedule.paused', 'schedule.resumed'],
} satisfies Record<string, ActivityType[]>;

/**
 * The latest change to a quest (or to the holiday, with `choreId` null) made after `since`
 * by a parent other than `parentId`: what a change queued on a phone would replace (spec
 * 007). Null when there's none.
 */
export function replacedChange(
  db: DbOrTx,
  target: { choreId: number } | 'pause',
  since: number,
  parentId: number,
): ReplacedChange | null {
  const row = db
    .select({ at: events.at, by: users.name })
    .from(events)
    .innerJoin(users, eq(users.id, events.actorId))
    .where(
      and(
        gt(events.at, since),
        isNotNull(events.actorId),
        ne(events.actorId, parentId),
        target === 'pause'
          ? inArray(events.type, PLAN_CHANGES.pause)
          : and(eq(events.choreId, target.choreId), inArray(events.type, PLAN_CHANGES.chore)),
      ),
    )
    .orderBy(desc(events.at), desc(events.id))
    .limit(1)
    .get();
  return row ?? null;
}
