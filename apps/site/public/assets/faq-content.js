/*
  THE FAQ's questions and answers (faq.html). Copied from 08-faq/faq-content.js when option C was locked
  (session 9.6); edit the wording here from now on. Voice rules (README): parents first, short sentences, none
  of the banned words (licence, subscription, server, relay, cloud, HTTPS, …). Answers may contain {{support}} / {{hello}}.

  For families buying lifetime access (remote access). People running it themselves go through the footer's
  "Set it up yourself" link, so "Can I try it first?" (free at home) was dropped.

  Facts checked against: terms (30-day refund, 90 days' notice, one computer, any number of children),
  privacy policy (email + purchase only), plan §2 (A$25, 250 spots), installation.md (with the home internet
  down, the phone app can't reach the computer), ADR 0021 (messages are decrypted at Cloudflare while passing
  through, not kept or logged: the FAQ must say so plainly).
*/
window.FAQ = [
  {
    group: 'Before you buy',
    items: [
      {
        q: 'What do I need?',
        a: 'A Windows computer for the kids’ screen (a family computer with a second monitor works brilliantly) and the grown-ups’ phones. We test on Android phones. iPhones should work, but we haven’t tried them yet. Mac is on its way.',
        tags: 'windows computer pc mac iphone android phone monitor screen tablet',
      },
      {
        q: 'Is it really pay once?',
        a: '$25, once, for the first 250 families. No monthly fees and nothing to renew. Every update and new feature is included.',
        tags: 'price cost monthly fee renew lifetime',
      },
      {
        q: 'Why does my receipt say A$25?',
        a: 'We’re in Australia, so the price is in Australian dollars. Outside Australia your bank converts it: about US$16, plus any fee your bank charges for overseas payments.',
        tags: 'currency aud usd dollars receipt overseas',
      },
      {
        q: 'Can I get my money back?',
        a: 'Yes. If it’s not right for your family, email {{support}} within 30 days of buying for a full refund.',
        tags: 'refund money back return',
      },
    ],
  },
  {
    group: 'Using it',
    items: [
      {
        q: 'Do the kids need phones or accounts?',
        a: 'No. They use the kids’ screen on the family computer. No emails, no passwords, no accounts.',
        tags: 'kids children phone account email password login',
      },
      {
        q: 'How many children and phones?',
        a: 'As many children as you like, and a phone for every grown-up at home. Lifetime access is for one family computer.',
        tags: 'children kids phones parents limit how many',
      },
      {
        q: 'What if the internet goes down?',
        a: 'The kids’ screen and quests keep working at home. The phone app needs the internet to reach your computer, so approvals wait until it’s back.',
        tags: 'internet offline down wifi',
      },
      {
        q: 'What if I get a new computer?',
        a: 'Save a backup from your phone, open it on the new computer, and enter your key again. Your phones carry on as before.',
        tags: 'new computer pc move backup restore key',
      },
      {
        q: 'I’ve lost my key.',
        a: 'Email {{support}} from the address you bought with, and we’ll send it again.',
        tags: 'key lost email resend',
      },
      {
        q: 'What if you stop running it?',
        a: 'We’d email you at least 90 days before. Pocket Money Pal keeps working on your home Wi-Fi, and you can still set up your own way to reach it from outside the house.',
        tags: 'shut down stop close business future',
      },
    ],
  },
  {
    group: 'Privacy',
    items: [
      {
        q: 'Where is my family’s information kept?',
        a: 'On your family’s computer. We never get a copy. We keep your email address and a record of your purchase, and that’s all.',
        tags: 'data information privacy stored where',
      },
      {
        q: 'What happens to messages when I’m out?',
        a: 'They pass through our connection service, run by Cloudflare, on their way to your computer. They’re protected on the way, but not sealed end to end: they’re unwrapped for a moment as they’re passed along. We don’t keep them, read them or log them.',
        tags: 'messages away out encrypted secure cloudflare',
      },
      {
        q: 'Any ads or tracking?',
        a: 'No ads, ever, and nothing in the app tracks you or the kids. This website counts visits without cookies.',
        tags: 'ads tracking cookies analytics',
      },
    ],
  },
];

window.FAQ_TEXT = (s) =>
  s
    .replace(/\{\{support\}\}/g, '<a href="mailto:support@pocketmoneypal.com">support@pocketmoneypal.com</a>')
    .replace(/\{\{hello\}\}/g, '<a href="mailto:hello@pocketmoneypal.com">hello@pocketmoneypal.com</a>');
