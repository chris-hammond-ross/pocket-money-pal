import {
  currentPause,
  OUTBOX_HEADERS,
  queuedPause,
  schedulePauseSchema,
  zonedDateOf,
  type SchedulePause,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import type { EditContext } from '../repo/chores';
import { ValidationError } from '../repo/db';
import { replacedChange } from '../repo/events';
import { setPause } from '../repo/pause';
import { getSettings } from '../repo/settings';
import { queuedSince, sayReplaced } from '../replay';
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
    // Queued while the PC was off (spec 007): a holiday that should already have started
    // starts today instead, and one that's over is no use now.
    const since = queuedSince(req);
    if (since !== null && pause !== null) {
      const late = queuedPause(pause, currentPause(getSettings(db).pause, ctx.today), ctx.today);
      if ('error' in late) return reply.code(409).send({ error: late.error });
      if (late.moved) reply.header(OUTBOX_HEADERS.moved, late.pause.from);
      pause = late.pause;
    }
    try {
      const { moves, replaced } = db.transaction((tx) => {
        const replaced = since === null ? null : replacedChange(tx, 'pause', since, ctx.parentId);
        return { ...setPause(tx, pause, ctx), replaced };
      });
      sayReplaced(reply, replaced);
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
