import { describe, expect, it } from 'vitest';
import { formatPointsChange, rateCaption } from './players';

describe('rateCaption', () => {
  it('uses the points that make exactly one pound when it can', () => {
    expect(rateCaption(5, 'GBP', 'en-GB')).toBe('20 points = £1.00');
    expect(rateCaption(1, 'GBP', 'en-GB')).toBe('100 points = £1.00');
    expect(rateCaption(20, 'GBP', 'en-GB')).toBe('5 points = £1.00');
  });

  it('otherwise uses the fewest points that make whole pounds', () => {
    expect(rateCaption(8, 'GBP', 'en-GB')).toBe('25 points = £2.00');
    expect(rateCaption(6, 'GBP', 'en-GB')).toBe('50 points = £3.00');
    expect(rateCaption(3, 'GBP', 'en-GB')).toBe('100 points = £3.00');
    expect(rateCaption(7, 'GBP', 'en-GB')).toBe('100 points = £7.00');
  });

  it('says "point" for one', () => {
    expect(rateCaption(100, 'GBP', 'en-GB')).toBe('1 point = £1.00');
  });
});

describe('formatPointsChange', () => {
  it('signs bonuses and penalties', () => {
    expect(formatPointsChange(10)).toBe('+10');
    expect(formatPointsChange(-5)).toBe('−5');
    expect(formatPointsChange(0)).toBe('+0');
  });
});
