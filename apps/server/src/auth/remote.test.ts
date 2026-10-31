/**
 * The remote trust model (ADR 0021): where a request comes from, and what a remote one may
 * do. The proxy requests copy what `tailscale serve` 1.104 really sends: the connection from
 * 127.0.0.1, `X-Forwarded-For` set to the one client address (never appended),
 * `X-Forwarded-Host` and `Host` both the ts.net name, and `X-Forwarded-Proto: https`.
 */
import type { FastifyInstance, InjectOptions, RouteOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { requestOrigin, tunnelledHeaders } from '../net';
import { getSetupToken } from '../repo/setup';
import { insertParent } from '../repo/users';
import { addChild, pairedCookie, PHONE_IP, PUBLIC_IP, TAILNET_IP, testDb } from '../test-helpers';

/** Every route `buildApp` registers, so a route added later is checked too. */
const routes = vi.hoisted(() => [] as { method: string; url: string }[]);
vi.mock('fastify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fastify')>();
  const factory = (opts: Parameters<typeof mod.default>[0]) => {
    const app = mod.default(opts);
    app.addHook('onRoute', (route: RouteOptions) => {
      for (const method of [route.method].flat()) routes.push({ method, url: route.url });
    });
    return app;
  };
  return { ...mod, default: Object.assign(factory, mod.default) };
});

const TS_HOST = 'family-pc.tail1234.ts.net';
const TS_ORIGIN = `https://${TS_HOST}`;

let db: Db;
let close: () => void;
let app: FastifyInstance;

beforeEach(async () => {
  routes.length = 0;
  ({ db, close } = testDb());
  app = await buildApp({ db, webDist: null });
  // What the guard decided, for the tests below. Not an API route, so never guarded.
  app.get('/test/origin', async (req) => ({
    origin: requestOrigin(req),
    tunnelHeader: req.headers['x-pmp-tunnelled'] ?? null,
  }));
});
afterEach(async () => {
  await app.close();
  close();
});

/** A family with a grown-up and a player; returns a paired phone's cookie. */
function family() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  return { mum, billy, cookie: pairedCookie(db, mum.id) };
}

/** Through `tailscale serve` on the PC, from `client`, with this origin's `Origin`. */
const viaTailscale = (opts: InjectOptions, client = TAILNET_IP) =>
  app.inject({
    ...opts,
    remoteAddress: '127.0.0.1',
    // A header given as undefined is one the browser left out.
    headers: Object.fromEntries(
      Object.entries({
        host: TS_HOST,
        origin: TS_ORIGIN,
        'x-forwarded-for': client,
        'x-forwarded-host': TS_HOST,
        'x-forwarded-proto': 'https',
        ...opts.headers,
      }).filter(([, value]) => value !== undefined),
    ),
  });

/** Through the tunnel (session 9.2 will inject requests like this). */
const viaTunnel = (opts: InjectOptions) =>
  app.inject({
    ...opts,
    remoteAddress: '127.0.0.1',
    headers: {
      host: 'abc.pocketmoneypal.app',
      origin: 'https://abc.pocketmoneypal.app',
      'x-forwarded-for': PUBLIC_IP,
      'x-forwarded-proto': 'https',
      ...tunnelledHeaders(),
      ...opts.headers,
    },
  });

const originOf = async (res: Promise<{ json: <T>() => T }>) =>
  (await res).json<{ origin: string }>().origin;

describe('requestOrigin', () => {
  it('is the PC for the kiosk on localhost, and for the PC through its own proxy', async () => {
    expect(await originOf(app.inject({ url: '/test/origin' }))).toBe('pc');
    expect(await originOf(viaTailscale({ url: '/test/origin' }, '127.0.0.1'))).toBe('pc');
  });

  it('is the LAN for a phone on the Wi-Fi, directly or through Vite', async () => {
    expect(await originOf(app.inject({ url: '/test/origin', remoteAddress: PHONE_IP }))).toBe(
      'lan',
    );
    // Vite's proxy (xfwd) appends to whatever the phone sent itself.
    const viaVite = app.inject({
      url: '/test/origin',
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-for': `127.0.0.1, ${PHONE_IP}`,
        'x-forwarded-host': 'localhost:5173',
        'x-forwarded-proto': 'http',
      },
    });
    expect(await originOf(viaVite)).toBe('lan');
  });

  it.each([
    ['a tailnet phone (100.x)', TAILNET_IP],
    ['a tailnet phone over IPv6', 'fd7a:115c:a1e0::1234:5678'],
    ['a public address (Funnel, cloudflared)', PUBLIC_IP],
  ])('is remote through a loopback proxy for %s', async (_name, client) => {
    expect(await originOf(viaTailscale({ url: '/test/origin' }, client))).toBe('remote');
  });

  it('is remote for a tailnet phone reaching the PC directly over plain HTTP', async () => {
    expect(await originOf(app.inject({ url: '/test/origin', remoteAddress: TAILNET_IP }))).toBe(
      'remote',
    );
  });

  it('is remote through a proxy that doesn’t say who the client is', async () => {
    const res = app.inject({
      url: '/test/origin',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': TS_HOST },
    });
    expect(await originOf(res)).toBe('remote');
  });

  it('is always remote through the tunnel, whatever address it reports', async () => {
    const res = viaTunnel({ url: '/test/origin', headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect((await res).json()).toEqual({ origin: 'remote', tunnelHeader: null });
  });

  it('ignores a tunnel mark nobody could know, and strips it', async () => {
    const res = app.inject({
      url: '/test/origin',
      remoteAddress: PHONE_IP,
      headers: { 'x-pmp-tunnelled': 'x'.repeat(43) },
    });
    expect((await res).json()).toEqual({ origin: 'lan', tunnelHeader: null });
  });
});

/** A concrete URL for a route pattern. Ids nobody has, so nothing real is touched. */
const concrete = (url: string) => url.replace(':date', '2026-10-31').replace(/:[a-zA-Z]+/g, '999');

/** The API routes, once each (HEAD mirrors GET). */
const apiRoutes = () =>
  routes.filter((r) => r.method !== 'HEAD' && (r.url === '/ws' || r.url.startsWith('/api/')));

const BOOTSTRAP = [
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
];

const call = (r: { method: string; url: string }, cookie?: string) =>
  viaTailscale({
    method: r.method as InjectOptions['method'],
    url: concrete(r.url),
    ...(r.method !== 'GET' && { payload: {} }),
    headers: cookie ? { cookie } : {},
  });

describe('an unpaired remote request', () => {
  it('gets 401 everywhere except the bootstrap list', async () => {
    family();
    await app.ready();
    expect(apiRoutes().length).toBeGreaterThan(50);
    const seen: Record<string, number> = {};
    for (const r of apiRoutes()) {
      const res = await call(r);
      seen[`${r.method} ${r.url}`] = res.statusCode;
      if (!BOOTSTRAP.includes(`${r.method} ${r.url}`)) {
        expect({ route: `${r.method} ${r.url}`, body: res.json() }).toEqual({
          route: `${r.method} ${r.url}`,
          body: { error: 'not-paired' },
        });
      }
    }
    for (const route of BOOTSTRAP) {
      expect({ route, status: seen[route] }).not.toMatchObject({ status: 401 });
      expect(seen[route]).toBeDefined();
    }
  });

  it('gets the static app', async () => {
    family();
    const res = await viaTailscale({ url: '/parent' });
    // No web bundle in tests: not found, but not refused.
    expect(res.statusCode).toBe(404);
  });

  it('can’t open the live socket', async () => {
    family();
    await app.ready();
    await expect(
      app.injectWS('/ws', {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          host: TS_HOST,
          origin: TS_ORIGIN,
          'x-forwarded-for': TAILNET_IP,
          'x-forwarded-host': TS_HOST,
          'x-forwarded-proto': 'https',
        },
      } as never),
    ).rejects.toThrow('Unexpected server response: 401');
  });

  it('can pair with a code, and is then a paired phone', async () => {
    // Mum's phone at home invites the new one.
    const { mum, cookie: inviter } = family();
    const invite = await app.inject({
      method: 'POST',
      url: '/api/devices/invites',
      remoteAddress: PHONE_IP,
      headers: { cookie: inviter },
      payload: {},
    });
    const { code } = invite.json<{ code: string }>();

    const check = await viaTailscale({
      method: 'POST',
      url: '/api/devices/pair/check',
      payload: { code },
    });
    expect(check.statusCode).toBe(200);
    const pair = await viaTailscale({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, parentId: mum.id },
    });
    expect(pair.statusCode).toBe(201);
    const setCookie = String(pair.headers['set-cookie']);
    expect(setCookie).toMatch(/Secure/);
    const cookie = setCookie.split(';')[0]!;
    expect((await viaTailscale({ url: '/api/children', headers: { cookie } })).statusCode).toBe(
      200,
    );
  });

  it('can’t use the kiosk’s unauthenticated routes, but the PC and the LAN still can', async () => {
    const { billy } = family();
    const goal = { childId: billy.id, name: 'Skateboard', emoji: '🛹', targetCents: 5000 };
    expect((await viaTailscale({ url: '/api/kiosk/today' })).statusCode).toBe(401);
    expect(
      (await viaTailscale({ method: 'POST', url: '/api/goals', payload: goal })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: '/api/kiosk/today' })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/kiosk/today', remoteAddress: PHONE_IP })).statusCode,
    ).toBe(200);
    // Kiosk writes need no Origin on the PC or the LAN.
    expect(
      (await app.inject({ method: 'POST', url: '/api/goals', payload: goal })).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/goals',
          payload: goal,
          remoteAddress: PHONE_IP,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('can’t sneak through as the PC with forwarded headers of its own', async () => {
    family();
    // Straight to :4789 from the internet: its X-Forwarded-For isn't trusted.
    const res = await app.inject({
      url: '/api/kiosk/today',
      remoteAddress: PUBLIC_IP,
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(res.statusCode).toBe(401);
    // Through `tailscale serve`, which replaces the header rather than appending to it.
    const proxied = await viaTailscale({
      url: '/api/kiosk/today',
      headers: { 'x-forwarded-for': TAILNET_IP },
    });
    expect(proxied.statusCode).toBe(401);
  });
});

describe('a paired remote phone', () => {
  it('reaches every route but the PC-only ones', async () => {
    const { cookie } = family();
    await app.ready();
    const pcOnly = ['GET /api/setup/kiosk', 'GET /api/devices/pc-invite'];
    for (const r of apiRoutes()) {
      const route = `${r.method} ${r.url}`;
      const res = await call(r, cookie);
      if (pcOnly.includes(route)) {
        expect({ route, body: res.json() }).toEqual({ route, body: { error: 'pc-only' } });
      } else {
        expect({ route, status: res.statusCode }).not.toMatchObject({
          status: expect.toSatisfy((s: number) => s === 401 || s === 403 || s === 429),
        });
      }
    }
  });

  it('does what the parent app does, including the routes it shares with the kiosk', async () => {
    const { billy, cookie } = family();
    const as = (opts: InjectOptions) =>
      viaTailscale({ ...opts, headers: { cookie, ...opts.headers } });
    expect((await as({ url: '/api/devices/me' })).statusCode).toBe(200);
    expect((await as({ url: '/api/instances/claimed' })).statusCode).toBe(200);
    expect((await as({ url: `/api/children/${billy.id}/savings` })).statusCode).toBe(200);
    expect(
      (
        await as({
          method: 'POST',
          url: `/api/children/${billy.id}/adjust`,
          payload: { points: 5 },
        })
      ).statusCode,
    ).toBe(201);
    const created = await as({
      method: 'POST',
      url: '/api/goals',
      payload: { childId: billy.id, name: 'Skateboard', emoji: '🛹', targetCents: 5000 },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: number }>();
    expect((await as({ method: 'DELETE', url: `/api/goals/${id}` })).statusCode).toBe(204);
    expect(
      (await as({ method: 'PATCH', url: '/api/settings', payload: { volume: 50 } })).statusCode,
    ).toBe(200);
  });

  it('opens the live socket', async () => {
    const { cookie } = family();
    await app.ready();
    const ws = await app.injectWS('/ws', {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        cookie,
        host: TS_HOST,
        origin: TS_ORIGIN,
        'x-forwarded-for': TAILNET_IP,
        'x-forwarded-host': TS_HOST,
        'x-forwarded-proto': 'https',
      },
    } as never);
    ws.terminate();
  });
});

describe('the Origin check on remote writes', () => {
  const adjust = (cookie: string, billyId: number, origin?: string) =>
    viaTailscale({
      method: 'POST',
      url: `/api/children/${billyId}/adjust`,
      payload: { points: 1 },
      headers: { cookie, origin },
    });

  it.each([
    ['no Origin', undefined],
    ['another family’s address', 'https://xyz.pocketmoneypal.app'],
    ['the same host over plain HTTP', `http://${TS_HOST}`],
    ['an opaque origin', 'null'],
  ])('refuses %s', async (_name, origin) => {
    const { billy, cookie } = family();
    const res = await adjust(cookie, billy.id, origin);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'bad-origin' });
  });

  it('accepts its own origin, written any way a browser might', async () => {
    const { billy, cookie } = family();
    expect((await adjust(cookie, billy.id, TS_ORIGIN)).statusCode).toBe(201);
    expect(
      (await adjust(cookie, billy.id, `https://FAMILY-PC.tail1234.ts.net:443`)).statusCode,
    ).toBe(201);
  });

  it('accepts a direct plain-HTTP tailnet request from its own origin', async () => {
    const { billy, cookie } = family();
    const res = await app.inject({
      method: 'POST',
      url: `/api/children/${billy.id}/adjust`,
      remoteAddress: TAILNET_IP,
      payload: { points: 1 },
      headers: { cookie, host: '100.111.205.63:4789', origin: 'http://100.111.205.63:4789' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('needs no Origin on reads, or on the PC and the LAN', async () => {
    const { billy, cookie } = family();
    expect(
      (await viaTailscale({ url: '/api/children', headers: { cookie, origin: undefined } }))
        .statusCode,
    ).toBe(200);
    for (const remoteAddress of ['127.0.0.1', PHONE_IP]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/children/${billy.id}/adjust`,
        remoteAddress,
        payload: { points: 1 },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it('applies to the live socket too', async () => {
    const { cookie } = family();
    await app.ready();
    await expect(
      app.injectWS('/ws', {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          cookie,
          host: TS_HOST,
          origin: 'https://xyz.pocketmoneypal.app',
          'x-forwarded-for': TAILNET_IP,
          'x-forwarded-host': TS_HOST,
          'x-forwarded-proto': 'https',
        },
      } as never),
    ).rejects.toThrow('Unexpected server response: 403');
  });

  it('leaves an unpaired phone on the LAN able to open the socket', async () => {
    await app.ready();
    const ws = await app.injectWS('/ws', { socket: { remoteAddress: PHONE_IP } } as never);
    ws.terminate();
  });
});

describe('remote setup', () => {
  const draft = {
    stage: 'masters',
    parentNames: ['Mum'],
    children: [],
    chores: [],
    centsPerPoint: 5,
  };

  it('is never the PC, so it needs the setup token', async () => {
    const status = await viaTunnel({ url: '/api/setup/status' });
    expect(status.json()).toEqual({ needed: true, onPc: false });
    const refused = await viaTailscale({ method: 'PUT', url: '/api/setup/draft', payload: draft });
    expect(refused.json()).toEqual({ error: 'setup-token' });
    const tunnelled = await viaTunnel({ method: 'PUT', url: '/api/setup/draft', payload: draft });
    expect(tunnelled.json()).toEqual({ error: 'setup-token' });

    const token = { 'x-setup-token': getSetupToken(db) };
    const allowed = await viaTailscale({
      method: 'PUT',
      url: '/api/setup/draft',
      payload: draft,
      headers: token,
    });
    expect(allowed.statusCode).toBe(204);
    // The PC needs none, through its own proxy too. Its title screen stays PC-only.
    const fromPc = await viaTailscale(
      { method: 'PUT', url: '/api/setup/draft', payload: draft },
      '127.0.0.1',
    );
    expect(fromPc.statusCode).toBe(204);
    expect((await viaTunnel({ url: '/api/setup/kiosk' })).statusCode).toBe(401);
    expect((await viaTunnel({ url: '/api/devices/pc-invite' })).statusCode).toBe(401);
  });

  it('may restore a backup only with the setup token', async () => {
    const upload = (headers: Record<string, string>) =>
      viaTailscale({
        method: 'POST',
        url: '/api/backup/inspect',
        payload: Buffer.from('not a backup'),
        headers: { 'content-type': 'application/octet-stream', ...headers },
      });
    expect((await upload({})).json()).toEqual({ error: 'not-paired' });
    const res = await upload({ 'x-setup-token': getSetupToken(db) });
    expect(res.json()).toEqual({ error: 'backup-invalid' });

    // Once setup is done, the setup route is closed to strangers.
    family();
    expect((await upload({})).json()).toEqual({ error: 'not-paired' });
  });
});

describe('remote rate limits', () => {
  const check = (client: string) =>
    viaTailscale(
      { method: 'POST', url: '/api/devices/pair/check', payload: { code: 'ABCDEFGH' } },
      client,
    );

  it('stop a remote client guessing pairing codes, and leave others alone', async () => {
    family();
    for (let i = 0; i < 10; i++) expect((await check(TAILNET_IP)).statusCode).toBe(404);
    const limited = await check(TAILNET_IP);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate-limited' });
    // Pairing itself has its own count.
    const pair = await viaTailscale({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code: 'ABCDEFGH', parentId: 1 },
    });
    expect(pair.statusCode).toBe(404);
    expect((await check(PUBLIC_IP)).statusCode).toBe(404);
  });

  it('never apply on the LAN or the PC', async () => {
    family();
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/devices/pair/check',
        remoteAddress: PHONE_IP,
        payload: { code: 'ABCDEFGH' },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
