// Site facts and tiny helpers (toast, sound, money). Plain script: exposes window.SITE.
// Ported from prototypes/landing-site/_shared/site.js. Production changes: the offer facts (price, spots,
// sold out, Stripe's publishable key) come from the <meta name="pmp-offer"> the site Worker puts in the page,
// and the buy buttons scroll to the checkout instead of showing a stand-in toast.
(function () {
  const base = document.currentScript.src.replace(/site\.js(\?.*)?$/, '');

  // The Worker's offer: { priceCents, currency, spotsTaken, spotsTotal, soldOut, publishableKey }.
  // Missing (the relay didn't answer, or the page was served without the Worker): offerKnown is false,
  // and the checkout asks /api/offer instead.
  let offer = null;
  try {
    offer = JSON.parse(document.querySelector('meta[name="pmp-offer"]').content);
  } catch {}

  const SITE = {
    name: 'Pocket Money Pal',
    priceCents: offer ? offer.priceCents : 2500,
    currency: '$', // shown as "$25" everywhere; charged in AUD (ADR 0026)
    spotsTotal: offer ? offer.spotsTotal : 250,
    spotsTaken: offer ? offer.spotsTaken : 0,
    soldOut: offer ? offer.soldOut : false,
    publishableKey: offer ? offer.publishableKey : null,
    offerKnown: offer !== null,
    emails: { hello: 'hello@pocketmoneypal.com', support: 'support@pocketmoneypal.com' },
    github: 'https://github.com/chris-hammond-ross/pocket-money-pal',
    country: 'Australia', // the complete page's footer shows the flag (_shared/img/flag-au.svg)
    asset: (p) => base + p,

    money(cents) {
      const whole = cents % 100 === 0;
      return this.currency + (cents / 100).toFixed(whole ? 0 : 2);
    },

    get spotsLeft() {
      return this.spotsTotal - this.spotsTaken;
    },

    // Plays a sound from _shared/sounds. Only call from a click/tap handler.
    muted: false,
    _audio: {},
    play(name, volume = 0.5) {
      if (this.muted) return;
      const a = (this._audio[name] ||= new Audio(base + 'sounds/' + name + '.mp3'));
      a.volume = volume;
      a.currentTime = 0;
      a.play().catch(() => {});
    },

    toast(text) {
      let el = document.getElementById('site-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'site-toast';
        el.style.cssText =
          'position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;' +
          'background:#111;color:#fff;padding:12px 18px;border-radius:12px;font:500 15px/1.3 Fredoka,system-ui,sans-serif;' +
          'box-shadow:0 10px 30px rgba(0,0,0,.4);transition:all .25s;z-index:9999;max-width:calc(100% - 32px);text-align:center';
        document.body.appendChild(el);
      }
      el.textContent = text;
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
      });
      clearTimeout(el._t);
      el._t = setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(-50%) translateY(20px)';
      }, 2600);
    },

    // The buy buttons (data-buy): the checkout is in the Lifetime access section.
    checkout() {
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById('pricing').scrollIntoView({ behavior: still ? 'auto' : 'smooth' });
    },
  };

  window.SITE = SITE;
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-buy]')) SITE.checkout();
  });
})();
