# Landing site (pocketmoneypal.com)

The promotional site and its checkout: static pages in `public/`, plus a small Cloudflare Worker in `worker/` that sells lifetime access through Stripe. Decisions: [ADR 0026](../../docs/decisions/0026-payments.md). Plan: [stripe-integration.md](../../docs/roadmap/stripe-integration.md) §8.

## What's where

| Path                                               | What it is                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/index.html`, `legal.html`, `download.html` | The pages, **ported verbatim** from `prototypes/landing-site/complete/` (the production rule in `prototypes/landing-site/README.md`). Change the look there first, then port it again. |
| `public/assets/`                                   | The pages' scripts (moved out of the HTML for the CSP), `brand.css`, images, sounds, self-hosted canvas-confetti, and `site.js` (the site's facts)                                     |
| `public/assets/checkout.js`                        | The real checkout (new code, not from the prototype): Stripe's Express Checkout Element and Payment Element in `#ofCo`                                                                 |
| `public/_headers`                                  | Security headers and the CSP. Update it if you add a script host, a font host or analytics.                                                                                            |
| `public/404.html`, `styles.css`                    | The not-found page (served with a 404 status for any missing path)                                                                                                                     |
| `worker/index.ts`                                  | The Worker's entry. Only handlers may be exported from it, so the routes are in `worker/app.ts`.                                                                                       |
| `worker/app.ts`                                    | `GET /` (adds the live offer to the page's head), `GET /api/offer`, `POST /api/checkout`, `GET /api/order`                                                                             |
| `worker/stripe.ts`, `validate.ts`, `offer.ts`      | Stripe over `fetch` (no SDK), input checks, and the offer and relay binding                                                                                                            |

The ported files in `public/` are excluded from ESLint and Prettier so they stay byte-for-byte; `checkout.js` and `worker/` aren't.

## How the checkout works

1. The Worker asks the relay (`RELAY` service binding → `RelayRpc`, private repo) for the spots, and puts the offer in the page as `<meta name="pmp-offer">`.
2. When the pricing section nears the screen, `checkout.js` loads Stripe.js and mounts the Elements (deferred mode, `allowedPaymentMethodTypes: ['card']`).
3. On Pay, `POST /api/checkout` creates the PaymentIntent (A$25, `allowed_payment_method_types[]=card`, metadata `product`, `email`, `environment`, `country`), and the browser confirms it.
4. Stripe's webhook goes to the relay, which makes the licence and emails the key. The success card polls `/api/order` for the family number.

## Environments

|               | Production                                                              | Staging                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker        | `pocketmoneypal`                                                        | `pocketmoneypal-staging`                                                                                                                     |
| Address       | `pocketmoneypal.com`                                                    | `staging.pocketmoneypal.com` (noindex)                                                                                                       |
| Stripe        | live (set up in session 9.6)                                            | sandbox, test mode                                                                                                                           |
| Relay binding | `pmp-relay`                                                             | `pmp-relay-staging`                                                                                                                          |
| Deployed by   | **hand, until launch** (9.6); Workers Builds' production builds are off | Workers Builds on every push to `main` touching `apps/site/` (`npx wrangler deploy --env staging`), or `npm run deploy:staging -w @pmp/site` |

Vars are in `wrangler.jsonc` (`ENVIRONMENT`, `PRICE_CENTS`, `CURRENCY`, `STRIPE_PUBLISHABLE_KEY`). The one secret is **`STRIPE_SECRET_KEY`**, per environment: a restricted key with PaymentIntents write (plan §5.8). Set it with `npx wrangler secret put STRIPE_SECRET_KEY [--env staging]`. Exception: a brand-new Worker can't be created without it, so the first deploy uses `--secrets-file`.

## Local development

```powershell
cd apps/site
# .dev.vars (gitignored): STRIPE_SECRET_KEY=rk_test_… (the staging checkout key)
npm run dev        # wrangler dev --env staging: http://localhost:8787
```

`wrangler dev` uses the deployed staging relay (a remote binding), so payments there create real staging licences and send real key emails. For test buyers, use `delivered@resend.dev`: Resend accepts it without delivering or hurting the domain's reputation. Apple Pay and Google Pay need HTTPS and a real device, so try them on staging.

Test cards: `4242 4242 4242 4242` (pays), `4000 0000 0000 0002` (declined), `4000 0027 6000 3184` (3-D Secure), any future date, any CVC.

## Tests

`npm test` at the repo root runs `worker/*.test.ts` in Node (project `site`), with Stripe as a `fetch` spy and stub bindings. `npm run typecheck -w @pmp/site` checks the Worker against `worker-configuration.d.ts`. Regenerate that file with `npm run types -w @pmp/site` after changing `wrangler.jsonc`.
