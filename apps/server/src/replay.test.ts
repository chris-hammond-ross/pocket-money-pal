import {
  choreSchema,
  decodeReplaced,
  familySettingsSchema,
  OUTBOX_HEADERS,
  REPLAY_KEEP_MS,
  zonedTimeToInstant,
  type ChoreInput,
} from '@pmp/shared';
import { isNull } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { Db } from './db/client';
import { chores, replayedRequests } from './db/schema';
import { insertParent } from './repo/users';
import { ensureDay } from './scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from './test-helpers';

const TZ = 'Europe/London';
// Monday 5 October 2026.
const DAY = '2026-10-05';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let mumCookie: string;
let dadCookie: string;
let billyId: number;
let bedId: number;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('10:00');
  app = await buildApp({ db, webDist: null, now: () => now });
  const mum = insertParent(db, { name: 'Mum' });
  const dad = insertParent(db, { name: 'Dad' });
  billyId = addChild(db, 'Billy').id;
  bedId = addChore(db, [billyId]).id;
  ensureDay(db, DAY, at('00:00'));
  mumCookie = pairedCookie(db, mum.id);
  dadCookie = pairedCookie(db, dad.id);
});
afterEach(async () => {
  await app.close();
  close();
});

const as = (cookie: string, opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });
const mum = (opts: InjectOptions) => as(mumCookie, opts);
const dad = (opts: InjectOptions) => as(dadCookie, opts);

let keys = 0;
const newKey = () => `test-key-${String(++keys).padStart(4, '0')}`;
/** A change queued on Mum's phone, which last heard from the PC at `since`. */
const queued = (key: string, since: number) => ({
  [OUTBOX_HEADERS.key]: key,
  [OUTBOX_HEADERS.queued]: String(since),
});

const fish = (fields: Partial<ChoreInput> = {}) => ({
  title: 'Feed the fish',
  icon: '🐟',
  bonusBefore: '08:00',
  dueBy: '09:00',
  lateAfter: '10:00',
  basePoints: 5,
  earlyBonus: 0,
  unpromptedBonus: 0,
  latePenalty: 0,
  days: [],
  oneOffDate: '2026-10-06',
  childIds: [billyId],
  libraryId: null,
  ...fields,
});

const activeChores = () => db.select().from(chores).where(isNull(chores.deletedAt)).all();

describe('Idempotency-Key', () => {
  it('applies a change once, and answers a repeat the same', async () => {
    const key = newKey();
    const send = () =>
      mum({ method: 'POST', url: '/api/chores', payload: fish(), headers: queued(key, now) });
    const first = await send();
    expect(first.statusCode).toBe(201);
    const second = await send();
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(choreSchema.parse(second.json()).title).toBe('Feed the fish');
    expect(activeChores()).toHaveLength(2);
  });

  it('keeps a refusal, and an empty answer', async () => {
    const bad = newKey();
    const refuse = () =>
      mum({
        method: 'POST',
        url: '/api/chores',
        payload: { title: '' },
        headers: queued(bad, now),
      });
    expect((await refuse()).statusCode).toBe(400);
    expect((await refuse()).statusCode).toBe(400);

    const key = newKey();
    const del = () =>
      mum({ method: 'DELETE', url: `/api/chores/${bedId}`, headers: queued(key, now) });
    expect((await del()).statusCode).toBe(204);
    // Without the key this would be a 404: the quest is gone.
    const again = await del();
    expect(again.statusCode).toBe(204);
    expect(again.body).toBe('');
  });

  it('doesn’t keep a 401, so a re-paired phone can send it again', async () => {
    const key = newKey();
    const res = await as('pmp_device=nope', {
      method: 'DELETE',
      url: `/api/chores/${bedId}`,
      headers: queued(key, now),
    });
    expect(res.statusCode).toBe(401);
    expect(db.select().from(replayedRequests).all()).toEqual([]);
    expect(
      (await mum({ method: 'DELETE', url: `/api/chores/${bedId}`, headers: queued(key, now) }))
        .statusCode,
    ).toBe(204);
  });

  it('refuses a malformed key, and ignores keys on reads', async () => {
    const res = await mum({
      method: 'POST',
      url: '/api/chores',
      payload: fish(),
      headers: { [OUTBOX_HEADERS.key]: 'no spaces allowed' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad-idempotency-key' });
    const read = await mum({
      method: 'GET',
      url: '/api/chores',
      headers: { [OUTBOX_HEADERS.key]: newKey() },
    });
    expect(read.statusCode).toBe(200);
    expect(db.select().from(replayedRequests).all()).toEqual([]);
  });

  it('forgets answers after 30 days', async () => {
    await mum({
      method: 'POST',
      url: '/api/chores',
      payload: fish(),
      headers: queued(newKey(), now),
    });
    now += REPLAY_KEEP_MS + 1;
    await mum({
      method: 'POST',
      url: '/api/chores',
      payload: fish({ oneOffDate: null, days: ['mon'] }),
      headers: queued(newKey(), now),
    });
    expect(db.select().from(replayedRequests).all()).toHaveLength(1);
  });
});

describe('X-PMP-Replaced', () => {
  it('says when another parent changed the quest after the phone last synced', async () => {
    const synced = now;
    now += 60_000;
    await dad({ method: 'PATCH', url: `/api/chores/${bedId}`, payload: { basePoints: 20 } });
    now += 60_000;
    const res = await mum({
      method: 'PATCH',
      url: `/api/chores/${bedId}`,
      payload: { days: ['sat'] },
      headers: queued(newKey(), synced),
    });
    expect(res.statusCode).toBe(200);
    expect(decodeReplaced(res.headers[OUTBOX_HEADERS.replaced] as string)).toEqual({
      by: 'Dad',
      at: synced + 60_000,
    });
    // Only the days changed: Dad's points stay.
    expect(choreSchema.parse(res.json())).toMatchObject({ days: ['sat'], basePoints: 20 });
  });

  it('says nothing for a change before the sync, the same parent’s, or a plain request', async () => {
    await dad({ method: 'PATCH', url: `/api/chores/${bedId}`, payload: { basePoints: 20 } });
    now += 60_000;
    const synced = now;
    now += 60_000;
    await mum({ method: 'PATCH', url: `/api/chores/${bedId}`, payload: { basePoints: 30 } });
    const res = await mum({
      method: 'PATCH',
      url: `/api/chores/${bedId}`,
      payload: { title: 'Bed' },
      headers: queued(newKey(), synced),
    });
    expect(res.headers[OUTBOX_HEADERS.replaced]).toBeUndefined();
    now += 60_000;
    await dad({ method: 'PATCH', url: `/api/chores/${bedId}`, payload: { basePoints: 40 } });
    const plain = await mum({
      method: 'PATCH',
      url: `/api/chores/${bedId}`,
      payload: { title: 'B' },
    });
    expect(plain.headers[OUTBOX_HEADERS.replaced]).toBeUndefined();
  });

  it('says so on a delete, and on a repeat of the same key', async () => {
    const synced = now;
    now += 1000;
    await dad({ method: 'PATCH', url: `/api/chores/${bedId}`, payload: { days: ['sun'] } });
    const key = newKey();
    const send = () =>
      mum({ method: 'DELETE', url: `/api/chores/${bedId}`, headers: queued(key, synced) });
    const first = await send();
    expect(first.statusCode).toBe(204);
    expect(decodeReplaced(first.headers[OUTBOX_HEADERS.replaced] as string)?.by).toBe('Dad');
    const again = await send();
    expect(again.headers[OUTBOX_HEADERS.replaced]).toBe(first.headers[OUTBOX_HEADERS.replaced]);
  });

  it('isn’t confused by a child’s claim on the quest', async () => {
    const synced = now;
    now += 1000;
    const instance = (
      await app.inject({ method: 'GET', url: '/api/kiosk/today', remoteAddress: '127.0.0.1' })
    ).json<{ children: { quests: { id: number }[] }[] }>().children[0]!.quests[0]!;
    await app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/claim`,
      remoteAddress: '127.0.0.1',
      payload: { childId: billyId, unprompted: false },
    });
    const res = await mum({
      method: 'PATCH',
      url: `/api/chores/${bedId}`,
      payload: { title: 'Bed' },
      headers: queued(newKey(), synced),
    });
    expect(res.headers[OUTBOX_HEADERS.replaced]).toBeUndefined();
  });
});

describe('late arrivals', () => {
  it('refuses a one-off whose day has passed, only when queued', async () => {
    const past = fish({ oneOffDate: '2026-10-04' });
    const res = await mum({
      method: 'POST',
      url: '/api/chores',
      payload: past,
      headers: queued(newKey(), now),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'date-passed' });
    const edit = await mum({
      method: 'PATCH',
      url: `/api/chores/${bedId}`,
      payload: { days: [], oneOffDate: '2026-10-01' },
      headers: queued(newKey(), now),
    });
    expect(edit.statusCode).toBe(409);
    // Today's still fine.
    const today = await mum({
      method: 'POST',
      url: '/api/chores',
      payload: fish({ oneOffDate: DAY }),
      headers: queued(newKey(), now),
    });
    expect(today.statusCode).toBe(201);
  });

  it('starts a late holiday today instead, and says so', async () => {
    const res = await mum({
      method: 'PUT',
      url: '/api/pause',
      payload: { from: '2026-10-03', until: '2026-10-09' },
      headers: queued(newKey(), now),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers[OUTBOX_HEADERS.moved]).toBe(DAY);
    expect(familySettingsSchema.parse(res.json()).pause).toEqual({
      from: DAY,
      until: '2026-10-09',
    });
  });

  it('refuses a holiday that’s already over', async () => {
    const res = await mum({
      method: 'PUT',
      url: '/api/pause',
      payload: { from: '2026-10-01', until: '2026-10-04' },
      headers: queued(newKey(), now),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'pause-over' });
  });

  it('says when a queued holiday replaced another parent’s', async () => {
    const synced = now;
    now += 1000;
    await dad({ method: 'PUT', url: '/api/pause', payload: { from: '2026-10-10', until: null } });
    const res = await mum({
      method: 'DELETE',
      url: '/api/pause',
      headers: queued(newKey(), synced),
    });
    expect(res.statusCode).toBe(200);
    expect(decodeReplaced(res.headers[OUTBOX_HEADERS.replaced] as string)?.by).toBe('Dad');
    expect(familySettingsSchema.parse(res.json()).pause).toBeNull();
  });
});
