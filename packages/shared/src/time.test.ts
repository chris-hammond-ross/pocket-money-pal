import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatTimeOfDay,
  isIsoDate,
  isValidTimeZone,
  parseTimeOfDay,
  startOfZonedDay,
  weekdayOf,
  zonedDateOf,
  zonedTimeOf,
  zonedTimeToInstant,
} from './time';

const LONDON = 'Europe/London';
const utc = (iso: string) => Date.parse(iso);

describe('time of day', () => {
  it('parses and formats HH:MM', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('17:30')).toBe(1050);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    expect(formatTimeOfDay(1050)).toBe('17:30');
    expect(formatTimeOfDay(5)).toBe('00:05');
  });

  it('rejects malformed times', () => {
    for (const bad of ['24:00', '7:30', '17:60', '17:30:00', '']) {
      expect(() => parseTimeOfDay(bad)).toThrow(RangeError);
    }
    expect(() => formatTimeOfDay(1440)).toThrow(RangeError);
    expect(() => formatTimeOfDay(-1)).toThrow(RangeError);
  });
});

describe('calendar dates', () => {
  it('knows the weekday', () => {
    expect(weekdayOf('2026-09-28')).toBe('mon');
    expect(weekdayOf('2026-09-30')).toBe('wed');
    expect(weekdayOf('2026-10-04')).toBe('sun');
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('validates dates', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
    expect(() => weekdayOf('nope')).toThrow(RangeError);
  });
});

describe('zonedTimeToInstant', () => {
  it('converts summer and winter times in London', () => {
    expect(zonedTimeToInstant('2026-09-30', '17:30', LONDON)).toBe(utc('2026-09-30T16:30:00Z'));
    expect(zonedTimeToInstant('2026-12-01', '17:30', LONDON)).toBe(utc('2026-12-01T17:30:00Z'));
  });

  it('moves a time skipped by the spring change forward by the gap', () => {
    // 29 Mar 2026: 01:00 GMT becomes 02:00 BST, so 01:00–01:59 never happens.
    expect(zonedTimeToInstant('2026-03-29', '01:30', LONDON)).toBe(utc('2026-03-29T01:30:00Z'));
    expect(zonedTimeToInstant('2026-03-29', '02:00', LONDON)).toBe(utc('2026-03-29T01:00:00Z'));
    expect(zonedTimeToInstant('2026-03-29', '00:45', LONDON)).toBe(utc('2026-03-29T00:45:00Z'));
    expect(zonedTimeToInstant('2026-03-29', '07:00', LONDON)).toBe(utc('2026-03-29T06:00:00Z'));
  });

  it('uses the first occurrence of a time repeated by the autumn change', () => {
    // 25 Oct 2026: 02:00 BST becomes 01:00 GMT, so 01:00–01:59 happens twice.
    expect(zonedTimeToInstant('2026-10-25', '01:30', LONDON)).toBe(utc('2026-10-25T00:30:00Z'));
    expect(zonedTimeToInstant('2026-10-25', '02:00', LONDON)).toBe(utc('2026-10-25T02:00:00Z'));
    expect(zonedTimeToInstant('2026-10-25', '07:00', LONDON)).toBe(utc('2026-10-25T07:00:00Z'));
  });

  it('handles other zones, including ones ahead of UTC', () => {
    expect(zonedTimeToInstant('2026-03-08', '02:30', 'America/New_York')).toBe(
      utc('2026-03-08T07:30:00Z'),
    );
    // Sydney leaves daylight saving on 5 Apr 2026 (03:00 AEDT → 02:00 AEST).
    expect(zonedTimeToInstant('2026-04-05', '02:30', 'Australia/Sydney')).toBe(
      utc('2026-04-04T15:30:00Z'),
    );
    expect(zonedTimeToInstant('2026-07-01', '08:00', 'Asia/Kolkata')).toBe(
      utc('2026-07-01T02:30:00Z'),
    );
  });

  it('round-trips every quarter hour on ordinary and change days', () => {
    for (const date of ['2026-09-30', '2026-10-25', '2026-03-29']) {
      for (let m = 0; m < 24 * 60; m += 15) {
        const time = formatTimeOfDay(m);
        const instant = zonedTimeToInstant(date, time, LONDON);
        const skipped = date === '2026-03-29' && m >= 60 && m < 120;
        if (!skipped) {
          expect(zonedTimeOf(instant, LONDON)).toBe(time);
          expect(zonedDateOf(instant, LONDON)).toBe(date);
        }
      }
    }
  });
});

describe('zoned days', () => {
  it('finds the local date of an instant', () => {
    expect(zonedDateOf(utc('2026-09-30T23:30:00Z'), LONDON)).toBe('2026-10-01');
    expect(zonedDateOf(utc('2026-12-31T23:30:00Z'), LONDON)).toBe('2026-12-31');
    expect(zonedTimeOf(utc('2026-09-30T23:30:00Z'), LONDON)).toBe('00:30');
  });

  it('gives 23- and 25-hour days at the changes', () => {
    const hours = (date: string) =>
      (startOfZonedDay(addDays(date, 1), LONDON) - startOfZonedDay(date, LONDON)) / 3_600_000;
    expect(hours('2026-03-29')).toBe(23);
    expect(hours('2026-10-25')).toBe(25);
    expect(hours('2026-09-30')).toBe(24);
  });

  it('validates time zones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
