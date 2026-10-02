import {
  CHORE_LIBRARY,
  setupDraftSchema,
  setupRequestSchema,
  type SetupKioskInfo,
  type SetupResult,
  type SetupStatus,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { isOnPc, lanAddresses } from '../net';
import { ConflictError } from '../repo/db';
import { setDeviceCookie } from '../auth/devices';
import { deviceNameFrom } from '../repo/devices';
import {
  completeSetup,
  getDraft,
  getSetupToken,
  isSetupNeeded,
  isSetupToken,
  saveDraft,
} from '../repo/setup';

/** Header a phone sends the setup token in (it arrives in the kiosk QR code's URL). */
export const SETUP_TOKEN_HEADER = 'x-setup-token';

export interface SetupRouteOptions {
  db: Db;
  now: () => number;
  publicUrl: string | null;
}

export async function setupRoutes(
  app: FastifyInstance,
  { db, now, publicUrl }: SetupRouteOptions,
): Promise<void> {
  /**
   * Refuses the request (and returns false) unless setup is still needed and the caller
   * is on the family PC or holds the setup token (ADR 0005).
   */
  const allowSetup = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isSetupNeeded(db)) {
      void reply.code(409).send({ error: 'setup-done' });
      return false;
    }
    const token = req.headers[SETUP_TOKEN_HEADER];
    if (isOnPc(req.ip) || isSetupToken(db, typeof token === 'string' ? token : undefined)) {
      return true;
    }
    void reply.code(403).send({ error: 'setup-token' });
    return false;
  };

  app.get('/api/setup/status', async (req): Promise<SetupStatus> => ({
    needed: isSetupNeeded(db),
    onPc: isOnPc(req.ip),
  }));

  // The kiosk's title screen: only the PC may see the token it puts in the QR code.
  app.get('/api/setup/kiosk', async (req, reply) => {
    if (!isOnPc(req.ip)) return reply.code(403).send({ error: 'pc-only' });
    if (!isSetupNeeded(db)) return reply.code(409).send({ error: 'setup-done' });
    const info: SetupKioskInfo = { token: getSetupToken(db), hosts: lanAddresses(), publicUrl };
    return info;
  });

  app.get('/api/setup/draft', async (req, reply) => {
    if (!allowSetup(req, reply)) return reply;
    return { draft: getDraft(db) };
  });

  app.put('/api/setup/draft', async (req, reply) => {
    const parsed = setupDraftSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    if (!allowSetup(req, reply)) return reply;
    saveDraft(db, parsed.data, now());
    return reply.code(204).send();
  });

  app.post('/api/setup', async (req, reply) => {
    const parsed = setupRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    if (!allowSetup(req, reply)) return reply;

    const request = parsed.data;
    const onPc = isOnPc(req.ip);
    let result;
    try {
      result = completeSetup(db, {
        request,
        now: now(),
        pairAs: onPc ? null : { deviceName: deviceNameFrom(req.headers['user-agent']) },
      });
    } catch (err) {
      if (err instanceof ConflictError) return reply.code(409).send({ error: 'setup-done' });
      throw err;
    }

    if (result.deviceToken) setDeviceCookie(req, reply, result.deviceToken);
    app.hub.broadcast({ type: 'setup.completed' });
    if (result.deviceToken) app.hub.broadcast({ type: 'devices.changed' });
    app.hub.broadcast({ type: 'settings.updated' });
    app.hub.broadcast({ type: 'day.changed', date: result.day.date });

    const body: SetupResult = { parentId: result.parentId, paired: result.deviceToken !== null };
    return reply.code(201).send(body);
  });

  app.get('/api/chore-library', async () => CHORE_LIBRARY);
}
