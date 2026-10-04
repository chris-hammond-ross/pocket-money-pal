/**
 * Money and jars (spec 004, ADR 0010): balances derived from the ledger, the payday
 * conversion, jar progress and milestones, the limits on moving coins, and jar stats.
 * Pure functions: everything is passed in. Money is integer cents; points are integers.
 */
import { centsToPoints, formatMoneyShort } from './money';

const DAY_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Balances

/** The ledger kinds (`ledger.kind`), as `apps/server/src/db/schema.ts` stores them. */
export type MoneyLedgerKind =
  | 'chore_points'
  | 'bonus'
  | 'penalty'
  | 'conversion'
  | 'extra_income'
  | 'goal_allocation'
  | 'spend'
  | 'adjustment';

/** The columns of one ledger row that money depends on. */
export interface MoneyLedgerRow {
  id: number;
  kind: MoneyLedgerKind;
  points: number;
  cents: number;
  centsPerPoint: number | null;
  goalId: number | null;
}

export interface PendingConversion {
  /** Points since the last conversion (may be zero or negative). */
  points: number;
  /** Those points' worth, each row at its own rate. */
  cents: number;
}

export interface MoneySummary {
  /** The money balance: every row's cents except moves between "to sort" and jars. */
  savedCents: number;
  /** Cents in each jar that has rows (deleted and bought jars net to 0). */
  jarCents: Map<number, number>;
  /** Saved minus the money in live jars. */
  toSortCents: number;
  /** Points since the last conversion, and what payday would make of them now. */
  unconverted: PendingConversion;
}

/**
 * Points and their worth in the rows after the last `conversion` row (by id). Each row
 * converts at its own `cents_per_point` (ADR 0004), so a rate change applies from then on.
 * A row without a rate uses `fallbackRate`.
 */
export function pendingConversion(
  rows: readonly MoneyLedgerRow[],
  fallbackRate: number,
): PendingConversion {
  let lastConversion = -Infinity;
  for (const r of rows) if (r.kind === 'conversion' && r.id > lastConversion) lastConversion = r.id;
  let points = 0;
  let cents = 0;
  for (const r of rows) {
    if (r.id <= lastConversion || r.kind === 'conversion' || r.points === 0) continue;
    points += r.points;
    cents += r.points * (r.centsPerPoint ?? fallbackRate);
  }
  return { points, cents };
}

/**
 * What a payday converts for one child: the pending points and money, but only when both
 * come out above zero. Otherwise nothing, and it all carries over (ADR 0010).
 */
export function conversionFor(
  rows: readonly MoneyLedgerRow[],
  fallbackRate: number,
): PendingConversion | null {
  const pending = pendingConversion(rows, fallbackRate);
  return pending.points > 0 && pending.cents > 0 ? pending : null;
}

/**
 * A child's whole money picture, from their ledger rows alone (spec 004, "Balances").
 * `liveGoalIds` are the jars that aren't deleted or bought.
 */
export function summariseMoney(
  rows: readonly MoneyLedgerRow[],
  liveGoalIds: Iterable<number>,
  fallbackRate: number,
): MoneySummary {
  let savedCents = 0;
  const jarCents = new Map<number, number>();
  for (const r of rows) {
    if (r.kind !== 'goal_allocation') savedCents += r.cents;
    if (r.goalId !== null && (r.kind === 'goal_allocation' || r.kind === 'spend')) {
      jarCents.set(r.goalId, (jarCents.get(r.goalId) ?? 0) + r.cents);
    }
  }
  let inLiveJars = 0;
  for (const id of liveGoalIds) inLiveJars += jarCents.get(id) ?? 0;
  return {
    savedCents,
    jarCents,
    toSortCents: savedCents - inLiveJars,
    unconverted: pendingConversion(rows, fallbackRate),
  };
}

// ---------------------------------------------------------------------------
// Jars

/** A jar priced over this fills towards milestones rather than its price. */
export const BIG_JAR_OVER_CENTS = 10_000;

/** Milestones for big jars (those below the price count, then the price itself). */
export const JAR_MILESTONES_CENTS = [
  1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 40_000, 50_000, 75_000, 100_000,
] as const;

/** Price limits for a jar: £1 to £1,000. */
export const JAR_MIN_CENTS = 100;
export const JAR_MAX_CENTS = 100_000;
export const JAR_NAME_MAX = 28;

/** The board shows this many jars; the rest are on the savings screen. */
export const JARS_ON_BOARD = 4;

export function isBigJar(targetCents: number): boolean {
  return targetCents > BIG_JAR_OVER_CENTS;
}

/** The levels a jar fills towards, in order, ending with its price. */
export function jarMilestones(targetCents: number): number[] {
  if (!isBigJar(targetCents)) return [targetCents];
  return [...JAR_MILESTONES_CENTS.filter((m) => m < targetCents), targetCents];
}

export interface JarProgress {
  big: boolean;
  /** At or over the price: "✓ Full! Smash it". */
  full: boolean;
  /** What the jar fills towards now: the next milestone, or the price. */
  fillToCents: number;
  /** How full the drawn jar is, 0–1 (`in ÷ fillTo`). */
  fill: number;
  /** Milestones below the price that the jar has reached. */
  passed: number[];
  /** Big jars: the next milestone below the price, if any is left. */
  nextMilestoneCents: number | null;
}

export function jarProgress(inCents: number, targetCents: number): JarProgress {
  const big = isBigJar(targetCents);
  const steps = jarMilestones(targetCents);
  const full = inCents >= targetCents;
  const fillToCents = full ? targetCents : steps.find((m) => m > inCents)!;
  const below = steps.slice(0, -1);
  return {
    big,
    full,
    fillToCents,
    fill: Math.min(1, Math.max(0, inCents / fillToCents)),
    passed: below.filter((m) => m <= inCents),
    nextMilestoneCents: below.find((m) => m > inCents) ?? null,
  };
}

/** Milestones below the price that a move from `before` to `after` passed going up. */
export function milestonesCrossed(before: number, after: number, targetCents: number): number[] {
  if (!isBigJar(targetCents)) return [];
  return jarMilestones(targetCents)
    .slice(0, -1)
    .filter((m) => before < m && after >= m);
}

// ---------------------------------------------------------------------------
// Moving coins between "to sort" and a jar

export interface MoveLimits {
  /** Most that can go in: the smaller of "to sort" and the room left. */
  maxIn: number;
  /** Most that can come out: what's in the jar. */
  maxOut: number;
}

export function moveLimits(jar: {
  toSortCents: number;
  inCents: number;
  targetCents: number;
  smashed: boolean;
}): MoveLimits {
  if (jar.smashed) return { maxIn: 0, maxOut: 0 };
  return {
    maxIn: Math.max(0, Math.min(jar.toSortCents, jar.targetCents - jar.inCents)),
    maxOut: Math.max(0, jar.inCents),
  };
}

/** Why a move can't happen, or null when it fits. Positive pours in; negative takes out. */
export function moveProblem(
  cents: number,
  limits: MoveLimits,
): 'zero' | 'too-much-in' | 'too-much-out' | null {
  if (cents === 0) return 'zero';
  if (cents > 0 && cents > limits.maxIn) return 'too-much-in';
  if (cents < 0 && -cents > limits.maxOut) return 'too-much-out';
  return null;
}

/** Holding a jar: the hold must last this long before coins pour (a quick tap stays a tap). */
export const POUR_HOLD_DELAY_MS = 250;

/** Each coin while pouring: 10p, then 25p, 50p and £1 the longer the hold goes on. */
export function pourStepCents(heldMs: number): number {
  if (heldMs < 1500) return 10;
  if (heldMs < 3000) return 25;
  if (heldMs < 4500) return 50;
  return 100;
}

/** Time between coins while pouring, getting faster the longer it's held. */
export function pourIntervalMs(heldMs: number): number {
  return Math.max(60, 180 - Math.floor(heldMs / 1000) * 30);
}

/** The jar pop-up's − / + step: 10p, or 50p once the most you can move is £5 or more. */
export function amountStepCents(maxCents: number): number {
  return maxCents >= 500 ? 50 : 10;
}

/** The pop-up's quick buttons below the maximum (an "All" button is always added). */
export function quickAmounts(maxCents: number): number[] {
  return [100, 500, 1000].filter((a) => a < maxCents);
}

/** The new-jar price's − / +: £1 steps up to £20, then £5, then £10 from £100. */
export function stepPrice(cents: number, direction: 1 | -1): number {
  const step =
    direction > 0
      ? cents >= 10_000
        ? 1000
        : cents >= 2000
          ? 500
          : 100
      : cents > 10_000
        ? 1000
        : cents > 2000
          ? 500
          : 100;
  return Math.min(JAR_MAX_CENTS, Math.max(JAR_MIN_CENTS, cents + direction * step));
}

/** The new-jar screen's quick prices. */
export const NEW_JAR_QUICK_PRICES = [500, 1000, 2500, 5000, 10_000] as const;
export const NEW_JAR_DEFAULT_CENTS = 1000;

// ---------------------------------------------------------------------------
// Jar stats (14-day rolling averages, ADR 0010)

export const STATS_WINDOW_DAYS = 14;

export interface EarningAverages {
  pointsPerDay: number;
  pointsPerQuest: number;
  /** Chore points (XP) per day: bonuses aren't XP (ADR 0003). For "about N days" to a level. */
  xpPerDay: number;
}

/**
 * Average points per day and per quest over the last 14 days, or over the days since the
 * child first earned points if that's fewer. Null with no approved quests in the window
 * ("a child with no history yet sees no stats line rather than a guess").
 */
export function earningAverages(input: {
  /** Earned points in the window: chore points, bonuses, penalties, adjustments, undos. */
  earnedPoints: number;
  /** Chore points in the window (net of undos). */
  chorePoints: number;
  /** Approved quests in the window (net of undos). */
  approvedQuests: number;
  /** The child's first earned-points row ever, or null. */
  firstEarnedAt: number | null;
  now: number;
}): EarningAverages | null {
  if (input.firstEarnedAt === null || input.approvedQuests <= 0) return null;
  const days = Math.min(
    STATS_WINDOW_DAYS,
    Math.max(1, Math.ceil((input.now - input.firstEarnedAt) / DAY_MS)),
  );
  return {
    pointsPerDay: input.earnedPoints / days,
    pointsPerQuest: input.chorePoints / input.approvedQuests,
    xpPerDay: input.chorePoints / days,
  };
}

export type JarStats =
  { kind: 'paydays'; paydays: number } | { kind: 'quests'; quests: number; milestoneCents: number };

/**
 * The jar's one line of stats:
 * - a normal jar: paydays = ⌈money still needed ÷ average weekly money⌉;
 * - a big jar: quests = ⌈points to the next milestone ÷ average points per quest⌉.
 * Null when the jar is full, or there's no history to go on.
 */
export function jarStats(input: {
  inCents: number;
  targetCents: number;
  averages: EarningAverages | null;
  centsPerPoint: number;
}): JarStats | null {
  const { inCents, targetCents, averages, centsPerPoint } = input;
  if (!averages || inCents >= targetCents || centsPerPoint <= 0) return null;
  const progress = jarProgress(inCents, targetCents);
  if (!progress.big) {
    const weekly = averages.pointsPerDay * 7 * centsPerPoint;
    if (weekly <= 0) return null;
    return { kind: 'paydays', paydays: Math.ceil((targetCents - inCents) / weekly) };
  }
  if (averages.pointsPerQuest <= 0) return null;
  const milestone = progress.fillToCents;
  const points = centsToPoints(milestone - inCents, centsPerPoint);
  return {
    kind: 'quests',
    quests: Math.ceil(points / averages.pointsPerQuest),
    milestoneCents: milestone,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "~2 paydays if all your pay goes here" or "Next ⭐ £25: about 11 quests". */
export function jarStatsText(stats: JarStats, currency: string, locale?: string): string {
  if (stats.kind === 'paydays') {
    return `~${plural(stats.paydays, 'payday', 'paydays')} if all your pay goes here`;
  }
  const milestone = formatMoneyShort(stats.milestoneCents, currency, locale);
  return `Next ⭐ ${milestone}: about ${plural(stats.quests, 'quest', 'quests')}`;
}

// ---------------------------------------------------------------------------
// Pictures and names for kid-made jars

/** The new-jar screen's 24 pictures, each with name ideas. */
export const JAR_EMOJI: Record<string, readonly string[]> = {
  '🎮': ['Video game', 'Nintendo Switch'],
  '⚽': ['Football', 'Football boots'],
  '🏀': ['Basketball'],
  '🛹': ['Skateboard'],
  '🚲': ['New bike'],
  '🎨': ['Art set', 'Paint pens'],
  '📚': ['Book', 'Comic'],
  '🧸': ['Teddy'],
  '🦄': ['Unicorn toy'],
  '🐴': ['Pony ride'],
  '🎧': ['Headphones'],
  '📱': ['Tablet'],
  '🏎️': ['Remote control car', 'Lego car'],
  '🧱': ['Lego set'],
  '🎸': ['Guitar'],
  '🎤': ['Karaoke mic'],
  '👟': ['Trainers'],
  '🎟️': ['Trip to the cinema', 'Theme park'],
  '🍦': ['Ice cream trip'],
  '🐠': ['Fish tank'],
  '⛸️': ['Ice skating'],
  '🔭': ['Telescope'],
  '🪁': ['Kite'],
  '🎁': ['Surprise'],
};
export const JAR_EMOJI_LIST = Object.keys(JAR_EMOJI);
