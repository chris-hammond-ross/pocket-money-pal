/**
 * The two Stripe calls the site makes, over Stripe's REST API with `fetch`: no SDK, so `apps/site` keeps no
 * runtime dependencies and wrangler bundles the TypeScript as is.
 *
 * Payment methods (ADR 0026): from API version 2026-09-30.endive, PaymentIntents refuse `payment_method_types`.
 * Card only (Apple Pay and Google Pay are cards to Stripe) is now `allowed_payment_method_types[]=card`. Cards never
 * redirect, so the page stays put. Stripe refuses it together with `automatic_payment_methods` (checked in the
 * sandbox, 2026-11-07), so that's left out.
 * Elements in the browser (checkout.js) must agree: `allowedPaymentMethodTypes: ['card']`.
 */

/** The relay's pinned version and the webhook endpoint's (relay src/stripe.ts). Change all three together. */
export const STRIPE_VERSION = '2026-10-28.endive';

const API = 'https://api.stripe.com/v1';

/** A failed Stripe call. The message is for the logs, never for the buyer. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/**
 * Stripe's form encoding: nested objects as `a[b]=…`, arrays as `a[]=…`. `null` and `undefined` are left out.
 */
export function formEncode(params: Record<string, Param>): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, value: Param): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((v) => add(`${key}[]`, v));
    else if (typeof value === 'object')
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out;
}

async function call<T>(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, Param>,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    'stripe-version': STRIPE_VERSION,
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  let body: string | undefined;
  if (params) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = formEncode(params).toString();
  }
  const res = await fetch(API + path, { method, headers, body });
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { type?: string; code?: string; message?: string };
  };
  if (!res.ok) {
    const e = json.error ?? {};
    throw new StripeError(res.status, e.type, e.code, e.message ?? `Stripe answered ${res.status}`);
  }
  return json;
}

/** The fields of a PaymentIntent the site reads. */
export interface PaymentIntent {
  id: string;
  client_secret: string | null;
  status: string;
  receipt_email: string | null;
}

export interface NewPaymentIntent {
  amountCents: number;
  currency: string;
  email: string;
  /** `production` or `staging`: the relay ignores the other environment's payments. */
  environment: string;
  /** Two-letter country from Cloudflare (`request.cf.country`), if known. */
  country: string | null;
  idempotencyKey: string;
}

/** Creates the lifetime-access PaymentIntent. The relay's webhook keys everything off this metadata. */
export function createPaymentIntent(key: string, p: NewPaymentIntent): Promise<PaymentIntent> {
  return call<PaymentIntent>(
    key,
    'POST',
    '/payment_intents',
    {
      amount: p.amountCents,
      currency: p.currency,
      allowed_payment_method_types: ['card'],
      receipt_email: p.email,
      description: 'Pocket Money Pal lifetime access',
      metadata: {
        product: 'lifetime',
        email: p.email,
        environment: p.environment,
        country: p.country,
      },
    },
    p.idempotencyKey,
  );
}

export function retrievePaymentIntent(key: string, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(key, 'GET', `/payment_intents/${encodeURIComponent(id)}`);
}
