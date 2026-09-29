import { describe, expect, it } from 'vitest';
import { centsToPoints, formatMoney, pointsToCents } from './money';

describe('pointsToCents', () => {
  it('multiplies by the rate', () => {
    expect(pointsToCents(20, 5)).toBe(100);
    expect(pointsToCents(0, 5)).toBe(0);
  });

  it('handles negative points (penalties)', () => {
    expect(pointsToCents(-3, 5)).toBe(-15);
  });

  it('rejects non-integers', () => {
    expect(() => pointsToCents(1.5, 5)).toThrow(TypeError);
    expect(() => pointsToCents(1, 0.5)).toThrow(TypeError);
  });
});

describe('centsToPoints', () => {
  it('rounds up to whole points', () => {
    expect(centsToPoints(100, 5)).toBe(20);
    expect(centsToPoints(101, 5)).toBe(21);
  });

  it('returns 0 for nothing left to earn', () => {
    expect(centsToPoints(0, 5)).toBe(0);
    expect(centsToPoints(-50, 5)).toBe(0);
  });

  it('rejects a zero rate', () => {
    expect(() => centsToPoints(100, 0)).toThrow(RangeError);
  });
});

describe('formatMoney', () => {
  it('formats cents in the given currency', () => {
    expect(formatMoney(4250, 'GBP', 'en-GB')).toBe('£42.50');
    expect(formatMoney(47999, 'USD', 'en-US')).toBe('$479.99');
  });
});
