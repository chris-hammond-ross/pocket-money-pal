import {
  adjustRequestSchema,
  childInputSchema,
  childPatchSchema,
  idSchema,
  phoneSettingsPatchSchema,
  zonedDateOf,
  type GameMasterList,
  type PlayerCard,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import type { EditContext } from '../repo/chores';
import { NotFoundError } from '../repo/db';
import { recordEvent } from '../repo/events';
import {
  adjustPoints,
  createChild,
  listGameMasters,
  listPlayerCards,
  NameTakenError,
  removeChild,
  setSickToday,
  updateChild,
} from '../repo/players';
import { getSettings, updateSettings } from '../repo/settings';

export interface PlayerRouteOptions {
  db: Db;
  now: () => number;
  /** The payday settings changed (the scheduler re-plans). */
  onScheduleChanged?: () => void;
}

/** The `:id` in the URL as a child id, or null when it isn't one. */
function childId(req: FastifyRequest): number | null {
  const { id } = req.params as { id: string };
  const parsed = idSchema.safeParse(/^\d+$/.test(id) ? Number(id) : NaN);
  return parsed.success ? parsed.data : null;
}

/** The phone's Players tab (spec 003, ADR 0009). Parents only. */
export async function playerRoutes(
  app: FastifyInstance,
  { db, now, onScheduleChanged }: PlayerRouteOptions,
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
    if (err instanceof NameTakenError) return reply.code(409).send({ error: 'name-taken' });
    throw err;
  };

  app.get('/api/children', parentOnly, async (): Promise<PlayerCard[]> =>
    listPlayerCards(db, now()),
  );

  app.get('/api/parents', parentOnly, async (): Promise<GameMasterList> => listGameMasters(db));

  /** "+ New player". */
  app.post('/api/children', parentOnly, async (req, reply) => {
    const input = childInputSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues });
    try {
      const ctx = context(req);
      const child = db.transaction((tx) => createChild(tx, input.data, ctx));
      app.hub.broadcast({ type: 'child.created', childId: child.id });
      return reply.code(201).send(listPlayerCards(db, ctx.now).find((c) => c.id === child.id));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.patch('/api/children/:id', parentOnly, async (req, reply) => {
    const id = childId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const patch = childPatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
    try {
      const ctx = context(req);
      db.transaction((tx) => updateChild(tx, id, patch.data, ctx));
      app.hub.broadcast({ type: 'child.updated', childId: id });
      return listPlayerCards(db, ctx.now).find((c) => c.id === id);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** "Remove player": archived and taken off every quest (ADR 0009). */
  app.delete('/api/children/:id', parentOnly, async (req, reply) => {
    const id = childId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const ctx = context(req);
      const emptied = db.transaction((tx) => removeChild(tx, id, ctx));
      app.hub.broadcast({ type: 'child.removed', childId: id });
      return { questsLeftEmpty: emptied };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** BONUS POINTS: +5, +10 or −5 (any whole number from −1000 to 1000, not 0). */
  app.post('/api/children/:id/adjust', parentOnly, async (req, reply) => {
    const id = childId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = adjustRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const ctx = context(req);
      const adjustment = db.transaction((tx) =>
        adjustPoints(tx, id, body.data.points, body.data.note, ctx),
      );
      app.hub.broadcast({ type: 'child.adjusted', adjustment });
      return reply.code(201).send(adjustment);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** "🤒 Sick day": skip all of the child's waiting quests today; DELETE puts them back. */
  const sickRoute = (sick: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const id = childId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const ctx = context(req);
      db.transaction((tx) => setSickToday(tx, id, sick, ctx));
      app.hub.broadcast({ type: 'child.updated', childId: id });
      return listPlayerCards(db, ctx.now).find((c) => c.id === id);
    } catch (err) {
      return refuse(reply, err);
    }
  };
  app.post('/api/children/:id/sick-today', parentOnly, sickRoute(true));
  app.delete('/api/children/:id/sick-today', parentOnly, sickRoute(false));

  /** LOOT RATE (from now on), the currency, quiet hours and the kiosk volume; payday's day, time and how it starts. */
  app.patch('/api/settings', parentOnly, async (req, reply) => {
    const patch = phoneSettingsPatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
    const ctx = context(req);
    const settings = db.transaction((tx) => {
      const before = getSettings(tx);
      const after = updateSettings(tx, patch.data, ctx.now);
      const changed = (
        ['centsPerPoint', 'currency', 'quietHours', 'volume', 'payday'] as const
      ).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length > 0) {
        recordEvent(tx, {
          type: 'settings.updated',
          at: ctx.now,
          actorId: ctx.parentId,
          data: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])),
        });
      }
      return { after, currencyChanged: before.currency !== after.currency };
    });
    app.hub.broadcast({ type: 'settings.updated' });
    // Every screen shows money in the currency (the kiosk board, jars, payday): refetch it all.
    if (settings.currencyChanged) app.hub.broadcast({ type: 'data.changed' });
    const { paydayDay, paydayTime, paydayAuto } = patch.data;
    if ([paydayDay, paydayTime, paydayAuto].some((v) => v !== undefined)) onScheduleChanged?.();
    return settings.after;
  });
}
