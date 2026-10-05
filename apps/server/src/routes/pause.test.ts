import {
  dayPlanSchema,
  familySettingsSchema,
  kioskTodaySchema,
  serverEventSchema,
  surpriseRunSchema,
  zonedTimeToInstant,
  type ServerEvent,
} from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { events, surpriseRuns } from '../db/schema';
import { listInstancesForDate } from '../repo/instances';
import { getSettings } from '../repo/settings';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const TZ = 'Europe/London';
// Monday 5 October 2026.
const DAY = '2026-10-05';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let cookie: string;
let sent: ServerEvent[];
let rescheduled: number;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('10:00');
  rescheduled = 0;
  app = await buildApp({
    db,
    webDist: null,
    now: () => now,
    onScheduleChanged: () => rescheduled++,
  });
  sent = [];
  const broadcast = app.hub.broadcast.bind(app.hub);
  app.hub.broadcast = (event) => {
    sent.push(serverEventSchema.parse(event));
    broadcast(event);
  };
});
afterEach(async () => {
  await app.close();
  close();
});

/** Mum (paired); Billy and Alice; Billy's bed and Alice's dishes, made for today. */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id]);
  const dishes = addChore(db, [alice.id], { title: 'Dishes', icon: '🍽️' });
  ensureDay(db, DAY, at('00:00'));
  cookie = pairedCookie(db, mum.id);
  return { mum, billy, alice, bed, dishes };
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });
const kiosk = (opts: InjectOptions) => app.inject({ ...opts, remoteAddress: '127.0.0.1' });

const pauseFor = (payload: object) => asPhone({ method: 'PUT', url: '/api/pause', payload });
const resume = () => asPhone({ method: 'DELETE', url: '/api/pause' });

async function board() {
  return kioskTodaySchema.parse((await kiosk({ method: 'GET', url: '/api/kiosk/today' })).json());
}

const statuses = (date = DAY) =>
  listInstancesForDate(db, date)
    .map((i) => `${i.choreId}:${i.status}`)
    .sort();

describe('parent-only', () => {
  it('refuses both endpoints without a paired phone', async () => {
    seed();
    for (const call of [
      { method: 'PUT', url: '/api/pause', payload: { from: DAY, until: null } },
      { method: 'DELETE', url: '/api/pause' },
    ] as InjectOptions[]) {
      expect((await kiosk(call)).statusCode, call.method).toBe(401);
    }
  });
});

describe('PUT /api/pause', () => {
  it("from today: today's waiting quests leave, a claim stays, and every screen hears", async () => {
    const f = seed();
    const bed = listInstancesForDate(db, DAY).find((i) => i.choreId === f.bed.id)!;
    await kiosk({
      method: 'POST',
      url: `/api/instances/${bed.id}/claim`,
      payload: { childId: f.billy.id, unprompted: false },
    });
    sent = [];

    const res = await pauseFor({ from: DAY, until: '2026-10-11' });
    expect(res.statusCode, res.body).toBe(200);
    expect(familySettingsSchema.parse(res.json()).pause).toEqual({
      from: DAY,
      until: '2026-10-11',
    });
    expect(statuses()).toEqual([`${f.bed.id}:claimed`]);
    expect(sent.map((e) => e.type)).toEqual(['settings.updated', 'day.changed']);
    expect(rescheduled).toBe(1);

    const b = await board();
    expect(b.pause).toEqual({ from: DAY, until: '2026-10-11' });
    expect(b.children.find((c) => c.id === f.alice.id)?.quests).toEqual([]);
    const plan = dayPlanSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/day/today' })).json(),
    );
    expect(plan.paused).toBe(true);

    const logged = db.select().from(events).where(eq(events.type, 'schedule.paused')).all();
    expect(logged.map((e) => [e.actorId, e.data])).toEqual([
      [f.mum.id, { pause: { from: DAY, until: '2026-10-11' }, was: null }],
    ]);
  });

  it('from tomorrow: today plays out, and the kiosk knows one is coming', async () => {
    const f = seed();
    await pauseFor({ from: '2026-10-06', until: null });
    expect(statuses()).toEqual([`${f.bed.id}:open`, `${f.dishes.id}:open`]);
    expect((await board()).pause).toEqual({ from: '2026-10-06', until: null });
    expect(ensureDay(db, '2026-10-06', at('00:00', '2026-10-06'))).toMatchObject({
      created: 0,
      paused: true,
    });
  });

  it("takes back today's surprises still to come, and refuses new ones", async () => {
    seed();
    const sendSurprise = (payload: object) =>
      asPhone({ method: 'POST', url: '/api/surprises', payload });
    const surprise = {
      task: { title: 'Sweep the patio', icon: '🧹', rewardPoints: 20 },
      who: 'all',
      timeFrameMin: 10,
    };
    const live = surpriseRunSchema.parse((await sendSurprise(surprise)).json());
    const later = surpriseRunSchema.parse(
      (await sendSurprise({ ...surprise, appearAt: '16:00' })).json(),
    );
    expect(live.status).toBe('live');
    sent = [];

    await pauseFor({ from: DAY, until: DAY });
    const runs = db.select().from(surpriseRuns).all();
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      [live.id, 'cancelled'],
      [later.id, 'cancelled'],
    ]);
    expect(sent.filter((e) => e.type === 'surprise.cancelled')).toHaveLength(2);
    expect((await board()).surprise).toBeNull();
    expect((await sendSurprise(surprise)).statusCode).toBe(409);
  });

  it('lets the pause going on change its end, but not its start', async () => {
    seed();
    await pauseFor({ from: DAY, until: '2026-10-07' });
    now = at('10:00', '2026-10-07');
    const longer = await pauseFor({ from: DAY, until: '2026-10-14' });
    expect(longer.statusCode, longer.body).toBe(200);
    expect(getSettings(db).pause).toEqual({ from: DAY, until: '2026-10-14' });
    // "Back tomorrow": the pause ends today.
    expect((await pauseFor({ from: DAY, until: '2026-10-07' })).statusCode).toBe(200);
    expect((await pauseFor({ from: '2026-10-06', until: '2026-10-14' })).statusCode).toBe(400);
  });

  it('refuses a pause in the past, back to front, too long, or not a date', async () => {
    seed();
    for (const payload of [
      { from: '2026-10-04', until: '2026-10-08' },
      { from: '2026-10-08', until: '2026-10-07' },
      { from: DAY, until: '2027-03-01' },
      { from: '2026-02-30', until: null },
      { from: DAY },
    ]) {
      const res = await pauseFor(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(getSettings(db).pause).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('DELETE /api/pause', () => {
  it("resumes right now: today's quests come back", async () => {
    const f = seed();
    await pauseFor({ from: DAY, until: null });
    expect(statuses()).toEqual([]);
    sent = [];

    const res = await resume();
    expect(res.statusCode).toBe(200);
    expect(familySettingsSchema.parse(res.json()).pause).toBeNull();
    expect(statuses()).toEqual([`${f.bed.id}:open`, `${f.dishes.id}:open`]);
    expect(sent.map((e) => e.type)).toEqual(['settings.updated', 'day.changed']);
    expect((await board()).pause).toBeNull();
    expect(db.select().from(events).where(eq(events.type, 'schedule.resumed')).all()).toHaveLength(
      1,
    );
  });

  it('calls off a pause still to come', async () => {
    seed();
    await pauseFor({ from: '2026-10-10', until: '2026-10-12' });
    await resume();
    expect(getSettings(db).pause).toBeNull();
  });
});
