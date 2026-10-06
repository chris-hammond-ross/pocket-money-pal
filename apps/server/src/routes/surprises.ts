import {
  idSchema,
  surpriseGrabSchema,
  surpriseSendSchema,
  surpriseTaskInputSchema,
  surpriseTaskPatchSchema,
  zonedDateOf,
  type GrabProblem,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import type { EditContext } from '../repo/chores';
import { ConflictError, NotFoundError, ValidationError } from '../repo/db';
import { getSettings } from '../repo/settings';
import {
  cancelSurprise,
  createSurpriseTask,
  deleteSurpriseTask,
  grabSurprise,
  GrabRefusedError,
  listSurpriseTasks,
  sendSurprise,
  todaySurprises,
  updateScheduledSurprise,
  updateSurpriseTask,
  type SurpriseMove,
} from '../repo/surprises';
import type { WsHub } from '../ws';

export interface SurpriseRouteOptions {
  db: Db;
  now: () => number;
  /** A run was sent, changed or ended: the scheduler re-plans its next wake. */
  onScheduleChanged?: () => void;
}

/** Tells every screen about each move, in order. */
export function broadcastSurprises(hub: WsHub, moves: readonly SurpriseMove[]): void {
  for (const move of moves) hub.broadcast(move);
}

/** How each refused grab answers (spec 006, "The claim race"). */
const GRAB_STATUS: Record<GrabProblem, number> = {
  'already-grabbed': 409,
  expired: 409,
  'not-live': 409,
  'not-eligible': 403,
};

function idParam(req: FastifyRequest): number | null {
  const { id } = req.params as { id: string };
  const parsed = idSchema.safeParse(/^\d+$/.test(id) ? Number(id) : NaN);
  return parsed.success ? parsed.data : null;
}

/** The surprise panel on the phone, and the grab on the kiosk (spec 006). */
export async function surpriseRoutes(
  app: FastifyInstance,
  { db, now, onScheduleChanged }: SurpriseRouteOptions,
): Promise<void> {
  const parentOnly = { preHandler: requireParent(db, now) };

  const context = (req: FastifyRequest): EditContext => {
    const at = now();
    return {
      now: at,
      today: zonedDateOf(at, getSettings(db).timezone),
      parentId: authOf(req).parent.id,
    };
  };

  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not-found' });
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.issues });
    if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict' });
    throw err;
  };

  const after = (moves: readonly SurpriseMove[]) => {
    broadcastSurprises(app.hub, moves);
    onScheduleChanged?.();
  };

  // The saved list

  app.get('/api/surprise-tasks', parentOnly, async () => listSurpriseTasks(db));

  app.post('/api/surprise-tasks', parentOnly, async (req, reply) => {
    const input = surpriseTaskInputSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues });
    try {
      const ctx = context(req);
      const task = db.transaction((tx) => createSurpriseTask(tx, input.data, ctx));
      app.hub.broadcast({ type: 'surprise_task.created', taskId: task.id });
      return reply.code(201).send(task);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.patch('/api/surprise-tasks/:id', parentOnly, async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const patch = surpriseTaskPatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
    try {
      const ctx = context(req);
      const task = db.transaction((tx) => updateSurpriseTask(tx, id, patch.data, ctx));
      app.hub.broadcast({ type: 'surprise_task.updated', taskId: id });
      return task;
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.delete('/api/surprise-tasks/:id', parentOnly, async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const ctx = context(req);
      db.transaction((tx) => deleteSurpriseTask(tx, id, ctx));
      app.hub.broadcast({ type: 'surprise_task.deleted', taskId: id });
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // Runs

  app.get('/api/surprises/today', parentOnly, async () => todaySurprises(db, now()));

  /** Send right away, or schedule for a set time today. */
  app.post('/api/surprises', parentOnly, async (req, reply) => {
    const input = surpriseSendSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues });
    try {
      const ctx = context(req);
      const { run, moves } = db.transaction((tx) => sendSurprise(tx, input.data, ctx));
      if (input.data.save && run.taskId !== null) {
        app.hub.broadcast({ type: 'surprise_task.created', taskId: run.taskId });
      }
      after(moves);
      return reply.code(201).send(run);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Change a scheduled one: the panel's whole state again. */
  app.patch('/api/surprises/:id', parentOnly, async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const input = surpriseSendSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues });
    try {
      const ctx = context(req);
      const { run, moves } = db.transaction((tx) =>
        updateScheduledSurprise(tx, id, input.data, ctx),
      );
      if (input.data.save && run.taskId !== null) {
        app.hub.broadcast({ type: 'surprise_task.created', taskId: run.taskId });
      }
      after(moves);
      return run;
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Take back a scheduled, queued, live or grabbed one (nothing approved yet). */
  app.delete('/api/surprises/:id', parentOnly, async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const ctx = context(req);
      const moves = db.transaction((tx) => cancelSurprise(tx, id, ctx));
      after(moves);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /**
   * The kiosk's "I'll do it!" or "We'll all do it!": the claim race, settled in one
   * transaction on the server's clock. The losing kiosk hears `surprise.grabbed` and closes.
   */
  app.post('/api/surprises/:id/grab', async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = surpriseGrabSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const { grabbed, moves } = db.transaction((tx) => grabSurprise(tx, id, body.data, now()));
      after([grabbed, ...moves]);
      return grabbed;
    } catch (err) {
      if (err instanceof GrabRefusedError) {
        return reply.code(GRAB_STATUS[err.problem]).send({ error: err.problem });
      }
      if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not-found' });
      throw err;
    }
  });
}
