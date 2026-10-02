/**
 * Chore timing and scoring rules (specs 001, 002 and 003, ADR 0003).
 * Pure functions: the time is always passed in.
 */
import { weekdayOf, zonedTimeToInstant, type Weekday } from './time';

/** Where a chore is in its day, relative to its three deadlines. */
export type ChoreStage = 'bonus' | 'due' | 'overdue' | 'late';

/** A chore's wall-clock deadlines ("HH:MM", family time zone). bonusBefore ≤ dueBy ≤ lateAfter. */
export interface ChoreTimes {
  bonusBefore: string;
  dueBy: string;
  lateAfter: string;
}

/** The same deadlines resolved to instants (epoch ms) for one day. */
export interface ChoreWindow {
  bonusBefore: number;
  dueBy: number;
  lateAfter: number;
}

/** What a chore can earn. All whole numbers ≥ 0; the late penalty is stored positive. */
export interface ChoreLoot {
  basePoints: number;
  earlyBonus: number;
  unpromptedBonus: number;
  latePenalty: number;
}

/** Which bonuses apply to one claim; parents can flip these when approving (spec 002). */
export interface PointChips {
  early: boolean;
  unprompted: boolean;
  late: boolean;
  /** Parent's extra points on top, may be negative. Whole number. */
  extra?: number;
}

/** Itemised points for a claim or approval. Stored on the instance, not only the total. */
export interface PointsBreakdown {
  base: number;
  early: number;
  unprompted: number;
  /** Penalty taken off, as a positive number (0 when not late). */
  late: number;
  extra: number;
  /** base + early + unprompted − late + extra, never below 0. */
  total: number;
}

export function choreWindow(date: string, times: ChoreTimes, timeZone: string): ChoreWindow {
  return {
    bonusBefore: zonedTimeToInstant(date, times.bonusBefore, timeZone),
    dueBy: zonedTimeToInstant(date, times.dueBy, timeZone),
    lateAfter: zonedTimeToInstant(date, times.lateAfter, timeZone),
  };
}

/**
 * Stage at `now`. Each deadline is inclusive: at exactly `bonusBefore` the early bonus
 * still counts, and the late penalty starts strictly after `lateAfter`.
 */
export function choreStage(window: ChoreWindow, now: number): ChoreStage {
  if (now <= window.bonusBefore) return 'bonus';
  if (now <= window.dueBy) return 'due';
  if (now <= window.lateAfter) return 'overdue';
  return 'late';
}

/** The deadline the chore is counting down to, or null once it's late. */
export function nextDeadline(window: ChoreWindow, now: number): number | null {
  switch (choreStage(window, now)) {
    case 'bonus':
      return window.bonusBefore;
    case 'due':
      return window.dueBy;
    case 'overdue':
      return window.lateAfter;
    case 'late':
      return null;
  }
}

/** The bonuses a claim gets by default: from the claim time and what the child said. */
export function defaultChips(stageAtClaim: ChoreStage, unprompted: boolean): PointChips {
  return { early: stageAtClaim === 'bonus', unprompted, late: stageAtClaim === 'late', extra: 0 };
}

export function scorePoints(loot: ChoreLoot, chips: PointChips): PointsBreakdown {
  const extra = chips.extra ?? 0;
  if (!Number.isInteger(extra)) throw new TypeError(`extra must be an integer, got ${extra}`);
  const breakdown = {
    base: loot.basePoints,
    early: chips.early ? loot.earlyBonus : 0,
    unprompted: chips.unprompted ? loot.unpromptedBonus : 0,
    late: chips.late ? loot.latePenalty : 0,
    extra,
  };
  const sum =
    breakdown.base + breakdown.early + breakdown.unprompted - breakdown.late + breakdown.extra;
  return { ...breakdown, total: Math.max(0, sum) };
}

/** Points for a child's claim at `claimedAt`, before any parent changes. */
export function claimPoints(
  loot: ChoreLoot,
  window: ChoreWindow,
  claimedAt: number,
  unprompted: boolean,
): PointsBreakdown {
  return scorePoints(loot, defaultChips(choreStage(window, claimedAt), unprompted));
}

/** "Up to +N" on an open quest card: the most it can earn if claimed now (spec 001). */
export function maxPointsNow(loot: ChoreLoot, window: ChoreWindow, now: number): number {
  return claimPoints(loot, window, now, true).total;
}

/** The earnings line and points range (spec 003): on time, best case, and late. */
export function pointsRange(loot: ChoreLoot): { onTime: number; max: number; late: number } {
  return {
    onTime: scorePoints(loot, { early: false, unprompted: false, late: false }).total,
    max: scorePoints(loot, { early: true, unprompted: true, late: false }).total,
    late: scorePoints(loot, { early: false, unprompted: false, late: true }).total,
  };
}

export interface RankableChore {
  id: number | string;
  window: ChoreWindow;
}

/**
 * Orders open chores for the "Next up" countdown (spec 001): overdue first; then the
 * fewest ms left to the next deadline; ties by due time, then late-after time; late
 * chores last (earliest late first). The first item is the one to show.
 */
export function rankNextUp<T extends RankableChore>(chores: readonly T[], now: number): T[] {
  const tier = (c: T) => {
    const stage = choreStage(c.window, now);
    return stage === 'overdue' ? 0 : stage === 'late' ? 2 : 1;
  };
  const left = (c: T) => (nextDeadline(c.window, now) ?? c.window.lateAfter) - now;

  return [...chores].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (tier(a) === 2 ? a.window.lateAfter - b.window.lateAfter : left(a) - left(b)) ||
      a.window.dueBy - b.window.dueBy ||
      a.window.lateAfter - b.window.lateAfter ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );
}

/** When a chore runs: on chosen weekdays, or once on a one-off date. */
export interface ChoreSchedule {
  days: readonly Weekday[];
  oneOffDate: string | null;
}

export function choreRunsOn(schedule: ChoreSchedule, date: string): boolean {
  if (schedule.oneOffDate !== null) return schedule.oneOffDate === date;
  return schedule.days.includes(weekdayOf(date));
}

/**
 * A family-wide pause (holidays): no chores are created on paused dates. `until` is
 * inclusive; null means paused until a parent resumes.
 */
export interface SchedulePause {
  from: string;
  until: string | null;
}

export function isPausedOn(pause: SchedulePause | null, date: string): boolean {
  if (pause === null) return false;
  return date >= pause.from && (pause.until === null || date <= pause.until);
}
