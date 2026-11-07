/**
 * The checkout funnel: one Workers Analytics Engine data point per step, so conversion over time and each visit's
 * path can be worked out.
 *
 *   visit     the landing page opened (assets/checkout.js, on load)
 *   offer     the Lifetime access card came into view (checkout.js)
 *   checkout  a PaymentIntent was made (this Worker, in POST /api/checkout)
 *   paid      the payment succeeded (checkout.js reports it; this Worker checks it with Stripe first)
 *
 * The only thing that joins a visit's steps is the funnel id: a random UUID that checkout.js makes when the page
 * opens and keeps in memory only (no cookie, no storage), so it's gone when the tab closes. It's also copied onto
 * the PaymentIntent's metadata (`funnel`), which is how `paid` is checked. A data point holds the id and the step,
 * nothing else: no IP, country, user agent, email or path (privacy policy, "This website").
 *
 * Layout: index1 = funnel id, blob1 = step, double1 = 1.
 */

export const FUNNEL_STEPS = ['visit', 'offer', 'checkout', 'paid'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** The steps a browser may report. `checkout` is only ever written by the Worker itself. */
const BROWSER_STEPS: readonly string[] = ['visit', 'offer', 'paid'];

export function parseBrowserStep(input: unknown): Exclude<FunnelStep, 'checkout'> | null {
  return typeof input === 'string' && BROWSER_STEPS.includes(input)
    ? (input as Exclude<FunnelStep, 'checkout'>)
    : null;
}

/** A funnel id: `crypto.randomUUID()`'s shape, lower case. Anything else is dropped, not refused. */
export function parseFunnelId(input: unknown): string | null {
  return typeof input === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)
    ? input
    : null;
}

/** Writes one step. Fire-and-forget: a missing binding or a failed write never fails the request. */
export function recordStep(env: Env, step: FunnelStep, funnelId: string): void {
  try {
    env.EVENTS?.writeDataPoint({ indexes: [funnelId], blobs: [step], doubles: [1] });
  } catch (e) {
    console.error('funnel: write failed', step, e instanceof Error ? e.name : 'unknown');
  }
}
