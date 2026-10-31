/**
 * The remote guard (ADR 0021). A request from outside the home (through the relay, or a
 * hands-on proxy such as `tailscale serve`) must come from a paired phone, apart from the
 * few routes a phone needs before it's paired. One `onRequest` hook, so a route added
 * later is safe by default. The PC and the LAN are left exactly as they were.
 */
import fastifyRateLimit from '@fastify/rate-limit';
import { WS_PATH } from '@pmp/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { requestOrigin } from '../net';
import { isSetupNeeded } from '../repo/setup';
import { canRunSetup } from '../routes/setup';
import { deviceOf } from './devices';

/**
 * Routes an unpaired remote phone may reach (`METHOD /route`), besides the static app.
 * Setup still needs its token (ADR 0005), and pairing its code.
 */
const BOOTSTRAP = new Set([
  'GET /api/health',
  'GET /api/access',
  'GET /api/settings',
  'GET /api/setup/status',
  'GET /api/setup/draft',
  'PUT /api/setup/draft',
  'POST /api/setup',
  'GET /api/chore-library',
  'POST /api/devices/pair/check',
  'POST /api/devices/pair',
]);

/** Setup-time restore (ADR 0020): only while setup is needed, and only with the token. */
const SETUP_RESTORE = new Set(['POST /api/backup/inspect', 'POST /api/backup/restore']);

/** The route a request matched, as `METHOD /route`. HEAD counts as the GET it mirrors. */
function routeKey(req: FastifyRequest): string | null {
  const route = req.routeOptions.url;
  if (route === undefined) return null;
  return `${req.method === 'HEAD' ? 'GET' : req.method} ${route}`;
}

/** Whether a route is part of the API (or the live socket), not the static app. */
function isApi(route: string | undefined): boolean {
  return (
    route !== undefined && (route === WS_PATH || route === '/api' || route.startsWith('/api/'))
  );
}

const DEFAULT_PORT: Record<string, string> = { http: '80', https: '443' };

/** `scheme://host[:port]`, lower case, without the scheme's default port. */
function canonicalOrigin(protocol: string, host: string): string {
  const scheme = protocol.toLowerCase();
  const lower = host.toLowerCase();
  const port = DEFAULT_PORT[scheme];
  const bare = port && lower.endsWith(`:${port}`) ? lower.slice(0, -port.length - 1) : lower;
  return `${scheme}://${bare}`;
}

/**
 * Whether the browser's `Origin` is this request's own origin, as the proxy or tunnel saw
 * it. Browsers send `Origin` on every write and every WebSocket.
 */
function isSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  let theirs: URL;
  try {
    theirs = new URL(origin);
  } catch {
    return false; // "null", or junk
  }
  return (
    canonicalOrigin(theirs.protocol.replace(/:$/, ''), theirs.host) ===
    canonicalOrigin(req.protocol, req.host)
  );
}

/**
 * Writes, and the WebSocket. Until `pocketmoneypal.app` is on the Public Suffix List, a
 * page on another family's address is "same site", so the browser sends this family's
 * cookie with its requests. CORS keeps it from reading a GET, but not from writing, and a
 * WebSocket has no CORS at all.
 */
function needsSameOrigin(req: FastifyRequest): boolean {
  return (req.method !== 'GET' && req.method !== 'HEAD') || req.routeOptions.url === WS_PATH;
}

/**
 * Installs the guard and the rate-limit plugin. Call before any route is registered. The
 * rate limits apply to remote requests only, on routes that opt in with `remoteLimit`.
 */
export async function installRemoteGuard(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: false,
    allowList: (req) => requestOrigin(req) !== 'remote',
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      error: 'rate-limited',
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
    }),
  });

  app.addHook('onRequest', async (req, reply) => {
    if (requestOrigin(req) !== 'remote') return;
    if (needsSameOrigin(req) && !isSameOrigin(req)) {
      return reply.code(403).send({ error: 'bad-origin' });
    }
    // The static app, and the SPA fallback for anything that isn't an API route.
    if (!isApi(req.routeOptions.url)) return;
    const key = routeKey(req);
    if (key && BOOTSTRAP.has(key)) return;
    if (key && SETUP_RESTORE.has(key) && isSetupNeeded(db) && canRunSetup(db, req)) return;
    if (!deviceOf(db, req)) return reply.code(401).send({ error: 'not-paired' });
  });
}
