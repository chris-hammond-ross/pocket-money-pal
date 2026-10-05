import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { WS_PATH, pingRequestSchema, type Health } from '@pmp/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serverVersion } from './build-info';
import type { ServerClock } from './clock';
import type { Db } from './db/client';
import { createImageFetcher, GoalImages, type ImageFetcher } from './goal-image';
import { ClaimNotifier, ensureVapidKeys, webPushSender, type PushSender } from './push';
import { getSettings } from './repo/settings';
import { choreRoutes } from './routes/chores';
import { devRoutes } from './routes/dev';
import { deviceRoutes } from './routes/devices';
import { instanceRoutes } from './routes/instances';
import { kioskRoutes } from './routes/kiosk';
import { moneyRoutes } from './routes/money';
import { pauseRoutes } from './routes/pause';
import { playerRoutes } from './routes/players';
import { pushRoutes } from './routes/push';
import { resetRoutes } from './routes/reset';
import { setupRoutes } from './routes/setup';
import { surpriseRoutes } from './routes/surprises';
import { SecureUrl } from './secure-url';
import { WsHub } from './ws';

/** Set by the server build from the root package.json (`scripts/build.mjs`). */
declare const __PMP_VERSION__: string | undefined;

/**
 * The app's version. The kiosk app passes its own (`PMP_APP_VERSION`), so an installed copy
 * always shows the installer's version; a source build uses the root package.json's.
 */
export const VERSION =
  process.env.PMP_APP_VERSION || (typeof __PMP_VERSION__ === 'string' ? __PMP_VERSION__ : 'dev');

export interface AppOptions {
  db: Db;
  webDist: string | null;
  logger?: FastifyServerOptions['logger'];
  /** The clock for domain timestamps (faked in tests). Defaults to `devClock`, then real time. */
  now?: () => number;
  /**
   * The movable development clock (`PMP_DEV_CLOCK=1`): adds `/api/dev/clock`. Null in
   * production, where those routes don't exist.
   */
  devClock?: ServerClock | null;
  /** `PMP_PUBLIC_URL`: the address phones should use, when the LAN guess is wrong. */
  publicUrl?: string | null;
  /** `PMP_SECURE_URL`: the HTTPS address; otherwise it's learned (ADR 0009). */
  secureUrl?: string | null;
  /** Sends Web Push messages. Defaults to the browser vendors' push services (tests fake it). */
  pushSender?: PushSender;
  /** `PMP_VAPID_SUBJECT`: the contact push services see in the VAPID token. */
  vapidSubject?: string;
  /** Where jar pictures are kept (`images/` next to the database); null keeps none. */
  imagesDir?: string | null;
  /** Fetches a shop link's picture. Defaults to the internet (tests fake it). */
  imageFetcher?: ImageFetcher;
  /**
   * The payday settings changed, or a surprise was sent or ended: the scheduler re-plans
   * (and may run a payday, or put the next surprise up).
   */
  onScheduleChanged?: () => void;
}

export async function buildApp({
  db,
  webDist,
  logger = false,
  devClock = null,
  now = devClock?.now ?? Date.now,
  publicUrl = null,
  secureUrl = null,
  pushSender,
  vapidSubject = 'mailto:pocketmoneypal@localhost',
  imagesDir = null,
  imageFetcher = createImageFetcher(),
  onScheduleChanged,
}: AppOptions): Promise<FastifyInstance> {
  // Trust X-Forwarded-For from loopback only: Vite's dev proxy (and a local HTTPS proxy such
  // as `tailscale serve`) forward the real client, so a phone is never mistaken for the PC.
  const app = Fastify({ logger, trustProxy: 'loopback' });
  // Only a served bundle has a build to compare: without one, clients never see an update.
  const servedDist = webDist && existsSync(resolve(webDist, 'index.html')) ? webDist : null;
  const version = () => serverVersion(servedDist);
  const hub = new WsHub(version);
  app.decorate('hub', hub);

  const vapid = ensureVapidKeys(db);
  const notifier = new ClaimNotifier({
    db,
    now,
    send: pushSender ?? webPushSender(vapid, vapidSubject),
    onError: (err) => app.log.warn({ err }, 'Push failed'),
  });
  app.decorate('notifier', notifier);
  app.addHook('onClose', async () => notifier.stop());

  const secure = new SecureUrl(db, secureUrl);
  // After the cookie is parsed, so a paired phone counts as trusted.
  app.addHook('preHandler', async (req) => secure.learn(req));

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  app.get(WS_PATH, { websocket: true }, (socket) => hub.add(socket));

  app.get('/api/health', async (): Promise<Health> => ({
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    ...version(),
  }));

  app.get('/api/settings', async () => getSettings(db));

  await app.register(setupRoutes, { db, now, publicUrl });
  await app.register(deviceRoutes, { db, now, publicUrl });
  await app.register(kioskRoutes, { db, now, devClock });
  await app.register(instanceRoutes, { db, now });
  await app.register(choreRoutes, { db, now });
  await app.register(playerRoutes, { db, now, onScheduleChanged });
  const images = new GoalImages(imagesDir, imageFetcher);
  await app.register(moneyRoutes, { db, now, images });
  await app.register(surpriseRoutes, { db, now, onScheduleChanged });
  await app.register(pauseRoutes, { db, now, onScheduleChanged });
  await app.register(pushRoutes, {
    db,
    now,
    notifier,
    vapidPublicKey: vapid.publicKey,
    secureUrl: secure,
  });
  await app.register(resetRoutes, { db, now, images, onScheduleChanged });
  if (devClock) await app.register(devRoutes, { db, clock: devClock });

  // Phase 0 plumbing check: any client can ping every connected screen.
  app.post('/api/ping', async (req, reply) => {
    const parsed = pingRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    hub.broadcast({ type: 'ping', from: parsed.data.from, at: new Date().toISOString() });
    return { ok: true, clients: hub.size };
  });

  if (servedDist) {
    // wildcard: files are looked up on disk per request. With `false` the plugin lists them
    // once at start-up, so a rebuild while the server runs (new hashed /assets/ names) was
    // served index.html pointing at 404s: a blank app (ADR 0011).
    await app.register(fastifyStatic, { root: servedDist, wildcard: true });
    // SPA fallback: unknown page GETs get index.html so client routes like /kiosk work. A
    // missing file (an old /assets/ bundle after an update) is a 404, never the page: a
    // service worker would otherwise cache HTML as the script and the app would go blank.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!;
      const isFile = path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path);
      if (req.method === 'GET' && !path.startsWith('/api') && !isFile) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: WsHub;
    notifier: ClaimNotifier;
  }
}
