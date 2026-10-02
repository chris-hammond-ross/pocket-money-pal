import { claimResultSchema, zonedTimeToInstant } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { ServerClock } from '../clock';
import type { Db } from '../db/client';
import { choreInstances, events, ledger } from '../db/schema';
import { getInstance, listInstancesForDate } from '../repo/instances';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, testDb } from '../test-helpers';

const TZ = 'Europe/London';
const DAY = '2026-09-30';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;

beforeEach(() => {
  ({ db, close } = testDb());
  now = at('16:40');
});
afterEach(async () => {
  await app?.close();
  close();
});

async function start(opts: { devClock?: ServerClock } = {}) {
  app = await buildApp({
    db,
    webDist: null,
    now: opts.devClock ? undefined : () => now,
    ...opts,
  });
  return app;
}

/** Billy and Alice share the tidy-up (bonus until 17:00); Billy also has the dishes. */
function seed() {
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const mum = insertParent(db, { name: 'Mum' });
  const loot = { basePoints: 10, earlyBonus: 5, unpromptedBonus: 5, latePenalty: 3 };
  const tidy = addChore(db, [billy.id, alice.id], {
    title: 'Tidy shared bedroom',
    together: true,
    bonusBefore: '17:00',
    dueBy: '18:30',
    lateAfter: '19:30',
    ...loot,
  });
  const dishes = addChore(db, [billy.id], {
    title: 'Empty the dishwasher',
    bonusBefore: '16:30',
    dueBy: '17:30',
    lateAfter: '19:00',
    ...loot,
  });
  ensureDay(db, DAY, at('00:00'));
  const find = (choreId: number, childId: number, date = DAY) =>
    listInstancesForDate(db, date).find((i) => i.choreId === choreId && i.childId === childId)!;
  return { billy, alice, mum, tidy, dishes, find };
}

function claim(id: number | string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/instances/${id}/claim`, payload });
}

describe('POST /api/instances/:id/claim', () => {
  it('claims an open quest in bonus time, and tells every screen', async () => {
    const f = seed();
    await start();
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const tidy = f.find(f.tidy.id, f.billy.id);

    const res = await claim(tidy.id, { childId: f.billy.id, unprompted: true });
    expect(res.statusCode).toBe(200);
    const body = claimResultSchema.parse(res.json());
    expect(body).toEqual({
      instanceId: tidy.id,
      childId: f.billy.id,
      claimedAt: now,
      unprompted: true,
      stage: 'bonus',
      points: { base: 10, early: 5, unprompted: 5, late: 0, extra: 0, total: 20 },
    });
    expect(broadcast).toHaveBeenCalledWith({ type: 'instance.claimed', claim: body });

    expect(getInstance(db, tidy.id)).toMatchObject({
      status: 'claimed',
      claimedAt: now,
      unprompted: true,
    });
  });

  it('records the claim in events, and writes nothing to the ledger', async () => {
    const f = seed();
    await start();
    const tidy = f.find(f.tidy.id, f.billy.id);
    await claim(tidy.id, { childId: f.billy.id, unprompted: false });

    const rows = db.select().from(events).where(eq(events.type, 'instance.claimed')).all();
    expect(rows).toEqual([
      expect.objectContaining({
        at: now,
        actorId: f.billy.id,
        childId: f.billy.id,
        choreId: f.tidy.id,
        instanceId: tidy.id,
        data: { unprompted: false },
      }),
    ]);
    expect(db.select().from(ledger).all()).toEqual([]);
  });

  it('scores a claim after the bonus without it, and a late one with the penalty', async () => {
    const f = seed();
    await start();
    // 16:40: the dishes' bonus ended at 16:30.
    let res = await claim(f.find(f.dishes.id, f.billy.id).id, {
      childId: f.billy.id,
      unprompted: false,
    });
    expect(res.json()).toMatchObject({ stage: 'due', points: { total: 10 } });

    now = at('19:31');
    res = await claim(f.find(f.tidy.id, f.alice.id).id, { childId: f.alice.id, unprompted: true });
    expect(res.json()).toMatchObject({
      stage: 'late',
      points: { base: 10, early: 0, unprompted: 5, late: 3, total: 12 },
    });
  });

  it('scores on the development clock when it is moved', async () => {
    const f = seed();
    const clock = new ServerClock(() => now);
    await start({ devClock: clock });
    await app.inject({ method: 'PUT', url: '/api/dev/clock', payload: { at: '18:40' } });

    const res = await claim(f.find(f.tidy.id, f.billy.id).id, {
      childId: f.billy.id,
      unprompted: false,
    });
    expect(res.json()).toMatchObject({ claimedAt: at('18:40'), stage: 'overdue' });
  });

  it('refuses a second claim of the same quest', async () => {
    const f = seed();
    await start();
    const tidy = f.find(f.tidy.id, f.billy.id);
    expect((await claim(tidy.id, { childId: f.billy.id, unprompted: true })).statusCode).toBe(200);

    now += 5_000;
    const again = await claim(tidy.id, { childId: f.billy.id, unprompted: false });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'not-open' });
    // The first claim stands.
    expect(getInstance(db, tidy.id)).toMatchObject({ claimedAt: at('16:40'), unprompted: true });
  });

  it("refuses to claim another child's copy of a shared chore", async () => {
    const f = seed();
    await start();
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const alicesTidy = f.find(f.tidy.id, f.alice.id);

    const res = await claim(alicesTidy.id, { childId: f.billy.id, unprompted: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'wrong-child' });
    expect(getInstance(db, alicesTidy.id).status).toBe('open');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses approved and skipped quests', async () => {
    const f = seed();
    await start();
    const tidy = f.find(f.tidy.id, f.billy.id);
    const dishes = f.find(f.dishes.id, f.billy.id);
    db.update(choreInstances)
      .set({ status: 'approved' })
      .where(eq(choreInstances.id, tidy.id))
      .run();
    db.update(choreInstances)
      .set({ status: 'skipped' })
      .where(eq(choreInstances.id, dishes.id))
      .run();

    for (const id of [tidy.id, dishes.id]) {
      const res = await claim(id, { childId: f.billy.id, unprompted: true });
      expect(res.statusCode).toBe(409);
    }
  });

  it("refuses yesterday's leftover quest", async () => {
    const f = seed();
    ensureDay(db, '2026-10-01', at('00:00', '2026-10-01'));
    now = at('09:00', '2026-10-01');
    await start();

    const yesterday = await claim(f.find(f.tidy.id, f.billy.id).id, {
      childId: f.billy.id,
      unprompted: true,
    });
    expect(yesterday.statusCode).toBe(409);
    expect(yesterday.json()).toEqual({ error: 'not-today' });

    const today = await claim(f.find(f.tidy.id, f.billy.id, '2026-10-01').id, {
      childId: f.billy.id,
      unprompted: true,
    });
    expect(today.statusCode).toBe(200);
  });

  it('clears the send-back note when the child claims again', async () => {
    const f = seed();
    await start();
    const tidy = f.find(f.tidy.id, f.billy.id);
    db.update(choreInstances)
      .set({ sendBackReason: 'needs_redo', sentBackBy: f.mum.id })
      .where(eq(choreInstances.id, tidy.id))
      .run();

    await claim(tidy.id, { childId: f.billy.id, unprompted: false });
    expect(getInstance(db, tidy.id)).toMatchObject({
      status: 'claimed',
      sendBackReason: null,
      sentBackBy: null,
    });
  });

  it.each([
    [{}],
    [{ childId: 1 }],
    [{ unprompted: true }],
    [{ childId: '1', unprompted: true }],
    [{ childId: 1, unprompted: 'yes' }],
  ])('refuses the body %j', async (payload) => {
    seed();
    await start();
    expect((await claim(1, payload)).statusCode).toBe(400);
  });

  it.each(['999', 'abc', '0', '-1', '1.5'])('answers 404 for the instance %s', async (id) => {
    const f = seed();
    await start();
    const res = await claim(id, { childId: f.billy.id, unprompted: true });
    expect(res.statusCode).toBe(404);
  });
});
