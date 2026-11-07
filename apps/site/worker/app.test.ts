import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, PAYMENT_ERROR } from './app';
import { STRIPE_VERSION } from './stripe';

const ORIGIN = 'https://staging.pocketmoneypal.com';
const PAGE =
  '<!doctype html><html><head><title>Pocket Money Pal</title></head><body></body></html>';

function makeEnv(over: Record<string, unknown> = {}) {
  const spots = vi.fn(async () => ({ taken: 163, total: 250 }));
  const order = vi.fn(async (): Promise<unknown> => ({
    state: 'ready',
    familyNumber: 164,
    emailed: true,
  }));
  const assets = vi.fn(
    async (_req: Request) =>
      new Response(PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' },
      }),
  );
  const env = {
    ASSETS: { fetch: assets },
    ENVIRONMENT: 'staging',
    PRICE_CENTS: 2500,
    CURRENCY: 'aud',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
    STRIPE_SECRET_KEY: 'rk_test_x',
    RELAY: { spots, order },
    ...over,
  } as unknown as Env;
  return { env, spots, order, assets };
}

const stripeOk = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const checkoutRequest = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  Object.assign(
    new Request(ORIGIN + '/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { cf: { country: 'AU' } },
  );
const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('GET /api/offer', () => {
  it('answers the offer, cacheable for 30 s', async () => {
    const { env } = makeEnv();
    const res = await handle(new Request(ORIGIN + '/api/offer'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(await res.json()).toEqual({
      priceCents: 2500,
      currency: 'aud',
      spotsTaken: 163,
      spotsTotal: 250,
      soldOut: false,
      publishableKey: 'pk_test_x',
    });
  });
  it('answers 503 when the relay is down', async () => {
    const { env, spots } = makeEnv();
    spots.mockRejectedValue(new Error('down'));
    expect((await handle(new Request(ORIGIN + '/api/offer'), env)).status).toBe(503);
  });
});

describe('POST /api/checkout', () => {
  it('creates a PaymentIntent and answers only its client secret', async () => {
    const { env } = makeEnv();
    fetchSpy.mockResolvedValue(
      stripeOk({ id: 'pi_1', client_secret: 'pi_1_secret_a', status: 'requires_payment_method' }),
    );
    const res = await handle(
      checkoutRequest({ email: ' mum@example.com ', idempotencyKey: KEY }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientSecret: 'pi_1_secret_a' });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer rk_test_x');
    expect(headers['stripe-version']).toBe(STRIPE_VERSION);
    expect(headers['idempotency-key']).toBe(KEY);
    const sent = Object.fromEntries(new URLSearchParams(init.body as string));
    expect(sent).toEqual({
      amount: '2500',
      currency: 'aud',
      'allowed_payment_method_types[]': 'card',
      receipt_email: 'mum@example.com',
      description: 'Pocket Money Pal lifetime access',
      'metadata[product]': 'lifetime',
      'metadata[email]': 'mum@example.com',
      'metadata[environment]': 'staging',
      'metadata[country]': 'AU',
    });
    expect(sent).not.toHaveProperty('payment_method_types[]');
    expect(sent).not.toHaveProperty('automatic_payment_methods[enabled]');
  });

  it("refuses another site's page, and a request with no origin", async () => {
    const { env } = makeEnv();
    expect(
      (
        await handle(
          checkoutRequest(
            { email: 'a@b.co', idempotencyKey: KEY },
            { origin: 'https://evil.example' },
          ),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handle(checkoutRequest({ email: 'a@b.co', idempotencyKey: KEY }, {}), env)).status,
    ).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a bad body, a bad email and a missing retry token', async () => {
    const { env } = makeEnv();
    expect((await handle(checkoutRequest('{not json'), env)).status).toBe(400);
    const badEmail = await handle(checkoutRequest({ email: 'nope', idempotencyKey: KEY }), env);
    expect(badEmail.status).toBe(400);
    expect(await badEmail.json()).toMatchObject({ error: 'email' });
    expect((await handle(checkoutRequest({ email: 'a@b.co' }), env)).status).toBe(400);
    expect((await handle(checkoutRequest('x'.repeat(5000)), env)).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 409 when sold out, without calling Stripe', async () => {
    const { env, spots } = makeEnv();
    spots.mockResolvedValue({ taken: 250, total: 250 });
    const res = await handle(checkoutRequest({ email: 'a@b.co', idempotencyKey: KEY }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'sold-out' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turns Stripe's errors into one fixed message", async () => {
    const { env } = makeEnv();
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'Invalid email: a@b.co' },
        }),
        { status: 400 },
      ),
    );
    const res = await handle(checkoutRequest({ email: 'a@b.co', idempotencyKey: KEY }), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'stripe', message: PAYMENT_ERROR });
    expect(
      JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain('a@b.co');
  });

  it('answers 503 when the relay is down (it can tell if sold out)', async () => {
    const { env, spots } = makeEnv();
    spots.mockRejectedValue(new Error('down'));
    expect(
      (await handle(checkoutRequest({ email: 'a@b.co', idempotencyKey: KEY }), env)).status,
    ).toBe(503);
  });

  it('only takes POST', async () => {
    const { env } = makeEnv();
    expect((await handle(new Request(ORIGIN + '/api/checkout'), env)).status).toBe(405);
  });
});

describe('GET /api/order', () => {
  const url = (pi: string, secret: string) => `${ORIGIN}/api/order?pi=${pi}&secret=${secret}`;
  const intent = (over: Record<string, unknown> = {}) =>
    stripeOk({
      id: 'pi_1',
      client_secret: 'pi_1_secret_a',
      status: 'succeeded',
      receipt_email: 'mum@example.com',
      ...over,
    });

  it('answers the relay order and where the key was emailed', async () => {
    const { env, order } = makeEnv();
    fetchSpy.mockResolvedValue(intent());
    const res = await handle(new Request(url('pi_1', 'pi_1_secret_a')), env);
    expect(await res.json()).toEqual({
      state: 'ready',
      familyNumber: 164,
      emailed: true,
      paid: true,
      emailedTo: 'mum@example.com',
    });
    expect(order).toHaveBeenCalledWith('pi_1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(
      'https://api.stripe.com/v1/payment_intents/pi_1',
    );
  });

  it('is pending until the payment succeeds, then until the relay has the licence', async () => {
    const { env, order } = makeEnv();
    fetchSpy.mockResolvedValueOnce(intent({ status: 'processing' }));
    expect(await (await handle(new Request(url('pi_1', 'pi_1_secret_a')), env)).json()).toEqual({
      state: 'pending',
      paid: false,
    });
    expect(order).not.toHaveBeenCalled();

    fetchSpy.mockResolvedValueOnce(intent());
    order.mockResolvedValueOnce({ state: 'pending' });
    expect(
      await (await handle(new Request(url('pi_1', 'pi_1_secret_a')), env)).json(),
    ).toMatchObject({ state: 'pending', paid: true });
  });

  it("won't show an order to someone without its secret", async () => {
    const { env } = makeEnv();
    fetchSpy.mockResolvedValue(intent());
    expect((await handle(new Request(url('pi_1', 'pi_1_secret_b')), env)).status).toBe(404);
    expect((await handle(new Request(url('pi_1', 'pi_2_secret_a')), env)).status).toBe(400);
    expect((await handle(new Request(`${ORIGIN}/api/order?pi=pi_1`), env)).status).toBe(400);
  });

  it('answers 404 for an unknown payment', async () => {
    const { env } = makeEnv();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 404 }),
    );
    expect((await handle(new Request(url('pi_9', 'pi_9_secret_a')), env)).status).toBe(404);
  });
});

describe('the landing page', () => {
  // Node has no HTMLRewriter: a stand-in that runs the 'head' handler's prepend.
  beforeEach(() => {
    class FakeRewriter {
      private html = '';
      on(_sel: string, h: { element: (el: { prepend: (s: string) => void }) => void }) {
        h.element({ prepend: (s) => (this.html = s) });
        return this;
      }
      transform(res: Response) {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        void res.text().then(async (t) => {
          const w = writable.getWriter();
          await w.write(new TextEncoder().encode(t.replace('<head>', '<head>' + this.html)));
          await w.close();
        });
        return new Response(readable, res);
      }
    }
    vi.stubGlobal('HTMLRewriter', FakeRewriter);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('gets the live offer in its head, no ETag, and noindex on staging', async () => {
    const { env } = makeEnv();
    const res = await handle(
      new Request(ORIGIN + '/', { headers: { 'if-none-match': '"abc"' } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('<head><meta name="pmp-offer" content="{&quot;priceCents&quot;:2500');
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('goes out without the offer when the relay is down', async () => {
    const { env, spots } = makeEnv();
    spots.mockRejectedValue(new Error('down'));
    const res = await handle(new Request(ORIGIN + '/'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('pmp-offer');
  });

  it('serves other paths from the assets, with noindex only off production', async () => {
    const { env, assets } = makeEnv();
    await handle(new Request(ORIGIN + '/legal'), env);
    expect((assets.mock.calls[0] as [Request])[0].url).toBe(ORIGIN + '/legal');
    const prod = makeEnv({ ENVIRONMENT: 'production' });
    const res = await handle(new Request('https://pocketmoneypal.com/legal'), prod.env);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});
