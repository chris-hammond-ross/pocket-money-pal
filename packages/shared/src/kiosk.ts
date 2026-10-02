/**
 * Kiosk dashboard rules (spec 001): the order of a column's quests, each quest's tracking
 * bar, and how countdowns read. Pure functions: the time is always passed in.
 */
import { choreStage, rankNextUp, type ChoreWindow } from './chores';

const MINUTE_MS = 60_000;

/** A tracking bar starts this long before its quest's bonus ends (spec 001). */
export const TRACK_LEAD_MS = 2 * 60 * MINUTE_MS;

/** The countdown throbs, and 2.5's tick-tock plays, in a bonus's last 5 minutes. */
export const BONUS_ENDING_MS = 5 * MINUTE_MS;

/** The span a quest's tracking bar covers, as instants. */
export interface QuestTrack {
  start: number;
  end: number;
}

/**
 * A quest's own tracking bar: from `bonus_before − 2h` (but not before the day starts)
 * to `late_after`.
 */
export function questTrack(window: ChoreWindow, dayStart: number): QuestTrack {
  return { start: Math.max(dayStart, window.bonusBefore - TRACK_LEAD_MS), end: window.lateAfter };
}

/** Where `t` falls on a track, as a percentage clamped to 0–100. */
export function trackPercent(track: QuestTrack, t: number): number {
  if (track.end <= track.start) return t < track.end ? 0 : 100;
  const pct = ((t - track.start) / (track.end - track.start)) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** True in the last 5 minutes of a quest's bonus time (inclusive of the deadline). */
export function isBonusEnding(window: ChoreWindow, now: number): boolean {
  return choreStage(window, now) === 'bonus' && window.bonusBefore - now <= BONUS_ENDING_MS;
}

/**
 * The Next-up countdown: "m:ss", or "h:mm:ss" from an hour up. Partial seconds round up,
 * so it reads 0:00 only at the deadline itself.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Time left on a quest card's status line: "20 min", "1h 20m", "2h". Partial minutes
 * round up, so a quest with 30 seconds left says "1 min", not "0 min".
 */
export function formatMinutesLeft(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / MINUTE_MS));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface KioskOrderable {
  id: number | string;
  status: 'open' | 'claimed' | 'approved' | 'skipped';
  window: ChoreWindow;
  claimedAt: number | null;
  approvedAt: number | null;
}

/**
 * A column's quests in spec order: open quests most pressing first (the Next-up ranking),
 * then claimed ones in claim order, then today's approved ones in approval order.
 * Skipped quests aren't shown.
 */
export function orderKioskQuests<T extends KioskOrderable>(quests: readonly T[], now: number): T[] {
  const by = (key: 'claimedAt' | 'approvedAt') => (a: T, b: T) =>
    (a[key] ?? 0) - (b[key] ?? 0) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  return [
    ...rankNextUp(
      quests.filter((q) => q.status === 'open'),
      now,
    ),
    ...quests.filter((q) => q.status === 'claimed').sort(by('claimedAt')),
    ...quests.filter((q) => q.status === 'approved').sort(by('approvedAt')),
  ];
}
