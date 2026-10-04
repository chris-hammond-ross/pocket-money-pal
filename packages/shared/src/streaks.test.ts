import { describe, expect, it } from 'vitest';
import {
  bestStreak,
  busyFold,
  crossedTier,
  currentStreak,
  daysToNextLevel,
  FLAME_TIERS,
  flameTier,
  isBusyDay,
  isMilestoneLevel,
  isReportWorthy,
  nextFlameTier,
  streakChange,
  streakDayResult,
  streakReportMessage,
  tierPillText,
  type StreakDay,
  type StreakResult,
} from './streaks';

/** Consecutive days from 2026-09-01, one result each. */
function days(...results: StreakResult[]): StreakDay[] {
  return results.map((result, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    result,
  }));
}
const TODAY = '2026-10-01';

describe('streakDayResult', () => {
  it('is neutral with no chores, or all skipped', () => {
    expect(streakDayResult([])).toBe('neutral');
    expect(streakDayResult(['skipped', 'skipped'])).toBe('neutral');
  });

  it('is done when every non-skipped chore is approved', () => {
    expect(streakDayResult(['approved'])).toBe('done');
    expect(streakDayResult(['approved', 'skipped', 'approved'])).toBe('done');
  });

  it('is missed when anything is still open, even with claims waiting', () => {
    expect(streakDayResult(['approved', 'open'])).toBe('missed');
    expect(streakDayResult(['claimed', 'open'])).toBe('missed');
  });

  it('is pending when nothing is open but something waits for a parent', () => {
    expect(streakDayResult(['approved', 'claimed'])).toBe('pending');
    expect(streakDayResult(['claimed', 'skipped'])).toBe('pending');
  });
});

describe('currentStreak', () => {
  it('is 0 with no history', () => {
    expect(currentStreak([], TODAY)).toBe(0);
  });

  it('counts done days back to the first missed one', () => {
    expect(currentStreak(days('done', 'missed', 'done', 'done', 'done'), TODAY)).toBe(3);
  });

  it('skips neutral and pending days without breaking the run', () => {
    expect(currentStreak(days('done', 'neutral', 'done', 'pending', 'done'), TODAY)).toBe(3);
  });

  it('is 0 right after a missed day', () => {
    expect(currentStreak(days('done', 'done', 'missed'), TODAY)).toBe(0);
  });

  it('never counts today or later (the dev clock may go back)', () => {
    const history = days('done', 'done', 'done');
    expect(currentStreak(history, '2026-09-03')).toBe(2);
    expect(currentStreak(history, '2026-09-01')).toBe(0);
  });

  it("doesn't depend on the input's order", () => {
    expect(currentStreak(days('missed', 'done', 'done').reverse(), TODAY)).toBe(2);
  });
});

describe('bestStreak', () => {
  it('is the longest run ever', () => {
    expect(bestStreak(days('done', 'done', 'done', 'missed', 'done'), TODAY)).toBe(3);
  });

  it('joins runs across neutral and pending days', () => {
    expect(bestStreak(days('done', 'neutral', 'done', 'pending', 'done', 'missed'), TODAY)).toBe(3);
  });

  it('is 0 with nothing done', () => {
    expect(bestStreak(days('missed', 'neutral'), TODAY)).toBe(0);
  });
});

describe('flameTier', () => {
  it('changes colour at 1, 7, 14, 28, 42, 56 and 84 days', () => {
    const at = [0, 1, 6, 7, 13, 14, 27, 28, 41, 42, 55, 56, 83, 84, 400];
    expect(at.map(flameTier)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  });

  it('names the next colour, and none at the top', () => {
    expect(nextFlameTier(5)).toMatchObject({ from: 7, name: 'yellow' });
    expect(nextFlameTier(100)).toBeNull();
  });

  it('has one tier per threshold, in order', () => {
    const froms = FLAME_TIERS.map((t) => t.from);
    expect([...froms].sort((a, b) => a - b)).toEqual(froms);
  });
});

describe('crossedTier', () => {
  it('is the new colour when a week mark is passed', () => {
    expect(crossedTier(6, 7)?.name).toBe('yellow');
    expect(crossedTier(13, 14)?.label).toBe('2 weeks');
  });

  it("isn't a mark when a flame is first lit, or within a colour", () => {
    expect(crossedTier(0, 1)).toBeNull();
    expect(crossedTier(7, 8)).toBeNull();
  });

  it('plays several marks at once as one change, to the newest colour', () => {
    expect(crossedTier(12, 30)?.name).toBe('blue');
  });

  it("isn't a mark going down", () => {
    expect(crossedTier(14, 0)).toBeNull();
  });
});

describe('streakChange', () => {
  const before = days('done', 'done', 'done', 'done');

  it('reports a newly done day', () => {
    const changed = [{ date: '2026-09-05', result: 'done' as const }];
    expect(streakChange(before, [...before, ...changed], changed, TODAY)).toEqual({
      dates: ['2026-09-05'],
      result: 'done',
      before: 4,
      after: 5,
      bestBefore: 4,
      best: 5,
    });
  });

  it('reports a missed day', () => {
    const changed = [{ date: '2026-09-05', result: 'missed' as const }];
    expect(streakChange(before, [...before, ...changed], changed, TODAY)).toMatchObject({
      result: 'missed',
      before: 4,
      after: 0,
      best: 4,
    });
  });

  it('reports nothing for pending or neutral days', () => {
    const changed = [
      { date: '2026-09-05', result: 'pending' as const },
      { date: '2026-09-06', result: 'neutral' as const },
    ];
    expect(streakChange(before, [...before, ...changed], changed, TODAY)).toBeNull();
  });

  it('covers several days after the PC was off', () => {
    const changed = [
      { date: '2026-09-07', result: 'done' as const },
      { date: '2026-09-05', result: 'done' as const },
      { date: '2026-09-06', result: 'neutral' as const },
    ];
    expect(streakChange(before, [...before, ...changed], changed, TODAY)).toMatchObject({
      dates: ['2026-09-05', '2026-09-07'],
      result: 'done',
      before: 4,
      after: 6,
    });
  });

  it('is missed if any day in the batch was missed', () => {
    const changed = [
      { date: '2026-09-05', result: 'missed' as const },
      { date: '2026-09-06', result: 'done' as const },
    ];
    expect(streakChange(before, [...before, ...changed], changed, TODAY)).toMatchObject({
      result: 'missed',
      after: 1,
    });
  });

  it('reports a pending day that resolves', () => {
    const pending = [...before, { date: '2026-09-05', result: 'pending' as const }];
    const changed = [{ date: '2026-09-05', result: 'done' as const }];
    const after = [...before, ...changed];
    expect(streakChange(pending, after, changed, TODAY)).toMatchObject({ before: 4, after: 5 });
  });
});

describe('isReportWorthy', () => {
  it('needs the number or the best to move', () => {
    expect(isReportWorthy({ before: 3, after: 4, bestBefore: 4, best: 4 })).toBe(true);
    expect(isReportWorthy({ before: 3, after: 0, bestBefore: 4, best: 4 })).toBe(true);
    expect(isReportWorthy({ before: 0, after: 0, bestBefore: 4, best: 4 })).toBe(false);
  });
});

describe('streakReportMessage', () => {
  it('counts towards the next colour', () => {
    expect(
      streakReportMessage({ result: 'done', before: 4, after: 5, bestBefore: 9, best: 9 }),
    ).toEqual({
      text: '5 days in a row! 2 more and your flame turns yellow.',
      crossed: null,
    });
  });

  it('lights a new flame', () => {
    expect(
      streakReportMessage({ result: 'done', before: 0, after: 1, bestBefore: 9, best: 9 }).text,
    ).toBe('1 day! 6 more and your flame turns yellow.');
  });

  it('celebrates a new colour', () => {
    const message = streakReportMessage({
      result: 'done',
      before: 13,
      after: 14,
      bestBefore: 20,
      best: 20,
    });
    expect(message.text).toBe(
      '2 weeks in a row! Your flame burns white now. Next colour at 28 days.',
    );
    expect(message.crossed?.name).toBe('white');
  });

  it('says the top colour is the hottest', () => {
    expect(
      streakReportMessage({ result: 'done', before: 83, after: 84, bestBefore: 83, best: 84 }).text,
    ).toBe('12 weeks in a row! Your flame burns rainbow now. The hottest flame there is! 🏆');
  });

  it('celebrates a new best', () => {
    expect(
      streakReportMessage({ result: 'done', before: 11, after: 12, bestBefore: 11, best: 12 }).text,
    ).toBe('12 days: your best ever! 🏆');
  });

  it('is kind when the streak ends', () => {
    expect(
      streakReportMessage({ result: 'missed', before: 4, after: 0, bestBefore: 11, best: 11 }).text,
    ).toBe(
      'Your 4-day streak ended. Your best is still 11 days. Do every quest today to light a new one! 💪',
    );
  });
});

describe('tierPillText', () => {
  it('reads like the prototype', () => {
    expect(tierPillText(FLAME_TIERS[3]!)).toBe('2-WEEK STREAK');
    expect(tierPillText(FLAME_TIERS[2]!)).toBe('1-WEEK STREAK');
  });
});

describe('busy days', () => {
  it('is busy above 5 active quests', () => {
    expect(isBusyDay(5)).toBe(false);
    expect(isBusyDay(6)).toBe(true);
  });

  it('shows the 3 most pressing, plus any that ring', () => {
    const open = [1, 2, 3, 4, 5, 6].map((id) => ({ id }));
    const { shown, folded } = busyFold(open, (q) => q.id === 5);
    expect(shown.map((q) => q.id)).toEqual([1, 2, 3, 5]);
    expect(folded.map((q) => q.id)).toEqual([4, 6]);
  });
});

describe('daysToNextLevel', () => {
  it('divides the XP left by the daily average, rounding', () => {
    expect(daysToNextLevel(205, 34)).toBe(6);
  });

  it('is at least a day', () => {
    expect(daysToNextLevel(3, 40)).toBe(1);
  });

  it('is unknown with no history', () => {
    expect(daysToNextLevel(100, null)).toBeNull();
    expect(daysToNextLevel(100, 0)).toBeNull();
  });
});

describe('isMilestoneLevel', () => {
  it('is every 5th level', () => {
    expect([4, 5, 10, 11, 20].map(isMilestoneLevel)).toEqual([false, true, true, false, true]);
  });
});
