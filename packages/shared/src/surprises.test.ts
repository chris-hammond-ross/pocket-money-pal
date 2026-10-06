import { describe, expect, it } from 'vitest';
import { orderKioskQuests, nextUpQuest } from './kiosk';
import { DEFAULT_QUIET_HOURS } from './notify';
import {
  surpriseGrabSchema,
  surpriseSendSchema,
  surpriseTaskInputSchema,
  surpriseTaskPatchSchema,
} from './schemas';
import {
  canGrabTogether,
  dueRunFate,
  formatGrabTime,
  formatTimeFrame,
  grabProblem,
  joinNames,
  queueOrder,
  setTimeProblem,
  stepReward,
  stepTimeFrame,
  surpriseBanner,
  surpriseEligible,
  surpriseRowState,
  surpriseTimeSlots,
} from './surprises';
import { zonedTimeToInstant } from './time';

const TZ = 'Europe/London';
const DAY = '2026-10-01';
const at = (time: string) => zonedTimeToInstant(DAY, time, TZ);
const MIN = 60_000;

describe('steppers', () => {
  it('steps the time frame through its stops, staying on the ends', () => {
    expect(stepTimeFrame(30, 1)).toBe(45);
    expect(stepTimeFrame(30, -1)).toBe(20);
    expect(stepTimeFrame(1, -1)).toBe(1);
    expect(stepTimeFrame(60, 1)).toBe(60);
    // A value between stops (from an older client) lands on the stop beside it.
    expect(stepTimeFrame(25, 1)).toBe(30);
    expect(stepTimeFrame(25, -1)).toBe(20);
  });

  it('steps the reward by 5, within 5–100', () => {
    expect(stepReward(20, 1)).toBe(25);
    expect(stepReward(5, -1)).toBe(5);
    expect(stepReward(100, 1)).toBe(100);
  });

  it('words a time frame', () => {
    expect(formatTimeFrame(1)).toBe('1 min');
    expect(formatTimeFrame(30)).toBe('30 min');
    expect(formatTimeFrame(60)).toBe('1 hour');
  });
});

describe('set times', () => {
  it('offers quarter hours from 10 minutes ahead until quiet hours start', () => {
    const slots = surpriseTimeSlots(DAY, at('17:21'), TZ, DEFAULT_QUIET_HOURS);
    expect(slots[0]).toBe('17:45');
    expect(slots.at(-1)).toBe('19:45');
    expect(slots).toHaveLength(9);
  });

  it('takes a quarter hour exactly 10 minutes ahead', () => {
    expect(surpriseTimeSlots(DAY, at('17:20'), TZ, DEFAULT_QUIET_HOURS)[0]).toBe('17:30');
  });

  it('is empty late in the evening', () => {
    expect(surpriseTimeSlots(DAY, at('19:40'), TZ, DEFAULT_QUIET_HOURS)).toEqual([]);
  });

  it('starts after the morning quiet hours, and runs to midnight without any', () => {
    expect(surpriseTimeSlots(DAY, at('05:00'), TZ, DEFAULT_QUIET_HOURS)[0]).toBe('07:00');
    expect(surpriseTimeSlots(DAY, at('22:00'), TZ, null)).toEqual([
      '22:15',
      '22:30',
      '22:45',
      '23:00',
      '23:15',
      '23:30',
      '23:45',
    ]);
  });

  it('says why a time is refused', () => {
    const now = at('17:00');
    expect(setTimeProblem('17:30', DAY, now, TZ, DEFAULT_QUIET_HOURS)).toBeNull();
    expect(setTimeProblem('17:20', DAY, now, TZ, DEFAULT_QUIET_HOURS)).toBe('not-quarter');
    expect(setTimeProblem('17:00', DAY, now, TZ, DEFAULT_QUIET_HOURS)).toBe('too-soon');
    expect(setTimeProblem('09:00', DAY, now, TZ, DEFAULT_QUIET_HOURS)).toBe('too-soon');
    expect(setTimeProblem('20:00', DAY, now, TZ, DEFAULT_QUIET_HOURS)).toBe('quiet');
  });
});

describe('dueRunFate', () => {
  const appearAt = at('17:30');
  it('waits, then appears within its time frame, then expires unseen', () => {
    expect(dueRunFate(appearAt, 10, appearAt - 1)).toBe('wait');
    expect(dueRunFate(appearAt, 10, appearAt)).toBe('appear');
    // The server was down at 5:30pm and came back at 5:39.
    expect(dueRunFate(appearAt, 10, appearAt + 9 * MIN)).toBe('appear');
    expect(dueRunFate(appearAt, 10, appearAt + 10 * MIN)).toBe('expire');
  });
});

describe('queueOrder', () => {
  it('goes oldest first, by when each was sent or due', () => {
    const runs = [
      { id: 1, appearAt: at('17:30'), sentAt: at('09:00') },
      { id: 2, appearAt: null, sentAt: at('17:10') },
      { id: 3, appearAt: null, sentAt: at('17:40') },
      { id: 4, appearAt: at('17:30'), sentAt: at('10:00') },
    ];
    expect(queueOrder(runs).map((r) => r.id)).toEqual([2, 1, 4, 3]);
  });
});

describe('the grab', () => {
  const kids = [
    { id: 1, sick: false },
    { id: 2, sick: false },
    { id: 3, sick: true },
  ];
  const live = { status: 'live' as const, expiresAt: at('17:30'), childId: null };

  it('leaves a sick child out, and keeps a named child to themselves', () => {
    expect(surpriseEligible(null, kids)).toEqual([1, 2]);
    expect(surpriseEligible(2, kids)).toEqual([2]);
    expect(surpriseEligible(3, kids)).toEqual([]);
  });

  it('allows "We\'ll all do it!" only for all children, with two who can take it', () => {
    expect(canGrabTogether(null, [1, 2])).toBe(true);
    expect(canGrabTogether(null, [1])).toBe(false);
    expect(canGrabTogether(2, [2])).toBe(false);
  });

  it('wins while live with time left: all together, or the one child who can take it', () => {
    const now = at('17:29');
    expect(grabProblem(live, { all: true }, [1, 2], now)).toBeNull();
    expect(grabProblem(live, { childId: 2 }, [2], now)).toBeNull();
    expect(grabProblem({ ...live, childId: 2 }, { childId: 2 }, [2], now)).toBeNull();
  });

  it('refuses a lone grab when all children can do it together', () => {
    expect(grabProblem(live, { childId: 1 }, [1, 2], at('17:00'))).toBe('not-eligible');
  });

  it('refuses a grab that comes too late, or after someone else', () => {
    expect(grabProblem(live, { childId: 1 }, [1, 2], at('17:30'))).toBe('expired');
    expect(grabProblem({ ...live, status: 'grabbed' }, { childId: 1 }, [1, 2], 0)).toBe(
      'already-grabbed',
    );
    expect(grabProblem({ ...live, status: 'expired' }, { all: true }, [1, 2], 0)).toBe('expired');
    expect(grabProblem({ ...live, status: 'queued' }, { childId: 1 }, [1, 2], 0)).toBe('not-live');
    expect(grabProblem({ ...live, status: 'cancelled' }, { childId: 1 }, [1, 2], 0)).toBe(
      'not-live',
    );
  });

  it('refuses a child who isn\'t eligible, and "all" on a one-child surprise', () => {
    const now = at('17:00');
    expect(grabProblem(live, { childId: 3 }, [1, 2], now)).toBe('not-eligible');
    expect(grabProblem({ ...live, childId: 2 }, { all: true }, [2], now)).toBe('not-eligible');
  });
});

describe('surpriseRowState', () => {
  const taker = (status: 'open' | 'claimed' | 'approved' | 'skipped') => ({ status });
  it('follows the run until the grab, then its takers', () => {
    expect(surpriseRowState({ status: 'scheduled', takers: [] })).toBe('scheduled');
    expect(surpriseRowState({ status: 'live', takers: [] })).toBe('live');
    expect(surpriseRowState({ status: 'expired', takers: [] })).toBe('expired');
    expect(surpriseRowState({ status: 'grabbed', takers: [taker('open')] })).toBe('grabbed');
    expect(surpriseRowState({ status: 'grabbed', takers: [taker('open'), taker('claimed')] })).toBe(
      'done',
    );
    expect(
      surpriseRowState({ status: 'grabbed', takers: [taker('approved'), taker('approved')] }),
    ).toBe('approved');
    // One child's points were undone: it's back to be checked.
    expect(
      surpriseRowState({ status: 'grabbed', takers: [taker('approved'), taker('claimed')] }),
    ).toBe('done');
    expect(surpriseRowState({ status: 'grabbed', takers: [] })).toBe('grabbed');
  });
});

describe('words', () => {
  it('joins names', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Billy'])).toBe('Billy');
    expect(joinNames(['Billy', 'Alice'])).toBe('Billy & Alice');
    expect(joinNames(['Billy', 'Alice', 'Cleo'])).toBe('Billy, Alice & Cleo');
  });

  it('says how fast it was grabbed', () => {
    expect(formatGrabTime(400)).toBe('1s');
    expect(formatGrabTime(4_900)).toBe('4s');
    expect(formatGrabTime(150_000)).toBe('3 min');
  });

  it('writes the phone banners', () => {
    expect(
      surpriseBanner({
        kind: 'grabbed',
        title: 'Sweep the patio',
        taker: { name: 'Billy', avatar: '🦖' },
        ms: 4_000,
      }),
    ).toEqual({
      icon: '🦖',
      title: 'Billy grabbed ‘Sweep the patio’',
      body: 'in 4s · it’s on Billy’s board now',
    });
    expect(
      surpriseBanner({
        kind: 'team',
        title: 'Sweep the patio',
        names: ['Billy', 'Alice'],
        reward: 20,
      }).title,
    ).toBe('Billy & Alice: “We’ll all do it!”');
    expect(
      surpriseBanner({
        kind: 'done',
        title: 'Sweep the patio',
        names: ['Billy', 'Alice'],
        avatar: '🦖',
      }),
    ).toEqual({
      icon: '✋',
      title: 'Billy & Alice say ‘Sweep the patio’ is done',
      body: 'Check it in the tray',
    });
    expect(surpriseBanner({ kind: 'expired', title: 'Sweep the patio' }).title).toBe(
      'Nobody grabbed ‘Sweep the patio’',
    );
    expect(surpriseBanner({ kind: 'appeared', title: 'Find the TV remote' }).body).toBe(
      'As you scheduled it',
    );
  });
});

describe('schemas', () => {
  const task = { title: 'Sweep the patio', icon: '🧹', rewardPoints: 20 };

  it('validates a saved quest: title 1–40, reward a multiple of 5 in 5–100, a known time frame', () => {
    const ok = { ...task, timeFrameMin: 30, who: 'all' };
    expect(surpriseTaskInputSchema.safeParse(ok).success).toBe(true);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, who: 3 }).success).toBe(true);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, title: '  ' }).success).toBe(false);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, title: 'x'.repeat(41) }).success).toBe(false);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, rewardPoints: 12 }).success).toBe(false);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, rewardPoints: 0 }).success).toBe(false);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, rewardPoints: 105 }).success).toBe(false);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, timeFrameMin: 25 }).success).toBe(false);
    expect(surpriseTaskInputSchema.safeParse({ ...ok, who: 'some' }).success).toBe(false);
    expect(surpriseTaskPatchSchema.safeParse({ rewardPoints: 25 }).success).toBe(true);
    expect(surpriseTaskPatchSchema.safeParse({ id: 3 }).success).toBe(false);
  });

  it('sends a saved quest by id alone (spec 002), or a new one with who and how long', () => {
    expect(surpriseSendSchema.safeParse({ taskId: 1 }).success).toBe(true);
    expect(
      surpriseSendSchema.safeParse({ task, who: 2, timeFrameMin: 10, appearAt: '17:30' }).success,
    ).toBe(true);
    expect(surpriseSendSchema.parse({ taskId: 1 }).save).toBe(false);
  });

  it('refuses a send with no quest, two quests, a new one missing its who, or saving a saved one', () => {
    expect(surpriseSendSchema.safeParse({}).success).toBe(false);
    expect(
      surpriseSendSchema.safeParse({ taskId: 1, task, who: 'all', timeFrameMin: 5 }).success,
    ).toBe(false);
    expect(surpriseSendSchema.safeParse({ task, timeFrameMin: 5 }).success).toBe(false);
    expect(surpriseSendSchema.safeParse({ taskId: 1, save: true }).success).toBe(false);
    expect(surpriseSendSchema.safeParse({ taskId: 1, appearAt: '5:30pm' }).success).toBe(false);
  });

  it('grabs for one child or all together, nothing else', () => {
    expect(surpriseGrabSchema.safeParse({ childId: 1 }).success).toBe(true);
    expect(surpriseGrabSchema.safeParse({ all: true }).success).toBe(true);
    expect(surpriseGrabSchema.safeParse({ all: false }).success).toBe(false);
    expect(surpriseGrabSchema.safeParse({ childId: 1, all: true }).success).toBe(false);
  });
});

describe('orderKioskQuests with surprises', () => {
  const window = (bonus: string, due: string, late: string) => ({
    bonusBefore: at(bonus),
    dueBy: at(due),
    lateAfter: at(late),
  });
  const quest = (id: number, surprise: boolean, w = window('08:00', '09:00', '12:00')) => ({
    id,
    status: 'open' as const,
    window: w,
    claimedAt: null,
    approvedAt: null,
    surprise: surprise ? { runId: id, team: false } : null,
  });

  it('puts grabbed surprises first, and leaves them out of Next-up', () => {
    const quests = [
      quest(1, false, window('18:00', '18:30', '19:00')),
      quest(7, true, window('23:59', '23:59', '23:59')),
      quest(2, false, window('17:00', '17:30', '18:00')),
    ];
    const ordered = orderKioskQuests(quests, at('16:00'));
    expect(ordered.map((q) => q.id)).toEqual([7, 2, 1]);
    expect(nextUpQuest(ordered)?.id).toBe(2);
    expect(nextUpQuest([quest(7, true)])).toBeUndefined();
  });
});
