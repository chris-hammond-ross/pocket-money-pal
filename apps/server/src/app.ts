import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { WS_PATH, familySettingsSchema, pingRequestSchema, type Health } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Db } from './db/client';
import { familySettings } from './db/schema';
import { WsHub } from './ws';

export const VERSION = '0.1.0';

export interface AppOptions {
  db: Db;
  webDist: string | null;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({
  db,
  webDist,
  logger = false,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  const hub = new WsHub();
  app.decorate('hub', hub);

  await app.register(fastifyWebsocket);
  app.get(WS_PATH, { websocket: true }, (socket) => hub.add(socket));

  app.get('/api/health', async (): Promise<Health> => ({
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/settings', async () => {
    const row = db.select().from(familySettings).where(eq(familySettings.id, 1)).get();
    return familySettingsSchema.parse(row);
  });

  // Phase 0 plumbing check: any client can ping every connected screen.
  app.post('/api/ping', async (req, reply) => {
    const parsed = pingRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    hub.broadcast({ type: 'ping', from: parsed.data.from, at: new Date().toISOString() });
    return { ok: true, clients: hub.size };
  });

  if (webDist && existsSync(resolve(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // SPA fallback: unknown non-API GETs get index.html so client routes like /kiosk work.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: WsHub;
  }
}
