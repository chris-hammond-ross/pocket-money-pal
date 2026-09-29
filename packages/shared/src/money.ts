/**
 * Money is always stored and computed as integer cents (minor units).
 * Points are integers. Conversion is a whole number of cents per point.
 */

export function pointsToCents(points: number, centsPerPoint: number): number {
  assertInteger(points, 'points');
  assertInteger(centsPerPoint, 'centsPerPoint');
  if (centsPerPoint < 0) throw new RangeError('centsPerPoint must be >= 0');
  return points * centsPerPoint;
}

/** Whole points needed to earn at least `cents`. */
export function centsToPoints(cents: number, centsPerPoint: number): number {
  assertInteger(cents, 'cents');
  assertInteger(centsPerPoint, 'centsPerPoint');
  if (centsPerPoint <= 0) throw new RangeError('centsPerPoint must be > 0');
  if (cents <= 0) return 0;
  return Math.ceil(cents / centsPerPoint);
}

export function formatMoney(cents: number, currency: string, locale?: string): string {
  assertInteger(cents, 'cents');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer, got ${value}`);
}
