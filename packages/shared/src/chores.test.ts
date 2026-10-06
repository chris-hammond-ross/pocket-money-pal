import { describe, expect, it } from 'vitest';
import {
  choreRunsOn,
  choreStage,
  choreWindow,
  isPausedOn,
  claimPoints,
  defaultChips,
  maxPointsNow,
  nextDeadline,
  pointsRange,
  rankNextUp,
  scorePoints,
  startsNextTime,
  type ChoreLoot,
  type ChoreWindow,
} from './chores';
import { zonedTimeToInstant } from './time';

const DAY = '2026-09-30';
const at = (time: string) => zonedTimeToInstant(DAY, time, 'UTC');
const window = (bonusBefore: string, dueBy: string, lateAfter: string): ChoreWindow =>
  choreWindow(DAY, { bonusBefore, dueBy, lateAfter }, 'UTC');

// "Tidy shared bedroom" from the prototypes' mock data.
const tidy = window('17:00', '18:30', '19:30');
const tidyLoot: ChoreLoot = { basePoints: 10, earlyBonus: 5, unpromptedBonus: 5, latePenalty: 3 };

describe('choreStage', () => {
  it.each([
    ['06:00', 'bonus'],
    ['16:59', 'bonus'],
    ['17:00', 'bonus'],
    ['17:01', 'due'],
    ['18:30', 'due'],
    ['18:31', 'overdue'],
    ['19:30', 'overdue'],
    ['19:31', 'late'],
    ['23:59', 'late'],
  ] as const)('at %s is %s', (time, stage) => {
    expect(choreStage(tidy, at(time))).toBe(stage);
  });

  it('treats each deadline as inclusive, to the millisecond', () => {
    expect(choreStage(tidy, tidy.bonusBefore)).toBe('bonus');
    expect(choreStage(tidy, tidy.bonusBefore + 1)).toBe('due');
    expect(choreStage(tidy, tidy.dueBy + 1)).toBe('overdue');
    expect(choreStage(tidy, tidy.lateAfter)).toBe('overdue');
    expect(choreStage(tidy, tidy.lateAfter + 1)).toBe('late');
  });

  it('skips empty stages when deadlines are equal', () => {
    const allAtSix = window('18:00', '18:00', '18:00');
    expect(choreStage(allAtSix, at('18:00'))).toBe('bonus');
    expect(choreStage(allAtSix, at('18:00') + 1)).toBe('late');
  });

  it('works across a clock change', () => {
    const w = choreWindow(
      '2026-03-29',
      { bonusBefore: '07:00', dueBy: '08:00', lateAfter: '09:00' },
      'Europe/London',
    );
    expect(w.bonusBefore).toBe(Date.parse('2026-03-29T06:00:00Z'));
    expect(choreStage(w, Date.parse('2026-03-29T06:30:00Z'))).toBe('due');
  });
});

describe('nextDeadline', () => {
  it('counts down to the deadline of the current stage', () => {
    expect(nextDeadline(tidy, at('16:00'))).toBe(tidy.bonusBefore);
    expect(nextDeadline(tidy, at('18:00'))).toBe(tidy.dueBy);
    expect(nextDeadline(tidy, at('19:00'))).toBe(tidy.lateAfter);
    expect(nextDeadline(tidy, at('20:00'))).toBeNull();
  });
});

describe('scorePoints', () => {
  it('adds the chosen bonuses and takes off the penalty', () => {
    expect(scorePoints(tidyLoot, { early: true, unprompted: true, late: false })).toEqual({
      base: 10,
      early: 5,
      unprompted: 5,
      late: 0,
      extra: 0,
      total: 20,
    });
    expect(scorePoints(tidyLoot, { early: false, unprompted: false, late: true }).total).toBe(7);
    expect(
      scorePoints(tidyLoot, { early: true, unprompted: false, late: false, extra: 4 }).total,
    ).toBe(19);
  });

  it('never goes below zero', () => {
    const harsh = { ...tidyLoot, latePenalty: 15 };
    const result = scorePoints(harsh, { early: false, unprompted: false, late: true });
    expect(result.late).toBe(15);
    expect(result.total).toBe(0);
    expect(
      scorePoints(tidyLoot, { early: false, unprompted: false, late: false, extra: -50 }).total,
    ).toBe(0);
  });

  it('rejects fractional extra points', () => {
    expect(() =>
      scorePoints(tidyLoot, { early: false, unprompted: false, late: false, extra: 1.5 }),
    ).toThrow(TypeError);
  });
});

describe('claimPoints', () => {
  it('scores from the claim time and what the child said', () => {
    expect(claimPoints(tidyLoot, tidy, at('16:40'), true).total).toBe(20);
    expect(claimPoints(tidyLoot, tidy, at('16:40'), false).total).toBe(15);
    expect(claimPoints(tidyLoot, tidy, at('18:00'), false).total).toBe(10);
    expect(claimPoints(tidyLoot, tidy, at('19:00'), true).total).toBe(15);
    expect(claimPoints(tidyLoot, tidy, at('20:00'), false).total).toBe(7);
  });

  it('matches the default chips a parent starts from', () => {
    expect(defaultChips('bonus', true)).toEqual({
      early: true,
      unprompted: true,
      late: false,
      extra: 0,
    });
    expect(defaultChips('overdue', false)).toEqual({
      early: false,
      unprompted: false,
      late: false,
      extra: 0,
    });
    expect(defaultChips('late', false).late).toBe(true);
  });
});

describe('maxPointsNow', () => {
  it('drops the early bonus after bonus time and the penalty after late', () => {
    expect(maxPointsNow(tidyLoot, tidy, at('16:00'))).toBe(20);
    expect(maxPointsNow(tidyLoot, tidy, at('18:00'))).toBe(15);
    expect(maxPointsNow(tidyLoot, tidy, at('20:00'))).toBe(12);
  });
});

describe('pointsRange', () => {
  it('gives the earnings line from spec 003', () => {
    const bed = { basePoints: 5, earlyBonus: 2, unpromptedBonus: 3, latePenalty: 5 };
    expect(pointsRange(bed)).toEqual({ onTime: 5, max: 10, late: 0 });
    expect(pointsRange(tidyLoot)).toEqual({ onTime: 10, max: 20, late: 7 });
  });
});

describe('rankNextUp', () => {
  const chore = (id: number, w: ChoreWindow) => ({ id, window: w });

  it('puts overdue chores first, even if another deadline is sooner', () => {
    const overdue = chore(1, window('16:00', '17:00', '19:00'));
    const bonusSoon = chore(2, window('17:05', '18:00', '19:00'));
    expect(rankNextUp([bonusSoon, overdue], at('17:00') + 60_000).map((c) => c.id)).toEqual([1, 2]);
  });

  it('then orders by the least time left to the next deadline', () => {
    const dueIn20 = chore(1, window('16:00', '17:20', '18:00'));
    const bonusIn10 = chore(2, window('17:10', '18:00', '19:00'));
    const bonusIn60 = chore(3, window('18:00', '18:30', '19:00'));
    expect(rankNextUp([bonusIn60, dueIn20, bonusIn10], at('17:00')).map((c) => c.id)).toEqual([
      2, 1, 3,
    ]);
  });

  it('breaks ties by due time, then late time, then id', () => {
    const a = chore(1, window('17:30', '19:00', '20:00'));
    const b = chore(2, window('17:30', '18:00', '20:00'));
    const c = chore(3, window('17:30', '18:00', '19:00'));
    const d = chore(10, window('17:30', '18:00', '19:00'));
    expect(rankNextUp([d, a, b, c], at('17:00')).map((x) => x.id)).toEqual([3, 10, 2, 1]);
  });

  it('puts late chores last, the longest-late first', () => {
    const late1 = chore(1, window('08:00', '09:00', '10:00'));
    const late2 = chore(2, window('06:00', '07:00', '08:00'));
    const open = chore(3, window('20:00', '21:00', '22:00'));
    expect(rankNextUp([late1, open, late2], at('12:00')).map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it('does not change the input', () => {
    const list = [chore(2, tidy), chore(1, window('08:00', '09:00', '10:00'))];
    rankNextUp(list, at('12:00'));
    expect(list.map((c) => c.id)).toEqual([2, 1]);
  });
});

describe('choreRunsOn', () => {
  it('runs on the chosen weekdays', () => {
    const mwf = { days: ['mon', 'wed', 'fri'] as const, oneOffDate: null };
    expect(choreRunsOn(mwf, '2026-09-30')).toBe(true);
    expect(choreRunsOn(mwf, '2026-10-01')).toBe(false);
  });

  it('runs a one-off only on its date', () => {
    const oneOff = { days: [], oneOffDate: '2026-10-01' };
    expect(choreRunsOn(oneOff, '2026-10-01')).toBe(true);
    expect(choreRunsOn(oneOff, '2026-10-08')).toBe(false);
  });

  it('never runs with no days', () => {
    expect(choreRunsOn({ days: [], oneOffDate: null }, '2026-09-30')).toBe(false);
  });
});

describe('isPausedOn', () => {
  it.each([
    [null, '2026-10-01', false],
    [{ from: '2026-10-20', until: '2026-10-27' }, '2026-10-19', false],
    [{ from: '2026-10-20', until: '2026-10-27' }, '2026-10-20', true],
    [{ from: '2026-10-20', until: '2026-10-27' }, '2026-10-27', true],
    [{ from: '2026-10-20', until: '2026-10-27' }, '2026-10-28', false],
    [{ from: '2026-10-20', until: null }, '2027-06-01', true],
    [{ from: '2026-10-20', until: null }, '2026-10-19', false],
  ])('%j on %s → %s', (pause, date, expected) => {
    expect(isPausedOn(pause, date)).toBe(expected);
  });
});

describe('startsNextTime', () => {
  // DAY is a Wednesday.
  const quest = {
    bonusBefore: '17:00',
    dueBy: '18:30',
    lateAfter: '19:30',
    days: ['wed' as const],
    oneOffDate: null,
  };

  it('starts today with at least 30 minutes of bonus time left, else next time', () => {
    expect(startsNextTime(quest, DAY, at('16:30'), 'UTC')).toBe(false);
    expect(startsNextTime(quest, DAY, at('16:31'), 'UTC')).toBe(true);
    expect(startsNextTime(quest, DAY, at('20:00'), 'UTC')).toBe(true);
  });

  it("never waits for a quest that doesn't run today, or a one-off", () => {
    expect(startsNextTime({ ...quest, days: ['thu'] }, DAY, at('20:00'), 'UTC')).toBe(false);
    expect(startsNextTime({ ...quest, days: [], oneOffDate: DAY }, DAY, at('20:00'), 'UTC')).toBe(
      false,
    );
  });
});
