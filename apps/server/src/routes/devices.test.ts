import { deviceListSchema, pairingInviteSchema, PAIRING_CODE_MINUTES } from '@pmp/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { devices, events } from '../db/schema';
import { DEVICE_COOKIE, revokeDevice } from '../repo/devices';
import { insertParent } from '../repo/users';
import { addChild, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = Date.UTC(2026, 9, 1, 17, 0);
  app = await buildApp({ db, webDist: null, now: () => now });
});
afterEach(async () => {
  await app.close();
  close();
});

/** A family that has finished setup: Mum and Dad, and one child. */
function family() {
  const mum = insertParent(db, { name: 'Mum' });
  const dad = insertParent(db, { name: 'Dad' });
  addChild(db, 'Billy');
  return { mum, dad };
}

const phone = (opts: InjectOptions, cookie?: string) =>
  app.inject({
    ...opts,
    remoteAddress: PHONE_IP,
    headers: { 'user-agent': ANDROID_UA, ...opts.headers, ...(cookie && { cookie }) },
  });
const pc = (opts: InjectOptions) => app.inject({ ...opts, remoteAddress: '127.0.0.1' });

/** The token in a response's Set-Cookie, as a `cookie` header. */
function cookieFrom(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === DEVICE_COOKIE);
  if (!c) throw new Error('No device cookie was set');
  return `${DEVICE_COOKIE}=${c.value}`;
}

async function invite(cookie: string): Promise<string> {
  const res = await phone({ method: 'POST', url: '/api/devices/invites' }, cookie);
  expect(res.statusCode).toBe(201);
  return pairingInviteSchema.parse(res.json()).code;
}

describe('device-token auth', () => {
  it('refuses parent endpoints without a paired device', async () => {
    family();
    for (const [method, url] of [
      ['GET', '/api/devices/me'],
      ['GET', '/api/devices'],
      ['POST', '/api/devices/invites'],
      ['GET', '/api/instances/claimed'],
      ['POST', '/api/instances/approve'],
      ['GET', '/api/chores'],
      ['GET', '/api/day/2026-10-01'],
    ] as const) {
      const res = await phone({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toEqual({ error: 'not-paired' });
    }
  });

  it('refuses a made-up token and a revoked device', async () => {
    const { mum } = family();
    expect(
      (await phone({ method: 'GET', url: '/api/devices/me' }, `${DEVICE_COOKIE}=nope`)).statusCode,
    ).toBe(401);
    const cookie = pairedCookie(db, mum.id);
    const me = await phone({ method: 'GET', url: '/api/devices/me' }, cookie);
    expect(me.json()).toMatchObject({ parent: { id: mum.id, name: 'Mum' } });
    revokeDevice(db, me.json().deviceId, now);
    expect((await phone({ method: 'GET', url: '/api/devices/me' }, cookie)).statusCode).toBe(401);
  });

  it('keeps last-seen fresh, and re-issues a cookie not seen for a day', async () => {
    const { mum } = family();
    const cookie = pairedCookie(db, mum.id, now - 2 * 24 * 60 * 60_000);
    const first = await phone({ method: 'GET', url: '/api/devices/me' }, cookie);
    expect(first.cookies.find((c) => c.name === DEVICE_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 400 * 24 * 60 * 60,
    });
    expect(db.select().from(devices).get()!.lastSeenAt).toBe(now);

    now += 30_000;
    const second = await phone({ method: 'GET', url: '/api/devices/me' }, cookie);
    expect(second.cookies).toEqual([]);
    expect(db.select().from(devices).get()!.lastSeenAt).toBe(now - 30_000);
  });
});

describe('pairing another phone', () => {
  it('invites, checks, and pairs a second phone as the grown-up it picks', async () => {
    const { mum, dad } = family();
    const mumsPhone = pairedCookie(db, mum.id);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const code = await invite(mumsPhone);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);

    const check = await phone({
      method: 'POST',
      url: '/api/devices/pair/check',
      payload: { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({
      parents: [
        { id: mum.id, name: 'Mum' },
        { id: dad.id, name: 'Dad' },
      ],
      expiresAt: now + PAIRING_CODE_MINUTES * 60_000,
    });

    const pair = await phone({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, parentId: dad.id },
    });
    expect(pair.statusCode).toBe(201);
    expect(pair.json()).toMatchObject({ name: 'Android phone', parent: { id: dad.id } });
    expect(broadcast).toHaveBeenCalledWith({ type: 'devices.changed' });

    const dadsPhone = cookieFrom(pair);
    const me = await phone({ method: 'GET', url: '/api/devices/me' }, dadsPhone);
    expect(me.json().parent.name).toBe('Dad');

    const audit = db
      .select()
      .from(events)
      .all()
      .find((e) => e.type === 'device.paired');
    expect(audit).toMatchObject({ actorId: dad.id, data: { via: 'invite' } });
    // Only a hash of the token is stored.
    const stored = JSON.stringify(db.select().from(devices).all());
    expect(stored).not.toContain(dadsPhone.split('=')[1]);
  });

  it('a code works once', async () => {
    const { mum } = family();
    const code = await invite(pairedCookie(db, mum.id));
    const pair = () =>
      phone({ method: 'POST', url: '/api/devices/pair', payload: { code, parentId: mum.id } });
    expect((await pair()).statusCode).toBe(201);
    const again = await pair();
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: 'code-expired' });
  });

  it('a code expires after 10 minutes', async () => {
    const { mum } = family();
    const code = await invite(pairedCookie(db, mum.id));
    now += PAIRING_CODE_MINUTES * 60_000;
    const res = await phone({ method: 'POST', url: '/api/devices/pair/check', payload: { code } });
    expect(res.statusCode).toBe(410);
  });

  it('an invite dies with the phone that made it', async () => {
    const { mum } = family();
    const cookie = pairedCookie(db, mum.id);
    const code = await invite(cookie);
    const me = await phone({ method: 'GET', url: '/api/devices/me' }, cookie);
    revokeDevice(db, me.json().deviceId, now);
    const res = await phone({ method: 'POST', url: '/api/devices/pair/check', payload: { code } });
    expect(res.statusCode).toBe(410);
  });

  it('refuses unknown codes, junk, an unknown grown-up, and the PC', async () => {
    const { mum } = family();
    const unknown = await phone({
      method: 'POST',
      url: '/api/devices/pair/check',
      payload: { code: 'ZZZZ-ZZZZ' },
    });
    expect(unknown.statusCode).toBe(404);
    const junk = await phone({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code: 'hello', parentId: mum.id },
    });
    expect(junk.statusCode).toBe(400);

    const code = await invite(pairedCookie(db, mum.id));
    const nobody = await phone({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, parentId: 999 },
    });
    expect(nobody.statusCode).toBe(400);
    const fromPc = await pc({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, parentId: mum.id },
    });
    expect(fromPc.statusCode).toBe(403);
    // The refused attempts didn't spend the code.
    const ok = await phone({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, parentId: mum.id },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("won't pair a phone that is already paired", async () => {
    const { mum } = family();
    const cookie = pairedCookie(db, mum.id);
    const code = await invite(cookie);
    const res = await phone(
      { method: 'POST', url: '/api/devices/pair', payload: { code, parentId: mum.id } },
      cookie,
    );
    expect(res.statusCode).toBe(409);
  });
});

describe("the PC's pairing code", () => {
  it('is only for the PC, only after setup, and only while no phone is paired', async () => {
    expect((await pc({ method: 'GET', url: '/api/devices/pc-invite' })).statusCode).toBe(409);
    const { mum } = family();
    expect((await phone({ method: 'GET', url: '/api/devices/pc-invite' })).statusCode).toBe(403);

    const res = await pc({ method: 'GET', url: '/api/devices/pc-invite' });
    expect(res.statusCode).toBe(200);
    const { code } = pairingInviteSchema.parse(res.json());

    const pair = await phone({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, parentId: mum.id },
    });
    expect(pair.statusCode).toBe(201);
    const audit = db
      .select()
      .from(events)
      .all()
      .find((e) => e.type === 'device.paired');
    expect(audit).toMatchObject({ data: { via: 'pc', invitedByDevice: null } });

    const after = await pc({ method: 'GET', url: '/api/devices/pc-invite' });
    expect(after.statusCode).toBe(409);
    expect(after.json()).toEqual({ error: 'phones-paired' });
  });

  it('stops working once any phone is paired', async () => {
    const { mum } = family();
    const { code } = (await pc({ method: 'GET', url: '/api/devices/pc-invite' })).json();
    pairedCookie(db, mum.id); // paired some other way meanwhile
    const res = await phone({ method: 'POST', url: '/api/devices/pair/check', payload: { code } });
    expect(res.statusCode).toBe(410);
  });
});

describe('paired phones list and revoking', () => {
  it('lists every active device, marking the one asking', async () => {
    const { mum, dad } = family();
    const mumsPhone = pairedCookie(db, mum.id, now - 60_000);
    pairedCookie(db, dad.id);
    const res = await phone({ method: 'GET', url: '/api/devices' }, mumsPhone);
    const list = deviceListSchema.parse(res.json());
    expect(list.map((d) => [d.parent.name, d.current])).toEqual([
      ['Mum', true],
      ['Dad', false],
    ]);
  });

  it('revokes another phone, which is locked out at once, and tells every screen', async () => {
    const { mum, dad } = family();
    const mumsPhone = pairedCookie(db, mum.id);
    const dadsPhone = pairedCookie(db, dad.id);
    const dadsId = (await phone({ method: 'GET', url: '/api/devices/me' }, dadsPhone)).json()
      .deviceId;
    const broadcast = vi.spyOn(app.hub, 'broadcast');

    const res = await phone({ method: 'DELETE', url: `/api/devices/${dadsId}` }, mumsPhone);
    expect(res.statusCode).toBe(204);
    expect(broadcast).toHaveBeenCalledWith({ type: 'devices.changed' });
    expect((await phone({ method: 'GET', url: '/api/devices/me' }, dadsPhone)).statusCode).toBe(
      401,
    );
    expect(
      db
        .select()
        .from(events)
        .all()
        .find((e) => e.type === 'device.revoked'),
    ).toMatchObject({
      actorId: mum.id,
      data: { deviceId: dadsId },
    });

    const again = await phone({ method: 'DELETE', url: `/api/devices/${dadsId}` }, mumsPhone);
    expect(again.statusCode).toBe(404);
  });

  it('revoking your own phone logs it out, and the PC can pair again', async () => {
    const { mum } = family();
    const cookie = pairedCookie(db, mum.id);
    const id = (await phone({ method: 'GET', url: '/api/devices/me' }, cookie)).json().deviceId;
    expect((await phone({ method: 'DELETE', url: `/api/devices/${id}` }, cookie)).statusCode).toBe(
      204,
    );
    expect((await phone({ method: 'GET', url: '/api/devices' }, cookie)).statusCode).toBe(401);
    expect((await pc({ method: 'GET', url: '/api/devices/pc-invite' })).statusCode).toBe(200);
  });
});
