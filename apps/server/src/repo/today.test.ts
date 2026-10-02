/**
 * "Edits apply to today" (spec 003, "Rules and data"): every way a parent changes a quest
 * goes through `syncToday`. These tests drive it through the repo functions the routes
 * call, and check what the kiosk, the Day tab and the tray would show afterwards.
 */
import { zonedTimeToInstant, type ChorePatch } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { choreInstances, chores, ledger } from '../db/schema';
import { ensureDay } from '../scheduler';
import { addChild, addChore, testDb } from '../test-helpers';
import { createChore, deleteChore, setSkippedToday, updateChore, type EditContext } from './chores';
import { dayPlan } from './day';
import {
  approveClaim,
  claimInstance,
  getInstance,
  listClaimed,
  listInstancesForDate,
  sendBackInstance,
  undoApprovalBy,
} from './instances';
import { balances } from './ledger';
import { kioskToday } from './kiosk';
import { updateSettings } from './settings';
import { syncToday } from './today';
import { insertParent } from './users';

const TZ = 'Europe/London';
const DAY = '2026-09-30'; // a Wednesday
const TOMORROW = '2026-10-01';
const at = (time: string, date = DAY) => zonedTimeToInstant(date, time, TZ);

let db: Db;
let close: () => void;
beforeEach(() => ({ db, close } = testDb()));
afterEach(() => close());

/**
 * Billy and Alice share "Make your bed" (bonus 17:00, due 18:00, late 19:00), every day.
 * It's 16:00 and Mum is editing on her phone.
 */
function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  const billy = addChild(db, 'Billy');
  const alice = addChild(db, 'Alice');
  const bed = addChore(db, [billy.id, alice.id], {
    bonusBefore: '17:00',
    dueBy: '18:00',
    lateAfter: '19:00',
    basePoints: 10,
    earlyBonus: 4,
    unpromptedBonus: 2,
    latePenalty: 3,
  });
  ensureDay(db, DAY, at('00:00'));
  const ctx = (time = '16:00'): EditContext => ({ today: DAY, now: at(time), parentId: mum.id });
  const today = (childId: number, choreId = bed.id) =>
    listInstancesForDate(db, DAY).find((i) => i.choreId === choreId && i.childId === childId);
  const claim = (childId: number, time = '16:30', unprompted = false) =>
    claimInstance(db, { instanceId: today(childId)!.id, childId, unprompted, now: at(time) });
  const approve = (childId: number, time = '16:45') =>
    approveClaim(db, { instanceId: today(childId)!.id, parentId: mum.id, now: at(time) });
  const edit = (patch: ChorePatch, time = '16:00') => updateChore(db, bed.id, patch, ctx(time));
  /** Each child's quests on the kiosk right now, as "title:status". */
  const kiosk = (time = '16:00') =>
    Object.fromEntries(
      kioskToday(db, at(time), { devClock: false }).children.map((c) => [
        c.name,
        c.quests.map((q) => `${q.title}:${q.status}`),
      ]),
    );
  const dayQuest = (time = '16:00') =>
    dayPlan(db, DAY, at(time)).quests.find((q) => q.chore.id === bed.id);
  return { mum, billy, alice, bed, ctx, today, claim, approve, edit, kiosk, dayQuest };
}

describe('changing times and loot', () => {
  it('moves open and skipped chores to the new window and loot', () => {
    const f = seed();
    setSkippedToday(db, f.bed.id, true, f.ctx());
    f.edit({ dueBy: '18:30', lateAfter: '20:00', basePoints: 20 });
    expect(f.today(f.alice.id)).toMatchObject({
      status: 'skipped',
      dueBy: '18:30',
      lateAfter: '20:00',
      basePoints: 20,
    });
    setSkippedToday(db, f.bed.id, false, f.ctx());
    expect(f.today(f.billy.id)).toMatchObject({ status: 'open', dueBy: '18:30', basePoints: 20 });
  });

  it('a claimed chore keeps its window, claim time and pending points', () => {
    const f = seed();
    const claimed = f.claim(f.billy.id, '16:30');
    // Bonus time now ends before the claim, and every loot value changes.
    f.edit({ bonusBefore: '16:00', basePoints: 1, earlyBonus: 0, unpromptedBonus: 0 });
    const billys = getInstance(db, claimed.instanceId);
    expect(billys).toMatchObject({
      status: 'claimed',
      claimedAt: at('16:30'),
      bonusBefore: '17:00',
      basePoints: 10,
      earlyBonus: 4,
    });
    expect(listClaimed(db)[0]).toMatchObject({ stage: 'bonus', points: { total: 14 } });
    expect(f.today(f.alice.id)).toMatchObject({ bonusBefore: '16:00', basePoints: 1 });
  });

  it('approving after the edit scores against the window the child claimed in', () => {
    const f = seed();
    f.claim(f.billy.id, '16:30');
    f.edit({ bonusBefore: '16:00', dueBy: '16:15', lateAfter: '16:15', latePenalty: 10 });
    const approval = f.approve(f.billy.id, '17:30');
    expect(approval.points).toMatchObject({ base: 10, early: 4, late: 0, total: 14 });
  });

  it('an approved chore keeps its window and awarded points, and the ledger is untouched', () => {
    const f = seed();
    f.claim(f.alice.id, '16:30');
    f.approve(f.alice.id);
    f.edit({ basePoints: 50, dueBy: '17:30' });
    expect(f.today(f.alice.id)).toMatchObject({
      status: 'approved',
      dueBy: '18:00',
      basePoints: 10,
      awardedTotal: 14,
    });
    expect(db.select().from(ledger).all()).toHaveLength(1);
    expect(balances(db).get(f.alice.id)?.points).toBe(14);
  });

  it('a sent-back chore takes the new window and keeps its note', () => {
    const f = seed();
    f.claim(f.billy.id);
    sendBackInstance(db, {
      instanceId: f.today(f.billy.id)!.id,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('16:40'),
    });
    f.edit({ dueBy: '18:30', lateAfter: '19:30' });
    expect(f.today(f.billy.id)).toMatchObject({
      status: 'open',
      dueBy: '18:30',
      sendBackReason: 'needs_redo',
    });
  });

  it("leaves other days' instances alone", () => {
    const f = seed();
    ensureDay(db, TOMORROW, at('00:00', TOMORROW));
    f.edit({ dueBy: '18:30', lateAfter: '20:00' });
    expect(
      listInstancesForDate(db, TOMORROW).every((i) => i.dueBy === '18:00' && i.status === 'open'),
    ).toBe(true);
  });
});

describe('removing a player', () => {
  it('deletes their open chore today', () => {
    const f = seed();
    f.edit({ childIds: [f.alice.id] });
    expect(f.today(f.billy.id)).toBeUndefined();
    expect(f.kiosk().Billy).toEqual([]);
  });

  it('keeps their claimed chore in the tray, and it can still be approved', () => {
    const f = seed();
    const claimed = f.claim(f.billy.id);
    f.edit({ childIds: [f.alice.id] });
    expect(listClaimed(db).map((t) => t.instanceId)).toEqual([claimed.instanceId]);
    expect(f.kiosk().Billy).toEqual(['Make your bed:claimed']);
    expect(f.dayQuest()!.instances.map((i) => [i.childId, i.status])).toEqual([
      [f.billy.id, 'claimed'],
      [f.alice.id, 'open'],
    ]);
    f.approve(f.billy.id);
    expect(getInstance(db, claimed.instanceId).status).toBe('approved');
    expect(balances(db).get(f.billy.id)?.points).toBe(14);
  });

  it('sending their claimed chore back takes it off the kiosk instead of reopening it', () => {
    const f = seed();
    const claimed = f.claim(f.billy.id);
    f.edit({ childIds: [f.alice.id] });
    sendBackInstance(db, {
      instanceId: claimed.instanceId,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('16:40'),
    });
    expect(f.today(f.billy.id)).toBeUndefined();
    expect(f.kiosk().Billy).toEqual([]);
    expect(listClaimed(db)).toEqual([]);
  });

  it('undoing their approved chore puts it back in the tray, not on the kiosk', () => {
    const f = seed();
    const claimed = f.claim(f.billy.id);
    f.approve(f.billy.id);
    f.edit({ childIds: [f.alice.id] });
    expect(f.today(f.billy.id)!.status).toBe('approved');
    undoApprovalBy(db, { instanceId: claimed.instanceId, parentId: f.mum.id, now: at('17:00') });
    expect(listClaimed(db).map((t) => t.instanceId)).toEqual([claimed.instanceId]);
    expect(balances(db).get(f.billy.id)?.points).toBe(0);
  });

  it('an open chore with ledger history is parked (not deleted), and hidden everywhere', () => {
    const f = seed();
    const claimed = f.claim(f.billy.id);
    f.approve(f.billy.id);
    undoApprovalBy(db, { instanceId: claimed.instanceId, parentId: f.mum.id, now: at('16:50') });
    sendBackInstance(db, {
      instanceId: claimed.instanceId,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('16:51'),
    });
    f.edit({ childIds: [f.alice.id] });
    expect(getInstance(db, claimed.instanceId).status).toBe('skipped');
    expect(db.select().from(ledger).all()).toHaveLength(2);
    expect(f.kiosk().Billy).toEqual([]);
    expect(f.dayQuest()).toMatchObject({ skipped: false });
    expect(f.dayQuest()!.instances.map((i) => i.childId)).toEqual([f.alice.id]);
  });

  it("a parked chore doesn't make the quest look skipped, or come back on Put back", () => {
    const f = seed();
    const claimed = f.claim(f.billy.id);
    f.approve(f.billy.id);
    undoApprovalBy(db, { instanceId: claimed.instanceId, parentId: f.mum.id, now: at('16:50') });
    sendBackInstance(db, {
      instanceId: claimed.instanceId,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('16:51'),
    });
    f.claim(f.alice.id, '16:55');
    f.edit({ childIds: [f.alice.id] }); // Billy's is parked; Alice's is claimed
    expect(f.dayQuest()!.skipped).toBe(false);

    // Swap Alice for a new player: they must join open, not skipped.
    const sam = addChild(db, 'Sam');
    f.edit({ childIds: [sam.id] });
    expect(f.today(sam.id)!.status).toBe('open');

    setSkippedToday(db, f.bed.id, true, f.ctx());
    setSkippedToday(db, f.bed.id, false, f.ctx());
    expect(f.today(f.billy.id)!.status).toBe('skipped');
    expect(f.kiosk().Billy).toEqual([]);
    expect(f.kiosk().Sam).toEqual(['Make your bed:open']);
  });

  it('adding them back reopens a parked chore and leaves a claim alone, with no duplicates', () => {
    const f = seed();
    const billys = parkable(f);
    f.claim(f.alice.id, '16:55');
    const sam = addChild(db, 'Sam');
    f.edit({ childIds: [sam.id] });
    expect(f.today(f.billy.id)!.status).toBe('skipped');

    f.edit({ childIds: [sam.id, f.billy.id, f.alice.id] });
    expect(getInstance(db, billys).status).toBe('open');
    expect(f.today(f.alice.id)!.status).toBe('claimed');
    expect(listInstancesForDate(db, DAY)).toHaveLength(3);
    expect(f.kiosk()).toEqual({
      Billy: ['Make your bed:open'],
      Alice: ['Make your bed:claimed'],
      Sam: ['Make your bed:open'],
    });
  });
});

/**
 * Billy's chore was approved, undone and sent back: open again, but with two ledger rows,
 * so it can't be deleted. Returns its instance id.
 */
function parkable(f: ReturnType<typeof seed>): number {
  const { instanceId } = f.claim(f.billy.id);
  f.approve(f.billy.id);
  undoApprovalBy(db, { instanceId, parentId: f.mum.id, now: at('16:50') });
  sendBackInstance(db, { instanceId, reason: 'needs_redo', parentId: f.mum.id, now: at('16:51') });
  return instanceId;
}

describe('adding a player', () => {
  it("creates their open chore today, with today's times", () => {
    const f = seed();
    const sam = addChild(db, 'Sam');
    f.edit({ childIds: [f.billy.id, f.alice.id, sam.id], dueBy: '18:15' });
    expect(f.today(sam.id)).toMatchObject({ status: 'open', dueBy: '18:15' });
  });

  it('joins skipped while the quest is skipped today, and Put back opens theirs too', () => {
    const f = seed();
    setSkippedToday(db, f.bed.id, true, f.ctx());
    const sam = addChild(db, 'Sam');
    f.edit({ childIds: [f.billy.id, f.alice.id, sam.id] });
    expect(f.today(sam.id)!.status).toBe('skipped');
    setSkippedToday(db, f.bed.id, false, f.ctx());
    expect(f.today(sam.id)!.status).toBe('open');
  });

  it("joins skipped even when everyone else's chore is already claimed", () => {
    const f = seed();
    setSkippedToday(db, f.bed.id, true, f.ctx());
    db.update(choreInstances)
      .set({ status: 'claimed', claimedAt: at('16:10') })
      .run();
    const sam = addChild(db, 'Sam');
    f.edit({ childIds: [f.billy.id, f.alice.id, sam.id] });
    expect(f.today(sam.id)!.status).toBe('skipped');
  });
});

describe('changing the days', () => {
  it('switching today off removes open chores only; switching it back brings them back', () => {
    const f = seed();
    f.claim(f.billy.id);
    f.edit({ days: ['mon', 'tue', 'thu'] });
    expect(f.today(f.alice.id)).toBeUndefined();
    expect(f.today(f.billy.id)!.status).toBe('claimed');
    expect(f.kiosk()).toEqual({ Billy: ['Make your bed:claimed'], Alice: [] });

    f.edit({ days: ['mon', 'tue', 'wed', 'thu'] });
    expect(f.today(f.alice.id)!.status).toBe('open');
    expect(f.today(f.billy.id)!.status).toBe('claimed');
    expect(listInstancesForDate(db, DAY)).toHaveLength(2);
  });

  it('a claim sent back after today was switched off leaves the kiosk', () => {
    const f = seed();
    const { instanceId } = f.claim(f.billy.id);
    f.edit({ days: ['mon'] });
    sendBackInstance(db, {
      instanceId,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('16:40'),
    });
    expect(f.today(f.billy.id)).toBeUndefined();
  });

  it('turning it into a one-off for another day removes today; for today keeps it', () => {
    const f = seed();
    f.edit({ days: [], oneOffDate: DAY });
    expect(f.today(f.alice.id)!.status).toBe('open');
    f.edit({ oneOffDate: TOMORROW });
    expect(f.today(f.alice.id)).toBeUndefined();
  });

  it('on a paused day an edit creates nothing', () => {
    const f = seed();
    updateSettings(db, { pause: { from: DAY, until: null } });
    const sam = addChild(db, 'Sam');
    f.edit({ childIds: [f.billy.id, f.alice.id, sam.id] });
    expect(f.today(sam.id)).toBeUndefined();
  });
});

describe('skip today', () => {
  it('skips open chores only; a claim sent back while skipped comes back skipped', () => {
    const f = seed();
    const { instanceId } = f.claim(f.billy.id);
    setSkippedToday(db, f.bed.id, true, f.ctx());
    expect(f.today(f.alice.id)!.status).toBe('skipped');
    expect(f.today(f.billy.id)!.status).toBe('claimed');
    expect(f.dayQuest()!.skipped).toBe(true);

    sendBackInstance(db, {
      instanceId,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('16:40'),
    });
    expect(f.today(f.billy.id)).toMatchObject({ status: 'skipped', sendBackReason: 'needs_redo' });
    expect(f.kiosk()).toEqual({ Billy: [], Alice: [] });
  });

  it('a quest skipped with every chore claimed still reads as skipped on the Day tab', () => {
    const f = seed();
    f.claim(f.billy.id);
    f.claim(f.alice.id);
    setSkippedToday(db, f.bed.id, true, f.ctx());
    expect(f.dayQuest()!.skipped).toBe(true);
    setSkippedToday(db, f.bed.id, false, f.ctx());
    expect(f.dayQuest()!.skipped).toBe(false);
  });

  it('lasts for today only, and survives the scheduler running again', () => {
    const f = seed();
    setSkippedToday(db, f.bed.id, true, f.ctx());
    expect(ensureDay(db, DAY, at('16:05')).created).toBe(0);
    expect(f.today(f.alice.id)!.status).toBe('skipped');
    ensureDay(db, TOMORROW, at('00:00', TOMORROW));
    expect(listInstancesForDate(db, TOMORROW).map((i) => i.status)).toEqual(['open', 'open']);
  });

  it('returns how many chores moved', () => {
    const f = seed();
    f.claim(f.billy.id);
    expect(setSkippedToday(db, f.bed.id, true, f.ctx())).toBe(1);
    expect(setSkippedToday(db, f.bed.id, true, f.ctx())).toBe(0);
    expect(setSkippedToday(db, f.bed.id, false, f.ctx())).toBe(1);
  });
});

describe('deleting a quest', () => {
  it("keeps today's approved chore and the ledger, and removes the open one", () => {
    const f = seed();
    f.claim(f.billy.id);
    f.approve(f.billy.id);
    deleteChore(db, f.bed.id, f.ctx('17:00'));
    expect(f.today(f.billy.id)).toMatchObject({ status: 'approved', awardedTotal: 14 });
    expect(f.today(f.alice.id)).toBeUndefined();
    expect(balances(db).get(f.billy.id)?.points).toBe(14);
    expect(f.kiosk('17:00')).toEqual({ Billy: ['Make your bed:approved'], Alice: [] });
  });

  it('undoing that approval afterwards puts it in the tray; sending it back parks it', () => {
    const f = seed();
    const { instanceId } = f.claim(f.billy.id);
    f.approve(f.billy.id);
    deleteChore(db, f.bed.id, f.ctx('17:00'));
    undoApprovalBy(db, { instanceId, parentId: f.mum.id, now: at('17:05') });
    expect(listClaimed(db).map((t) => t.instanceId)).toEqual([instanceId]);
    expect(balances(db).get(f.billy.id)?.points).toBe(0);
    sendBackInstance(db, {
      instanceId,
      reason: 'needs_redo',
      parentId: f.mum.id,
      now: at('17:06'),
    });
    expect(getInstance(db, instanceId).status).toBe('skipped');
    expect(f.kiosk('17:06')).toEqual({ Billy: [], Alice: [] });
  });

  it('keeps a claimed chore in the tray until a parent handles it', () => {
    const f = seed();
    const { instanceId } = f.claim(f.alice.id);
    deleteChore(db, f.bed.id, f.ctx());
    expect(listClaimed(db).map((t) => t.instanceId)).toEqual([instanceId]);
    expect(f.approve(f.alice.id).points.total).toBe(10 + 4);
  });

  it('a parked chore of a deleted quest stays parked, and the scheduler never brings it back', () => {
    const f = seed();
    const billys = parkable(f);
    deleteChore(db, f.bed.id, f.ctx('17:00'));
    expect(getInstance(db, billys).status).toBe('skipped');
    expect(ensureDay(db, DAY, at('17:01')).created).toBe(0);
    ensureDay(db, TOMORROW, at('00:00', TOMORROW));
    expect(listInstancesForDate(db, TOMORROW)).toEqual([]);
  });
});

describe('creating a quest', () => {
  it("makes today's open chores only if it runs today and the day isn't paused", () => {
    const f = seed();
    const input = {
      title: 'Feed the cat',
      icon: '🐱',
      together: false,
      bonusBefore: '17:00',
      dueBy: '17:30',
      lateAfter: '18:00',
      basePoints: 5,
      earlyBonus: 0,
      unpromptedBonus: 0,
      latePenalty: 0,
      days: ['wed' as const],
      oneOffDate: null,
      childIds: [f.alice.id],
    };
    const cat = createChore(db, input, f.ctx());
    expect(f.today(f.alice.id, cat.id)!.status).toBe('open');
    const sat = createChore(db, { ...input, days: ['sat'] }, f.ctx());
    expect(f.today(f.alice.id, sat.id)).toBeUndefined();
    updateSettings(db, { pause: { from: DAY, until: DAY } });
    const paused = createChore(db, input, f.ctx());
    expect(f.today(f.alice.id, paused.id)).toBeUndefined();
  });
});

describe('syncToday', () => {
  it('is idempotent', () => {
    const f = seed();
    f.claim(f.billy.id);
    const before = listInstancesForDate(db, DAY);
    syncToday(db, f.bed.id, DAY);
    syncToday(db, f.bed.id, DAY);
    expect(listInstancesForDate(db, DAY)).toEqual(before);
  });

  it('only touches the given chore', () => {
    const f = seed();
    const bins = addChore(db, [f.billy.id], { title: 'Bins' });
    ensureDay(db, DAY, at('00:00'));
    db.update(chores)
      .set({ dueBy: '12:00', lateAfter: '12:00' })
      .where(eq(chores.id, f.bed.id))
      .run();
    syncToday(db, f.bed.id, DAY);
    expect(f.today(f.billy.id, bins.id)!.dueBy).toBe('09:00');
    expect(f.today(f.billy.id)!.dueBy).toBe('12:00');
  });
});
