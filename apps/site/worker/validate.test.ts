import { describe, expect, it } from 'vitest';
import { formEncode } from './stripe';
import { buildOffer, offerMetaTag } from './offer';
import {
  isAllowedOrigin,
  parseClientSecret,
  parseEmail,
  parseIdempotencyKey,
  parsePaymentIntentId,
  sameSecret,
} from './validate';

describe('parseEmail', () => {
  it('accepts an address and trims it', () => {
    expect(parseEmail('  mum@example.com ')).toBe('mum@example.com');
  });
  it.each([
    undefined,
    null,
    '',
    '   ',
    42,
    'no-at-sign',
    'two@@example.com',
    'a b@example.com',
    'mum@example.com\nBcc: x@y',
  ])('refuses %j', (input) => expect(parseEmail(input)).toBeNull());
  it('refuses anything longer than 254 characters', () => {
    expect(parseEmail('a'.repeat(250) + '@b.co')).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  const site = new URL('https://staging.pocketmoneypal.com/api/checkout');
  it('allows the same origin', () =>
    expect(isAllowedOrigin('https://staging.pocketmoneypal.com', site)).toBe(true));
  it('refuses another site, a missing header and junk', () => {
    expect(isAllowedOrigin('https://evil.example', site)).toBe(false);
    expect(isAllowedOrigin(null, site)).toBe(false);
    expect(isAllowedOrigin('not a url', site)).toBe(false);
  });
  it('allows loopback to loopback (wrangler dev), but not loopback to the real site', () => {
    expect(
      isAllowedOrigin('http://localhost:5173', new URL('http://127.0.0.1:8787/api/checkout')),
    ).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', site)).toBe(false);
  });
});

describe('parseIdempotencyKey', () => {
  it('accepts a UUID', () => {
    expect(parseIdempotencyKey('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(
      '3b241101-e2bb-4255-8caf-4136c566a962',
    );
  });
  it.each([undefined, 12, 'short', 'x'.repeat(256)])('refuses %j', (input) =>
    expect(parseIdempotencyKey(input)).toBeNull(),
  );
});

describe('PaymentIntent id and client secret', () => {
  it('accepts a real-looking pair', () => {
    expect(parsePaymentIntentId('pi_3Abc123')).toBe('pi_3Abc123');
    expect(parseClientSecret('pi_3Abc123_secret_XyZ789', 'pi_3Abc123')).toBe(
      'pi_3Abc123_secret_XyZ789',
    );
  });
  it('refuses junk and a secret for another payment', () => {
    expect(parsePaymentIntentId('pi_')).toBeNull();
    expect(parsePaymentIntentId('ch_123')).toBeNull();
    expect(parsePaymentIntentId('pi_1/../x')).toBeNull();
    expect(parseClientSecret('pi_other_secret_XyZ', 'pi_3Abc123')).toBeNull();
    expect(parseClientSecret('pi_3Abc123_secret_<script>', 'pi_3Abc123')).toBeNull();
    expect(parseClientSecret(undefined, 'pi_3Abc123')).toBeNull();
  });
  it('sameSecret compares exactly', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });
});

describe('formEncode', () => {
  it("uses Stripe's nesting for objects and arrays, and leaves out null", () => {
    const body = formEncode({
      amount: 2500,
      allowed_payment_method_types: ['card'],
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { product: 'lifetime', country: null },
    });
    expect([...body]).toEqual([
      ['amount', '2500'],
      ['allowed_payment_method_types[]', 'card'],
      ['automatic_payment_methods[enabled]', 'true'],
      ['automatic_payment_methods[allow_redirects]', 'never'],
      ['metadata[product]', 'lifetime'],
    ]);
  });
});

describe('the offer', () => {
  const env = {
    PRICE_CENTS: 2500,
    CURRENCY: 'aud',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  } as unknown as Env;
  it('counts spots, and is sold out at the total', () => {
    expect(buildOffer(env, { taken: 163, total: 250 })).toEqual({
      priceCents: 2500,
      currency: 'aud',
      spotsTaken: 163,
      spotsTotal: 250,
      soldOut: false,
      publishableKey: 'pk_test_x',
    });
    expect(buildOffer(env, { taken: 250, total: 250 }).soldOut).toBe(true);
  });
  it('never shows more taken than there are', () => {
    expect(buildOffer(env, { taken: 260, total: 250 })).toMatchObject({
      spotsTaken: 250,
      soldOut: true,
    });
  });
  it('escapes the meta tag so it reads back as the same JSON', () => {
    const offer = buildOffer(env, { taken: 1, total: 250 });
    const tag = offerMetaTag({ ...offer, publishableKey: '"><script>' });
    expect(tag).not.toContain('<script>');
    expect(tag).toContain('&quot;&gt;&lt;script&gt;');
  });
});
