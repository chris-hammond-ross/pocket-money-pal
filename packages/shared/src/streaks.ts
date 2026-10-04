/**
 * Streaks (spec 005, ADR 0003, ADR 0012): a day's result from its chores, the current and
 * best streak, and the flame's colour tier. Pure functions; the server stores the results.
 */

/** What one day did for a child's streak. */
export type StreakResult = 'done' | 'missed' | 'neutral' | 'pending';

export const STREAK_RESULTS = ['done', 'missed', 'neutral', 'pending'] as const;

/**
 * A past day's result from its instances' statuses as they are now:
 * - **neutral:** none, or all skipped (a holiday pause creates none);
 * - **missed:** any still open (never claimed, or sent back): a past chore can't be claimed;
 * - **pending:** none open, but some still claimed and waiting for a parent;
 * - **done:** every non-skipped one approved. Late ones count.
 */
export function streakDayResult(
  statuses: readonly ('open' | 'claimed' | 'approved' | 'skipped')[],
): StreakResult {
  const counted = statuses.filter((s) => s !== 'skipped');
  if (counted.length === 0) return 'neutral';
  if (counted.includes('open')) return 'missed';
  if (counted.includes('claimed')) return 'pending';
  return 'done';
}

export interface StreakDay {
  /** "YYYY-MM-DD" in the family time zone. */
  date: string;
  result: StreakResult;
}

/** Only days before `today` count: today is never decided until it's over. */
function decided(days: readonly StreakDay[], today: string): StreakDay[] {
  return days.filter((d) => d.date < today).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The current streak: done days counting back from the newest, skipping neutral and
 * pending days, stopping at the first missed one.
 */
export function currentStreak(days: readonly StreakDay[], today: string): number {
  let run = 0;
  for (const day of decided(days, today).reverse()) {
    if (day.result === 'missed') break;
    if (day.result === 'done') run++;
  }
  return run;
}

/** The longest run ever, by the same rule. */
export function bestStreak(days: readonly StreakDay[], today: string): number {
  let best = 0;
  let run = 0;
  for (const day of decided(days, today)) {
    if (day.result === 'missed') run = 0;
    if (day.result === 'done') best = Math.max(best, ++run);
  }
  return best;
}

export interface FlameTier {
  /** Streak days from which this colour shows. */
  from: number;
  /** The colour's name in messages ("Your flame burns yellow now"). */
  name: string;
  /** The milestone's name ("1 week"), for the colour-change pill. Null below a week. */
  label: string | null;
}

/** The flame's colours (spec 005, ADR 0012). Index = tier. Tune the steps here. */
export const FLAME_TIERS: readonly FlameTier[] = [
  { from: 0, name: 'grey', label: null },
  { from: 1, name: 'orange', label: null },
  { from: 7, name: 'yellow', label: '1 week' },
  { from: 14, name: 'white', label: '2 weeks' },
  { from: 28, name: 'blue', label: '4 weeks' },
  { from: 42, name: 'green', label: '6 weeks' },
  { from: 56, name: 'purple', label: '8 weeks' },
  { from: 84, name: 'rainbow', label: '12 weeks' },
];

/** The flame's colour tier for a streak of `days`: 0 for none, up to the top tier. */
export function flameTier(days: number): number {
  let tier = 0;
  FLAME_TIERS.forEach((t, i) => {
    if (days >= t.from) tier = i;
  });
  return tier;
}

/** The next colour up, or null at the top. */
export function nextFlameTier(days: number): FlameTier | null {
  return FLAME_TIERS[flameTier(days) + 1] ?? null;
}

export interface StreakChange {
  dates: string[];
  result: 'done' | 'missed';
  before: number;
  after: number;
  bestBefore: number;
  best: number;
}

/**
 * What a batch of newly decided days means for the morning report (ADR 0012), or null
 * when nothing became done or missed (only pending or neutral: no report plays).
 * `changed` are the batch's days with their new results.
 */
export function streakChange(
  before: readonly StreakDay[],
  after: readonly StreakDay[],
  changed: readonly StreakDay[],
  today: string,
): StreakChange | null {
  const reported = changed
    .filter((d) => d.date < today && (d.result === 'done' || d.result === 'missed'))
    .map((d) => d.date)
    .sort();
  if (reported.length === 0) return null;
  return {
    dates: reported,
    result: changed.some((d) => reported.includes(d.date) && d.result === 'missed')
      ? 'missed'
      : 'done',
    before: currentStreak(before, today),
    after: currentStreak(after, today),
    bestBefore: bestStreak(before, today),
    best: bestStreak(after, today),
  };
}

/** The morning report's message (spec 005, "Kiosk: the morning report"). */
export function streakReportMessage(change: {
  result: 'done' | 'missed';
  before: number;
  after: number;
  bestBefore: number;
  best: number;
}): { text: string; crossed: FlameTier | null } {
  if (change.result === 'missed') {
    const best = Math.max(change.best, change.before);
    return {
      text: `Your ${change.before}-day streak ended. Your best is still ${best} ${dayWord(best)}. Do every quest today to light a new one! 💪`,
      crossed: null,
    };
  }
  const crossed = crossedTier(change.before, change.after);
  if (crossed) {
    const next = FLAME_TIERS[FLAME_TIERS.indexOf(crossed) + 1];
    return {
      text: `${capitalise(crossed.label!)} in a row! Your flame burns ${crossed.name} now. ${
        next ? `Next colour at ${next.from} days.` : 'The hottest flame there is! 🏆'
      }`,
      crossed,
    };
  }
  if (change.after > change.bestBefore && change.after > 1) {
    return { text: `${change.after} days: your best ever! 🏆`, crossed: null };
  }
  const next = nextFlameTier(change.after);
  const runText = `${change.after} ${change.after === 1 ? 'day' : 'days in a row'}!`;
  if (!next) return { text: `${runText} Do every quest today to keep it going.`, crossed: null };
  const left = next.from - change.after;
  return {
    text: `${runText} ${left} more and your flame turns ${next.name}.`,
    crossed: null,
  };
}

/**
 * The colour mark a streak passed going from `before` to `after` days (7, 14, 28…), or
 * null. Lighting a new flame (0 → 1) isn't a mark. Passing several marks at once (the PC
 * was off) counts as one change, to the newest colour.
 */
export function crossedTier(before: number, after: number): FlameTier | null {
  const tier = FLAME_TIERS[flameTier(after)]!;
  return flameTier(after) > flameTier(before) && tier.label !== null ? tier : null;
}

/**
 * Whether a change is worth a morning report: the number or the best moved. A missed day
 * on a streak that was already 0 changes nothing, so nothing plays.
 */
export function isReportWorthy(change: {
  before: number;
  after: number;
  bestBefore: number;
  best: number;
}): boolean {
  return change.before !== change.after || change.best !== change.bestBefore;
}

function dayWord(n: number): string {
  return n === 1 ? 'day' : 'days';
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2-WEEK STREAK" for the colour-change pill. */
export function tierPillText(tier: FlameTier): string {
  return `${(tier.label ?? tier.name).replace(/ weeks?$/, '-WEEK').toUpperCase()} STREAK`;
}

/** Busy days (spec 005): a column folds when it has more active quests than this. */
export const BUSY_THRESHOLD = 5;
/** On a busy day, this many of the most pressing open quests show as full cards. */
export const BUSY_SHOWN = 3;

/** How long an unfolded busy column stays open before it folds itself back. */
export const BUSY_UNFOLD_MS = 30_000;

/** True when a column has more active (open + claimed) quests than fit at 1920×1080. */
export function isBusyDay(activeQuests: number): boolean {
  return activeQuests > BUSY_THRESHOLD;
}

/**
 * Which open quests a busy column shows as full cards: the first `BUSY_SHOWN` in Next-up
 * order (the input's order), plus any that are ringing. Returns ids to show and to fold.
 */
export function busyFold<T extends { id: number }>(
  open: readonly T[],
  isRinging: (quest: T) => boolean,
): { shown: T[]; folded: T[] } {
  const shown: T[] = [];
  const folded: T[] = [];
  open.forEach((q, i) => (i < BUSY_SHOWN || isRinging(q) ? shown : folded).push(q));
  return { shown, folded };
}

/** "about 6 days" / "about a day" to the next level, or null with no history. */
export function daysToNextLevel(xpToNext: number, xpPerDay: number | null): number | null {
  if (xpPerDay === null || xpPerDay <= 0) return null;
  return Math.max(1, Math.round(xpToNext / xpPerDay));
}

/** Every 5th level is a milestone (spec 005): "⭐ Level 20: a milestone!". */
export function isMilestoneLevel(level: number): boolean {
  return level > 1 && level % 5 === 0;
}
