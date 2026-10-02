import { devClockRequestSchema, type DevClock } from '@pmp/shared';
import type { FastifyInstance } from 'fastify';
import { devClockTarget, type ServerClock } from '../clock';
import type { Db } from '../db/client';
import { getSettings } from '../repo/settings';

/**
 * Development-only routes, registered only when the server runs with `PMP_DEV_CLOCK=1`
 * (`npm run dev` and `npm run desktop:dev` set it). Never present in a packaged app.
 */
export async function devRoutes(
  app: FastifyInstance,
  { db, clock }: { db: Db; clock: ServerClock },
): Promise<void> {
  const state = (): DevClock => ({ offsetMs: clock.offsetMs, now: clock.now() });

  app.get('/api/dev/clock', async () => state());

  /** Moves the server's clock (the kiosk's `?now=18:40`), or puts it back with `at: null`. */
  app.put('/api/dev/clock', async (req, reply) => {
    const parsed = devClockRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const { at } = parsed.data;
    if (at === null) clock.reset();
    else clock.setTo(devClockTarget(at, clock.realNow(), getSettings(db).timezone));
    app.hub.broadcast({ type: 'clock.changed' });
    return state();
  });
}
