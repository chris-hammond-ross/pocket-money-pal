import { describe, expect, it } from 'vitest';
import { formatMoneyShort } from './money';
import {
  amountStepCents,
  conversionFor,
  earningAverages,
  jarMilestones,
  jarProgress,
  jarStats,
  jarStatsText,
  milestonesCrossed,
  moveLimits,
  moveProblem,
  pendingConversion,
  pourStepCents,
  quickAmounts,
  stepPrice,
  summariseMoney,
  type MoneyLedgerKind,
  type MoneyLedgerRow,
} from './savings';

let nextId = 1;
function row(
  kind: MoneyLedgerKind,
  fields: Partial<Omit<MoneyLedgerRow, 'kind'>> = {},
): MoneyLedgerRow {
  return {
    id: nextId++,
    kind,
    points: 0,
    cents: 0,
    centsPerPoint: null,
    goalId: null,
    ...fields,
  };
}
const points = (n: number, rate = 5, kind: MoneyLedgerKind = 'chore_points') =>
  row(kind, { points: n, centsPerPoint: rate });

describe('pendingConversion', () => {
  it('is zero for a child with no history yet', () => {
    expect(pendingConversion([], 5)).toEqual({ points: 0, cents: 0 });
    expect(conversionFor([], 5)).toBeNull();
  });

  it('converts each row at its own rate, so a mid-week rate change applies from then on', () => {
    // Monday to Wednesday at 5p, then the rate goes up to 10p.
    const rows = [points(20, 5), points(10, 5), points(15, 10), points(5, 10, 'bonus')];
    expect(pendingConversion(rows, 10)).toEqual({ points: 50, cents: 30 * 5 + 20 * 10 });
  });

  it('only counts rows after the last conversion', () => {
    const rows = [
      points(40),
      row('conversion', { points: -40, cents: 200 }),
      points(12),
      points(-2, 5, 'penalty'),
    ];
    expect(pendingConversion(rows, 5)).toEqual({ points: 10, cents: 50 });
  });

  it('takes an undo after payday off the next pot, at the original rate', () => {
    const approved = points(20, 5);
    const rows = [
      approved,
      row('conversion', { points: -20, cents: 100 }),
      // The rate has gone up since, but the reversal keeps the original's 5p.
      row('chore_points', { points: -20, centsPerPoint: 5 }),
      points(30, 10),
    ];
    expect(pendingConversion(rows, 10)).toEqual({ points: 10, cents: -100 + 300 });
  });

  it('ignores rows that move money only', () => {
    const rows = [
      points(10),
      row('extra_income', { cents: 2000 }),
      row('goal_allocation', { cents: 500, goalId: 1 }),
      row('spend', { cents: -300 }),
    ];
    expect(pendingConversion(rows, 5)).toEqual({ points: 10, cents: 50 });
  });

  it('uses the current rate for a row with none', () => {
    expect(pendingConversion([row('adjustment', { points: 4 })], 7)).toEqual({
      points: 4,
      cents: 28,
    });
  });
});

describe('conversionFor', () => {
  it('converts positive points', () => {
    expect(conversionFor([points(23)], 5)).toEqual({ points: 23, cents: 115 });
  });

  it('carries zero or negative points over', () => {
    expect(conversionFor([points(5), points(-5, 5, 'penalty')], 5)).toBeNull();
    expect(conversionFor([points(-8, 5, 'penalty')], 5)).toBeNull();
  });

  it('carries over points that would be worth no money', () => {
    // 10 points at 1p, minus 9 at 5p: 1 point, but −35p.
    expect(conversionFor([points(10, 1), points(-9, 5, 'penalty')], 5)).toBeNull();
  });

  it('includes a carried-over negative week in the next payday', () => {
    const rows = [points(-5, 5, 'penalty'), points(20, 5)];
    expect(conversionFor(rows, 5)).toEqual({ points: 15, cents: 75 });
  });
});

describe('summariseMoney', () => {
  it('is all zero for a child with no history yet', () => {
    const m = summariseMoney([], [], 5);
    expect(m.savedCents).toBe(0);
    expect(m.toSortCents).toBe(0);
    expect(m.jarCents.size).toBe(0);
    expect(m.unconverted).toEqual({ points: 0, cents: 0 });
  });

  it('rebuilds saved, to sort, each jar and unconverted points from the ledger alone', () => {
    const PS5 = 1;
    const BALL = 2;
    const OLD = 3; // deleted: its money went back to "to sort"
    const rows = [
      points(100),
      row('conversion', { points: -100, cents: 500 }),
      row('extra_income', { cents: 2000 }),
      row('goal_allocation', { cents: 1500, goalId: PS5 }),
      row('goal_allocation', { cents: 600, goalId: BALL }),
      row('goal_allocation', { cents: -100, goalId: BALL }),
      row('goal_allocation', { cents: 200, goalId: OLD }),
      row('goal_allocation', { cents: -200, goalId: OLD }),
      row('spend', { cents: -300 }), // from "to sort"
      row('spend', { cents: -250, goalId: PS5 }), // from a jar
      points(12),
    ];
    const m = summariseMoney(rows, [PS5, BALL], 5);
    expect(m.savedCents).toBe(500 + 2000 - 300 - 250);
    expect(m.jarCents.get(PS5)).toBe(1250);
    expect(m.jarCents.get(BALL)).toBe(500);
    expect(m.jarCents.get(OLD)).toBe(0);
    expect(m.toSortCents).toBe(1950 - 1250 - 500);
    expect(m.unconverted).toEqual({ points: 12, cents: 60 });
  });

  it('takes a bought jar out of saved without touching "to sort"', () => {
    const JAR = 9;
    const rows = [
      row('extra_income', { cents: 3000 }),
      row('goal_allocation', { cents: 2499, goalId: JAR }),
      row('spend', { cents: -2499, goalId: JAR }),
    ];
    const m = summariseMoney(rows, [], 5);
    expect(m.savedCents).toBe(501);
    expect(m.toSortCents).toBe(501);
    expect(m.jarCents.get(JAR)).toBe(0);
  });
});

describe('jars and milestones', () => {
  it('fills a jar of £100 or less against its price', () => {
    expect(jarMilestones(2499)).toEqual([2499]);
    expect(jarMilestones(10_000)).toEqual([10_000]);
    const p = jarProgress(1200, 2499);
    expect(p).toMatchObject({ big: false, full: false, fillToCents: 2499, passed: [] });
    expect(p.fill).toBeCloseTo(1200 / 2499);
    expect(p.nextMilestoneCents).toBeNull();
  });

  it('fills a big jar towards its next milestone', () => {
    expect(jarMilestones(47_999)).toEqual([
      1000, 2500, 5000, 10_000, 20_000, 30_000, 40_000, 47_999,
    ]);
    const p = jarProgress(2000, 47_999);
    expect(p).toMatchObject({
      big: true,
      full: false,
      fillToCents: 2500,
      fill: 0.8,
      passed: [1000],
      nextMilestoneCents: 2500,
    });
  });

  it('counts a milestone as passed exactly at it', () => {
    expect(jarProgress(2500, 47_999)).toMatchObject({ fillToCents: 5000, passed: [1000, 2500] });
  });

  it('fills towards the price once the last milestone is passed', () => {
    expect(jarProgress(45_000, 47_999)).toMatchObject({
      fillToCents: 47_999,
      nextMilestoneCents: null,
    });
  });

  it('is full at or over the price', () => {
    expect(jarProgress(2499, 2499)).toMatchObject({ full: true, fill: 1 });
    expect(jarProgress(48_000, 47_999)).toMatchObject({ full: true, fill: 1, fillToCents: 47_999 });
  });

  it('is empty at zero', () => {
    expect(jarProgress(0, 47_999)).toMatchObject({ fill: 0, fillToCents: 1000, passed: [] });
  });

  it('reports the milestones a pour passed', () => {
    expect(milestonesCrossed(900, 2600, 47_999)).toEqual([1000, 2500]);
    expect(milestonesCrossed(1000, 1500, 47_999)).toEqual([]);
    expect(milestonesCrossed(2400, 2500, 47_999)).toEqual([2500]);
    expect(milestonesCrossed(0, 2499, 2499)).toEqual([]); // a normal jar has none
    expect(milestonesCrossed(40_000, 47_999, 47_999)).toEqual([]); // the price is "full"
  });
});

describe('moving coins', () => {
  const jar = { toSortCents: 825, inCents: 500, targetCents: 1000, smashed: false };

  it('limits "put in" to the smaller of "to sort" and the room left', () => {
    expect(moveLimits(jar)).toEqual({ maxIn: 500, maxOut: 500 });
    expect(moveLimits({ ...jar, toSortCents: 125 })).toEqual({ maxIn: 125, maxOut: 500 });
  });

  it('has no room in a full jar and nothing to take from an empty one', () => {
    expect(moveLimits({ ...jar, inCents: 1000 }).maxIn).toBe(0);
    expect(moveLimits({ ...jar, inCents: 0 }).maxOut).toBe(0);
    expect(moveLimits({ ...jar, toSortCents: 0 }).maxIn).toBe(0);
  });

  it('allows nothing on a smashed jar', () => {
    expect(moveLimits({ ...jar, smashed: true })).toEqual({ maxIn: 0, maxOut: 0 });
  });

  it('refuses moves that do not fit', () => {
    const limits = moveLimits(jar);
    expect(moveProblem(500, limits)).toBeNull();
    expect(moveProblem(-500, limits)).toBeNull();
    expect(moveProblem(510, limits)).toBe('too-much-in');
    expect(moveProblem(-510, limits)).toBe('too-much-out');
    expect(moveProblem(0, limits)).toBe('zero');
  });

  it('pours faster the longer a jar is held', () => {
    expect([0, 1499, 1500, 2999, 3000, 4499, 4500, 9000].map(pourStepCents)).toEqual([
      10, 10, 25, 25, 50, 50, 100, 100,
    ]);
  });

  it('steps the pop-up in 10p, or 50p from £5', () => {
    expect(amountStepCents(499)).toBe(10);
    expect(amountStepCents(500)).toBe(50);
    expect(quickAmounts(125)).toEqual([100]);
    expect(quickAmounts(1000)).toEqual([100, 500]);
    expect(quickAmounts(5000)).toEqual([100, 500, 1000]);
    expect(quickAmounts(100)).toEqual([]);
  });

  it('steps a new jar price by the chosen step, within £1–£1,000', () => {
    expect(stepPrice(1000, 1, 100)).toBe(1100);
    expect(stepPrice(1000, 1, 2500)).toBe(3500);
    expect(stepPrice(3500, -1, 500)).toBe(3000);
    expect(stepPrice(1000, -1, 2500)).toBe(100);
    expect(stepPrice(100, -1, 100)).toBe(100);
    expect(stepPrice(95_000, 1, 10_000)).toBe(100_000);
  });
});

describe('earningAverages', () => {
  const DAY = 24 * 60 * 60_000;
  const now = 100 * DAY;

  it('has nothing to go on for a child with no history yet', () => {
    expect(
      earningAverages({
        earnedPoints: 0,
        chorePoints: 0,
        approvedQuests: 0,
        firstEarnedAt: null,
        now,
      }),
    ).toBeNull();
  });

  it('has nothing to go on with no approved quests in the window', () => {
    expect(
      earningAverages({
        earnedPoints: 10,
        chorePoints: 0,
        approvedQuests: 0,
        firstEarnedAt: now - 30 * DAY,
        now,
      }),
    ).toBeNull();
  });

  it('averages over 14 days', () => {
    expect(
      earningAverages({
        earnedPoints: 140,
        chorePoints: 120,
        approvedQuests: 12,
        firstEarnedAt: now - 60 * DAY,
        now,
      }),
    ).toEqual({ pointsPerDay: 10, pointsPerQuest: 10, xpPerDay: 120 / 14 });
  });

  it('averages over fewer days for a child who started recently', () => {
    expect(
      earningAverages({
        earnedPoints: 30,
        chorePoints: 30,
        approvedQuests: 4,
        firstEarnedAt: now - 2.5 * DAY,
        now,
      }),
    ).toEqual({ pointsPerDay: 10, pointsPerQuest: 7.5, xpPerDay: 10 });
  });

  it('counts at least one day', () => {
    expect(
      earningAverages({
        earnedPoints: 8,
        chorePoints: 8,
        approvedQuests: 1,
        firstEarnedAt: now - 1000,
        now,
      }),
    ).toEqual({ pointsPerDay: 8, pointsPerQuest: 8, xpPerDay: 8 });
  });
});

describe('jarStats', () => {
  const averages = { pointsPerDay: 16, pointsPerQuest: 9, xpPerDay: 14 };

  it('counts paydays for a normal jar', () => {
    // £12.99 still needed; 16 points a day × 7 × 5p = £5.60 a week → 3 paydays.
    const stats = jarStats({ inCents: 1200, targetCents: 2499, averages, centsPerPoint: 5 });
    expect(stats).toEqual({ kind: 'paydays', paydays: 3 });
    expect(jarStatsText(stats!, 'GBP', 'en-GB')).toBe('~3 paydays if all your pay goes here');
  });

  it('counts quests to the next milestone for a big jar', () => {
    // £5 to £25 = 100 points at 5p; 9 points a quest → 12 quests.
    const stats = jarStats({ inCents: 2000, targetCents: 47_999, averages, centsPerPoint: 5 });
    expect(stats).toEqual({ kind: 'quests', quests: 12, milestoneCents: 2500 });
    expect(jarStatsText(stats!, 'GBP', 'en-GB')).toBe('Next ⭐ £25: about 12 quests');
  });

  it('says one payday and one quest in the singular', () => {
    expect(jarStatsText({ kind: 'paydays', paydays: 1 }, 'GBP', 'en-GB')).toBe(
      '~1 payday if all your pay goes here',
    );
    expect(
      jarStatsText({ kind: 'quests', quests: 1, milestoneCents: 47_999 }, 'GBP', 'en-GB'),
    ).toBe('Next ⭐ £479.99: about 1 quest');
  });

  it('shows no stats line without history, for a full jar, or with no earnings', () => {
    expect(
      jarStats({ inCents: 0, targetCents: 2499, averages: null, centsPerPoint: 5 }),
    ).toBeNull();
    expect(jarStats({ inCents: 2499, targetCents: 2499, averages, centsPerPoint: 5 })).toBeNull();
    expect(
      jarStats({
        inCents: 0,
        targetCents: 2499,
        averages: { pointsPerDay: -2, pointsPerQuest: 5, xpPerDay: 0 },
        centsPerPoint: 5,
      }),
    ).toBeNull();
  });
});

describe('formatMoneyShort', () => {
  it('drops the pence on whole amounts', () => {
    expect(formatMoneyShort(2500, 'GBP', 'en-GB')).toBe('£25');
    expect(formatMoneyShort(2499, 'GBP', 'en-GB')).toBe('£24.99');
    expect(formatMoneyShort(2450, 'GBP', 'en-GB')).toBe('£24.50');
  });
});
