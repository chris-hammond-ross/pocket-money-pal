import {
  approveRequestSchema,
  claimRequestSchema,
  idSchema,
  sendBackRequestSchema,
  type Approval,
  type ClaimProblem,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import { ConflictError, NotFoundError } from '../repo/db';
import {
  approveClaim,
  claimInstance,
  getInstance,
  ClaimRefusedError,
  listClaimed,
  markDone,
  sendBackInstance,
  undoApprovalBy,
} from '../repo/instances';
import { refreshStreaksFor, type StreakUpdate } from '../repo/streaks';
import { teamSiblings } from '../repo/surprises';

export interface InstanceRouteOptions {
  db: Db;
  now: () => number;
}

/** The `:id` in the URL as an instance id, or null when it isn't one. */
function instanceId(req: FastifyRequest): number | null {
  const { id } = req.params as { id: string };
  const parsed = idSchema.safeParse(/^\d+$/.test(id) ? Number(id) : NaN);
  return parsed.success ? parsed.data : null;
}

/** How each refused claim answers. */
const CLAIM_STATUS: Record<ClaimProblem, number> = {
  'wrong-child': 403,
  'not-open': 409,
  'not-today': 409,
};

export async function instanceRoutes(
  app: FastifyInstance,
  { db, now }: InstanceRouteOptions,
): Promise<void> {
  /**
   * A child claims a quest (spec 001). Scored on the server's clock (the dev clock when
   * it's on), then every screen hears `instance.claimed` and plays the animation. A team
   * surprise needs one claim (spec 006): everyone's quest is claimed with the same time.
   */
  app.post('/api/instances/:id/claim', async (req, reply) => {
    const id = instanceId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = claimRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });

    const at = now();
    try {
      const claims = db.transaction((tx) => {
        const claim = claimInstance(tx, {
          instanceId: id,
          childId: body.data.childId,
          unprompted: body.data.unprompted,
          now: at,
        });
        const team = teamSiblings(tx, id, ['open']).map((siblingId) =>
          claimInstance(tx, {
            instanceId: siblingId,
            childId: getInstance(tx, siblingId).childId,
            unprompted: body.data.unprompted,
            now: at,
          }),
        );
        return [claim, ...team];
      });
      for (const claim of claims) app.hub.broadcast({ type: 'instance.claimed', claim });
      app.notifier.claimed(...claims.map((c) => c.instanceId));
      return claims[0];
    } catch (err) {
      if (err instanceof ClaimRefusedError) {
        return reply.code(CLAIM_STATUS[err.problem]).send({ error: err.problem });
      }
      if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not-found' });
      throw err;
    }
  });

  const parentOnly = { preHandler: requireParent(db, now) };

  /** 404 / 409 for the repo's errors; anything else is a real failure. */
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not-found' });
    if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict' });
    throw err;
  };

  const celebrate = (approvals: Approval[]) => {
    for (const approval of approvals) app.hub.broadcast({ type: 'instance.approved', approval });
  };

  /** A chore from a past day changed: its day's streak result may have too (spec 005). */
  const streaksChanged = (updates: StreakUpdate[]) => {
    for (const { childId, last } of updates) {
      app.hub.broadcast({ type: 'streak.updated', childId, last });
    }
  };

  /** The phone's to-check tray. */
  app.get('/api/instances/claimed', parentOnly, async () => listClaimed(db));

  /**
   * Approve one or more claimed chores, in one transaction: all of them or none. Then one
   * `instance.approved` per chore, which the kiosk plays one at a time (spec 002). A team
   * surprise's claimed quests are approved together, with the same chips (spec 006).
   */
  app.post('/api/instances/approve', parentOnly, async (req, reply) => {
    const body = approveRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { parent } = authOf(req);
    const at = now();
    try {
      const { approvals, streaks } = db.transaction((tx) => {
        const items = [...body.data.items];
        const asked = new Set(items.map((i) => i.id));
        for (const item of body.data.items) {
          for (const id of teamSiblings(tx, item.id, ['claimed'])) {
            if (asked.has(id)) continue;
            asked.add(id);
            items.push({ ...item, id });
          }
        }
        const approvals = items.map(({ id, ...chips }) =>
          approveClaim(tx, { instanceId: id, chips, parentId: parent.id, now: at }),
        );
        const ids = approvals.map((a) => a.instanceId);
        return { approvals, streaks: refreshStreaksFor(tx, ids, at) };
      });
      celebrate(approvals);
      streaksChanged(streaks);
      return { approvals };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.post('/api/instances/:id/send-back', parentOnly, async (req, reply) => {
    const id = instanceId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = sendBackRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const at = now();
      // A team surprise goes back for all of them (spec 006).
      const { instances, streaks } = db.transaction((tx) => {
        const ids = [id, ...teamSiblings(tx, id, ['claimed'])];
        const instances = ids.map((instanceId) =>
          sendBackInstance(tx, {
            instanceId,
            reason: body.data.reason,
            parentId: authOf(req).parent.id,
            now: at,
          }),
        );
        return { instances, streaks: refreshStreaksFor(tx, ids, at) };
      });
      for (const instance of instances) {
        app.hub.broadcast({
          type: 'instance.sent_back',
          instanceId: instance.id,
          childId: instance.childId,
        });
      }
      streaksChanged(streaks);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** A parent saw it done: claim it for the child and approve it at once. */
  app.post('/api/instances/:id/mark-done', parentOnly, async (req, reply) => {
    const id = instanceId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const approval = db.transaction((tx) =>
        markDone(tx, { instanceId: id, parentId: authOf(req).parent.id, now: now() }),
      );
      celebrate([approval]);
      return { approvals: [approval] };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Undo an approval: a reversing ledger row, and it waits in the tray again. */
  app.post('/api/instances/:id/undo-approval', parentOnly, async (req, reply) => {
    const id = instanceId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    try {
      const at = now();
      const { instance, streaks } = db.transaction((tx) => {
        const instance = undoApprovalBy(tx, {
          instanceId: id,
          parentId: authOf(req).parent.id,
          now: at,
        });
        return { instance, streaks: refreshStreaksFor(tx, [id], at) };
      });
      app.hub.broadcast({
        type: 'instance.undone',
        instanceId: instance.id,
        childId: instance.childId,
      });
      streaksChanged(streaks);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });
}
