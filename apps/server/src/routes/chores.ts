import {
  choreInputSchema,
  choreLibraryRefSchema,
  chorePatchSchema,
  idSchema,
  isoDateSchema,
  zonedDateOf,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import {
  createChore,
  deleteChore,
  listChores,
  setSkippedToday,
  updateChore,
  type EditContext,
} from '../repo/chores';
import { NotFoundError, ValidationError } from '../repo/db';
import { dayPlan } from '../repo/day';
import { getSettings } from '../repo/settings';

export interface ChoreRouteOptions {
  db: Db;
  now: () => number;
}

/** The `:id` in the URL as a chore id, or null when it isn't one. */
function choreId(req: FastifyRequest): number | null {
  const { id } = req.params as { id: string };
  const parsed = idSchema.safeParse(/^\d+$/.test(id) ? Number(id) : NaN);
  return parsed.success ? parsed.data : null;
}

/** The phone's quest editor, Week tab and Day tab (spec 003). Parents only. */
export async function choreRoutes(
  app: FastifyInstance,
  { db, now }: ChoreRouteOptions,
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
    throw err;
  };

  app.get('/api/chores', parentOnly, async () => listChores(db));

  /** A day's plan; `today` means today in the family time zone. */
  app.get('/api/day/:date', parentOnly, async (req, reply) => {
    const at = now();
    const param = (req.params as { date: string }).date;
    const date = isoDateSchema.safeParse(
      param === 'today' ? zonedDateOf(at, getSettings(db).timezone) : param,
    );
    if (!date.success) return reply.code(400).send({ error: date.error.issues });
    return dayPlan(db, date.data, at);
  });

  app.post('/api/chores', parentOnly, async (req, reply) => {
    const input = choreInputSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues });
    const ref = choreLibraryRefSchema.safeParse(req.body);
    if (!ref.success) return reply.code(400).send({ error: ref.error.issues });
    try {
      const ctx = context(req);
      const chore = db.transaction((tx) =>
        createChore(tx, { ...input.data, libraryId: ref.data.libraryId }, ctx),
      );
      app.hub.broadcast({ type: 'chore.created', choreId: chore.id });
      return reply.code(201).send(chore);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.patch('/api/chores/:id', parentOnly, async (req, reply) => {
    const id = choreId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const patch = chorePatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
    try {
      const ctx = context(req);
      const chore = db.transaction((tx) => updateChore(tx, id, patch.data, ctx));
      app.hub.broadcast({ type: 'chore.updated', choreId: chore.id });
      return chore;
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.delete('/api/chores/:id', parentOnly, async (req, reply) => {
    const id = choreId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const ctx = context(req);
      db.transaction((tx) => deleteChore(tx, id, ctx));
      app.hub.broadcast({ type: 'chore.deleted', choreId: id });
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  const skipRoute = (skip: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const id = choreId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const ctx = context(req);
      db.transaction((tx) => setSkippedToday(tx, id, skip, ctx));
      app.hub.broadcast({ type: 'day.changed', date: ctx.today });
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  };
  app.post('/api/chores/:id/skip-today', parentOnly, skipRoute(true));
  app.delete('/api/chores/:id/skip-today', parentOnly, skipRoute(false));
}
