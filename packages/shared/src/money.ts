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

/** Like `formatMoney`, but whole amounts drop the pence: "£25", "£24.99". */
export function formatMoneyShort(cents: number, currency: string, locale?: string): string {
  assertInteger(cents, 'cents');
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...(cents % 100 === 0 && { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
  }).format(cents / 100);
}

/**
 * A typed amount ("24.99", "£24", "24.5", "1,250.00") as whole cents, or null when it isn't
 * one. More than two decimal places is refused rather than rounded.
 */
export function parseMoneyInput(text: string): number | null {
  const cleaned = text.replace(/[\s£$€,]/g, '');
  const match = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const pence = (match[2] ?? '').padEnd(2, '0');
  return Number(match[1]) * 100 + Number(pence);
}

/** The keypad's next amount (cash-register style: digits push in from the right). */
export function keypadCents(cents: number, key: string, maxCents = 100_000): number {
  const next =
    key === 'back'
      ? Math.floor(cents / 10)
      : key === '00'
        ? cents * 100
        : /^\d$/.test(key)
          ? cents * 10 + Number(key)
          : cents;
  return next > maxCents ? cents : next;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer, got ${value}`);
}
