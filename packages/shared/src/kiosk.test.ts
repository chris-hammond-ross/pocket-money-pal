import { describe, expect, it } from 'vitest';
import { choreWindow, type ChoreWindow } from './chores';
import {
  formatCountdown,
  formatMinutesLeft,
  isBonusEnding,
  orderKioskQuests,
  questTrack,
  trackPercent,
  type KioskOrderable,
} from './kiosk';
import { devClockRequestSchema, kioskTodaySchema } from './schemas';
import { startOfZonedDay, zonedTimeToInstant } from './time';

const DAY = '2026-09-30';
const at = (time: string) => zonedTimeToInstant(DAY, time, 'UTC');
const dayStart = startOfZonedDay(DAY, 'UTC');
const window = (bonusBefore: string, dueBy: string, lateAfter: string): ChoreWindow =>
  choreWindow(DAY, { bonusBefore, dueBy, lateAfter }, 'UTC');

// "Tidy shared bedroom" from the prototypes' mock data.
const tidy = window('17:00', '18:30', '19:30');

describe('questTrack', () => {
  it('runs from two hours before the bonus ends to late_after', () => {
    expect(questTrack(tidy, dayStart)).toEqual({ start: at('15:00'), end: at('19:30') });
  });

  it('never starts before the day does', () => {
    expect(questTrack(window('01:00', '02:00', '03:00'), dayStart)).toEqual({
      start: dayStart,
      end: at('03:00'),
    });
  });
});

describe('trackPercent', () => {
  const track = questTrack(tidy, dayStart); // 15:00 → 19:30, 270 minutes

  it.each([
    ['14:00', 0],
    ['15:00', 0],
    ['17:00', (120 / 270) * 100],
    ['18:30', (210 / 270) * 100],
    ['19:30', 100],
    ['21:00', 100],
  ])('at %s is %f%%', (time, pct) => {
    expect(trackPercent(track, at(time))).toBeCloseTo(pct, 6);
  });

  it('handles a track with no length', () => {
    const flat = { start: at('10:00'), end: at('10:00') };
    expect(trackPercent(flat, at('09:59'))).toBe(0);
    expect(trackPercent(flat, at('10:00'))).toBe(100);
  });
});

describe('isBonusEnding', () => {
  it.each([
    ['16:54', false],
    ['16:55', true],
    ['16:59', true],
    ['17:00', true], // the deadline itself is still bonus time
    ['17:01', false],
  ])('at %s → %s', (time, expected) => {
    expect(isBonusEnding(tidy, at(time))).toBe(expected);
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [-5_000, '0:00'],
    [1, '0:01'], // partial seconds round up
    [59_000, '0:59'],
    [60_000, '1:00'],
    [19 * 60_000 + 57_000, '19:57'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_600_000 + 5 * 60_000 + 7_000, '1:05:07'],
    [10 * 3_600_000, '10:00:00'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('formatMinutesLeft', () => {
  it.each([
    [0, '0 min'],
    [30_000, '1 min'],
    [20 * 60_000, '20 min'],
    [59 * 60_000, '59 min'],
    [60 * 60_000, '1h'],
    [65 * 60_000, '1h 5m'],
    [80 * 60_000, '1h 20m'],
    [120 * 60_000, '2h'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatMinutesLeft(ms)).toBe(text);
  });
});

describe('orderKioskQuests', () => {
  const q = (
    id: number,
    status: KioskOrderable['status'],
    w: ChoreWindow,
    extra: Partial<KioskOrderable> = {},
  ): KioskOrderable => ({ id, status, window: w, claimedAt: null, approvedAt: null, ...extra });

  it('lists open (most pressing first), then claimed, then approved, and drops skipped', () => {
    const quests = [
      q(1, 'approved', tidy, { approvedAt: at('09:00') }),
      q(2, 'claimed', tidy, { claimedAt: at('08:20') }),
      q(3, 'open', window('17:00', '18:00', '19:00')),
      q(4, 'open', window('16:30', '17:30', '19:00')), // due at 18:00: overdue
      q(5, 'skipped', tidy),
      q(6, 'claimed', tidy, { claimedAt: at('07:50') }),
      q(7, 'approved', tidy, { approvedAt: at('08:00') }),
      q(8, 'open', window('17:30', '18:30', '20:00')),
    ];
    const ids = orderKioskQuests(quests, at('18:00')).map((x) => x.id);
    // At 18:00: 4 is overdue, 3 is due with nothing left, 8 is due with 30 min left.
    expect(ids).toEqual([4, 3, 8, 6, 2, 7, 1]);
  });

  it('puts late quests after every other open quest', () => {
    const quests = [q(1, 'open', window('08:00', '09:00', '10:00')), q(2, 'open', tidy)];
    expect(orderKioskQuests(quests, at('12:00')).map((x) => x.id)).toEqual([2, 1]);
  });
});

describe('kiosk schemas', () => {
  it('accepts an empty board', () => {
    const board = {
      serverNow: at('10:00'),
      date: DAY,
      timezone: 'UTC',
      dayStart,
      devClock: false,
      currency: 'GBP',
      centsPerPoint: 5,
      payday: {
        day: 0,
        time: '18:00',
        auto: true,
        nextAt: at('18:00'),
        waitingSlot: null,
        latestId: null,
        latestRanAt: null,
      },
      children: [],
    };
    expect(kioskTodaySchema.parse(board)).toEqual(board);
  });

  it.each([
    ['18:40', true],
    ['2026-10-03T07:05', true],
    [null, true],
    ['6:40', false],
    ['24:00', false],
    ['2026-02-30T10:00', false],
    ['tomorrow', false],
  ])('dev clock "at": %s → %s', (value, ok) => {
    expect(devClockRequestSchema.safeParse({ at: value }).success).toBe(ok);
  });
});
