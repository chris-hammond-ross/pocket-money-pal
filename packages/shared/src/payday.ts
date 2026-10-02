/**
 * Payday (spec 004, ADR 0010): when it is, which slot a payday covers, how the countdown
 * reads, the week's stats for the show, and the gift and spending note chips.
 * Pure functions: the time is always passed in.
 */
import {
  addDays,
  parseTimeOfDay,
  weekdayOf,
  WEEKDAYS,
  zonedDateOf,
  zonedTimeOf,
  zonedTimeToInstant,
} from './time';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Payday day as stored: 0 = Sunday … 6 = Saturday. */
export const PAYDAY_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The phone's day chips, Friday to Sunday first (spec 004). */
export const PAYDAY_DAY_ORDER = [5, 6, 0, 1, 2, 3, 4] as const;

export const DEFAULT_PAYDAY = { day: 0, time: '18:00', auto: true } as const;

export interface PaydaySchedule {
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** "HH:MM", on the hour. */
  time: string;
}

/** Day of the week of a calendar date, 0 = Sunday. */
function sundayIndex(date: string): number {
  return (WEEKDAYS.indexOf(weekdayOf(date)) + 1) % 7;
}

/** The latest payday slot at or before `now` (an instant). */
export function paydaySlotOnOrBefore(
  now: number,
  schedule: PaydaySchedule,
  timeZone: string,
): number {
  const today = zonedDateOf(now, timeZone);
  const back = (sundayIndex(today) - schedule.day + 7) % 7;
  const slot = zonedTimeToInstant(addDays(today, -back), schedule.time, timeZone);
  if (slot <= now) return slot;
  return zonedTimeToInstant(addDays(today, -back - 7), schedule.time, timeZone);
}

/** The first payday slot after `t`. */
export function paydaySlotAfter(t: number, schedule: PaydaySchedule, timeZone: string): number {
  const today = zonedDateOf(t, timeZone);
  const ahead = (schedule.day - sundayIndex(today) + 7) % 7;
  const slot = zonedTimeToInstant(addDays(today, ahead), schedule.time, timeZone);
  if (slot > t) return slot;
  return zonedTimeToInstant(addDays(today, ahead + 7), schedule.time, timeZone);
}

export interface PaydayState {
  now: number;
  schedule: PaydaySchedule;
  timeZone: string;
  /** The slot the latest payday covered, or null before the first. */
  lastSlot: number | null;
  /** When the day or time last changed: earlier slots never start a payday. */
  since: number | null;
}

/**
 * The slot waiting for a payday: the latest one that has passed, if no payday covers it
 * and it's after the last schedule change. The scheduler runs it (automatic mode), or the
 * phones are told and wait for "Start payday now".
 */
export function duePaydaySlot(state: PaydayState): number | null {
  const slot = paydaySlotOnOrBefore(state.now, state.schedule, state.timeZone);
  if (state.lastSlot !== null && slot <= state.lastSlot) return null;
  if (state.since !== null && slot <= state.since) return null;
  return slot;
}

/**
 * The slot "Start payday now" covers: the waiting one, or else the next one (which is then
 * skipped). Null when the next one is already covered too.
 */
export function manualPaydaySlot(state: PaydayState): number | null {
  const due = duePaydaySlot(state);
  if (due !== null) return due;
  const next = paydaySlotAfter(state.now, state.schedule, state.timeZone);
  return state.lastSlot !== null && state.lastSlot >= next ? null : next;
}

/** The next payday the board counts down to: the first slot no payday has covered yet. */
export function nextPaydaySlot(state: PaydayState): number {
  return paydaySlotAfter(
    Math.max(state.now, state.lastSlot ?? -Infinity),
    state.schedule,
    state.timeZone,
  );
}

/** The loot card's countdown: "3d 1h", "1h 20m", or "20m" (minutes round up). */
export function formatPaydayCountdown(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / MINUTE_MS));
  if (mins >= 24 * 60) {
    const d = Math.floor(mins / (24 * 60));
    return `${d}d ${Math.floor((mins % (24 * 60)) / 60)}h`;
  }
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

/** The payday box glows in the last hour. */
export function isPaydaySoon(ms: number): boolean {
  return ms > 0 && ms <= HOUR_MS;
}

/** "6pm", "9:30am": a time of day on a 12-hour clock. */
export function formatClock12(time: string): string {
  const minutes = parseTimeOfDay(time);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** "Sun 6pm": a slot's day and time in the family time zone. */
export function formatPaydayWhen(slot: number, timeZone: string): string {
  const day = PAYDAY_DAY_NAMES[sundayIndex(zonedDateOf(slot, timeZone))]!.slice(0, 3);
  return `${day} ${formatClock12(zonedTimeOf(slot, timeZone))}`;
}

/** The phone's time chips: on the hour, 7am to 9pm. */
export const PAYDAY_TIMES = Array.from(
  { length: 15 },
  (_, i) => `${String(i + 7).padStart(2, '0')}:00`,
);

// ---------------------------------------------------------------------------
// The payday show's stats

export interface PaydayStats {
  questsDone: number;
  earlyBonuses: number;
  unprompted: number;
  /** The day with the most points ("Tue · 40 pts"), or null with none. */
  bestDay: { date: string; points: number } | null;
}

/**
 * The week's stats for the show, counted since the previous payday: approved quests (not
 * undone), how many had the early or unprompted bonus, and the best day by earned points.
 */
export function paydayStats(
  input: {
    quests: readonly { early: boolean; unprompted: boolean }[];
    earned: readonly { at: number; points: number }[];
  },
  timeZone: string,
): PaydayStats {
  const byDate = new Map<string, number>();
  for (const e of input.earned) {
    const date = zonedDateOf(e.at, timeZone);
    byDate.set(date, (byDate.get(date) ?? 0) + e.points);
  }
  let bestDay: PaydayStats['bestDay'] = null;
  for (const [date, points] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    if (points > 0 && (bestDay === null || points > bestDay.points)) bestDay = { date, points };
  }
  return {
    questsDone: input.quests.length,
    earlyBonuses: input.quests.filter((q) => q.early).length,
    unprompted: input.quests.filter((q) => q.unprompted).length,
    bestDay,
  };
}

/** "Tue" for a date. */
export function shortDayName(date: string): string {
  return PAYDAY_DAY_NAMES[sundayIndex(date)]!.slice(0, 3);
}

/** How long a payday stays worth showing on a kiosk that has never shown one. */
export const PAYDAY_SHOW_FRESH_MS = 7 * DAY_MS;

// ---------------------------------------------------------------------------
// Gifts and spending (the phone's sheets)

export const GIFT_AMOUNTS = [100, 500, 1000, 2000] as const;

/** Note chips for a gift. `from` names the envelope's sender; null means the parent. */
export const GIFT_NOTES: readonly { note: string; from: string | null }[] = [
  { note: '🎂 Birthday money', from: null },
  { note: '👵 From Grandma', from: 'Grandma' },
  { note: '🦷 Tooth fairy', from: 'the Tooth Fairy' },
  { note: '🧹 Extra job', from: null },
  { note: '🪙 Found coins', from: null },
];

/** Who an envelope is from: the note chip's sender, or the parent who sent it. */
export function envelopeSender(note: string, parentName: string): string {
  return GIFT_NOTES.find((g) => g.note === note)?.from ?? parentName;
}

export const SPEND_NOTES = [
  '🛒 Bought something',
  '🍬 Sweets',
  '🎟️ Day out',
  '🎁 Present for someone',
  '🎮 Game',
] as const;

export const NOTE_MAX = 40;
