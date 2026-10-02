/**
 * The parent phone's planning rules (spec 003): the Day strip's week, the quest editor's
 * zoomed window bar and its draggable markers, and the Week tab's totals. Pure functions.
 */
import type { ChoreSchedule, ChoreTimes } from './chores';
import {
  addDays,
  formatTimeOfDay,
  parseTimeOfDay,
  weekdayOf,
  WEEKDAYS,
  type Weekday,
} from './time';

/** Monday to Sunday of the week holding `date`, as "YYYY-MM-DD". */
export function weekDates(date: string): string[] {
  const monday = addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
  return WEEKDAYS.map((_, i) => addDays(monday, i));
}

/** Minutes since midnight. */
export interface MinuteSpan {
  start: number;
  end: number;
}

const EDITOR_EARLIEST = 5 * 60;
const EDITOR_LATEST = 23 * 60;
const EDITOR_MIN_SPAN = 5 * 60;
const EDITOR_MARGIN = 90;

/** Markers snap to this many minutes. */
export const MARKER_STEP_MINUTES = 15;

/**
 * The quest editor's bar (spec 003): from 90 minutes before `bonus_before` (rounded down to
 * the hour) to 90 minutes after `late_after` (rounded up), at least 5 hours wide, and never
 * outside 5am–11pm. Worked out once when the sheet opens, so the bar never moves under a
 * finger.
 */
export function editorSpan(times: ChoreTimes): MinuteSpan {
  const bonus = parseTimeOfDay(times.bonusBefore);
  const late = parseTimeOfDay(times.lateAfter);
  let start = Math.max(EDITOR_EARLIEST, Math.floor((bonus - EDITOR_MARGIN) / 60) * 60);
  let end = Math.min(EDITOR_LATEST, Math.ceil((late + EDITOR_MARGIN) / 60) * 60);
  if (end - start < EDITOR_MIN_SPAN) end = Math.min(EDITOR_LATEST, start + EDITOR_MIN_SPAN);
  if (end - start < EDITOR_MIN_SPAN) start = Math.max(EDITOR_EARLIEST, end - EDITOR_MIN_SPAN);
  return { start, end };
}

/** The hours to label under the editor bar: every hour, or every other past 8 hours. */
export function editorHourLabels(span: MinuteSpan): number[] {
  const hours: number[] = [];
  const every = span.end - span.start > 8 * 60 ? 2 : 1;
  for (let m = span.start, i = 0; m <= span.end; m += 60, i++) {
    if (i % every === 0) hours.push(m / 60);
  }
  return hours;
}

export type MarkerKey = keyof ChoreTimes;
const MARKER_ORDER: MarkerKey[] = ['bonusBefore', 'dueBy', 'lateAfter'];

/**
 * Moves one marker to `minutes`: snapped to 15 minutes, kept on the bar, and never past its
 * neighbours (`bonus_before ≤ due_by ≤ late_after`; equal is allowed). The others stay put.
 */
export function moveMarker(
  times: ChoreTimes,
  key: MarkerKey,
  minutes: number,
  span: MinuteSpan,
): ChoreTimes {
  const i = MARKER_ORDER.indexOf(key);
  const before = MARKER_ORDER[i - 1];
  const after = MARKER_ORDER[i + 1];
  const lo = before ? parseTimeOfDay(times[before]) : span.start;
  const hi = after ? parseTimeOfDay(times[after]) : span.end;
  const snapped = Math.round(minutes / MARKER_STEP_MINUTES) * MARKER_STEP_MINUTES;
  const onBar = Math.max(span.start, Math.min(span.end, snapped));
  return { ...times, [key]: formatTimeOfDay(Math.max(lo, Math.min(hi, onBar))) };
}

/** Where a time falls on a span, as a percentage clamped to 0–100. */
export function spanPercent(span: MinuteSpan, minutes: number): number {
  const pct = ((minutes - span.start) / (span.end - span.start)) * 100;
  return Math.max(0, Math.min(100, pct));
}

export interface PlannableChore extends ChoreSchedule {
  basePoints: number;
  childIds: readonly number[];
}

/** The Week tab's bottom row: base points on that weekday, across all children. */
export function basePointsOnDay(chores: readonly PlannableChore[], day: Weekday): number {
  return chores
    .filter((c) => c.oneOffDate === null && c.days.includes(day))
    .reduce((sum, c) => sum + c.basePoints * c.childIds.length, 0);
}

/** A child's recurring base points over a week ("235 pts a week on time"). */
export function weeklyBasePoints(chores: readonly PlannableChore[], childId: number): number {
  return chores
    .filter((c) => c.oneOffDate === null && c.childIds.includes(childId))
    .reduce((sum, c) => sum + c.basePoints * c.days.length, 0);
}

/**
 * Which marker a drag should move. Markers may sit on the same time; then the one under
 * the finger may be pinned by its neighbour in the direction of the drag, so the drag
 * passes to that neighbour (dragging left from a shared 🏁/💀 moves 🏁, right moves 💀).
 */
export function markerToDrag(times: ChoreTimes, key: MarkerKey, minutes: number): MarkerKey {
  let i = MARKER_ORDER.indexOf(key);
  const at = (j: number) => parseTimeOfDay(times[MARKER_ORDER[j]!]);
  const here = at(i);
  if (minutes < here) while (i > 0 && at(i - 1) === here) i--;
  else if (minutes > here) while (i < MARKER_ORDER.length - 1 && at(i + 1) === here) i++;
  return MARKER_ORDER[i]!;
}
