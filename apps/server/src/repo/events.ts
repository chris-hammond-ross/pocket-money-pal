import type { ActivityType } from '@pmp/shared';
import { events } from '../db/schema';
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
