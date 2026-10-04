import { factoryResetRequestSchema, type FactoryResetResult } from '@pmp/shared';
import type { FastifyInstance } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import type { GoalImages } from '../goal-image';
import { DEVICE_COOKIE } from '../repo/devices';
import { factoryReset } from '../repo/reset';

export interface ResetRouteOptions {
  db: Db;
  now: () => number;
  images: GoalImages;
  /** The scheduler re-plans: no payday or surprise is left to run. */
  onScheduleChanged?: () => void;
}

/** "Factory reset" on the phone's Players tab (ADR 0014). Parents only. */
export async function resetRoutes(
  app: FastifyInstance,
  { db, now, images, onScheduleChanged }: ResetRouteOptions,
): Promise<void> {
  app.post('/api/factory-reset', { preHandler: requireParent(db, now) }, async (req, reply) => {
    const body = factoryResetRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });

    const { parent, device } = authOf(req);
    app.log.warn({ parent: parent.name, device: device.name }, 'Factory reset');
    const setupToken = factoryReset(db);
    await images.removeAll();

    // Every pairing is gone with the devices table: this phone's cookie means nothing now.
    void reply.clearCookie(DEVICE_COOKIE, { path: '/' });
    // Setup is needed again: the kiosk goes to its title screen, other phones to /setup.
    app.hub.broadcast({ type: 'data.changed' });
    onScheduleChanged?.();
    const result: FactoryResetResult = { setupToken };
    return result;
  });
}
