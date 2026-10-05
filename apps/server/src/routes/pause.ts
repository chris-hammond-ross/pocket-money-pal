import { schedulePauseSchema, zonedDateOf, type SchedulePause } from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import type { EditContext } from '../repo/chores';
import { ValidationError } from '../repo/db';
import { setPause } from '../repo/pause';
import { getSettings } from '../repo/settings';
import { broadcastSurprises } from './surprises';

export interface PauseRouteOptions {
  db: Db;
  now: () => number;
  /** Payday's next slot moved, or surprises were taken back: the scheduler re-plans. */
  onScheduleChanged?: () => void;
}

/** "🌴 Pause quests" on the Week tab (ADR 0016). Parents only. */
export async function pauseRoutes(
  app: FastifyInstance,
  { db, now, onScheduleChanged }: PauseRouteOptions,
): Promise<void> {
  const parentOnly = { preHandler: requireParent(db, now) };

  const apply = (req: FastifyRequest, reply: FastifyReply, pause: SchedulePause | null) => {
    const at = now();
    const ctx: EditContext = {
      now: at,
      today: zonedDateOf(at, getSettings(db).timezone),
      parentId: authOf(req).parent.id,
    };
    try {
      const { moves } = db.transaction((tx) => setPause(tx, pause, ctx));
      app.hub.broadcast({ type: 'settings.updated' });
      app.hub.broadcast({ type: 'day.changed', date: ctx.today });
      broadcastSurprises(app.hub, moves);
      onScheduleChanged?.();
      return getSettings(db);
    } catch (err) {
      if (err instanceof ValidationError) return reply.code(400).send({ error: err.issues });
      throw err;
    }
  };

  /** Pause from a date, to a date or until resumed; or change the end of the one going on. */
  app.put('/api/pause', parentOnly, async (req, reply) => {
    const input = schedulePauseSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues });
    return apply(req, reply, input.data);
  });

  /** "Resume right now" (or call off one still to come): today's quests come back. */
  app.delete('/api/pause', parentOnly, async (req, reply) => apply(req, reply, null));
}
