/**
 * What the checkout endpoints accept from a browser. Pure, so it's tested without a Workers runtime.
 *
 * Ported from drawer-designer's worker/validate.ts. The differences: there's no amount (the price is set on the
 * server only, ADR 0026), the email is required (it's where the key goes), and there are checks for the
 * PaymentIntent id and client secret that /api/order is called with.
 */

/** Longest address RFC 5321 permits. */
const MAX_EMAIL = 254;

/**
 * The buyer's email, or `null` if it isn't one. Deliberately loose: Stripe and the key email are the real
 * test. This refuses non-strings, blanks, anything enormous, and header injection wearing an `@`.
 */
export function parseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim();
  if (email === '' || email.length > MAX_EMAIL) return null;
  // One `@`, something either side, no whitespace anywhere (which keeps newlines out of email headers).
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * Whether a request claiming to come from `origin` may start a checkout. Not authentication: it stops someone
 * else's page posting to this one, which would put their fraud on this account's Radar score. Browsers send
 * `Origin` on every POST, so a missing header means it didn't come from a page. Loopback on both sides is
 * allowed so `wrangler dev` works.
 */
export function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (origin === null) return false;
  let sender: URL;
  try {
    sender = new URL(origin);
  } catch {
    return false;
  }
  if (sender.origin === url.origin) return true;
  return isLoopback(sender.hostname) && isLoopback(url.hostname);
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname === '::1';

/**
 * The browser's retry token, or `null`. Stripe replays the first response for a repeated key instead of
 * charging again, which makes retrying over a bad connection safe. Only the shape is checked: a caller who sends
 * rubbish loses idempotency on their own request and nobody else's.
 */
export function parseIdempotencyKey(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const key = input.trim();
  if (key.length < 16 || key.length > 255) return null;
  return key;
}

/** A PaymentIntent id (`pi_…`), or `null`. */
export function parsePaymentIntentId(input: unknown): string | null {
  return typeof input === 'string' && /^pi_[A-Za-z0-9]{1,100}$/.test(input) ? input : null;
}

/** A PaymentIntent client secret (`pi_…_secret_…`) belonging to `paymentIntentId`, or `null`. */
export function parseClientSecret(input: unknown, paymentIntentId: string): string | null {
  if (typeof input !== 'string' || input.length > 255) return null;
  if (!input.startsWith(paymentIntentId + '_secret_')) return null;
  return /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(input) ? input : null;
}

/** Compares two strings in time that depends only on their length. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
