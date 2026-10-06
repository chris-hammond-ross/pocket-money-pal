/**
 * Surprise quests (spec 006): the rules a sent surprise (a "run") follows, as pure
 * functions. The server decides everything with these; screens use them to draw it.
 */
import type { InstanceStatus } from './schemas';
import { isQuietTime, type QuietHours } from './notify';
import { formatTimeOfDay, zonedTimeToInstant } from './time';

const MINUTE_MS = 60_000;

/** How long a surprise stays up on the kiosk to be accepted, in minutes (the stepper's stops). */
export const SURPRISE_TIME_FRAMES = [1, 2, 5, 10, 15, 20, 30, 45, 60] as const;
export type SurpriseTimeFrame = (typeof SURPRISE_TIME_FRAMES)[number];

/** A surprise's reward: 5–100 points, in steps of 5. */
export const SURPRISE_REWARD = { min: 5, max: 100, step: 5 } as const;

export const SURPRISE_TITLE_MAX = 40;

/** A new quest in the panel starts with these. */
export const SURPRISE_DEFAULTS = { icon: '⚡', rewardPoints: 10, timeFrameMin: 30 } as const;

/** The icons the panel offers for a new surprise quest. */
export const SURPRISE_ICONS = [
  '⚡',
  '🧹',
  '🛍️',
  '🎁',
  '🧦',
  '📬',
  '🧽',
  '🐕',
  '🧺',
  '🚗',
  '🍪',
  '🪴',
  '🗑️',
  '📦',
  '🧸',
  '🍽️',
] as const;

/** A set time must be at least this far ahead. */
export const SURPRISE_LEAD_MS = 10 * MINUTE_MS;

/**
 * The times a grab gives its one-off quest (bonus, due and late all at once): it's never
 * late today, and with no early bonus or late penalty the reward is all it can earn.
 */
export const SURPRISE_CHORE_TIME = '23:59';

export const SURPRISE_RUN_STATUSES = [
  'scheduled',
  'queued',
  'live',
  'grabbed',
  'expired',
  'cancelled',
] as const;
export type SurpriseRunStatus = (typeof SURPRISE_RUN_STATUSES)[number];

/** Who can accept a surprise: every child, or one named child (by id). */
export type SurpriseWho = 'all' | number;

/** The next stop on the time-frame stepper, staying on the ends. */
export function stepTimeFrame(current: number, dir: 1 | -1): SurpriseTimeFrame {
  const stops = SURPRISE_TIME_FRAMES;
  if (dir === 1) return stops.find((s) => s > current) ?? stops[stops.length - 1]!;
  return [...stops].reverse().find((s) => s < current) ?? stops[0];
}

/** The reward stepper: ±5, kept within 5–100. */
export function stepReward(current: number, dir: 1 | -1): number {
  const { min, max, step } = SURPRISE_REWARD;
  return Math.min(max, Math.max(min, current + dir * step));
}

/** "30 min", or "1 hour" for 60. */
export function formatTimeFrame(minutes: number): string {
  return minutes === 60 ? '1 hour' : `${minutes} min`;
}

// ---------------------------------------------------------------------------
// When it appears

/**
 * The panel's "Today at [time ▾]" choices: every quarter hour today at least 10 minutes
 * from `now`, outside quiet hours. Empty late in the evening.
 */
export function surpriseTimeSlots(
  today: string,
  now: number,
  timeZone: string,
  quiet: QuietHours | null,
): string[] {
  const slots: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    const time = formatTimeOfDay(minutes);
    if (setTimeProblem(time, today, now, timeZone, quiet) === null) slots.push(time);
  }
  return slots;
}

export type SetTimeProblem = 'not-quarter' | 'too-soon' | 'quiet';

/** Why a set time ("HH:MM" today) can't be used, or null when it can (spec 006). */
export function setTimeProblem(
  time: string,
  today: string,
  now: number,
  timeZone: string,
  quiet: QuietHours | null,
): SetTimeProblem | null {
  if (Number(time.slice(3)) % 15 !== 0) return 'not-quarter';
  if (zonedTimeToInstant(today, time, timeZone) < now + SURPRISE_LEAD_MS) return 'too-soon';
  if (isQuietTime(quiet, time)) return 'quiet';
  return null;
}

/**
 * A scheduled run whose time has come (or not): it waits until `appearAt`, then appears
 * with its full time frame. If the server was down at that moment it still appears when it
 * starts again within the time frame; any later, it expires without showing.
 */
export function dueRunFate(
  appearAt: number,
  timeFrameMin: number,
  now: number,
): 'wait' | 'appear' | 'expire' {
  if (now < appearAt) return 'wait';
  return now < appearAt + timeFrameMin * MINUTE_MS ? 'appear' : 'expire';
}

/** Queued runs in the order they go live: oldest first, by when they were sent or due. */
export function queueOrder<T extends { id: number; appearAt: number | null; sentAt: number }>(
  runs: readonly T[],
): T[] {
  const key = (r: T) => r.appearAt ?? r.sentAt;
  return [...runs].sort((a, b) => key(a) - key(b) || a.id - b.id);
}

// ---------------------------------------------------------------------------
// The grab

/**
 * The children who can accept a run now: the named child, or every child, leaving out
 * anyone on a sick day (ADR 0013). `children` are the active ones, in column order.
 */
export function surpriseEligible(
  runChildId: number | null,
  children: readonly { id: number; sick: boolean }[],
): number[] {
  return children
    .filter((c) => !c.sick && (runChildId === null || c.id === runChildId))
    .map((c) => c.id);
}

/**
 * "We'll all do it!" needs a run for all children and at least two who can take it. Such a
 * run is team-only: nobody can grab it alone (with one child left, it's theirs).
 */
export function canGrabTogether(runChildId: number | null, eligible: readonly number[]): boolean {
  return runChildId === null && eligible.length >= 2;
}

export type GrabProblem = 'not-live' | 'already-grabbed' | 'expired' | 'not-eligible';
export type Grab = { childId: number } | { all: true };

/**
 * Why a grab fails, or null when it wins (spec 006, "The claim race"): the run must be
 * live with time left, and the child (or, for "all", the run) eligible. A run that can be
 * grabbed together can't be grabbed alone.
 */
export function grabProblem(
  run: { status: SurpriseRunStatus; expiresAt: number | null; childId: number | null },
  grab: Grab,
  eligible: readonly number[],
  now: number,
): GrabProblem | null {
  if (run.status === 'grabbed') return 'already-grabbed';
  if (run.status === 'expired') return 'expired';
  if (run.status !== 'live') return 'not-live';
  if (run.expiresAt === null || now >= run.expiresAt) return 'expired';
  const team = canGrabTogether(run.childId, eligible);
  if ('all' in grab) return team ? null : 'not-eligible';
  return !team && eligible.includes(grab.childId) ? null : 'not-eligible';
}

// ---------------------------------------------------------------------------
// After sending

export type SurpriseRowState =
  'scheduled' | 'queued' | 'live' | 'grabbed' | 'done' | 'approved' | 'expired' | 'cancelled';

/**
 * Where a run's row stands on the Day tab (spec 006). After the grab, progress lives on
 * the takers' instances: any claimed means "to check", all approved means approved.
 */
export function surpriseRowState(run: {
  status: SurpriseRunStatus;
  takers: readonly { status: InstanceStatus }[];
}): SurpriseRowState {
  if (run.status !== 'grabbed') return run.status;
  const statuses = run.takers.map((t) => t.status);
  if (statuses.some((s) => s === 'claimed')) return 'done';
  if (statuses.length > 0 && statuses.every((s) => s === 'approved')) return 'approved';
  return 'grabbed';
}

/** "Billy", "Billy & Alice", "Billy, Alice & Cleo". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** How fast it was grabbed: "4s", "2 min". Partial seconds round down, never below 1s. */
export function formatGrabTime(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

export interface SurpriseBanner {
  icon: string;
  title: string;
  body: string;
}

/**
 * The phone's in-app banners (spec 006, "In-app banners"). `names` are the children's
 * names (and avatars) the moment is about.
 */
export function surpriseBanner(
  moment:
    | { kind: 'grabbed'; title: string; taker: { name: string; avatar: string }; ms: number | null }
    | { kind: 'team'; title: string; names: readonly string[]; reward: number }
    | { kind: 'done'; title: string; names: readonly string[]; avatar: string }
    | { kind: 'expired'; title: string }
    | { kind: 'appeared'; title: string },
): SurpriseBanner {
  switch (moment.kind) {
    case 'grabbed':
      return {
        icon: moment.taker.avatar,
        title: `${moment.taker.name} grabbed ‘${moment.title}’`,
        body: `${moment.ms === null ? '' : `in ${formatGrabTime(moment.ms)} · `}it’s on ${moment.taker.name}’s board now`,
      };
    case 'team':
      return {
        icon: '👫',
        title: `${joinNames(moment.names)}: “We’ll all do it!”`,
        body: `‘${moment.title}’ · +${moment.reward} each when it’s done`,
      };
    case 'done':
      return {
        icon: moment.names.length > 1 ? '✋' : moment.avatar,
        title: `${joinNames(moment.names)} ${moment.names.length > 1 ? 'say' : 'says'} ‘${moment.title}’ is done`,
        body: 'Check it in the tray',
      };
    case 'expired':
      return {
        icon: '😴',
        title: `Nobody grabbed ‘${moment.title}’`,
        body: 'Tap its row to send it again',
      };
    case 'appeared':
      return {
        icon: '🕒',
        title: `‘${moment.title}’ just popped up`,
        body: 'As you scheduled it',
      };
  }
}
