import { pushSubscriptionSchema, pushTestRequestSchema, type AccessInfo } from '@pmp/shared';
import type { FastifyInstance } from 'fastify';
import { authOf, requireParent } from '../auth/devices';
import type { Db } from '../db/client';
import { setPushSubscription, type ClaimNotifier } from '../push';
import type { SecureUrl } from '../secure-url';

export interface PushRouteOptions {
  db: Db;
  now: () => number;
  notifier: ClaimNotifier;
  vapidPublicKey: string;
  secureUrl: SecureUrl;
}

/**
 * HTTPS and push (ADR 0002, ADR 0009): the server's HTTPS address, the VAPID public key,
 * and each phone's push subscription. Subscriptions only ever come from HTTPS pages, since
 * browsers offer push to secure origins only.
 */
export async function pushRoutes(
  app: FastifyInstance,
  { db, now, notifier, vapidPublicKey, secureUrl }: PushRouteOptions,
): Promise<void> {
  const parentOnly = { preHandler: requireParent(db, now) };

  /** Where "Switch to secure app" goes: set by PMP_SECURE_URL, or learned. */
  app.get('/api/access', async (): Promise<AccessInfo> => ({ secureUrl: secureUrl.get() }));

  app.get('/api/push/key', parentOnly, async () => ({ publicKey: vapidPublicKey }));

  /** Stores (or replaces) this phone's subscription. */
  app.post('/api/devices/me/push-subscription', parentOnly, async (req, reply) => {
    const sub = pushSubscriptionSchema.safeParse(req.body);
    if (!sub.success) return reply.code(400).send({ error: sub.error.issues });
    setPushSubscription(db, authOf(req).device.id, sub.data);
    return reply.code(204).send();
  });

  app.delete('/api/devices/me/push-subscription', parentOnly, async (req, reply) => {
    setPushSubscription(db, authOf(req).device.id, null);
    return reply.code(204).send();
  });

  /**
   * A test notification to this phone, now or after `delaySeconds` (lock the phone and
   * wait: ADR 0002's Doze check). 409 when this phone has no subscription.
   */
  app.post('/api/devices/me/push-test', parentOnly, async (req, reply) => {
    const body = pushTestRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { id } = authOf(req).device;
    const { delaySeconds } = body.data;
    if (delaySeconds === 0) {
      const sent = await notifier.test(id);
      return sent ? reply.code(204).send() : reply.code(409).send({ error: 'not-subscribed' });
    }
    if (!notifier.hasSubscription(id)) {
      return reply.code(409).send({ error: 'not-subscribed' });
    }
    setTimeout(() => {
      notifier.test(id).catch((err: unknown) => app.log.warn({ err }, 'Test push failed'));
    }, delaySeconds * 1000).unref();
    return reply.code(202).send({ inSeconds: delaySeconds });
  });
}
