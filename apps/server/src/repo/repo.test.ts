import { zonedTimeToInstant } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { choreInstances, events, ledger } from '../db/schema';
import { ensureDay } from '../scheduler';
import { addChild, addChore, testDb } from '../test-helpers';
import { softDeleteChore } from './chores';
import { ConflictError } from './db';
import { recordEvent } from './events';
import {
  approveInstance,
  awardedPoints,
  getInstance,
  listInstancesForDate,
  undoApproval,
} from './instances';
import { appendLedger, balances, lifetimeXp, pointsToday } from './ledger';
import { updateSettings } from './settings';
import { insertParent } from './users';

const TZ = 'Europe/London';
const DAY = '2026-09-30';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
beforeEach(() => ({ db, close } = testDb()));
afterEach(() => close());

/** A child with today's "Make your bed" claimed at `claimedAt`. */
function claimedInstance(claimedAt = at('07:30'), unprompted = true) {
  const child = addChild(db);
  addChore(db, [child.id]);
  ensureDay(db, DAY, at('00:00'));
  const instance = listInstancesForDate(db, DAY).find((i) => i.childId === child.id)!;
  db.update(choreInstances)
    .set({ status: 'claimed', claimedAt, unprompted })
    .where(eq(choreInstances.id, instance.id))
    .run();
  return { child, instance };
}
const parentId = () => insertParent(db, { name: 'Mum' }).id;

describe('approveInstance', () => {
  it('stores the itemised points on the instance and one ledger row at the current rate', () => {
    const { child, instance } = claimedInstance();
    const mum = parentId();
    const chips = { early: true, unprompted: true, late: false, extra: 1 };

    const points = approveInstance(db, {
      instanceId: instance.id,
      chips,
      parentId: mum,
      now: at('19:00'),
    });

    expect(points).toEqual({ base: 5, early: 3, unprompted: 2, late: 0, extra: 1, total: 11 });
    const stored = getInstance(db, instance.id);
    expect(stored).toMatchObject({ status: 'approved', approvedBy: mum, approvedAt: at('19:00') });
    expect(awardedPoints(stored)).toEqual(points);
    expect(db.select().from(ledger).all()).toEqual([
      expect.objectContaining({
        childId: child.id,
        kind: 'chore_points',
        points: 11,
        cents: 0,
        centsPerPoint: 5,
        instanceId: instance.id,
        createdBy: mum,
      }),
    ]);
  });

  it('snapshots the rate: a later rate change does not touch earlier rows', () => {
    const { instance } = claimedInstance();
    approveInstance(db, {
      instanceId: instance.id,
      chips: { early: false, unprompted: false, late: false },
      parentId: parentId(),
      now: at('19:00'),
    });
    updateSettings(db, { centsPerPoint: 10 });
    expect(db.select().from(ledger).get()?.centsPerPoint).toBe(5);
  });

  it('never awards below 0 when the penalty is bigger than the base', () => {
    const child = addChild(db);
    addChore(db, [child.id], { basePoints: 2, latePenalty: 5 });
    ensureDay(db, DAY, 0);
    const [instance] = listInstancesForDate(db, DAY);
    db.update(choreInstances).set({ status: 'claimed' }).run();
    const points = approveInstance(db, {
      instanceId: instance!.id,
      chips: { early: false, unprompted: false, late: true },
      parentId: parentId(),
      now: 0,
    });
    expect(points).toMatchObject({ late: 5, total: 0 });
  });

  it('refuses a chore that is not claimed', () => {
    const child = addChild(db);
    addChore(db, [child.id]);
    ensureDay(db, DAY, 0);
    const [open] = listInstancesForDate(db, DAY);
    expect(() =>
      approveInstance(db, {
        instanceId: open!.id,
        chips: { early: false, unprompted: false, late: false },
        parentId: parentId(),
        now: 0,
      }),
    ).toThrow(ConflictError);
    expect(db.select().from(ledger).all()).toHaveLength(0);
  });
});

describe('undoApproval', () => {
  it('appends a reversing row, keeps the original, and returns the chore to claimed', () => {
    const { child, instance } = claimedInstance();
    const mum = parentId();
    approveInstance(db, {
      instanceId: instance.id,
      chips: { early: true, unprompted: false, late: false },
      parentId: mum,
      now: at('19:00'),
    });
    undoApproval(db, { instanceId: instance.id, parentId: mum, now: at('19:05') });

    const rows = db.select().from(ledger).all();
    expect(rows.map((r) => [r.points, r.reversesId])).toEqual([
      [8, null],
      [-8, rows[0]!.id],
    ]);
    const stored = getInstance(db, instance.id);
    expect(stored.status).toBe('claimed');
    expect(awardedPoints(stored)).toBeNull();
    expect(lifetimeXp(db).get(child.id)).toBe(0);

    // Approving again after an undo, then undoing again, only reverses the new row.
    approveInstance(db, {
      instanceId: instance.id,
      chips: { early: false, unprompted: false, late: false },
      parentId: mum,
      now: at('19:10'),
    });
    undoApproval(db, { instanceId: instance.id, parentId: mum, now: at('19:15') });
    expect(
      db
        .select()
        .from(ledger)
        .all()
        .map((r) => r.points),
    ).toEqual([8, -8, 5, -5]);
  });

  it('refuses a chore that is not approved', () => {
    const { instance } = claimedInstance();
    expect(() =>
      undoApproval(db, { instanceId: instance.id, parentId: parentId(), now: 0 }),
    ).toThrow(ConflictError);
  });
});

describe('ledger queries', () => {
  it('derives balances, XP and points today, in the family time zone', () => {
    const billy = addChild(db, 'Billy');
    const alice = addChild(db, 'Alice');
    const add = (
      childId: number,
      kind: 'chore_points' | 'bonus' | 'conversion',
      points: number,
      when: number,
      cents = 0,
    ) => appendLedger(db, { childId, kind, points, cents, at: when });

    add(billy.id, 'chore_points', 10, at('23:30', '2026-09-29')); // yesterday, 23:30 BST
    add(billy.id, 'chore_points', 7, at('00:00')); // first instant of today
    add(billy.id, 'bonus', 5, at('12:00'));
    add(billy.id, 'conversion', -4, at('18:00'), 20); // Phase 4 shape: not "earned today"
    add(billy.id, 'chore_points', 3, at('00:00', '2026-10-01')); // tomorrow
    add(alice.id, 'chore_points', 4, at('08:00'));

    const now = at('20:00');
    expect(pointsToday(db, now, TZ)).toEqual(
      new Map([
        [billy.id, 12],
        [alice.id, 4],
      ]),
    );
    expect(lifetimeXp(db)).toEqual(
      new Map([
        [billy.id, 20],
        [alice.id, 4],
      ]),
    );
    expect(balances(db)).toEqual(
      new Map([
        [billy.id, { points: 21, cents: 20 }],
        [alice.id, { points: 4, cents: 0 }],
      ]),
    );
    // In New York the 30th runs 05:00 BST on the 30th to 05:00 BST on 1 October: the
    // noon bonus and the 00:00 BST (19:00 EDT) row count; the midnight BST row doesn't.
    expect(pointsToday(db, at('04:59', '2026-10-01'), 'America/New_York').get(billy.id)).toBe(8);
  });

  it('refuses fractional amounts', () => {
    const child = addChild(db);
    expect(() =>
      appendLedger(db, { childId: child.id, kind: 'bonus', points: 1.5, at: 0 }),
    ).toThrow(TypeError);
  });
});

describe('softDeleteChore', () => {
  it('removes open chores from today on, keeps claimed ones, and skips open ones with ledger history', () => {
    const [a, b, c] = [addChild(db), addChild(db), addChild(db)];
    const chore = addChore(db, [a.id, b.id, c.id]);
    ensureDay(db, DAY, 0);
    const byChild = new Map(listInstancesForDate(db, DAY).map((i) => [i.childId, i]));
    const mum = parentId();

    db.update(choreInstances)
      .set({ status: 'claimed' })
      .where(eq(choreInstances.childId, b.id))
      .run();
    // c: approved, undone, then sent back → open again, but with ledger rows.
    db.update(choreInstances)
      .set({ status: 'claimed' })
      .where(eq(choreInstances.childId, c.id))
      .run();
    const cId = byChild.get(c.id)!.id;
    approveInstance(db, {
      instanceId: cId,
      chips: { early: false, unprompted: false, late: false },
      parentId: mum,
      now: 0,
    });
    undoApproval(db, { instanceId: cId, parentId: mum, now: 0 });
    db.update(choreInstances).set({ status: 'open' }).where(eq(choreInstances.id, cId)).run();
    recordEvent(db, { type: 'instance.sent_back', at: 0, instanceId: byChild.get(a.id)!.id });

    softDeleteChore(db, chore.id, DAY, at('10:00'));

    const left = listInstancesForDate(db, DAY).map((i) => [i.childId, i.status]);
    expect(left).toEqual([
      [b.id, 'claimed'],
      [c.id, 'skipped'],
    ]);
    expect(db.select().from(events).all()).toHaveLength(2); // day.scheduled + sent_back survive
    expect(ensureDay(db, DAY, 0).created).toBe(0);
  });
});
