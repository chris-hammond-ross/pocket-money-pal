import { describe, expect, it } from 'vitest';
import { centsToPoints, formatMoney, keypadCents, parseMoneyInput, pointsToCents } from './money';

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

describe('parseMoneyInput', () => {
  it.each([
    ['24.99', 2499],
    ['24', 2400],
    ['24.5', 2450],
    ['24.', 2400],
    ['£24.99', 2499],
    [' 1,250.00 ', 125_000],
    ['0.05', 5],
  ])('%s → %i', (text, cents) => {
    expect(parseMoneyInput(text)).toBe(cents);
  });

  it.each(['', 'abc', '24.999', '-5', '1.2.3', '.50'])('refuses %j', (text) => {
    expect(parseMoneyInput(text)).toBeNull();
  });
});

describe('keypadCents', () => {
  it('pushes digits in from the right, like a till', () => {
    let cents = 0;
    for (const key of ['2', '0', '0', '0']) cents = keypadCents(cents, key);
    expect(cents).toBe(2000);
    expect(keypadCents(cents, 'back')).toBe(200);
    expect(keypadCents(5, '00')).toBe(500);
  });

  it('stops at the most allowed', () => {
    expect(keypadCents(10_000, '0', 100_000)).toBe(100_000);
    expect(keypadCents(100_000, '1', 100_000)).toBe(100_000);
  });
});
