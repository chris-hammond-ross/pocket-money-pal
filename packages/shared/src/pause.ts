/**
 * The holiday pause (ADR 0004, ADR 0016): which pause still matters, whether a new one is
 * allowed, and how the kiosk counts down to the family coming back. Pure functions: today
 * is always passed in. `isPausedOn` (chores.ts) says whether one date is paused.
 */
import { isPausedOn, type SchedulePause } from './chores';
import { addDays } from './time';

/** The longest pause a parent can set with an end date. */
export const PAUSE_MAX_DAYS = 90;

/** The phone's length chips (ADR 0016). `days: null` is "Until I resume". */
export const PAUSE_PRESETS = [
  { key: '3d', label: '3 days', days: 3 },
  { key: '1w', label: '1 week', days: 7 },
  { key: '2w', label: '2 weeks', days: 14 },
  { key: 'open', label: 'Until I resume', days: null },
] as const;

/** Whole days from `a` to `b` ("YYYY-MM-DD"): 1 from today to tomorrow. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The pause still to come or going on, or null when there's none or it's over. */
export function currentPause(pause: SchedulePause | null, today: string): SchedulePause | null {
  if (pause === null || (pause.until !== null && pause.until < today)) return null;
  return pause;
}

/** Whether the pause covers today ("active"), starts later ("upcoming"), or neither. */
export function pauseState(
  pause: SchedulePause | null,
  today: string,
): 'active' | 'upcoming' | null {
  const current = currentPause(pause, today);
  if (current === null) return null;
  return isPausedOn(current, today) ? 'active' : 'upcoming';
}

/** The last paused date of a pause of `days` days from `from` (inclusive). */
export function pauseUntilFor(from: string, days: number): string {
  return addDays(from, days - 1);
}

/**
 * Why a pause can't be set, or null when it can. A new pause starts today or later; a
 * pause already going on keeps its start (so it can be shortened or made longer). Either
 * way it can't end before today. `next` has already passed `schedulePauseSchema`.
 */
export function pauseProblem(
  next: SchedulePause,
  current: SchedulePause | null,
  today: string,
): string | null {
  const ongoing = pauseState(current, today) === 'active' && current!.from === next.from;
  if (next.from < today && !ongoing) return 'A pause can’t start in the past';
  if (next.until !== null && next.until < today) return 'A pause can’t end before today';
  if (next.until !== null && daysBetween(next.from, next.until) + 1 > PAUSE_MAX_DAYS) {
    return `A pause can be up to ${PAUSE_MAX_DAYS} days, or until you resume`;
  }
  return null;
}

/**
 * The kiosk's countdown while paused: the first day back, and the sleeps until then
 * (1 on the last paused day). Both null for "until a parent resumes".
 */
export function pauseCountdown(
  pause: SchedulePause,
  today: string,
): { backOn: string | null; sleeps: number | null } {
  if (pause.until === null) return { backOn: null, sleeps: null };
  const backOn = addDays(pause.until, 1);
  return { backOn, sleeps: daysBetween(today, backOn) };
}
