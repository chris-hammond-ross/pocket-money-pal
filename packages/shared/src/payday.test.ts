import { describe, expect, it } from 'vitest';
import {
  duePaydaySlot,
  envelopeSender,
  formatClock12,
  formatPaydayCountdown,
  formatPaydayWhen,
  isPaydaySoon,
  manualPaydaySlot,
  nextPaydaySlot,
  paydaySlotAfter,
  paydaySlotOnOrBefore,
  paydayStats,
  shortDayName,
  type PaydayState,
} from './payday';
import { zonedTimeToInstant } from './time';

const TZ = 'Europe/London';
const at = (date: string, time: string) => zonedTimeToInstant(date, time, TZ);
const SUNDAY_6PM = { day: 0, time: '18:00' };
// Thursday 1 October 2026. Sunday 27 September was the last payday slot.
const THU = at('2026-10-01', '16:40');
const LAST_SUN = at('2026-09-27', '18:00');
const NEXT_SUN = at('2026-10-04', '18:00');

const state = (fields: Partial<PaydayState> = {}): PaydayState => ({
  now: THU,
  schedule: SUNDAY_6PM,
  timeZone: TZ,
  lastSlot: null,
  since: null,
  ...fields,
});

describe('payday slots', () => {
  it('finds the latest slot at or before now', () => {
    expect(paydaySlotOnOrBefore(THU, SUNDAY_6PM, TZ)).toBe(LAST_SUN);
    expect(paydaySlotOnOrBefore(NEXT_SUN, SUNDAY_6PM, TZ)).toBe(NEXT_SUN);
    expect(paydaySlotOnOrBefore(NEXT_SUN - 1, SUNDAY_6PM, TZ)).toBe(LAST_SUN);
  });

  it('finds the first slot after a time', () => {
    expect(paydaySlotAfter(THU, SUNDAY_6PM, TZ)).toBe(NEXT_SUN);
    expect(paydaySlotAfter(NEXT_SUN, SUNDAY_6PM, TZ)).toBe(at('2026-10-11', '18:00'));
    expect(paydaySlotAfter(NEXT_SUN - 1, SUNDAY_6PM, TZ)).toBe(NEXT_SUN);
  });

  it('works for every day of the week', () => {
    const friday = { day: 5, time: '09:00' };
    expect(paydaySlotAfter(THU, friday, TZ)).toBe(at('2026-10-02', '09:00'));
    expect(paydaySlotOnOrBefore(THU, friday, TZ)).toBe(at('2026-09-25', '09:00'));
    const thursday = { day: 4, time: '17:00' };
    expect(paydaySlotAfter(THU, thursday, TZ)).toBe(at('2026-10-01', '17:00'));
    expect(paydaySlotOnOrBefore(THU, thursday, TZ)).toBe(at('2026-09-24', '17:00'));
  });

  it('keeps the wall-clock time across the clocks going back', () => {
    // Clocks go back on Sunday 25 October 2026: payday is still 6pm on the day.
    const before = at('2026-10-24', '12:00');
    const slot = paydaySlotAfter(before, SUNDAY_6PM, TZ);
    expect(slot).toBe(at('2026-10-25', '18:00'));
    expect(new Date(slot).toISOString()).toBe('2026-10-25T18:00:00.000Z'); // GMT again
    expect(slot - paydaySlotOnOrBefore(before, SUNDAY_6PM, TZ)).toBe(7 * 24 * 3600_000 + 3600_000);
  });
});

describe('duePaydaySlot', () => {
  it('waits for the first slot when nothing has run and nothing limits it', () => {
    expect(duePaydaySlot(state())).toBe(LAST_SUN);
  });

  it('is nothing once that slot is covered', () => {
    expect(duePaydaySlot(state({ lastSlot: LAST_SUN }))).toBeNull();
  });

  it('runs a missed payday once, for the latest slot only', () => {
    // The PC was off for three Sundays: only the latest one runs.
    const lastSlot = at('2026-09-06', '18:00');
    expect(duePaydaySlot(state({ lastSlot }))).toBe(LAST_SUN);
  });

  it('never runs a slot from before the schedule changed', () => {
    // Moved to Monday 9am on Tuesday: Monday's slot has passed, so it waits for next week.
    const monday = { day: 1, time: '09:00' };
    const since = at('2026-09-29', '10:00');
    const tuesday = at('2026-09-29', '10:05');
    expect(
      duePaydaySlot(state({ now: tuesday, schedule: monday, since, lastSlot: LAST_SUN })),
    ).toBeNull();
    const nextMonday = at('2026-10-05', '09:00');
    expect(
      duePaydaySlot(state({ now: nextMonday, schedule: monday, since, lastSlot: LAST_SUN })),
    ).toBe(nextMonday);
  });

  it('is due exactly at the payday time', () => {
    expect(duePaydaySlot(state({ now: NEXT_SUN, lastSlot: LAST_SUN }))).toBe(NEXT_SUN);
    expect(duePaydaySlot(state({ now: NEXT_SUN - 1, lastSlot: LAST_SUN }))).toBeNull();
  });
});

describe('manualPaydaySlot', () => {
  it('covers the waiting slot first', () => {
    expect(manualPaydaySlot(state({ lastSlot: at('2026-09-20', '18:00') }))).toBe(LAST_SUN);
  });

  it("otherwise covers the next slot, so Sunday's payday is skipped after a Saturday start", () => {
    expect(manualPaydaySlot(state({ lastSlot: LAST_SUN }))).toBe(NEXT_SUN);
  });

  it('refuses when the next slot is already covered', () => {
    expect(manualPaydaySlot(state({ lastSlot: NEXT_SUN }))).toBeNull();
  });
});

describe('nextPaydaySlot', () => {
  it('counts down to the next slot', () => {
    expect(nextPaydaySlot(state({ lastSlot: LAST_SUN }))).toBe(NEXT_SUN);
  });

  it('skips a slot a manual start already covered', () => {
    expect(nextPaydaySlot(state({ lastSlot: NEXT_SUN }))).toBe(at('2026-10-11', '18:00'));
  });
});

describe('countdown and labels', () => {
  const MIN = 60_000;
  it('reads days and hours, hours and minutes, or minutes', () => {
    expect(formatPaydayCountdown((3 * 24 * 60 + 61) * MIN)).toBe('3d 1h');
    expect(formatPaydayCountdown(24 * 60 * MIN)).toBe('1d 0h');
    expect(formatPaydayCountdown(80 * MIN)).toBe('1h 20m');
    expect(formatPaydayCountdown(60 * MIN)).toBe('1h 0m');
    expect(formatPaydayCountdown(20 * MIN)).toBe('20m');
    expect(formatPaydayCountdown(30_000)).toBe('1m');
    expect(formatPaydayCountdown(-5)).toBe('0m');
  });

  it('glows in the last hour', () => {
    expect(isPaydaySoon(60 * MIN)).toBe(true);
    expect(isPaydaySoon(60 * MIN + 1)).toBe(false);
    expect(isPaydaySoon(0)).toBe(false);
  });

  it('names the slot', () => {
    expect(formatPaydayWhen(LAST_SUN, TZ)).toBe('Sun 6pm');
    expect(formatPaydayWhen(at('2026-10-02', '09:30'), TZ)).toBe('Fri 9:30am');
    expect(formatClock12('00:00')).toBe('12am');
    expect(formatClock12('12:00')).toBe('12pm');
    expect(shortDayName('2026-09-29')).toBe('Tue');
  });
});

describe('paydayStats', () => {
  it('counts the week and finds the best day', () => {
    const stats = paydayStats(
      {
        quests: [
          { early: true, unprompted: true },
          { early: true, unprompted: false },
          { early: false, unprompted: true },
          { early: false, unprompted: false },
        ],
        earned: [
          { at: at('2026-09-28', '08:00'), points: 15 },
          { at: at('2026-09-29', '08:00'), points: 25 },
          { at: at('2026-09-29', '19:00'), points: 15 },
          { at: at('2026-09-30', '08:00'), points: 40 },
          { at: at('2026-09-30', '09:00'), points: -5 },
        ],
      },
      TZ,
    );
    expect(stats).toEqual({
      questsDone: 4,
      earlyBonuses: 2,
      unprompted: 2,
      bestDay: { date: '2026-09-29', points: 40 },
    });
  });

  it('has no best day without points', () => {
    expect(paydayStats({ quests: [], earned: [] }, TZ)).toEqual({
      questsDone: 0,
      earlyBonuses: 0,
      unprompted: 0,
      bestDay: null,
    });
  });
});

describe('envelopeSender', () => {
  it('takes the sender from the note chip, or the parent', () => {
    expect(envelopeSender('👵 From Grandma', 'Mum')).toBe('Grandma');
    expect(envelopeSender('🦷 Tooth fairy', 'Mum')).toBe('the Tooth Fairy');
    expect(envelopeSender('🎂 Birthday money', 'Dad')).toBe('Dad');
    expect(envelopeSender('Helped wash the car', 'Mum')).toBe('Mum');
  });
});
