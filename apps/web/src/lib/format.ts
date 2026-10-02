import { parseTimeOfDay, zonedTimeOf, type Weekday } from '@pmp/shared';

/** "07:45" → "7:45am", "18:00" → "6pm". */
export function clock12(time: string): string {
  const minutes = parseTimeOfDay(time);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour = ((h + 11) % 12) + 1;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** "17:00" → "5:00pm", "07:45" → "7:45am": the kiosk always shows the minutes. */
export function clockTime(time: string): string {
  const minutes = parseTimeOfDay(time);
  const h = Math.floor(minutes / 60);
  return `${((h + 11) % 12) + 1}:${String(minutes % 60).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

/** An instant as the family's wall clock: "4:40pm". */
export function clockTimeAt(instant: number, timeZone: string): string {
  return clockTime(zonedTimeOf(instant, timeZone));
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatMinutesAgo(instant: number, now = Date.now()): string {
  const mins = Math.floor((now - instant) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const DAY_SHORT: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** This browser's IANA time zone, e.g. "Europe/London". */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A short random id for things that don't have a server id yet. Not `crypto.randomUUID`:
 * that needs a secure origin, and phones reach the PC over plain HTTP.
 */
export function newKey(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
