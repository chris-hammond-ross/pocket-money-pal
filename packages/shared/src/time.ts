/**
 * Dates and times in the family's time zone.
 *
 * Chore times are wall-clock "HH:MM" strings and days are "YYYY-MM-DD" strings, both in
 * the family time zone. Instants are epoch milliseconds. Nothing here reads the clock:
 * callers pass `now` in, so every rule is testable.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "17:30" → 1050 (minutes since midnight). */
export function parseTimeOfDay(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new RangeError(`Invalid time of day "${time}", expected HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 1050 → "17:30". */
export function formatTimeOfDay(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
    throw new RangeError(`Invalid minutes since midnight: ${minutes}`);
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseIsoDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d) {
      return { y, m, d };
    }
  }
  throw new RangeError(`Invalid date "${date}", expected YYYY-MM-DD`);
}

export function isIsoDate(date: string): boolean {
  try {
    parseIsoDate(date);
    return true;
  } catch {
    return false;
  }
}

/** Day of the week of a calendar date (no time zone involved). */
export function weekdayOf(date: string): Weekday {
  const { y, m, d } = parseIsoDate(date);
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

/** Calendar arithmetic on "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in a time zone. */
function wallClock(instant: number, timeZone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(instant))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** Offset of the zone from UTC at an instant, in ms (Europe/London in summer: +3 600 000). */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return wallAsUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant at which the family's clock shows `time` on `date`.
 *
 * Around daylight-saving changes:
 * - a time skipped when clocks go forward (01:30 on the spring change in London) is moved
 *   forward by the gap (to 02:30), so a chore in the gap still happens that day;
 * - a time that occurs twice when clocks go back resolves to the first occurrence.
 */
export function zonedTimeToInstant(date: string, time: string, timeZone: string): number {
  const { y, m, d } = parseIsoDate(date);
  const minutes = parseTimeOfDay(time);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);

  // Assume at most one offset change within 12 hours either side (true for real zones).
  const before = offsetAt(wall - 12 * HOUR_MS, timeZone);
  const after = offsetAt(wall + 12 * HOUR_MS, timeZone);
  const valid = [before, after]
    .map((offset) => wall - offset)
    .filter((candidate) => wall - offsetAt(candidate, timeZone) === candidate);

  if (valid.length > 0) return Math.min(...valid);
  // In a gap: use the offset from before the change, which lands after the gap.
  return wall - before;
}

/** Calendar date ("YYYY-MM-DD") of an instant in the family's time zone. */
export function zonedDateOf(instant: number, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/** Wall-clock time ("HH:MM") of an instant in the family's time zone. */
export function zonedTimeOf(instant: number, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return formatTimeOfDay(w.h * 60 + w.mi);
}

/** The instant the family's day `date` starts (usually local midnight). */
export function startOfZonedDay(date: string, timeZone: string): number {
  return zonedTimeToInstant(date, '00:00', timeZone);
}
