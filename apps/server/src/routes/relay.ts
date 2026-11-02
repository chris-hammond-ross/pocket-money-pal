import { relayConnectRequestSchema, licenceHintOf, type RelayInfo } from '@pmp/shared';
import type { FastifyInstance } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import { clearRelayRecord, getRelayRecord, setRelayRecord } from '../relay/record';
import { registerWithRelay, unregisterFromRelay } from '../relay/register';
import { recordEvent } from '../repo/events';

export interface RelayRouteOptions {
  db: Db;
  now: () => number;
}

/** How long `POST /api/relay` waits for the tunnel before answering with the state. */
const CONNECT_WAIT_MS = 5_000;

/**
 * Remote access on the phone (spec 008, ADR 0025): the PC's connection to the relay, a
 * licence key to connect, and Disconnect. Parent-only. The PC keeps the relay's secret,
 * never the key. Every change reaches phones as `relay.changed` (from `app.relay`).
 */
export async function relayRoutes(
  app: FastifyInstance,
  { db, now }: RelayRouteOptions,
): Promise<void> {
  const parentOnly = { preHandler: requireParent(db, now) };

  app.get('/api/relay', parentOnly, async (): Promise<RelayInfo> => app.relay.info());

  /**
   * Registers with the relay and connects. `409 licence-in-use` while another PC has the
   * licence, unless `takeOver`. A registration already stored (the Problem state) is let go
   * first, so a PC re-entering its own key isn't asked about itself.
   */
  app.post('/api/relay', parentOnly, async (req, reply) => {
    const body = relayConnectRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const relayUrl = app.relay.relayUrl;
    if (!relayUrl) return reply.code(424).send({ error: 'relay-unreachable' });
    const { licenceKey, takeOver = false } = body.data;

    const old = getRelayRecord(db);
    if (old) {
      await app.relay.stop();
      if (await unregisterFromRelay(relayUrl, old)) clearRelayRecord(db);
    }

    const result = await registerWithRelay(relayUrl, {
      licenceKey,
      ...(takeOver && { takeOver }),
    });
    if (!result.ok) {
      // Back to how it was (the old registration, if the relay didn't let it go).
      app.relay.reload();
      return reply.code(result.status).send({ error: result.problem });
    }

    const { registration } = result;
    const at = now();
    db.transaction((tx) => {
      setRelayRecord(tx, { ...registration, licenceHint: licenceHintOf(licenceKey) });
      recordEvent(tx, {
        type: 'relay.connected',
        at,
        actorId: authOf(req).parent.id,
        data: { url: registration.url, licenceHint: licenceHintOf(licenceKey), tookOver: takeOver },
      });
    });
    app.relay.reload();
    await app.relay.settled(CONNECT_WAIT_MS);
    return app.relay.info();
  });

  /** "Try again" from the Problem state: connects with the stored registration. */
  app.post('/api/relay/retry', parentOnly, async (_req, reply) => {
    if (!getRelayRecord(db)) return reply.code(409).send({ error: 'not-registered' });
    app.relay.retry();
    await app.relay.settled(CONNECT_WAIT_MS);
    return app.relay.info();
  });

  /**
   * Disconnect: the PC forgets its secret, and tells the relay to free the licence (best
   * effort, after answering: this phone may be on the relay address itself).
   */
  app.delete('/api/relay', parentOnly, async (req, reply) => {
    const old = getRelayRecord(db);
    if (old) {
      const at = now();
      db.transaction((tx) => {
        clearRelayRecord(tx);
        recordEvent(tx, {
          type: 'relay.disconnected',
          at,
          actorId: authOf(req).parent.id,
          data: { url: old.url },
        });
      });
    }
    const off: RelayInfo = {
      ...app.relay.info(),
      state: 'off',
      url: null,
      problem: null,
      lastError: null,
      licenceHint: null,
      since: Date.now(),
    };
    void reply.send(off);
    // Waits for this answer to leave the tunnel before letting go of it.
    if (old) void app.relay.letGo(old);
    return reply;
  });
}
