/**
 * Levels (ADR 0003). XP is lifetime approved chore points and never resets.
 * Each level needs 10 XP more than the one before: level 2 at 50 XP, 3 at 110, 4 at 180…
 */

const FIRST_STEP_XP = 50;
const STEP_GROWTH_XP = 10;

/** Total XP needed to reach `level` (level 1 starts at 0). */
export function xpForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1) throw new RangeError(`Invalid level: ${level}`);
  const steps = level - 1;
  return steps * FIRST_STEP_XP + (STEP_GROWTH_XP * steps * (steps - 1)) / 2;
}

export interface LevelProgress {
  level: number;
  /** XP earned since reaching this level. */
  xpIntoLevel: number;
  /** XP this level takes from start to finish (the XP bar's full width). */
  xpForThisLevel: number;
  /** XP still needed for the next level. */
  xpToNext: number;
}

export function levelProgress(xp: number): LevelProgress {
  if (!Number.isInteger(xp)) throw new TypeError(`xp must be an integer, got ${xp}`);
  const total = Math.max(0, xp);

  // Solve xpForLevel(n) ≤ total for the largest n, then correct for float rounding.
  const a = STEP_GROWTH_XP / 2;
  const b = FIRST_STEP_XP - STEP_GROWTH_XP / 2;
  let steps = Math.floor((-b + Math.sqrt(b * b + 4 * a * total)) / (2 * a));
  while (xpForLevel(steps + 2) <= total) steps++;
  while (steps > 0 && xpForLevel(steps + 1) > total) steps--;

  const level = steps + 1;
  const start = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    xpIntoLevel: total - start,
    xpForThisLevel: next - start,
    xpToNext: next - total,
  };
}
