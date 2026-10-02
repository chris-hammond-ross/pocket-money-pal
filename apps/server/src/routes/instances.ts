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
  ClaimRefusedError,
  listClaimed,
  markDone,
  sendBackInstance,
  undoApprovalBy,
} from '../repo/instances';

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
   * it's on), then every screen hears `instance.claimed` and plays the animation.
   */
  app.post('/api/instances/:id/claim', async (req, reply) => {
    const id = instanceId(req);
    if (id === null) return reply.code(404).send({ error: 'not-found' });
    const body = claimRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });

    const at = now();
    try {
      const claim = db.transaction((tx) =>
        claimInstance(tx, {
          instanceId: id,
          childId: body.data.childId,
          unprompted: body.data.unprompted,
          now: at,
        }),
      );
      app.hub.broadcast({ type: 'instance.claimed', claim });
      app.notifier.claimed(claim.instanceId);
      return claim;
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

  /** The phone's to-check tray. */
  app.get('/api/instances/claimed', parentOnly, async () => listClaimed(db));

  /**
   * Approve one or more claimed chores, in one transaction: all of them or none. Then one
   * `instance.approved` per chore, which the kiosk plays one at a time (spec 002).
   */
  app.post('/api/instances/approve', parentOnly, async (req, reply) => {
    const body = approveRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { parent } = authOf(req);
    const at = now();
    try {
      const approvals = db.transaction((tx) =>
        body.data.items.map(({ id, ...chips }) =>
          approveClaim(tx, { instanceId: id, chips, parentId: parent.id, now: at }),
        ),
      );
      celebrate(approvals);
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
      const instance = db.transaction((tx) =>
        sendBackInstance(tx, {
          instanceId: id,
          reason: body.data.reason,
          parentId: authOf(req).parent.id,
          now: now(),
        }),
      );
      app.hub.broadcast({
        type: 'instance.sent_back',
        instanceId: instance.id,
        childId: instance.childId,
      });
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
      const instance = db.transaction((tx) =>
        undoApprovalBy(tx, { instanceId: id, parentId: authOf(req).parent.id, now: now() }),
      );
      app.hub.broadcast({
        type: 'instance.undone',
        instanceId: instance.id,
        childId: instance.childId,
      });
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });
}
