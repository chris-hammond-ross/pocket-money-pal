/**
 * The phone's Players tab (spec 003): bonus buttons, the loot-rate slider and its caption.
 * Pure functions.
 */
import { formatMoney } from './money';

/** The bonus-points buttons on each child's row. Negative is a penalty. */
export const BONUS_STEPS = [5, 10, -5] as const;

/** The loot-rate slider's range, in cents per point (1p to 20p). */
export const RATE_SLIDER_MIN = 1;
export const RATE_SLIDER_MAX = 20;

/**
 * The line under the loot-rate slider: the fewest points that make a whole amount of money
 * ("20 points = £1.00" at 5p, "25 points = £2.00" at 8p, "100 points = £3.00" at 3p).
 */
export function rateCaption(centsPerPoint: number, currency: string, locale?: string): string {
  const points = 100 / gcd(100, centsPerPoint);
  const unit = points === 1 ? 'point' : 'points';
  return `${points} ${unit} = ${formatMoney(points * centsPerPoint, currency, locale)}`;
}

/** "+10" or "−5" (a real minus sign), for the bonus buttons and the kiosk's float. */
export function formatPointsChange(points: number): string {
  return points < 0 ? `−${-points}` : `+${points}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
