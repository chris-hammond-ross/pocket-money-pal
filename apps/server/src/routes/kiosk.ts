import type { FastifyInstance } from 'fastify';
import type { ServerClock } from '../clock';
import type { Db } from '../db/client';
import { kioskToday } from '../repo/kiosk';

export interface KioskRouteOptions {
  db: Db;
  now: () => number;
  devClock: ServerClock | null;
}

export async function kioskRoutes(
  app: FastifyInstance,
  { db, now, devClock }: KioskRouteOptions,
): Promise<void> {
  /** The kiosk board (spec 001). Read-only; claiming comes in 2.5. */
  app.get('/api/kiosk/today', async () =>
    kioskToday(db, now(), { devClock: (devClock?.offsetMs ?? 0) !== 0 }),
  );
}
