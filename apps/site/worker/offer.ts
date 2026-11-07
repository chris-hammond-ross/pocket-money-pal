/**
 * The early-bird offer: the price (set here only) and the spots, which the relay counts from its purchases.
 */

/** What the relay's `RelayRpc` entrypoint answers (relay repo, src/rpc.ts). */
export interface RelayRpc {
  spots(): Promise<{ taken: number; total: number }>;
  order(
    paymentIntentId: string,
  ): Promise<{ state: 'pending' } | { state: 'ready'; familyNumber: number; emailed: boolean }>;
}

/** The service binding, typed. wrangler can't see the relay's types across repos. */
export const relay = (env: Env): RelayRpc => env.RELAY as unknown as RelayRpc;

export interface Offer {
  priceCents: number;
  currency: string;
  spotsTaken: number;
  spotsTotal: number;
  soldOut: boolean;
  publishableKey: string;
}

export function buildOffer(env: Env, spots: { taken: number; total: number }): Offer {
  const total = Math.max(0, Math.trunc(spots.total));
  const taken = Math.min(total, Math.max(0, Math.trunc(spots.taken)));
  return {
    priceCents: Number(env.PRICE_CENTS),
    currency: env.CURRENCY,
    spotsTaken: taken,
    spotsTotal: total,
    soldOut: taken >= total,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  };
}

export async function getOffer(env: Env): Promise<Offer> {
  return buildOffer(env, await relay(env).spots());
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The tag the Worker adds to the landing page's head; assets/site.js reads it before any section renders. */
export function offerMetaTag(offer: Offer): string {
  return `<meta name="pmp-offer" content="${escapeAttr(JSON.stringify(offer))}" />`;
}
