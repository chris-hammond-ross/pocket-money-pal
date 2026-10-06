import {
  choreListSchema,
  dayPlanSchema,
  kioskTodaySchema,
  surpriseRunSchema,
  surpriseTaskListSchema,
  surpriseTaskSchema,
  surpriseTodaySchema,
  trayListSchema,
  zonedTimeToInstant,
  type ServerEvent,
} from '@pmp/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { chores, events, ledger, surpriseRuns, users } from '../db/schema';
import { getInstance } from '../repo/instances';
import { insertParent } from '../repo/users';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';
import { ensureDay } from '../scheduler';

const TZ = 'Europe/London';
const DAY = '2026-10-01';
const at = (time: string) => zonedTimeToInstant(DAY, time, TZ);
const MIN = 60_000;

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let cookie: string;
let sent: ServerEvent[];
let rescheduled: number;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('17:00');
  rescheduled = 0;
  app = await buildApp({
    db,
    webDist: null,
    now: () => now,
    onScheduleChanged: () => rescheduled++,
  });
  sent = [];
  vi.spyOn(app.hub, 'broadcast').mockImplementation((e) => void sent.push(e));
});
afterEach(async () => {
  await app.close();
  close();
});

function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  cookie = pairedCookie(db, mum.id);
  return { mum, billy, alice };
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });
const kiosk = (opts: InjectOptions) => app.inject({ ...opts, remoteAddress: '127.0.0.1' });

const patio = { title: 'Sweep the patio', icon: '🧹', rewardPoints: 20 };

async function saveTask(fields: object = {}) {
  const res = await asPhone({
    method: 'POST',
    url: '/api/surprise-tasks',
    payload: { ...patio, timeFrameMin: 30, who: 'all', ...fields },
  });
  expect(res.statusCode).toBe(201);
  return surpriseTaskSchema.parse(res.json());
}

async function send(payload: object) {
  const res = await asPhone({ method: 'POST', url: '/api/surprises', payload });
  expect(res.statusCode, res.body).toBe(201);
  return surpriseRunSchema.parse(res.json());
}

const grab = (runId: number, payload: object) =>
  kiosk({ method: 'POST', url: `/api/surprises/${runId}/grab`, payload });

async function board() {
  return kioskTodaySchema.parse((await kiosk({ method: 'GET', url: '/api/kiosk/today' })).json());
}

async function today() {
  const res = await asPhone({ method: 'GET', url: '/api/surprises/today' });
  return surpriseTodaySchema.parse(res.json());
}

const types = () => sent.map((e) => e.type);

describe('saved surprise quests', () => {
  it('are made, listed, edited and deleted (softly) from a phone', async () => {
    const { alice } = seed();
    const task = await saveTask({ who: alice.id, timeFrameMin: 10 });
    expect(task).toMatchObject({ ...patio, who: alice.id, timeFrameMin: 10 });

    const patched = await asPhone({
      method: 'PATCH',
      url: `/api/surprise-tasks/${task.id}`,
      payload: { rewardPoints: 25, who: 'all' },
    });
    expect(patched.json()).toMatchObject({ rewardPoints: 25, who: 'all', title: patio.title });

    expect(
      (await asPhone({ method: 'DELETE', url: `/api/surprise-tasks/${task.id}` })).statusCode,
    ).toBe(204);
    const list = await asPhone({ method: 'GET', url: '/api/surprise-tasks' });
    expect(surpriseTaskListSchema.parse(list.json())).toEqual([]);
    expect(types()).toEqual([
      'surprise_task.created',
      'surprise_task.updated',
      'surprise_task.deleted',
    ]);
    const audit = db
      .select()
      .from(events)
      .all()
      .map((e) => e.type);
    expect(audit).toEqual(
      expect.arrayContaining([
        'surprise_task.created',
        'surprise_task.updated',
        'surprise_task.deleted',
      ]),
    );
  });

  it('refuses bad fields, an unknown child, a missing quest, and anyone not paired', async () => {
    seed();
    const bad = await asPhone({
      method: 'POST',
      url: '/api/surprise-tasks',
      payload: { ...patio, rewardPoints: 12, timeFrameMin: 30, who: 'all' },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await asPhone({
      method: 'POST',
      url: '/api/surprise-tasks',
      payload: { ...patio, timeFrameMin: 30, who: 999 },
    });
    expect(unknown.statusCode).toBe(400);
    expect(
      (await asPhone({ method: 'PATCH', url: '/api/surprise-tasks/9', payload: {} })).statusCode,
    ).toBe(404);
    expect((await kiosk({ method: 'GET', url: '/api/surprise-tasks' })).statusCode).toBe(401);
    expect((await kiosk({ method: 'POST', url: '/api/surprises', payload: {} })).statusCode).toBe(
      401,
    );
  });
});

describe('POST /api/surprises', () => {
  it("sends a saved quest by id alone, with its defaults (spec 002's form)", async () => {
    const { billy, alice } = seed();
    const task = await saveTask({ timeFrameMin: 15 });
    const run = await send({ taskId: task.id });
    expect(run).toMatchObject({
      taskId: task.id,
      ...patio,
      who: 'all',
      timeFrameMin: 15,
      status: 'live',
      shownAt: now,
      expiresAt: now + 15 * MIN,
      eligibleIds: [billy.id, alice.id],
    });
    expect(types()).toEqual(['surprise_task.created', 'surprise.queued', 'surprise.live']);
    expect(rescheduled).toBe(1);
    const audit = db.select().from(events).where(eq(events.type, 'surprise.sent')).all();
    expect(audit).toHaveLength(1);
  });

  it('lets this send change who and how long, without changing the saved quest', async () => {
    const { alice } = seed();
    const task = await saveTask();
    const run = await send({ taskId: task.id, who: alice.id, timeFrameMin: 5 });
    expect(run).toMatchObject({ who: alice.id, timeFrameMin: 5, eligibleIds: [alice.id] });
    const list = await asPhone({ method: 'GET', url: '/api/surprise-tasks' });
    expect(list.json()[0]).toMatchObject({ who: 'all', timeFrameMin: 30 });
  });

  it('sends a new quest once, or saves it with this send as its defaults', async () => {
    const { alice } = seed();
    const once = await send({ task: patio, who: 'all', timeFrameMin: 10 });
    expect(once.taskId).toBeNull();
    const kept = await send({
      task: { ...patio, title: 'Find the remote' },
      who: alice.id,
      timeFrameMin: 5,
      save: true,
    });
    expect(kept.taskId).not.toBeNull();
    const list = surpriseTaskListSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/surprise-tasks' })).json(),
    );
    expect(list).toEqual([
      {
        id: kept.taskId,
        title: 'Find the remote',
        icon: '🧹',
        rewardPoints: 20,
        timeFrameMin: 5,
        who: alice.id,
      },
    ]);
  });

  it('schedules for a set time today, and refuses a bad one', async () => {
    seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 10, appearAt: '17:30' });
    expect(run).toMatchObject({ status: 'scheduled', appearAt: at('17:30'), shownAt: null });
    expect(types()).toEqual(['surprise.scheduled']);

    for (const appearAt of ['17:05', '17:20', '20:00', '9:00']) {
      const res = await asPhone({
        method: 'POST',
        url: '/api/surprises',
        payload: { task: patio, who: 'all', timeFrameMin: 10, appearAt },
      });
      expect(res.statusCode, appearAt).toBe(400);
    }
  });

  it('refuses a deleted quest, an unknown child, and a child on a sick day', async () => {
    const { alice } = seed();
    const task = await saveTask();
    await asPhone({ method: 'DELETE', url: `/api/surprise-tasks/${task.id}` });
    const gone = await asPhone({
      method: 'POST',
      url: '/api/surprises',
      payload: { taskId: task.id },
    });
    expect(gone.statusCode).toBe(404);
    const unknown = await asPhone({
      method: 'POST',
      url: '/api/surprises',
      payload: { task: patio, who: 999, timeFrameMin: 10 },
    });
    expect(unknown.statusCode).toBe(400);
    db.update(users).set({ sickOn: DAY }).where(eq(users.id, alice.id)).run();
    const sick = await asPhone({
      method: 'POST',
      url: '/api/surprises',
      payload: { task: patio, who: alice.id, timeFrameMin: 10 },
    });
    expect(sick.statusCode).toBe(400);
  });
});

describe('one on the kiosk at a time', () => {
  it('queues the next until the first is grabbed, then gives it its full time frame', async () => {
    const { billy } = seed();
    const first = await send({ task: patio, who: 'all', timeFrameMin: 10 });
    const second = await send({
      task: { ...patio, title: 'Fetch the post' },
      who: 'all',
      timeFrameMin: 5,
    });
    expect(second.status).toBe('queued');
    expect((await board()).surprise).toMatchObject({ run: { id: first.id }, queued: 1 });

    now = at('17:04');
    sent = [];
    expect((await grab(first.id, { childId: billy.id })).statusCode).toBe(200);
    expect(types()).toEqual(['surprise.grabbed', 'surprise.live']);
    const up = (await board()).surprise!;
    expect(up).toMatchObject({ run: { id: second.id, shownAt: now }, queued: 0 });
    expect(up.run.expiresAt).toBe(now + 5 * MIN);
  });

  it('puts the next one up when a parent takes the live one back', async () => {
    seed();
    const first = await send({ task: patio, who: 'all', timeFrameMin: 10 });
    const second = await send({ task: patio, who: 'all', timeFrameMin: 10 });
    sent = [];
    expect(
      (await asPhone({ method: 'DELETE', url: `/api/surprises/${first.id}` })).statusCode,
    ).toBe(204);
    expect(types()).toEqual(['surprise.cancelled', 'surprise.live']);
    expect((await board()).surprise?.run.id).toBe(second.id);
    // Taken back: it leaves the Day tab, and can't be taken back twice.
    expect((await today()).map((r) => r.id)).toEqual([second.id]);
    expect(
      (await asPhone({ method: 'DELETE', url: `/api/surprises/${first.id}` })).statusCode,
    ).toBe(409);
  });
});

describe('POST /api/surprises/:id/grab: the claim race', () => {
  it('gives it to one of two children tapping at the same moment; the other hears 409', async () => {
    const { billy, alice } = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    now = at('17:00') + 4_000;
    const [a, b] = await Promise.all([
      grab(run.id, { childId: billy.id }),
      grab(run.id, { childId: alice.id }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json()).toEqual({ error: 'already-grabbed' });
    const winner = a.statusCode === 200 ? billy.id : alice.id;
    const grabbed = sent.filter((e) => e.type === 'surprise.grabbed');
    expect(grabbed).toHaveLength(1);
    expect(grabbed[0]).toMatchObject({ childIds: [winner], team: false });
    expect(db.select().from(chores).all()).toHaveLength(1);
  });

  it('"We\'ll all do it!" beats a later single grab', async () => {
    const { billy, alice } = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    expect((await grab(run.id, { all: true })).json()).toMatchObject({
      type: 'surprise.grabbed',
      childIds: [billy.id, alice.id],
      team: true,
    });
    const late = await grab(run.id, { childId: billy.id });
    expect([late.statusCode, late.json()]).toEqual([409, { error: 'already-grabbed' }]);
  });

  it('…and loses to an earlier one', async () => {
    const { billy } = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    expect((await grab(run.id, { childId: billy.id })).statusCode).toBe(200);
    const team = await grab(run.id, { all: true });
    expect([team.statusCode, team.json()]).toEqual([409, { error: 'already-grabbed' }]);
  });

  it('refuses a grab arriving just after the countdown ran out, and takes one just before', async () => {
    const { billy } = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 1 });
    now = run.expiresAt!;
    const late = await grab(run.id, { childId: billy.id });
    expect([late.statusCode, late.json()]).toEqual([409, { error: 'expired' }]);
    now = run.expiresAt! - 1;
    expect((await grab(run.id, { childId: billy.id })).statusCode).toBe(200);
  });

  it("keeps a named child's surprise to them, and leaves a sick child out", async () => {
    const { billy, alice } = seed();
    const justAlice = await send({ task: patio, who: alice.id, timeFrameMin: 10 });
    expect((await board()).surprise).toMatchObject({
      canTeam: false,
      run: { eligibleIds: [alice.id] },
    });
    expect((await grab(justAlice.id, { childId: billy.id })).statusCode).toBe(403);
    expect((await grab(justAlice.id, { all: true })).json()).toEqual({ error: 'not-eligible' });
    await asPhone({ method: 'DELETE', url: `/api/surprises/${justAlice.id}` });

    db.update(users).set({ sickOn: DAY }).where(eq(users.id, billy.id)).run();
    const forAll = await send({ task: patio, who: 'all', timeFrameMin: 10 });
    expect((await board()).surprise).toMatchObject({
      canTeam: false,
      run: { eligibleIds: [alice.id] },
    });
    expect((await grab(forAll.id, { childId: billy.id })).statusCode).toBe(403);
  });

  it("refuses a run that isn't up yet, and an unknown one", async () => {
    const { billy } = seed();
    const later = await send({ task: patio, who: 'all', timeFrameMin: 10, appearAt: '18:00' });
    expect((await grab(later.id, { childId: billy.id })).json()).toEqual({ error: 'not-live' });
    expect((await grab(999, { childId: billy.id })).statusCode).toBe(404);
    expect((await grab(later.id, { all: false })).statusCode).toBe(400);
  });
});

describe('a grabbed surprise is a quest', () => {
  it("puts an open one-off quest, worth exactly the reward, first in the taker's column", async () => {
    const { billy, alice } = seed();
    addChore(db, [billy.id], { bonusBefore: '18:00', dueBy: '18:30', lateAfter: '19:00' });
    ensureDay(db, DAY, at('00:00'));
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    await grab(run.id, { childId: billy.id });

    const b = await board();
    expect(b.surprise).toBeNull();
    const column = b.children.find((c) => c.id === billy.id)!;
    expect(column.quests.map((q) => [q.title, q.status, q.surprise])).toEqual([
      ['Sweep the patio', 'open', { runId: run.id, team: false }],
      ['Make your bed', 'open', null],
    ]);
    expect(column.quests[0]!.maxPoints).toBe(20);
    // Next-up is the quest with a deadline, not the surprise.
    expect(column.nextUpId).toBe(column.quests[1]!.id);
    expect(b.children.find((c) => c.id === alice.id)!.quests).toEqual([]);

    // The phone's quest list and Day tab leave it out: the SURPRISES TODAY row stands for it.
    const list = choreListSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/chores' })).json(),
    );
    expect(list.map((c) => c.title)).toEqual(['Make your bed']);
    const plan = dayPlanSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/day/today' })).json(),
    );
    expect(plan.quests.map((q) => q.chore.title)).toEqual(['Make your bed']);
    const [row] = await today();
    expect(row).toMatchObject({
      status: 'grabbed',
      team: false,
      takers: [{ childId: billy.id, status: 'open' }],
    });
  });

  it('is claimed on the kiosk, waits in the tray with how fast it was grabbed, and pays the reward', async () => {
    const { billy } = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    now = at('17:00') + 4_000;
    await grab(run.id, { childId: billy.id });
    const { takers } = (await today())[0]!;
    const id = takers[0]!.instanceId;

    now = at('17:20');
    const claim = await kiosk({
      method: 'POST',
      url: `/api/instances/${id}/claim`,
      payload: { childId: billy.id, unprompted: false },
    });
    expect(claim.json().points.total).toBe(20);
    const tray = trayListSchema.parse(
      (await asPhone({ method: 'GET', url: '/api/instances/claimed' })).json(),
    );
    expect(tray[0]).toMatchObject({
      title: 'Sweep the patio',
      points: { total: 20 },
      surprise: { runId: run.id, team: false, grabbedInMs: 4_000 },
    });

    await asPhone({ method: 'POST', url: '/api/instances/approve', payload: { items: [{ id }] } });
    expect(getInstance(db, id)).toMatchObject({ status: 'approved', awardedTotal: 20 });
  });

  it('can be deleted from a phone, but not edited into an ordinary quest', async () => {
    const { billy } = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    await grab(run.id, { childId: billy.id });
    const choreId = db.select().from(chores).get()!.id;
    const edit = await asPhone({
      method: 'PATCH',
      url: `/api/chores/${choreId}`,
      payload: { basePoints: 50 },
    });
    expect(edit.statusCode).toBe(404);
    expect((await asPhone({ method: 'DELETE', url: `/api/chores/${choreId}` })).statusCode).toBe(
      204,
    );
    expect((await board()).children[0]!.quests).toEqual([]);
  });

  it('can be taken back, open or waiting in the tray, until it is approved', async () => {
    const { billy, alice } = seed();
    const open = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    await grab(open.id, { childId: billy.id });
    sent = [];
    expect((await asPhone({ method: 'DELETE', url: `/api/surprises/${open.id}` })).statusCode).toBe(
      204,
    );
    expect(types()).toEqual(['surprise.cancelled']);
    expect((await board()).children.flatMap((c) => c.quests)).toEqual([]);
    expect(await today()).toEqual([]);
    expect(
      choreListSchema.parse((await asPhone({ method: 'GET', url: '/api/chores' })).json()),
    ).toEqual([]);

    // Claimed: it leaves the tray, and no points were ever paid.
    const claimed = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    await grab(claimed.id, { childId: alice.id });
    const id = (await today())[0]!.takers[0]!.instanceId;
    await kiosk({
      method: 'POST',
      url: `/api/instances/${id}/claim`,
      payload: { childId: alice.id, unprompted: false },
    });
    expect(
      (await asPhone({ method: 'DELETE', url: `/api/surprises/${claimed.id}` })).statusCode,
    ).toBe(204);
    expect(getInstance(db, id).status).toBe('skipped');
    expect(
      trayListSchema.parse(
        (await asPhone({ method: 'GET', url: '/api/instances/claimed' })).json(),
      ),
    ).toEqual([]);
    expect(db.select().from(ledger).all()).toEqual([]);

    // Approved: its points are in the ledger, so it stays.
    const paid = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    await grab(paid.id, { childId: billy.id });
    const paidId = (await today())[0]!.takers[0]!.instanceId;
    await kiosk({
      method: 'POST',
      url: `/api/instances/${paidId}/claim`,
      payload: { childId: billy.id, unprompted: false },
    });
    await asPhone({
      method: 'POST',
      url: '/api/instances/approve',
      payload: { items: [{ id: paidId }] },
    });
    expect((await asPhone({ method: 'DELETE', url: `/api/surprises/${paid.id}` })).statusCode).toBe(
      409,
    );
    expect(getInstance(db, paidId).status).toBe('approved');
  });
});

describe('a team surprise', () => {
  async function teamUp() {
    const f = seed();
    const run = await send({ task: patio, who: 'all', timeFrameMin: 30 });
    await grab(run.id, { all: true });
    const { takers } = (await today())[0]!;
    const ids = Object.fromEntries(takers.map((t) => [t.childId, t.instanceId]));
    return { ...f, run, billyId: ids[f.billy.id]!, aliceId: ids[f.alice.id]! };
  }

  it('gives each taker the quest, and one claim claims them all with the same time', async () => {
    const f = await teamUp();
    const b = await board();
    for (const child of b.children) {
      expect(child.quests[0]).toMatchObject({
        status: 'open',
        shared: true,
        surprise: { team: true },
      });
    }
    now = at('17:25');
    sent = [];
    const res = await kiosk({
      method: 'POST',
      url: `/api/instances/${f.aliceId}/claim`,
      payload: { childId: f.alice.id, unprompted: false },
    });
    expect(res.json()).toMatchObject({ instanceId: f.aliceId });
    expect(types()).toEqual(['instance.claimed', 'instance.claimed']);
    expect(getInstance(db, f.billyId)).toMatchObject({ status: 'claimed', claimedAt: now });
    expect(getInstance(db, f.aliceId)).toMatchObject({ status: 'claimed', claimedAt: now });
  });

  it('is approved for all of them from one card (each gets the full reward), and sent back for all', async () => {
    const f = await teamUp();
    await kiosk({
      method: 'POST',
      url: `/api/instances/${f.billyId}/claim`,
      payload: { childId: f.billy.id, unprompted: false },
    });
    const back = await asPhone({
      method: 'POST',
      url: `/api/instances/${f.billyId}/send-back`,
      payload: { reason: 'not_finished' },
    });
    expect(back.statusCode).toBe(204);
    expect(getInstance(db, f.aliceId).status).toBe('open');

    await kiosk({
      method: 'POST',
      url: `/api/instances/${f.aliceId}/claim`,
      payload: { childId: f.alice.id, unprompted: false },
    });
    const ok = await asPhone({
      method: 'POST',
      url: '/api/instances/approve',
      payload: { items: [{ id: f.billyId }] },
    });
    expect(ok.json().approvals).toHaveLength(2);
    const rows = db.select().from(ledger).where(eq(ledger.kind, 'chore_points')).all();
    expect(rows.map((r) => [r.childId, r.points]).sort()).toEqual(
      [
        [f.billy.id, 20],
        [f.alice.id, 20],
      ].sort(),
    );
  });

  it('is undone one child at a time', async () => {
    const f = await teamUp();
    await kiosk({
      method: 'POST',
      url: `/api/instances/${f.billyId}/claim`,
      payload: { childId: f.billy.id, unprompted: false },
    });
    await asPhone({
      method: 'POST',
      url: '/api/instances/approve',
      payload: { items: [{ id: f.billyId }, { id: f.aliceId }] },
    });
    await asPhone({ method: 'POST', url: `/api/instances/${f.aliceId}/undo-approval` });
    expect(getInstance(db, f.aliceId).status).toBe('claimed');
    expect(getInstance(db, f.billyId).status).toBe('approved');
    const [row] = await today();
    expect(row!.takers.map((t) => t.status).sort()).toEqual(['approved', 'claimed']);
  });
});

describe('PATCH /api/surprises/:id', () => {
  it('changes a scheduled run only, and sends it now without a set time', async () => {
    const { alice } = seed();
    const task = await saveTask();
    const run = await send({ taskId: task.id, appearAt: '18:00' });
    const res = await asPhone({
      method: 'PATCH',
      url: `/api/surprises/${run.id}`,
      payload: { taskId: task.id, who: alice.id, timeFrameMin: 10, appearAt: '18:30' },
    });
    expect(res.json()).toMatchObject({ status: 'scheduled', who: alice.id, appearAt: at('18:30') });
    expect((await asPhone({ method: 'GET', url: '/api/surprise-tasks' })).json()[0]).toMatchObject({
      who: 'all',
      timeFrameMin: 30,
    });

    sent = [];
    const now2 = await asPhone({
      method: 'PATCH',
      url: `/api/surprises/${run.id}`,
      payload: { taskId: task.id },
    });
    expect(now2.json()).toMatchObject({ status: 'live' });
    expect(types()).toEqual(['surprise.updated', 'surprise.queued', 'surprise.live']);
    const again = await asPhone({
      method: 'PATCH',
      url: `/api/surprises/${run.id}`,
      payload: { taskId: task.id, appearAt: '19:00' },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('the run row', () => {
  it('copies its quest, so editing the saved one later changes nothing sent', async () => {
    seed();
    const task = await saveTask();
    const run = await send({ taskId: task.id, appearAt: '18:00' });
    await asPhone({
      method: 'PATCH',
      url: `/api/surprise-tasks/${task.id}`,
      payload: { title: 'Sweep the drive', rewardPoints: 50 },
    });
    const row = db
      .select()
      .from(surpriseRuns)
      .where(and(eq(surpriseRuns.id, run.id)))
      .get()!;
    expect(row).toMatchObject({ title: 'Sweep the patio', rewardPoints: 20 });
  });
});
