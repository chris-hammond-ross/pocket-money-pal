import { createReadStream } from 'node:fs';
import {
  envelopeCreateSchema,
  formatMoney,
  goalCreateSchema,
  goalMoveSchema,
  goalPatchSchema,
  idSchema,
  PAYDAY_PUSH_URL,
  smashPushText,
  spendSchema,
  type MoneyOverview,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, deviceOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import type { GoalImages } from '../goal-image';
import { NotFoundError } from '../repo/db';
import {
  buyGoal,
  createGoal,
  deleteGoal,
  familyMoney,
  getActiveChild,
  MoneyConflictError,
  moveGoal,
  openEnvelope,
  sendEnvelope,
  setGoalImage,
  smashGoal,
  spendMoney,
  unsmashGoal,
  updateGoal,
  type Actor,
  type Goal,
} from '../repo/money';
import { paydayInfo, paydaySummary, savingsBook, startPaydayNow } from '../repo/payday';
import { getSettings } from '../repo/settings';
import { goals } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface MoneyRouteOptions {
  db: Db;
  now: () => number;
  images: GoalImages;
}

/** The `:id` in the URL as an id, or null when it isn't one. */
function paramId(req: FastifyRequest): number | null {
  const { id } = req.params as { id: string };
  const parsed = idSchema.safeParse(/^\d+$/.test(id) ? Number(id) : NaN);
  return parsed.success ? parsed.data : null;
}

/**
 * Money and jars (spec 004, ADR 0010). Kiosk calls (make, move, delete, smash, open an
 * envelope, the savings book and the show) need no token, like claims; the server still
 * checks each one. Phone calls need a paired phone (`requireParent`, ADR 0008).
 */
export async function moneyRoutes(
  app: FastifyInstance,
  { db, now, images }: MoneyRouteOptions,
): Promise<void> {
  const parentOnly = { preHandler: requireParent(db, now) };

  /** A paired phone's request counts as its parent; anything else is the child. */
  const actorOf = (req: FastifyRequest): Actor => {
    const found = deviceOf(db, req);
    return found ? { kind: 'parent', parentId: found.parent.id } : { kind: 'child' };
  };

  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not-found' });
    if (err instanceof MoneyConflictError) return reply.code(409).send({ error: err.code });
    throw err;
  };

  const goalEvent = (
    type: 'goal.created' | 'goal.updated' | 'goal.deleted' | 'goal.smashed' | 'goal.bought',
    goal: Goal,
    byChild: boolean,
  ) => app.hub.broadcast({ type, goalId: goal.id, childId: goal.childId, byChild });

  /**
   * Fetches a jar's picture in the background (ADR 0010). The jar is already saved; when
   * the picture arrives it's stored and every screen refreshes. Failures are only logged.
   */
  const fetchPicture = (goal: Goal) => {
    const url = goal.shopUrl;
    if (!url) return;
    void images
      .fetchAndSave(goal.id, url)
      .then(async (name) => {
        if (!name) return;
        const current = db.select().from(goals).where(eq(goals.id, goal.id)).get();
        if (!current || current.shopUrl !== url) {
          await images.remove(name); // the link changed meanwhile
          return;
        }
        setGoalImage(db, goal.id, name);
        await images.remove(current.imagePath);
        goalEvent('goal.updated', current, false);
      })
      .catch((err: unknown) => app.log.info({ err, goalId: goal.id }, 'No picture for jar'));
  };

  // -------------------------------------------------------------------------
  // Reading

  /** The phone's Payday tab: payday, and every child's money, jars and envelopes. */
  app.get('/api/money', parentOnly, async (): Promise<MoneyOverview> => {
    const at = now();
    const { timezone, currency, centsPerPoint } = getSettings(db);
    return {
      serverNow: at,
      timezone,
      currency,
      centsPerPoint,
      payday: paydayInfo(db, at),
      children: familyMoney(db, at),
    };
  });

  /** The savings book (kiosk and phone). */
  app.get('/api/children/:id/savings', async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      return savingsBook(db, id);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** The latest payday's summary, for the show. */
  app.get('/api/paydays/latest', async (_req, reply) => {
    const summary = paydaySummary(db);
    return summary ?? reply.code(404).send({ error: 'no-payday' });
  });

  /** A jar's picture, kept on the PC (ADR 0010). */
  app.get('/api/goals/:id/image', async (req, reply) => {
    const id = paramId(req);
    const goal = id === null ? null : db.select().from(goals).where(eq(goals.id, id)).get();
    const file = goal?.imagePath ? images.fileOf(goal.imagePath) : null;
    if (!file) return reply.code(404).send({ error: 'not-found' });
    return reply
      .type(file.type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(file.path));
  });

  // -------------------------------------------------------------------------
  // Jars

  /** Make a jar: from the kiosk the price waits to be checked; from a phone it's checked. */
  app.post('/api/goals', async (req, reply) => {
    const body = goalCreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const actor = actorOf(req);
    try {
      const goal = db.transaction((tx) => createGoal(tx, body.data, actor, now()));
      goalEvent('goal.created', goal, actor.kind === 'child');
      fetchPicture(goal);
      return reply.code(201).send({ id: goal.id });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** The phone's jar sheet: name, picture, price, link. Marks the price checked. */
  app.patch('/api/goals/:id', parentOnly, async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = goalPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const before = db.select().from(goals).where(eq(goals.id, id)).get();
      const { goal, linkChanged } = db.transaction((tx) =>
        updateGoal(tx, id, body.data, authOf(req).parent.id, now()),
      );
      goalEvent('goal.updated', goal, false);
      if (linkChanged) {
        await images.remove(before?.imagePath ?? null);
        fetchPicture(goal);
      }
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Delete a jar (kiosk or phone): its money goes back to "to sort". */
  app.delete('/api/goals/:id', async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const actor = actorOf(req);
    try {
      const { goal } = db.transaction((tx) => deleteGoal(tx, id, actor, now()));
      goalEvent('goal.deleted', goal, actor.kind === 'child');
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Kiosk: one move per hold or pop-up action. Positive pours in, negative takes out. */
  app.post('/api/goals/:id/move', async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = goalMoveSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const move = db.transaction((tx) => moveGoal(tx, id, body.data.cents, now()));
      app.hub.broadcast({ type: 'goal.moved', move });
      return move;
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Kiosk: smash a full jar. The phones get a push (ADR 0010). */
  app.post('/api/goals/:id/smash', async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const goal = db.transaction((tx) => smashGoal(tx, id, now()));
      goalEvent('goal.smashed', goal, true);
      const child = getActiveChild(db, goal.childId);
      const amount = formatMoney(goal.targetCents, getSettings(db).currency);
      app.notifier.notifyAll({
        ...smashPushText(child.name, goal.name, amount),
        url: PAYDAY_PUSH_URL,
      });
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Phone: "↩ Put it back". */
  app.delete('/api/goals/:id/smash', parentOnly, async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const goal = db.transaction((tx) => unsmashGoal(tx, id, authOf(req).parent.id, now()));
      goalEvent('goal.updated', goal, false);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Phone: "✓ Bought it". The jar's money is spent and the jar is finished. */
  app.post('/api/goals/:id/bought', parentOnly, async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const { goal } = db.transaction((tx) => buyGoal(tx, id, authOf(req).parent.id, now()));
      goalEvent('goal.bought', goal, false);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Money in and out

  /** Phone: a gift, waiting on the kiosk as an envelope. */
  app.post('/api/children/:id/envelopes', parentOnly, async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = envelopeCreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const envelope = db.transaction((tx) =>
        sendEnvelope(tx, id, body.data, authOf(req).parent, now()),
      );
      app.hub.broadcast({ type: 'envelope.created', envelopeId: envelope.id, childId: id });
      return reply.code(201).send({ id: envelope.id });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Kiosk: open an envelope. Its money goes to "to sort". */
  app.post('/api/envelopes/:id/open', async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const envelope = db.transaction((tx) => openEnvelope(tx, id, now()));
      app.hub.broadcast({
        type: 'envelope.opened',
        envelopeId: envelope.id,
        childId: envelope.childId,
      });
      return { id: envelope.id, cents: envelope.cents };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Phone: money out, from "to sort" or a jar. */
  app.post('/api/children/:id/spend', parentOnly, async (req, reply) => {
    const id = paramId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = spendSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      db.transaction((tx) => spendMoney(tx, id, body.data, authOf(req).parent.id, now()));
      app.hub.broadcast({ type: 'money.spent', childId: id, cents: body.data.cents });
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Payday

  /** Phone: "▶ Start payday now". */
  app.post('/api/paydays', parentOnly, async (req, reply) => {
    try {
      const result = db.transaction((tx) => startPaydayNow(tx, authOf(req).parent.id, now()));
      app.hub.broadcast({ type: 'payday.done', paydayId: result.paydayId });
      return reply.code(201).send(result);
    } catch (err) {
      return refuse(reply, err);
    }
  });
}
