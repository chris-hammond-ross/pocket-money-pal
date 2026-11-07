// The real checkout in the Lifetime access card (#ofCo): Stripe's Express Checkout Element (Apple Pay /
// Google Pay) and Payment Element (card) in deferred mode, in place of the prototype's stand-in fields.
// New code, not part of the ported prototype (session 9.5b, ADR 0026).
//
// - Stripe.js loads only when the offer section nears the screen, never on page load.
// - The PaymentIntent is made on Pay (POST /api/checkout), not on load, so there are no abandoned intents.
// - The retry token belongs to the email: retrying the same purchase replays the same PaymentIntent (no second
//   charge); a different email gets a new one.
// - `allowedPaymentMethodTypes: ['card']` must match the Worker's `allowed_payment_method_types[]=card`
//   (worker/stripe.ts). Since API 2026-09-30.endive, `paymentMethodTypes` throws.
// - After paying, /api/order is polled for the family number (the relay's webhook makes the licence); after
//   ~15 s the success card shows without it.
// The look of the card, the sold-out note and the success card belong to the page (OFFER_UI in assets/index.js).
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('ofCo');
  if (!form || !window.OFFER_UI) return;

  const STRIPE_JS = 'https://js.stripe.com/endive/stripe.js';
  const OFFLINE = "We couldn't reach the payment server. Nothing was charged.";
  const BROKEN =
    'Something went wrong setting up the payment. Nothing was charged. Please try again.';
  const POLL_MS = 1500;
  const POLL_FOR_MS = 15000;

  const emailInput = $('ofEmail');
  const pay = $('ofPay');
  const payLabel = pay.innerHTML;
  const looksLikeEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

  // Where Stripe's messages go: under the Pay button.
  const errorLine = document.createElement('p');
  errorLine.setAttribute('role', 'alert');
  errorLine.hidden = true;
  Object.assign(errorLine.style, {
    margin: '12px 0 0',
    color: 'var(--late)',
    fontSize: '.95rem',
    textAlign: 'center',
    lineHeight: '1.45',
  });
  pay.after(errorLine);
  const showError = (message) => {
    errorLine.textContent = message || '';
    errorLine.hidden = !message;
  };

  let stripe = null;
  let elements = null;
  let busy = false;
  let attempt = null; // { email, token }

  // ---- The offer: normally in the page's head already; if the Worker couldn't add it, ask for it ----
  function showOffer() {
    const set = (sel, v) => document.querySelectorAll(sel).forEach((el) => (el.textContent = v));
    set('.price, .of-p', SITE.money(SITE.priceCents));
    set('.total, .of-total', SITE.spotsTotal);
    set('.of-n', SITE.spotsTaken + 1);
    set('#spotsLeft, #ofLeft', SITE.spotsLeft);
    const width = (SITE.spotsTaken / SITE.spotsTotal) * 100 + '%';
    for (const id of ['spotsBar', 'ofBar']) if ($(id)) $(id).style.width = width;
    if (SITE.soldOut) OFFER_UI.soldOut();
  }

  async function ensureOffer() {
    if (SITE.offerKnown) return true;
    try {
      const res = await fetch('/api/offer');
      if (!res.ok) throw new Error(String(res.status));
      const o = await res.json();
      Object.assign(SITE, {
        priceCents: o.priceCents,
        spotsTaken: o.spotsTaken,
        spotsTotal: o.spotsTotal,
        soldOut: o.soldOut,
        publishableKey: o.publishableKey,
        offerKnown: true,
      });
      showOffer();
      return true;
    } catch {
      showError(OFFLINE);
      return false;
    }
  }

  function soldOutNow() {
    SITE.spotsTaken = SITE.spotsTotal;
    SITE.soldOut = true;
    showOffer();
  }

  // ---- Stripe ----
  let stripeJs = null;
  const loadStripeJs = () =>
    (stripeJs ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = STRIPE_JS;
      s.onload = () => resolve(window.Stripe);
      s.onerror = () => {
        stripeJs = null;
        reject(new Error('Stripe.js did not load'));
      };
      document.head.append(s);
    }));

  // The stand-in's dark inputs: --bg fill, --line border, gold focus ring, 10px radius, Fredoka.
  const appearance = {
    theme: 'night',
    labels: 'above',
    variables: {
      colorPrimary: '#ffd43b',
      colorBackground: '#0f1024',
      colorText: '#eef0ff',
      colorTextSecondary: '#8f93c7',
      colorTextPlaceholder: '#5a5d99',
      colorDanger: '#ff4d6d',
      fontFamily: 'Fredoka, system-ui, sans-serif',
      fontSizeBase: '16px',
      borderRadius: '10px',
      spacingUnit: '4px',
    },
    rules: {
      '.Input': { border: '1px solid #3a3c7a', boxShadow: 'none', padding: '11px 12px' },
      '.Input:focus': { borderColor: '#ffd43b', boxShadow: '0 0 0 3px rgba(255, 212, 59, .15)' },
      '.Input--invalid': { borderColor: '#ff4d6d', boxShadow: 'none' },
      '.Label': { color: '#8f93c7', fontSize: '0.85rem', fontWeight: '400' },
    },
  };

  async function mount() {
    if (!(await ensureOffer()) || SITE.soldOut || !SITE.publishableKey) return;
    let Stripe;
    try {
      Stripe = await loadStripeJs();
    } catch {
      showError(OFFLINE);
      return;
    }
    stripe = Stripe(SITE.publishableKey);
    elements = stripe.elements({
      mode: 'payment',
      amount: SITE.priceCents,
      currency: 'aud',
      allowedPaymentMethodTypes: ['card'],
      appearance,
      fonts: [
        {
          cssSrc: 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600&display=swap',
        },
      ],
    });

    // The wallet buttons and the "or pay with card" divider stay hidden until Stripe says this device has a
    // wallet. (The divider's CSS sets display, so `hidden` alone wouldn't hide it.)
    const showWallets = (on) => {
      $('ofExpress').style.display = on ? '' : 'none';
      document.querySelector('.of-or').style.display = on ? '' : 'none';
    };
    showWallets(false);
    $('ofPayment').style.marginTop = '10px';

    // Card fields. Wallets live in the Express Checkout Element above, so they're off here. Only the email is
    // supplied by the page (billing_details at confirm); every other field is Stripe's call ('auto').
    elements
      .create('payment', {
        layout: { type: 'tabs' },
        wallets: { applePay: 'never', googlePay: 'never' },
        terms: { card: 'never' },
        fields: { billingDetails: { email: 'never' } },
      })
      .mount('#ofPayment');

    const express = elements.create('expressCheckout', {
      buttonType: { applePay: 'buy', googlePay: 'buy' },
      buttonTheme: { applePay: 'black', googlePay: 'black' },
      buttonHeight: 44,
      paymentMethods: { link: 'never' },
    });
    express.on('ready', ({ availablePaymentMethods }) => {
      showWallets(
        !!availablePaymentMethods && Object.values(availablePaymentMethods).some(Boolean),
      );
    });
    express.on('click', (event) => {
      SITE.play('coin', 0.5);
      event.resolve({ emailRequired: true });
    });
    express.on('confirm', (event) => {
      const email = (event.billingDetails && event.billingDetails.email) || emailInput.value.trim();
      run(email);
    });
    express.mount('#ofExpress');
  }

  // ---- Paying ----
  function setBusy(on) {
    busy = on;
    pay.disabled = on;
    if (on) pay.textContent = 'Paying…';
    else pay.innerHTML = payLabel;
  }

  async function run(email) {
    if (busy || !elements) return;
    setBusy(true);
    showError(null);
    try {
      const checked = await elements.submit();
      if (checked.error) {
        showError(checked.error.message || 'Please check the card details.');
        return;
      }

      if (!attempt || attempt.email !== email) attempt = { email, token: crypto.randomUUID() };
      let res, body;
      try {
        res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, idempotencyKey: attempt.token }),
        });
        body = await res.json();
      } catch {
        showError(OFFLINE);
        return;
      }
      if (res.status === 409) {
        soldOutNow();
        return;
      }
      if (!res.ok || !body.clientSecret) {
        showError(body.message || OFFLINE);
        return;
      }

      // Card only, no redirects: a 3-D Secure check opens in Stripe's overlay and the page stays put.
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret: body.clientSecret,
        confirmParams: {
          return_url: location.origin + '/#pricing',
          payment_method_data: { billing_details: { email } },
        },
        redirect: 'if_required',
      });
      if (error) {
        showError(error.message || "That payment didn't go through. Nothing was charged.");
        return;
      }
      attempt = null;
      await finish(paymentIntent.id, body.clientSecret, email);
    } catch (e) {
      console.error('Checkout failed:', e);
      showError(BROKEN);
    } finally {
      setBusy(false);
    }
  }

  // Paid: wait a little for the relay to make the licence, then show the success card (with the number if known).
  async function finish(pi, secret, email) {
    pay.textContent = 'Paid! One moment…';
    const until = Date.now() + POLL_FOR_MS;
    let shownTo = email;
    while (Date.now() < until) {
      try {
        const res = await fetch(
          `/api/order?pi=${encodeURIComponent(pi)}&secret=${encodeURIComponent(secret)}`,
        );
        if (res.ok) {
          const o = await res.json();
          if (o.emailedTo) shownTo = o.emailedTo;
          if (o.state === 'ready') {
            OFFER_UI.paid(shownTo, o.familyNumber);
            return;
          }
        }
      } catch {
        // keep trying until the time's up
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    OFFER_UI.paid(shownTo, null);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!looksLikeEmail(email)) {
      emailInput.classList.add('bad');
      emailInput.focus();
      SITE.play('tap', 0.4);
      return;
    }
    if (!elements) {
      showError(OFFLINE);
      return;
    }
    SITE.play('coin', 0.5);
    run(email);
  });

  // Back from a redirect (shouldn't happen with cards only, but Stripe may still send someone back here).
  const q = new URLSearchParams(location.search);
  if (q.get('payment_intent') && q.get('payment_intent_client_secret')) {
    const pi = q.get('payment_intent');
    const secret = q.get('payment_intent_client_secret');
    history.replaceState(null, '', location.pathname + '#pricing');
    if (q.get('redirect_status') === 'succeeded') finish(pi, secret, '');
  }

  // Load Stripe when the offer is about to be seen (or straight away if the page opens there).
  if (SITE.soldOut) return;
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        mount();
      }
    },
    { rootMargin: '600px 0px' },
  );
  io.observe($('pricing'));
})();
