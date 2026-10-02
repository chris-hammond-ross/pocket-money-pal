import { approvalSchema, trayListSchema, zonedTimeToInstant } from '@pmp/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { choreInstances, events, ledger } from '../db/schema';
import { getInstance, listInstancesForDate } from '../repo/instances';
import { balances } from '../repo/ledger';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

const TZ = 'Europe/London';
const DAY = '2026-09-30';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
let app: FastifyInstance;
let now: number;
let cookie: string;

beforeEach(async () => {
  ({ db, close } = testDb());
  now = at('18:00');
  app = await buildApp({ db, webDist: null, now: () => now });
});
afterEach(async () => {
  await app.close();
  close();
});

/**
 * Billy's bed (bonus until 08:00, due 09:00, late after 12:00: 5 + 3 early + 2 unprompted,
 * −2 late) and Alice's dishes. Mum's phone is paired.
 */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id]);
  const dishes = addChore(db, [alice.id], { title: 'Empty the dishwasher', icon: '🍽️' });
  ensureDay(db, DAY, at('00:00'));
  cookie = pairedCookie(db, mum.id);
  const find = (choreId: number, childId: number) =>
    listInstancesForDate(db, DAY).find((i) => i.choreId === choreId && i.childId === childId)!;
  return {
    mum,
    billy,
    alice,
    bedId: find(bed.id, billy.id).id,
    dishesId: find(dishes.id, alice.id).id,
  };
}

function claimAt(id: number, time: string, unprompted: boolean) {
  db.update(choreInstances)
    .set({ status: 'claimed', claimedAt: at(time), unprompted })
    .where(eq(choreInstances.id, id))
    .run();
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });
const approve = (items: object[]) =>
  asPhone({ method: 'POST', url: '/api/instances/approve', payload: { items } });

describe('GET /api/instances/claimed', () => {
  it('is the tray: every claimed chore, oldest first, with its points at claim time', async () => {
    const f = seed();
    claimAt(f.dishesId, '17:00', false);
    claimAt(f.bedId, '07:30', true);
    const res = await asPhone({ method: 'GET', url: '/api/instances/claimed' });
    const tray = trayListSchema.parse(res.json());
    expect(tray.map((t) => [t.instanceId, t.stage, t.points.total])).toEqual([
      [f.bedId, 'bonus', 10],
      [f.dishesId, 'late', 3],
    ]);
    expect(tray[0]).toMatchObject({
      title: 'Make your bed',
      childId: f.billy.id,
      unprompted: true,
    });
  });
});

describe('POST /api/instances/approve', () => {
  it('approves with the claim defaults, records it, and tells every screen', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    const broadcast = vi.spyOn(app.hub, 'broadcast');

    const res = await approve([{ id: f.bedId }]);
    expect(res.statusCode).toBe(200);
    const [approval] = res.json().approvals.map((a: unknown) => approvalSchema.parse(a));
    expect(approval).toMatchObject({
      instanceId: f.bedId,
      childId: f.billy.id,
      points: { base: 5, early: 3, unprompted: 2, late: 0, extra: 0, total: 10 },
      xpBefore: 0,
      xpAfter: 10,
      markedDone: false,
    });
    expect(broadcast).toHaveBeenCalledWith({ type: 'instance.approved', approval });

    const instance = getInstance(db, f.bedId);
    expect(instance).toMatchObject({ status: 'approved', approvedBy: f.mum.id, awardedTotal: 10 });
    // Points only: converting to money is Phase 4.
    expect(balances(db).get(f.billy.id)).toEqual({ points: 10, cents: 0 });
    expect(
      db.select().from(events).where(eq(events.type, 'instance.approved')).get(),
    ).toMatchObject({ actorId: f.mum.id, instanceId: f.bedId });
  });

  it("applies the parent's chips over the defaults", async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    const res = await approve([{ id: f.bedId, unprompted: false, extra: 4 }]);
    expect(res.json().approvals[0].points).toMatchObject({
      early: 3,
      unprompted: 0,
      extra: 4,
      total: 12,
    });
  });

  it('approves a batch in one transaction, one event per chore', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    claimAt(f.dishesId, '17:00', false);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await approve([{ id: f.bedId }, { id: f.dishesId }]);
    expect(res.statusCode).toBe(200);
    expect(broadcast.mock.calls.filter(([e]) => e.type === 'instance.approved')).toHaveLength(2);
    expect(db.select().from(ledger).all()).toHaveLength(2);
  });

  it('approves none of a batch if one is no longer claimed', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await approve([{ id: f.bedId }, { id: f.dishesId }]); // dishes is still open
    expect(res.statusCode).toBe(409);
    expect(getInstance(db, f.bedId).status).toBe('claimed');
    expect(db.select().from(ledger).all()).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown chore, 400 for a bad body, 409 approving twice', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    expect((await approve([{ id: 999 }])).statusCode).toBe(404);
    expect((await approve([])).statusCode).toBe(400);
    expect((await approve([{ id: f.bedId, late: 'yes' }])).statusCode).toBe(400);
    expect((await approve([{ id: f.bedId }])).statusCode).toBe(200);
    expect((await approve([{ id: f.bedId }])).statusCode).toBe(409);
  });

  it('refuses a request with no paired device', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    cookie = '';
    expect((await approve([{ id: f.bedId }])).statusCode).toBe(401);
    expect(getInstance(db, f.bedId).status).toBe('claimed');
  });
});

describe('POST /api/instances/:id/send-back', () => {
  it("reopens it with the parent's note and tells every screen", async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await asPhone({
      method: 'POST',
      url: `/api/instances/${f.bedId}/send-back`,
      payload: { reason: 'needs_redo' },
    });
    expect(res.statusCode).toBe(204);
    expect(getInstance(db, f.bedId)).toMatchObject({
      status: 'open',
      claimedAt: null,
      unprompted: null,
      sendBackReason: 'needs_redo',
      sentBackBy: f.mum.id,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'instance.sent_back',
      instanceId: f.bedId,
      childId: f.billy.id,
    });
    expect(
      db.select().from(events).where(eq(events.type, 'instance.sent_back')).get(),
    ).toMatchObject({ actorId: f.mum.id, data: { reason: 'needs_redo' } });
  });

  it('refuses a bad reason, and a chore that is not claimed', async () => {
    const f = seed();
    const send = (id: number, reason: string) =>
      asPhone({ method: 'POST', url: `/api/instances/${id}/send-back`, payload: { reason } });
    expect((await send(f.bedId, 'needs_redo')).statusCode).toBe(409);
    claimAt(f.bedId, '07:30', true);
    expect((await send(f.bedId, 'meh')).statusCode).toBe(400);
    expect((await send(999, 'needs_redo')).statusCode).toBe(404);
  });
});

describe('POST /api/instances/:id/mark-done', () => {
  it('claims it now for the child, "not asked" off, and approves it at once', async () => {
    const f = seed();
    now = at('08:30'); // after the bonus, before due
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await asPhone({ method: 'POST', url: `/api/instances/${f.bedId}/mark-done` });
    expect(res.statusCode).toBe(200);
    const approval = approvalSchema.parse(res.json().approvals[0]);
    expect(approval).toMatchObject({ markedDone: true, points: { total: 5, unprompted: 0 } });
    expect(broadcast).toHaveBeenCalledWith({ type: 'instance.approved', approval });
    expect(getInstance(db, f.bedId)).toMatchObject({
      status: 'approved',
      claimedAt: now,
      unprompted: false,
    });
    expect(
      db.select().from(events).where(eq(events.type, 'instance.marked_done')).get(),
    ).toBeTruthy();
  });

  it('only marks open chores from today', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    const mark = (id: number) => asPhone({ method: 'POST', url: `/api/instances/${id}/mark-done` });
    expect((await mark(f.bedId)).statusCode).toBe(409);
    now = at('08:00', '2026-10-01');
    expect((await mark(f.dishesId)).statusCode).toBe(409);
  });
});

describe('POST /api/instances/:id/undo-approval', () => {
  it('reverses the ledger row, keeps the original, and puts it back in the tray', async () => {
    const f = seed();
    claimAt(f.bedId, '07:30', true);
    await approve([{ id: f.bedId }]);
    const broadcast = vi.spyOn(app.hub, 'broadcast');
    const res = await asPhone({ method: 'POST', url: `/api/instances/${f.bedId}/undo-approval` });
    expect(res.statusCode).toBe(204);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'instance.undone',
      instanceId: f.bedId,
      childId: f.billy.id,
    });
    const rows = db
      .select()
      .from(ledger)
      .where(and(eq(ledger.instanceId, f.bedId)))
      .all();
    expect(rows.map((r) => r.points)).toEqual([10, -10]);
    expect(balances(db).get(f.billy.id)).toEqual({ points: 0, cents: 0 });
    expect(getInstance(db, f.bedId).status).toBe('claimed');
    const tray = (await asPhone({ method: 'GET', url: '/api/instances/claimed' })).json();
    expect(tray.map((t: { instanceId: number }) => t.instanceId)).toEqual([f.bedId]);

    const again = await asPhone({ method: 'POST', url: `/api/instances/${f.bedId}/undo-approval` });
    expect(again.statusCode).toBe(409);
  });
});
