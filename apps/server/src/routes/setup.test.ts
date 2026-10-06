import {
  CHORE_LIBRARY,
  choreFromLibrary,
  zonedTimeToInstant,
  type SetupDraft,
  type SetupRequestInput,
} from '@pmp/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import {
  choreAssignments,
  chores,
  devices,
  events,
  familySettings,
  setupDrafts,
  users,
} from '../db/schema';
import { listInstancesForDate } from '../repo/instances';
import { testDb } from '../test-helpers';
import { SETUP_TOKEN_HEADER } from './setup';

/** Wednesday 30 September 2026, 10:00 in London. */
const NOW = zonedTimeToInstant('2026-09-30', '10:00', 'Europe/London');
/** A phone on the LAN (TEST-NET-1, never one of this machine's addresses). */
const PHONE = '192.0.2.77';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

const bed = CHORE_LIBRARY.find((c) => c.id === 'make-bed')!;
const bins = CHORE_LIBRARY.find((c) => c.id === 'bins')!; // Sundays only

function setupBody(overrides: Partial<SetupRequestInput> = {}): SetupRequestInput {
  return {
    parents: [{ name: 'Mum' }, { name: 'Dad' }],
    children: [
      { key: 'a', name: 'Alice', age: 10, avatar: '🦄', colour: '#e64980' },
      { key: 'b', name: 'Billy', age: 7, avatar: '🦖', colour: '#228be6' },
    ],
    chores: [
      { ...choreFromLibrary(bed, ['a', 'b']), together: true },
      choreFromLibrary(bins, ['a']),
      {
        ...choreFromLibrary(bed, ['b']),
        key: 'own:1',
        libraryId: null,
        title: 'Feed the fish',
        icon: '🐟',
      },
    ],
    centsPerPoint: 10,
    timezone: 'Europe/London',
    ...overrides,
  };
}

const draft: SetupDraft = {
  stage: 'quests',
  parentNames: ['Mum', ''],
  children: [{ key: 'a', name: 'Alice', age: 10, avatar: '🦄', colour: '#e64980' }],
  chores: [choreFromLibrary(bed, ['a'])],
  centsPerPoint: 5,
};

describe('setup API', () => {
  let db: Db;
  let close: () => void;
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ db, close } = testDb());
    app = await buildApp({ db, webDist: null, now: () => NOW });
  });

  afterEach(async () => {
    await app.close();
    close();
  });

  /** A request from the family PC (inject's default address is 127.0.0.1). */
  const pc = (opts: InjectOptions) => app.inject(opts);
  /** A request from a phone on the LAN, with the setup token if given. */
  const phone = (opts: InjectOptions, token?: string) =>
    app.inject({
      ...opts,
      remoteAddress: PHONE,
      headers: {
        'user-agent': ANDROID_UA,
        ...(token && { [SETUP_TOKEN_HEADER]: token }),
        ...opts.headers,
      },
    });
  const kioskToken = async () =>
    (await pc({ method: 'GET', url: '/api/setup/kiosk' })).json().token as string;

  describe('GET /api/setup/status', () => {
    it('is needed on an empty database, and knows the PC from a phone', async () => {
      expect((await pc({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({
        needed: true,
        onPc: true,
      });
      expect((await phone({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({
        needed: true,
        onPc: false,
      });
    });

    it("trusts a loopback proxy's X-Forwarded-For (Vite in development)", async () => {
      const res = await pc({
        method: 'GET',
        url: '/api/setup/status',
        headers: { 'x-forwarded-for': PHONE },
      });
      expect(res.json().onPc).toBe(false);
    });

    it("ignores X-Forwarded-For from anywhere else, so a phone can't pose as the PC", async () => {
      const res = await phone({
        method: 'GET',
        url: '/api/setup/status',
        headers: { 'x-forwarded-for': '127.0.0.1' },
      });
      expect(res.json().onPc).toBe(false);
    });
  });

  describe('GET /api/setup/kiosk', () => {
    it('gives the PC a token and the addresses for the QR code', async () => {
      const res = await pc({ method: 'GET', url: '/api/setup/kiosk' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toMatch(/^[\w-]{43}$/);
      expect(Array.isArray(body.hosts)).toBe(true);
      expect(body.publicUrl).toBeNull();
    });

    it('keeps the same token until setup is done, even across a restart', async () => {
      const first = await kioskToken();
      expect(await kioskToken()).toBe(first);
      const restarted = await buildApp({ db, webDist: null });
      const res = await restarted.inject({ method: 'GET', url: '/api/setup/kiosk' });
      expect(res.json().token).toBe(first);
      await restarted.close();
    });

    it('never shows the token to a phone', async () => {
      const res = await phone({ method: 'GET', url: '/api/setup/kiosk' });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('token":');
    });

    it('passes PMP_PUBLIC_URL through', async () => {
      const withUrl = await buildApp({ db, webDist: null, publicUrl: 'http://pc.lan:4789' });
      const res = await withUrl.inject({ method: 'GET', url: '/api/setup/kiosk' });
      expect(res.json().publicUrl).toBe('http://pc.lan:4789');
      await withUrl.close();
    });
  });

  describe('drafts', () => {
    it('starts empty and keeps what is saved', async () => {
      expect((await pc({ method: 'GET', url: '/api/setup/draft' })).json()).toEqual({
        draft: null,
      });
      const put = await pc({ method: 'PUT', url: '/api/setup/draft', payload: draft });
      expect(put.statusCode).toBe(204);
      expect((await pc({ method: 'GET', url: '/api/setup/draft' })).json()).toEqual({ draft });
    });

    it('saving a draft keeps the setup token', async () => {
      const token = await kioskToken();
      await pc({ method: 'PUT', url: '/api/setup/draft', payload: draft });
      expect(await kioskToken()).toBe(token);
    });

    it('lets a phone in with the token only', async () => {
      const token = await kioskToken();
      const none = await phone({ method: 'GET', url: '/api/setup/draft' });
      expect(none.statusCode).toBe(403);
      expect(none.json()).toEqual({ error: 'setup-token' });
      const wrong = await phone({ method: 'GET', url: '/api/setup/draft' }, 'x'.repeat(43));
      expect(wrong.statusCode).toBe(403);
      const put = await phone({ method: 'PUT', url: '/api/setup/draft', payload: draft }, token);
      expect(put.statusCode).toBe(204);
      const got = await phone({ method: 'GET', url: '/api/setup/draft' }, token);
      expect(got.json()).toEqual({ draft });
    });

    it('refuses a phone before the kiosk has made a token', async () => {
      const res = await phone({ method: 'GET', url: '/api/setup/draft' }, 'anything');
      expect(res.statusCode).toBe(403);
    });

    it('validates drafts', async () => {
      const bad = await pc({
        method: 'PUT',
        url: '/api/setup/draft',
        payload: { ...draft, centsPerPoint: 0 },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('POST /api/setup', () => {
    it('creates parents, players, quests, the rate and today’s board in one go', async () => {
      const broadcast = vi.spyOn(app.hub, 'broadcast');
      await pc({ method: 'PUT', url: '/api/setup/draft', payload: draft });

      const res = await pc({ method: 'POST', url: '/api/setup', payload: setupBody() });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ paired: false });

      const people = db.select().from(users).orderBy(asc(users.id)).all();
      expect(people.map((u) => [u.role, u.name, u.sortOrder])).toEqual([
        ['parent', 'Mum', 0],
        ['parent', 'Dad', 0],
        ['child', 'Alice', 0],
        ['child', 'Billy', 1],
      ]);
      expect(people[0]!.pinHash).toBeNull(); // no PINs (ADR 0008)
      expect(res.json().parentId).toBe(people[0]!.id);

      const saved = db.select().from(chores).orderBy(asc(chores.id)).all();
      expect(saved.map((c) => [c.title, c.libraryId, c.together])).toEqual([
        ['Make your bed', 'make-bed', true],
        ['Take the bins out', 'bins', false],
        ['Feed the fish', null, false],
      ]);
      expect(db.select().from(choreAssignments).all()).toHaveLength(4);

      // Wednesday: both beds and the fish, but not the Sunday bins. At 10:00 their 08:00
      // bonus time is over, so they start next time instead of late (spec 003).
      const today = listInstancesForDate(db, '2026-09-30');
      expect(today).toHaveLength(3);
      expect(today.every((i) => i.status === 'skipped')).toBe(true);

      expect(db.select().from(familySettings).get()).toMatchObject({
        centsPerPoint: 10,
        timezone: 'Europe/London',
      });
      expect(
        db
          .select()
          .from(events)
          .all()
          .map((e) => e.type),
      ).toEqual(expect.arrayContaining(['setup.completed', 'day.scheduled']));
      expect(db.select().from(setupDrafts).all()).toEqual([]);

      expect(broadcast.mock.calls.map(([e]) => e.type)).toEqual([
        'setup.completed',
        'settings.updated',
        'day.changed',
      ]);
    });

    it('does not pair the family PC', async () => {
      const res = await pc({ method: 'POST', url: '/api/setup', payload: setupBody() });
      expect(res.cookies).toEqual([]);
      expect(db.select().from(devices).all()).toEqual([]);
    });

    it('pairs a phone that finishes setup to the first grown-up', async () => {
      const token = await kioskToken();
      const res = await phone({ method: 'POST', url: '/api/setup', payload: setupBody() }, token);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ paired: true });

      const cookie = res.cookies.find((c) => c.name === 'pmp_device')!;
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
      expect(cookie.secure).toBeFalsy();

      const [device] = db.select().from(devices).all();
      expect(device).toMatchObject({ name: 'Android phone', userId: res.json().parentId });
      expect(device!.tokenHash).not.toBe(cookie.value);
      expect(db.select().from(events).where(eq(events.type, 'device.paired')).all()).toHaveLength(
        1,
      );

      const me = await phone({
        method: 'GET',
        url: '/api/devices/me',
        cookies: { pmp_device: cookie.value },
      });
      expect(me.json()).toMatchObject({ name: 'Android phone', parent: { name: 'Mum' } });
    });

    it('refuses a phone without the token', async () => {
      await kioskToken();
      const res = await phone({ method: 'POST', url: '/api/setup', payload: setupBody() });
      expect(res.statusCode).toBe(403);
      expect(db.select().from(users).all()).toEqual([]);
    });

    it('refuses two grown-ups with the same name on the server too', async () => {
      const res = await pc({
        method: 'POST',
        url: '/api/setup',
        payload: setupBody({ parents: [{ name: 'Mum' }, { name: 'MUM' }] }),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('Each grown-up needs a different name.');
      expect(db.select().from(users).all()).toEqual([]);
    });

    it.each([
      ['no quests', { chores: [] }],
      ['no players', { children: [] }],
      ['a quest for an unknown player', { chores: [choreFromLibrary(bed, ['z'])] }],
      ['an unknown time zone', { timezone: 'Mars/Olympus' }],
      ['a rate of 0', { centsPerPoint: 0 }],
    ])('refuses %s', async (_label, overrides) => {
      const res = await pc({ method: 'POST', url: '/api/setup', payload: setupBody(overrides) });
      expect(res.statusCode).toBe(400);
      expect(db.select().from(users).all()).toEqual([]);
    });

    it("uses the finishing browser's time zone for today's board", async () => {
      // 10:00 in London is 05:00 in New York: still Wednesday there.
      const res = await pc({
        method: 'POST',
        url: '/api/setup',
        payload: setupBody({ timezone: 'America/New_York' }),
      });
      expect(res.statusCode).toBe(201);
      expect(db.select().from(familySettings).get()?.timezone).toBe('America/New_York');
      const today = listInstancesForDate(db, '2026-09-30');
      expect(today).toHaveLength(3);
      // 05:00 there: the bonus time is still to come, so they start today.
      expect(today.every((i) => i.status === 'open')).toBe(true);
    });

    it('keeps the current time zone when none is sent', async () => {
      const body = setupBody();
      delete body.timezone;
      await pc({ method: 'POST', url: '/api/setup', payload: body });
      expect(db.select().from(familySettings).get()?.timezone).toBe('Europe/London');
    });

    it('only works once: everything answers 409 afterwards', async () => {
      const token = await kioskToken();
      await pc({ method: 'POST', url: '/api/setup', payload: setupBody() });

      expect((await pc({ method: 'GET', url: '/api/setup/status' })).json().needed).toBe(false);
      for (const res of [
        await pc({ method: 'POST', url: '/api/setup', payload: setupBody() }),
        await phone({ method: 'POST', url: '/api/setup', payload: setupBody() }, token),
        await pc({ method: 'GET', url: '/api/setup/kiosk' }),
        await pc({ method: 'GET', url: '/api/setup/draft' }),
        await pc({ method: 'PUT', url: '/api/setup/draft', payload: draft }),
      ]) {
        expect(res.statusCode).toBe(409);
      }
      expect(db.select().from(users).where(eq(users.role, 'parent')).all()).toHaveLength(2);
    });

    it('lets only one of two simultaneous finishes win', async () => {
      const [a, b] = await Promise.all([
        pc({ method: 'POST', url: '/api/setup', payload: setupBody() }),
        pc({ method: 'POST', url: '/api/setup', payload: setupBody() }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      expect(db.select().from(users).where(eq(users.role, 'parent')).all()).toHaveLength(2);
    });
  });

  describe('GET /api/devices/me', () => {
    it('is 401 without a cookie, with an unknown one, or once revoked', async () => {
      expect((await phone({ method: 'GET', url: '/api/devices/me' })).statusCode).toBe(401);
      const unknown = await phone({
        method: 'GET',
        url: '/api/devices/me',
        cookies: { pmp_device: 'nope' },
      });
      expect(unknown.statusCode).toBe(401);

      const token = await kioskToken();
      const res = await phone({ method: 'POST', url: '/api/setup', payload: setupBody() }, token);
      const cookie = res.cookies.find((c) => c.name === 'pmp_device')!.value;
      db.update(devices).set({ revokedAt: NOW }).run();
      const revoked = await phone({
        method: 'GET',
        url: '/api/devices/me',
        cookies: { pmp_device: cookie },
      });
      expect(revoked.statusCode).toBe(401);
    });
  });

  it('GET /api/chore-library returns the seed suggestions', async () => {
    const res = await phone({ method: 'GET', url: '/api/chore-library' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(CHORE_LIBRARY.length);
  });
});
