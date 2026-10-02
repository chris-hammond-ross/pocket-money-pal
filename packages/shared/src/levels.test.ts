import { describe, expect, it } from 'vitest';
import { levelProgress, xpForLevel } from './levels';

describe('xpForLevel', () => {
  it('rises by 10 more XP each level', () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 50, 110, 180, 260]);
  });

  it('rejects impossible levels', () => {
    expect(() => xpForLevel(0)).toThrow(RangeError);
    expect(() => xpForLevel(1.5)).toThrow(RangeError);
  });
});

describe('levelProgress', () => {
  it('starts at level 1', () => {
    expect(levelProgress(0)).toEqual({
      level: 1,
      xpIntoLevel: 0,
      xpForThisLevel: 50,
      xpToNext: 50,
    });
  });

  it('levels up exactly on the threshold', () => {
    expect(levelProgress(49).level).toBe(1);
    expect(levelProgress(50)).toEqual({
      level: 2,
      xpIntoLevel: 0,
      xpForThisLevel: 60,
      xpToNext: 60,
    });
    expect(levelProgress(179).level).toBe(3);
    expect(levelProgress(180).level).toBe(4);
  });

  it('agrees with xpForLevel across a long range', () => {
    for (let xp = 0; xp <= 50_000; xp += 7) {
      const { level, xpIntoLevel, xpToNext } = levelProgress(xp);
      expect(xpForLevel(level)).toBeLessThanOrEqual(xp);
      expect(xpForLevel(level + 1)).toBeGreaterThan(xp);
      expect(xpForLevel(level) + xpIntoLevel).toBe(xp);
      expect(xp + xpToNext).toBe(xpForLevel(level + 1));
    }
  });

  it('treats negative XP as none, and rejects fractions', () => {
    expect(levelProgress(-10).level).toBe(1);
    expect(() => levelProgress(1.5)).toThrow(TypeError);
  });
});
