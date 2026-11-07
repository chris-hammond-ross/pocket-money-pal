// Terms and privacy policy wording for the legal page.
//
// Each section has:
//   id     anchor (unique across both documents)
//   title  the formal heading
//   q      the same thing as a parent would ask it (option C leads with these)
//   plain  one or two sentences in plain words (A: summary list, B: margin note, C: the visible answer)
//   body   the wording itself (HTML)
// Tokens: {{hello}} / {{support}} → the emails; [[text]] → a "to decide" placeholder.
(function () {
  const LEGAL = {
    updated: '7 November 2026',

    terms: {
      id: 'terms',
      title: 'Terms',
      long: 'Terms of sale and use',
      intro: 'These are the rules for buying and using Pocket Money Pal. We\'ve kept them as short and plain as we can.',
      sections: [
        {
          id: 't-who', title: 'Who we are', q: 'Who am I buying from?',
          plain: 'A small family business in Australia. Email us any time.',
          body: '<p>Pocket Money Pal is made and sold by Christopher Hammond-Ross (ABN 33 940 100 921), based in Australia ("we", "us"). You can reach us at {{hello}} for anything, or {{support}} for help with your family\'s setup.</p><p>"You" means the parent or guardian who buys lifetime access. You must be 18 or over to buy it.</p>',
        },
        {
          id: 't-what', title: 'What lifetime access includes', q: 'What do I get for my money?',
          plain: 'Pay once, and your whole household can use it for as long as the app exists, with every update included.',
          body: '<p>Lifetime access is a one-off payment that lets one household use Pocket Money Pal on one family computer and on the phones of the grown-ups in that household, with as many children as you like.</p><p>It includes every update and new feature we release, for as long as we offer the app. There is nothing more to pay, and nothing renews.</p><p>The early-bird price is offered to the first 250 households. If the price changes later, it doesn\'t change what early-bird households have already paid for.</p>',
        },
        {
          id: 't-need', title: 'What you need', q: 'What do I need to make it work?',
          plain: 'A Windows computer for the kids\' screen, and your phones. Keeping them running (and backed up) is up to you.',
          body: '<p>Pocket Money Pal runs on your family\'s computer (currently Windows; Mac and Linux are planned but not promised by a date) and is controlled from the grown-ups\' phones. You\'re responsible for the computer, the phones and your home internet, and for keeping them working and up to date.</p><p>Your family\'s information is stored on your computer, not with us, so we can\'t restore it if it\'s lost. The app lets you make a backup; we recommend you do so regularly.</p>',
        },
        {
          id: 't-away', title: 'Using it away from home', q: 'What if you stop running the part that works away from home?',
          plain: 'At home it always keeps working. If we ever stop the away-from-home part, we\'ll tell you well in advance.',
          body: '<p>When you use your phone away from home, messages between your phone and your family\'s computer pass through a connection service we run. We aim to keep it running all the time, but it may occasionally be unavailable, for example during maintenance.</p><p>If we ever decide to stop running it, we\'ll give you at least 90 days\' notice by email. Pocket Money Pal will keep working on your home Wi-Fi, and you\'ll still be able to set up your own way to reach it from outside the house.</p>',
        },
        {
          id: 't-refunds', title: 'Refunds', q: 'Can I get my money back?',
          plain: 'Yes. If it\'s not right for your family, ask within 30 days for a full refund. No questions.',
          body: '<p>If you\'re not happy, email {{support}} within 30 days of buying and we\'ll refund you in full. When we refund you, your lifetime access ends.</p><p>Our goods and services come with guarantees that cannot be excluded under the Australian Consumer Law. Nothing in these terms limits your rights under that law.</p>',
        },
        {
          id: 't-money', title: 'Pocket money is a record, not a bank', q: 'Does the app hold real money?',
          plain: 'No. It keeps track of what your kids have earned. You pay the actual pocket money.',
          body: '<p>Pocket Money Pal records points and pocket money that you, the parent, decide on. It doesn\'t hold, send or pay out real money, and it isn\'t a bank account or financial product. Paying the pocket money it shows is up to you.</p>',
        },
        {
          id: 't-fair', title: 'Fair use', q: 'Is there anything I\'m not allowed to do?',
          plain: 'Use it for your own household, don\'t resell it, and don\'t try to break it.',
          body: '<p>Please don\'t share your access with other households, resell it, or try to interfere with, overload or get around the security of the app or our connection service. If you do, we may end your access, after first telling you why where we reasonably can.</p>',
        },
        {
          id: 't-liability', title: 'Our responsibility', q: 'What if something goes wrong?',
          plain: 'Tell us and we\'ll try to put it right. Your consumer rights always apply.',
          body: '<p>We work hard to make Pocket Money Pal reliable, but we can\'t promise it will be free of faults. Apart from your rights under the Australian Consumer Law, and to the extent the law allows, we\'re not responsible for indirect losses, or for losses caused by your computer, phones, internet connection or other services we don\'t control.</p><p>Where the law allows us to limit our responsibility, it is limited to re-supplying the app or refunding what you paid.</p>',
        },
        {
          id: 't-diy', title: 'The free, set-it-up-yourself version', q: 'Do these terms cover the free version?',
          plain: 'No. The free version comes with its own terms, published alongside its code.',
          body: '<p>These terms cover lifetime access bought from us. The free version that you install and run yourself is provided under the terms published with its code on GitHub, and comes without support or the away-from-home connection service.</p>',
        },
        {
          id: 't-changes', title: 'Changes and the law', q: 'Can these terms change?',
          plain: 'Rarely, and never to take away what you paid for. We\'ll email you first.',
          body: '<p>We may update these terms, for example when we add features or the law changes. We\'ll email you about any important change at least 30 days before it applies. Changes won\'t take away lifetime access you have already paid for.</p><p>These terms are governed by the laws of South Australia, Australia.</p>',
        },
      ],
    },

    privacy: {
      id: 'privacy-policy',
      title: 'Privacy policy',
      long: 'Privacy policy',
      intro: 'The short version: your family\'s information stays on your family\'s computer. We keep your email address and your purchase, and nothing else.',
      sections: [
        {
          id: 'p-home', title: 'What stays at home', q: 'Can you see my family\'s information?',
          plain: 'No. Names, chores, points, goals and money stay on your family\'s computer. We never see them.',
          body: '<p>Everything you put into Pocket Money Pal (your children\'s names and photos, their chores, points, goals, pocket money and history) is stored on your family\'s computer. It is not sent to us, and we can\'t see it.</p>',
        },
        {
          id: 'p-keep', title: 'What we collect', q: 'So what do you keep?',
          plain: 'Your email address and a record of your purchase. That\'s it.',
          body: '<p>When you buy lifetime access we keep:</p><ul><li>your email address, to send your download link, important notices and help you ask for;</li><li>a record of your purchase: what you bought, when, the price, your country and the payment reference from Stripe.</li></ul><p>To connect your phones to your computer when you\'re away from home, we also keep a random code that tells messages which home to go to. It doesn\'t identify you or your children.</p>',
        },
        {
          id: 'p-away', title: 'Messages away from home', q: 'What happens to messages when I\'m out?',
          plain: 'They pass through us to reach your computer, and aren\'t kept or read.',
          body: '<p>When you use your phone away from home, messages between your phone and your computer pass through our connection service, which is hosted by Cloudflare. They\'re encrypted on the way and passed straight through: we don\'t store them, read them or use them for anything else.</p>',
        },
        {
          id: 'p-pay', title: 'Payments', q: 'Do you see my card details?',
          plain: 'No. Stripe handles the payment; we never see your card.',
          body: '<p>Payments are processed by Stripe. Your card details go straight to Stripe and never reach us. Stripe\'s use of your information is covered by its own privacy policy.</p>',
        },
        {
          id: 'p-share', title: 'Who we share it with', q: 'Do you sell or share my information?',
          plain: 'Never sold. Only shared with the few services we need to run things.',
          body: '<p>We never sell your information, show you ads, or share it with advertisers. We share it only with the services that help us run Pocket Money Pal: Stripe (payments), Cloudflare (this website and the connection service) and Resend (email) (sending your emails). Some of them store information outside Australia, including in the United States.</p><p>We\'ll also disclose information if the law requires us to.</p>',
        },
        {
          id: 'p-kids', title: 'Children', q: 'Do my kids have accounts with you?',
          plain: 'No. Kids never sign up with us or give us anything.',
          body: '<p>Children use Pocket Money Pal on your family\'s computer, but they never create an account with us, and we don\'t collect any information from or about them.</p>',
        },
        {
          id: 'p-site', title: 'This website', q: 'Do you track me on this website?',
          plain: 'No cookies and no ad tracking. We count visits without knowing who you are.',
          body: '<p>This website doesn\'t use cookies or advertising trackers. We use Cloudflare Web Analytics, which counts page visits without cookies and without identifying you, and we count how many visitors reach each step of buying (seeing the offer, starting to pay, paying) using a random number that\'s forgotten when you close the page. Neither records your name, email or IP address. Like any website, our hosting provider handles your IP address briefly to deliver the pages to you.</p>',
        },
        {
          id: 'p-long', title: 'How long we keep it', q: 'How long do you keep my details?',
          plain: 'For as long as you have lifetime access, and purchase records for as long as tax law says.',
          body: '<p>We keep your email address while you have lifetime access. We keep purchase records for 5 years after the purchase, because Australian tax law requires it. After that, they\'re deleted.</p>',
        },
        {
          id: 'p-rights', title: 'Your choices', q: 'Can I see or delete what you hold?',
          plain: 'Yes. Email us and we\'ll show you, fix it or delete it.',
          body: '<p>You can ask to see the information we hold about you, correct it, or delete it (except what we must keep by law). Email {{support}} and we\'ll respond within 30 days.</p><p>To remove your family\'s information, uninstall the app from your computer and delete its data folder; we never had a copy.</p><p>If you\'re unhappy with how we\'ve handled your information, please tell us first. You can also complain to the Office of the Australian Information Commissioner (oaic.gov.au).</p>',
        },
        {
          id: 'p-changes', title: 'Changes to this policy', q: 'Will this policy change?',
          plain: 'If it does, we\'ll email you first.',
          body: '<p>If we change this policy in a way that matters, we\'ll email you before the change applies, and update the date at the top.</p>',
        },
      ],
    },

    // Replace tokens with real values. tbcClass is the class each option uses for "to decide" placeholders.
    fill(html, tbcClass = 'lg-tbc') {
      return html
        .replace(/\{\{hello\}\}/g, `<a href="mailto:${SITE.emails.hello}">${SITE.emails.hello}</a>`)
        .replace(/\{\{support\}\}/g, `<a href="mailto:${SITE.emails.support}">${SITE.emails.support}</a>`)
        .replace(/\[\[(.+?)\]\]/g, `<mark class="${tbcClass}" title="To decide">$1</mark>`);
    },
    // Plain text version (no tags, placeholders kept as their text).
    text(html) {
      return html.replace(/\[\[(.+?)\]\]/g, '$1');
    },
  };
  LEGAL.docs = [LEGAL.terms, LEGAL.privacy];
  window.LEGAL = LEGAL;
})();
