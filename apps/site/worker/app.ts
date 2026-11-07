/**
 * The landing site's Worker. Static assets serve everything except:
 *
 *   GET  /              the landing page, with the live offer (price, spots, sold out) added to its head
 *   GET  /api/offer     the same offer as JSON
 *   POST /api/checkout  { email, idempotencyKey } → { clientSecret } for a new lifetime-access PaymentIntent
 *   GET  /api/order     ?pi=&secret= → the order's state once paid: family number, where the key was emailed
 *   POST /api/event     { step, funnelId, pi?, secret? } → 204: one checkout-funnel step (funnel.ts)
 *
 * Licences are the relay's business: this Worker only creates PaymentIntents and asks the relay,
 * over the RELAY service binding, for spot counts and order states. Stripe's webhook goes to the relay.
 * On staging every request comes through here (run_worker_first: true) so it can add X-Robots-Tag: noindex.
 */
import { parseBrowserStep, parseFunnelId, recordStep } from './funnel';
import { getOffer, offerMetaTag, relay } from './offer';
import { createPaymentIntent, retrievePaymentIntent, StripeError } from './stripe';
import {
  isAllowedOrigin,
  parseClientSecret,
  parseEmail,
  parseIdempotencyKey,
  parsePaymentIntentId,
  sameSecret,
} from './validate';

/** Shown for any Stripe failure; the real error goes to the logs. */
export const PAYMENT_ERROR =
  "We couldn't start the payment. Nothing was charged. Please try again in a moment.";

const json = (body: unknown, status = 200, cache = 'no-store'): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let res: Response;
  if (url.pathname.startsWith('/api/')) res = await api(request, env, url);
  else if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD'))
    res = await home(env, url);
  else res = await env.ASSETS.fetch(request);
  if (env.ENVIRONMENT !== 'production') {
    res = new Response(res.body, res);
    res.headers.set('x-robots-tag', 'noindex');
  }
  return res;
}

/**
 * The landing page with `<meta name="pmp-offer">` in its head. Fetched from the assets without the browser's
 * conditional headers, and sent without an ETag, so a cached copy never shows yesterday's spots. If the relay
 * doesn't answer, the page goes out without the tag and the checkout asks /api/offer itself.
 */
async function home(env: Env, url: URL): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(url.origin + '/'));
  if (!page.ok || !(page.headers.get('content-type') ?? '').includes('text/html')) return page;
  const offer = await getOffer(env).catch((e: unknown) => {
    console.error('offer: relay spots failed', e);
    return null;
  });
  const res = new Response(page.body, page);
  res.headers.delete('etag');
  res.headers.set('cache-control', 'no-cache');
  if (!offer) return res;
  return new HTMLRewriter()
    .on('head', { element: (head) => void head.prepend(offerMetaTag(offer), { html: true }) })
    .transform(res);
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  switch (url.pathname) {
    case '/api/offer':
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      return offer(env);
    case '/api/checkout':
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      return checkout(request, env, url);
    case '/api/order':
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      return order(env, url);
    case '/api/event':
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      return funnelEvent(request, env, url);
    default:
      return json({ error: 'not-found' }, 404);
  }
}

async function offer(env: Env): Promise<Response> {
  try {
    return json(await getOffer(env), 200, 'public, max-age=30');
  } catch (e) {
    console.error('offer: relay spots failed', e);
    return json({ error: 'unavailable' }, 503);
  }
}

async function checkout(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAllowedOrigin(request.headers.get('origin'), url)) return json({ error: 'origin' }, 403);

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return json({ error: 'too-large' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad-request' }, 400);
  }
  const input = (body ?? {}) as { email?: unknown; idempotencyKey?: unknown; funnelId?: unknown };
  const email = parseEmail(input.email);
  if (!email)
    return json({ error: 'email', message: "That email address doesn't look right." }, 400);
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) return json({ error: 'bad-request' }, 400);

  let soldOut: boolean;
  try {
    soldOut = (await getOffer(env)).soldOut;
  } catch (e) {
    console.error('checkout: relay spots failed', e);
    return json({ error: 'unavailable', message: PAYMENT_ERROR }, 503);
  }
  if (soldOut) return json({ error: 'sold-out' }, 409);

  const cf = (request as { cf?: { country?: unknown } }).cf;
  const funnelId = parseFunnelId(input.funnelId);
  const country =
    typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : null;
  try {
    const pi = await createPaymentIntent(env.STRIPE_SECRET_KEY, {
      amountCents: Number(env.PRICE_CENTS),
      currency: env.CURRENCY,
      email,
      environment: env.ENVIRONMENT,
      country,
      idempotencyKey,
      funnelId,
    });
    if (!pi.client_secret)
      throw new Error(`PaymentIntent ${pi.id} came back without a client secret`);
    console.log('checkout: created', pi.id);
    if (funnelId) recordStep(env, 'checkout', funnelId);
    return json({ clientSecret: pi.client_secret });
  } catch (e) {
    logStripe('checkout: create failed', e);
    return json({ error: 'stripe', message: PAYMENT_ERROR }, 502);
  }
}

/**
 * An order's state, for the success card. The client secret proves the caller made the payment, so nobody can
 * look up someone else's order (and their email) by guessing ids.
 */
async function order(env: Env, url: URL): Promise<Response> {
  const pi = parsePaymentIntentId(url.searchParams.get('pi'));
  const secret = pi && parseClientSecret(url.searchParams.get('secret'), pi);
  if (!pi || !secret) return json({ error: 'bad-request' }, 400);

  let intent;
  try {
    intent = await retrievePaymentIntent(env.STRIPE_SECRET_KEY, pi);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return json({ error: 'not-found' }, 404);
    logStripe('order: retrieve failed', e);
    return json({ error: 'stripe' }, 502);
  }
  if (!intent.client_secret || !sameSecret(intent.client_secret, secret))
    return json({ error: 'not-found' }, 404);
  if (intent.status !== 'succeeded') return json({ state: 'pending', paid: false });

  try {
    const state = await relay(env).order(pi);
    return json({ ...state, paid: true, emailedTo: intent.receipt_email });
  } catch (e) {
    console.error('order: relay order failed', e);
    return json({ state: 'pending', paid: true, emailedTo: intent.receipt_email });
  }
}

/**
 * One funnel step from the page (funnel.ts). Same-origin only, like the checkout. `paid` is written only once Stripe
 * says that PaymentIntent succeeded, the client secret matches, and the payment carries this funnel id, so a page
 * can't make up purchases. A `paid` that doesn't check out (or Stripe not answering) is still 204, with nothing
 * written: the page never waits on this or shows its result.
 */
async function funnelEvent(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAllowedOrigin(request.headers.get('origin'), url)) return json({ error: 'origin' }, 403);
  let input: { step?: unknown; funnelId?: unknown; pi?: unknown; secret?: unknown };
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ error: 'too-large' }, 413);
    input = (JSON.parse(text) ?? {}) as typeof input;
  } catch {
    return json({ error: 'bad-request' }, 400);
  }
  const step = parseBrowserStep(input.step);
  const funnelId = parseFunnelId(input.funnelId);
  if (!step || !funnelId) return json({ error: 'bad-request' }, 400);
  if (step !== 'paid') {
    recordStep(env, step, funnelId);
    return new Response(null, { status: 204 });
  }

  const pi = parsePaymentIntentId(input.pi);
  const secret = pi && parseClientSecret(input.secret, pi);
  if (!pi || !secret) return json({ error: 'bad-request' }, 400);
  let intent;
  try {
    intent = await retrievePaymentIntent(env.STRIPE_SECRET_KEY, pi);
  } catch (e) {
    logStripe('event: retrieve failed', e);
    return new Response(null, { status: 204 });
  }
  if (
    intent.client_secret &&
    sameSecret(intent.client_secret, secret) &&
    intent.status === 'succeeded' &&
    intent.metadata?.funnel === funnelId
  )
    recordStep(env, 'paid', funnelId);
  return new Response(null, { status: 204 });
}

/** Stripe failures in the logs: status, type, code and message, with anything like an email masked. */
function logStripe(what: string, e: unknown): void {
  const mask = (s: string): string => s.replace(/[^\s@'"]+@[^\s@'"]+/g, '[email]');
  if (e instanceof StripeError) console.error(what, e.status, e.type, e.code, mask(e.message));
  else console.error(what, e instanceof Error ? mask(e.message) : 'unknown error');
}
