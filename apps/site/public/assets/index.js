// ---- 01 · Hero ----
(() => {
  const $ = (id) => document.getElementById(id);
  const COLOURS = ['#ffd43b', '#37e28c', '#9d6bff', '#228be6'];

  // ---- Offer ----
  document.querySelectorAll('.price').forEach((el) => (el.textContent = SITE.money(SITE.priceCents)));
  document.querySelectorAll('.total').forEach((el) => (el.textContent = SITE.spotsTotal));
  $('spotsLeft').textContent = SITE.spotsLeft;
  $('spotsBar').style.width = (SITE.spotsTaken / SITE.spotsTotal) * 100 + '%';

  // ---- Shared helpers ----
  function fly(text, from, to, onDone) {
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const el = Object.assign(document.createElement('div'), { className: 'fly', textContent: text });
    document.body.appendChild(el);
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
    const x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
    el.animate([
      { transform: `translate(${x0}px, ${y0}px) translate(-50%, -50%) scale(1)` },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - 60}px) translate(-50%, -50%) scale(1.5)` },
      { transform: `translate(${x1}px, ${y1}px) translate(-50%, -50%) scale(.6)`, opacity: .3 },
    ], { duration: 650, easing: 'cubic-bezier(.4,0,.2,1)' }).onfinish = () => { el.remove(); onDone && onDone(); };
  }

  function countTo(el, from, to, fmt = (n) => n) {
    const t0 = performance.now();
    (function step(t) {
      const k = Math.min(1, (t - t0) / 500);
      el.textContent = fmt(Math.round(from + (to - from) * k));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

  function burst() {
    const r = $('toy').getBoundingClientRect();
    confetti({ particleCount: 140, spread: 80, origin: { x: (r.left + r.width / 2) / innerWidth, y: (r.bottom - 60) / innerHeight }, colors: COLOURS });
  }

  // ---- Switch between the two demos ----
  let parentMode = false;
  function setMode(parent) {
    parentMode = parent;
    $('kidView').classList.toggle('show', !parent);
    $('parentView').classList.toggle('show', parent);
    $('toy').classList.toggle('parent', parent);
    $('switch').textContent = parent ? '🧒 Switch to the kids\' screen' : '📱 Switch to parent view';
  }
  $('switch').addEventListener('click', () => { SITE.play('whoosh', 0.3); setMode(!parentMode); });

  // ---- Kids' screen demo ----
  const kid = PMP.children[0]; // Billy
  const goal = PMP.goals.find((g) => g.id === 'g2'); // Basketball
  const CENTS_PER_POINT = 5;
  const START_SAVED = 2300; // so three quests tip him over the goal
  const QUESTS = [
    { ...PMP.chores.find((c) => c.id === 'ch1'), pts: 10 },
    { ...PMP.chores.find((c) => c.id === 'ch3'), pts: 10 },
    { ...PMP.chores.find((c) => c.id === 'ch4'), pts: 20 },
  ];

  $('avatar').textContent = kid.avatar;
  $('kidName').textContent = kid.name;
  $('goalEmoji').textContent = goal.emoji;
  $('target').textContent = SITE.money(goal.targetCents);

  let points, saved, done;

  function renderGoal() {
    const pct = Math.min(100, (saved / goal.targetCents) * 100);
    $('goalBar').style.width = pct + '%';
    $('jarFill').style.height = pct + '%';
    $('saved').textContent = SITE.money(saved);
  }

  function resetKids() {
    points = 0; saved = START_SAVED; done = 0;
    $('ptsNum').textContent = 0;
    $('goalName').textContent = goal.name;
    $('payday').classList.remove('show');
    $('again').classList.remove('show');
    $('quests').innerHTML = QUESTS.map((q, i) => `
      <li><button class="quest ${i === 0 ? 'hint' : ''}" data-i="${i}">
        <span class="ico">${q.icon}</span>
        <span class="t"><b>${q.title}</b><small>⚡ Tap it when it's done!</small></span>
        <span class="p">+${q.pts}</span>
      </button></li>`).join('');
    renderGoal();
  }

  $('quests').addEventListener('click', (e) => {
    const btn = e.target.closest('.quest');
    if (!btn || btn.disabled) return;
    const q = QUESTS[btn.dataset.i];
    btn.disabled = true;
    btn.classList.remove('hint');
    btn.classList.add('claimed');
    btn.querySelector('small').textContent = '✋ Done! Waiting for Mum to check…';
    SITE.play('pop');

    setTimeout(() => {
      $('noteText').textContent = `${kid.name}: ${q.title} (+${q.pts})`;
      $('note').classList.add('show');
      SITE.play('tap', 0.4);
    }, 700);

    setTimeout(() => {
      $('note').classList.remove('show');
      btn.classList.replace('claimed', 'done');
      btn.querySelector('.ico').textContent = '✓';
      btn.querySelector('small').textContent = 'Approved';
      fly(`+${q.pts} ⭐`, btn.querySelector('.p'), $('pts'), () => {
        SITE.play('coin');
        countTo($('ptsNum'), points, points + q.pts);
        points += q.pts;
        bump($('pts'));
        done++;
        const next = $('quests').querySelector('.quest:not(:disabled)');
        if (next) next.classList.add('hint');
        if (done === QUESTS.length) {
          $('payday').textContent = `💰 Payday! ${points} points → ${SITE.money(points * CENTS_PER_POINT)}`;
          $('payday').classList.add('show');
        }
      });
    }, 1900);
  });

  $('payday').addEventListener('click', () => {
    $('payday').classList.remove('show');
    SITE.play('chaching');
    const cents = points * CENTS_PER_POINT;
    let i = 0;
    const coin = setInterval(() => {
      fly('🪙', $('pts'), $('jarFill').parentElement);
      if (++i === 6) clearInterval(coin);
    }, 90);
    setTimeout(() => {
      const from = saved;
      saved += cents;
      renderGoal();
      countTo($('saved'), from, saved, (n) => SITE.money(n));
      if (saved >= goal.targetCents) {
        setTimeout(() => {
          SITE.play('fanfare', 0.4);
          burst();
          $('goalName').textContent = `${goal.name}: goal reached! 🎉`;
          $('again').classList.add('show');
        }, 700);
      }
    }, 650);
  });

  $('again').addEventListener('click', resetKids);

  // ---- Parent's phone demo ----
  const [billy, alice] = PMP.children;
  const kidById = { c1: billy, c2: alice };
  const CLAIMS = [
    { childId: 'c2', choreId: 'ch4', pts: 25, at: '4:20pm', how: 'all by herself' },
    { childId: 'c1', choreId: 'ch2', pts: 15, at: '4:35pm', how: 'after a reminder' },
    { childId: 'c2', choreId: 'ch6', pts: 20, at: '4:41pm', how: 'all by herself' },
  ];
  const START_PTS = { c1: 35, c2: 25 };
  let kidPts, pending;

  function renderKids() {
    $('kids').innerHTML = [billy, alice].map((k) => `
      <div class="kid" id="kid-${k.id}">
        <span class="av" style="background:${k.colour}">${k.avatar}</span><b>${k.name}</b>
        <span class="kp"><span id="kp-${k.id}">${kidPts[k.id]}</span><small>points today</small></span>
      </div>`).join('');
  }

  function renderTrayHead() {
    const left = pending.filter(Boolean);
    $('count').textContent = left.length;
    $('sum').textContent = left.length ? `+${left.reduce((s, c) => s + c.pts, 0)} ⭐` : '';
    $('all').textContent = `✓ Approve all ${left.length} (+${left.reduce((s, c) => s + c.pts, 0)})`;
    $('trayFoot').style.visibility = left.length ? '' : 'hidden';
    $('caught').classList.toggle('show', !left.length);
    bump($('count'));
  }

  // Keep the approvals area as tall as the full list, so the card never shrinks as cards go.
  function holdStackHeight() {
    if (!pending.every(Boolean)) return; // only measure the full list
    $('stack').style.minHeight = '';
    $('stack').style.minHeight = $('claims').offsetHeight + 'px';
  }
  document.fonts.ready.then(holdStackHeight);
  addEventListener('resize', holdStackHeight);

  function resetParent() {
    kidPts = { ...START_PTS };
    pending = CLAIMS.map((c) => ({ ...c }));
    $('sent').textContent = '';
    renderKids();
    $('claims').innerHTML = pending.map((c, i) => {
      const k = kidById[c.childId], ch = PMP.chores.find((x) => x.id === c.choreId);
      return `
        <div class="claim" data-i="${i}">
          <span class="av" style="background:${k.colour}">${k.avatar}</span>
          <div class="ct"><b>${ch.icon} ${ch.title}</b><small>${k.name} · ${c.at} · ${c.how}</small></div>
          <span class="cp">+${c.pts}</span>
          <div class="acts"><button class="no" title="Send back">↩</button><button class="yes" title="Approve">✓</button></div>
        </div>`;
    }).join('');
    holdStackHeight();
    renderTrayHead();
  }

  function resolve(card, approve) {
    const i = +card.dataset.i, c = pending[i];
    if (!c) return;
    pending[i] = null;
    card.classList.add(approve ? 'ok' : 'back');
    if (approve) {
      SITE.play('coin');
      fly(`+${c.pts} ⭐`, card.querySelector('.cp'), $('kid-' + c.childId), () => {
        const el = $('kp-' + c.childId);
        countTo(el, kidPts[c.childId], kidPts[c.childId] + c.pts);
        kidPts[c.childId] += c.pts;
        bump($('kid-' + c.childId));
      });
    } else {
      SITE.play('whoosh', 0.4);
      $('sent').textContent = `↩ Sent back to ${kidById[c.childId].name}: "Nearly! Look again 😉"`;
    }
    setTimeout(() => card.classList.add(approve ? 'gone-r' : 'gone-l'), 150);
    setTimeout(() => {
      card.remove();
      renderTrayHead();
      if (!pending.some(Boolean)) { SITE.play('fanfare', 0.35); burst(); }
    }, 450);
  }

  $('claims').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) resolve(b.closest('.claim'), b.classList.contains('yes'));
  });

  // Swipe right to approve, left to send back.
  let drag = null;
  $('claims').addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.claim');
    if (!card || e.target.closest('button')) return;
    drag = { card, x: e.clientX, dx: 0 };
    card.classList.add('dragging');
    card.setPointerCapture(e.pointerId);
  });
  $('claims').addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x;
    drag.card.style.transform = `translateX(${drag.dx}px)`;
    drag.card.classList.toggle('ok', drag.dx > 60);
    drag.card.classList.toggle('back', drag.dx < -60);
  });
  $('claims').addEventListener('pointerup', () => {
    if (!drag) return;
    const { card, dx } = drag;
    drag = null;
    card.classList.remove('dragging');
    card.style.transform = '';
    if (Math.abs(dx) > 80) resolve(card, dx > 0);
    else card.classList.remove('ok', 'back');
  });

  $('all').addEventListener('click', () => {
    document.querySelectorAll('.claim').forEach((card, n) => setTimeout(() => resolve(card, true), n * 180));
  });
  $('againP').addEventListener('click', resetParent);

  // ---- Misc ----
  $('mute').addEventListener('click', () => {
    SITE.muted = !SITE.muted;
    $('mute').textContent = SITE.muted ? '🔇 Sound off' : '🔊 Sound on';
  });

  // ---- Pixel night sky: square stars that twinkle and drift slowly left ----
  (function sky() {
    const cv = $('sky'), ctx = cv.getContext('2d'), area = cv.parentElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const COLOURS = ['#eef0ff', '#eef0ff', '#eef0ff', '#ffd43b', '#9d6bff', '#37e28c'];
    const rand = (a, b) => a + Math.random() * (b - a);
    let w, h, stars, last = performance.now();
    function size() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = area.clientWidth; h = area.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: Math.round((w * h) / 9000) }, () => ({
        x: rand(0, w), y: rand(0, h), size: [1, 2, 2, 3][Math.floor(Math.random() * 4)],
        c: COLOURS[Math.floor(Math.random() * COLOURS.length)], ph: rand(0, 6.3), sp: rand(0.6, 2),
      }));
    }
    function frame(now) {
      const t = now / 1000, dt = Math.min(50, now - last) / 1000;
      last = now;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.x -= s.size * 2.5 * dt; // bigger stars drift faster: a hint of depth
        if (s.x < -4) s.x = w + 4;
        ctx.globalAlpha = 0.15 + 0.45 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
        ctx.fillStyle = s.c;
        ctx.fillRect(Math.round(s.x), Math.round(s.y), s.size, s.size);
      }
      if (!still) requestAnimationFrame(frame);
    }
    size();
    new ResizeObserver(size).observe(area);
    requestAnimationFrame(frame);
  })();

  resetKids();
  resetParent();
  setMode(location.hash === '#parent');
})();

// ---- 02 · How it works ----
(() => {
  const $ = (id) => document.getElementById(id);
  const IMG = (n) => `/assets/img/${n}.png`;
  const DOLLAR_PTS = Math.round(100 / PMP.settings.centsPerPoint); // points per $1

  // Each step: tile copy, colour, and one or more "views" (chips). A view sets the focus, both
  // screenshots (m/p name what each screen shows, used as alt text). Steps with one view show no chips.
  const STEPS = [
    {
      id: 'chores', e: '🧹', name: 'Chores', tile: 'You pick the jobs on your phone.', c: 'var(--surprise)',
      title: 'Set up the week once',
      lead: 'On your phone, choose the jobs and tick the days they happen. <b>You only do it once</b>: the week repeats by itself, every week, until you change it.',
      views: [
        {
          chip: '🔁 Every week', focus: 'phone', phone: 'phone-week', mon: 'kiosk',
          text: 'Start from ready-made jobs (make your bed, feed the cat, set the table) or write your own. Tap a square to switch a job on or off for a day. Going on holiday? Pause the lot.',
          p: ['The week planner', 'Jobs down the side, days across the top. Each dot is a child. Underneath, what each child can earn in a week.'],
          m: ['Waits for the morning', 'Every day, that day\'s jobs appear on the kids\' screen as quests. Nothing to do each morning.'],
        },
        {
          chip: '📌 One-off jobs', focus: 'phone', phone: 'phone-quest-editor', mon: 'kiosk',
          text: 'Something just for one day, like <b>"wash the car on Saturday"</b>? Add it as a one-off and it only shows up that day. For every job you choose the points, and when it\'s due.',
          p: ['The job editor', 'Who does it, the points, and the time window: early earns a bonus, late loses a few.'],
          m: ['Shows up on the day', 'A one-off appears alongside the usual quests, then it\'s gone.'],
        },
        {
          chip: '⚡ Surprise quests', focus: 'both', phone: 'phone-surprise', mon: 'kiosk-surprise',
          text: 'Need a hand right now? Send a <b>surprise quest</b>. It pops up full screen on the kids\' screen and they race to grab it, or all do it together.',
          p: ['Sending a surprise', 'Pick the job and the reward, who can take it, and how long it stays up.'],
          m: ['A surprise pops up', 'Full screen, with a countdown. Whoever grabs it first gets the quest.'],
        },
      ],
    },
    {
      id: 'quests', e: '⚔️', name: 'Quests', tile: 'They pop up on the kids\' screen, with a countdown.', c: '#74c0fc',
      title: 'Jobs become quests',
      lead: 'Each child has their own column on the family computer, with today\'s quests, most urgent first. A <b>big countdown</b> shows what\'s next, so the screen does the reminding, not you.',
      views: [{
        focus: 'monitor', phone: 'phone-day', mon: 'kiosk',
        text: 'Every quest has a time window: <b>green</b> while there\'s an early bonus, <b>yellow</b> when it\'s due, <b>red</b> when it\'s late. Doing them all builds a streak, and points add up to new levels.',
        m: ['Billy and Alice\'s quests', 'Points today, the streak flame, "next up" with its countdown, and the quests still to do. Done ones are ticked at the bottom.'],
        p: ['Today at a glance', 'You can see the same day on your phone, but you don\'t need to: the kids\' screen runs itself.'],
      }],
    },
    {
      id: 'points', e: '⭐', name: 'Points', tile: 'Earned when you approve. Early means bonus points.', c: 'var(--gold)',
      title: 'Kids tap it, you check it',
      lead: 'When a job\'s done, the child taps it on their screen. Your phone shows it, and you approve it with a swipe. <b>Then the points land</b>, with a coin sound.',
      views: [
        {
          chip: '1 · Billy taps "done"', focus: 'monitor', phone: 'phone-tray', mon: 'kiosk-claim',
          text: 'Billy taps the quest and says whether he did it <b>without being asked</b>, which earns a bit extra. It turns stripy while it waits for you.',
          m: ['Saying it\'s done', 'One tap, then "did you do it without being asked?"'],
          p: ['It\'s on its way', 'Your phone gets a little "to check" tray.'],
        },
        {
          chip: '2 · You approve', focus: 'phone', phone: 'phone-tray', mon: 'kiosk-claim',
          text: '<b>Swipe right</b> to approve, and the points fly up on the kids\' screen. Not quite done? <b>Swipe left</b> to send it back with a note. Or approve them all at once.',
          p: ['The "to check" tray', 'Everything the kids say they\'ve finished, with who did it, when, and the points.'],
          m: ['Points fly up', 'A coin sound, and the points land on their column.'],
        },
      ],
    },
    {
      id: 'money', e: '💰', name: 'Pocket money', short: 'Money', tile: 'On payday, points turn into money at your rate.', c: 'var(--bonus)',
      title: 'Payday!',
      lead: `Once a week, the week's points turn into <b>pocket money</b>, at a rate you choose (say ${DOLLAR_PTS} points for ${SITE.money(100)}). The kids watch it count up in a little show.`,
      views: [{
        focus: 'monitor', phone: 'phone-payday', mon: 'kiosk-payday',
        text: 'You pick the day and time. It can start by itself, or wait until you press start, when everyone\'s home. Change the rate any time; it only counts from then on.',
        m: ['The payday show', 'Each child\'s points count down into money, ready to pour into their jars.'],
        p: ['Payday settings', 'When payday happens, and anything waiting for you to check.'],
      }],
    },
    {
      id: 'goals', e: '🏀', name: 'Goals', tile: 'Kids save it in jars for things they really want.', c: 'var(--bonus)',
      title: 'Saving for something they want',
      lead: 'Kids make <b>jars</b> for the things they\'re saving for, and pour their pocket money in. When a jar is full they get to <b>smash it</b>, and your phone asks you to buy the thing.',
      views: [{
        focus: 'monitor', phone: 'phone-gift', mon: 'kiosk-savings',
        text: 'Birthday money from Grandma or the tooth fairy? Send it from your phone as an envelope; they open it on their screen and it goes in a jar too.',
        m: ['Billy\'s jars', 'How much is in each jar, and what\'s still to sort from payday.'],
        p: ['Sending a gift', 'Money in or out, and a savings book with every payday, gift and purchase.'],
      }],
    },
  ];

  // Preload every screenshot so swaps don't flash.
  STEPS.flatMap((s) => s.views.flatMap((v) => [v.phone, v.mon])).forEach((n) => (new Image().src = IMG(n)));

  // ---- Tiles ----
  const arrow = '<span class="arrow" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M0 4h6V1l4 4-4 4V6H0z" fill="currentColor"/></svg></span>';
  $('tiles').innerHTML = STEPS.map((s, i) => `
    <button class="tile" role="tab" id="tab-${s.id}" data-i="${i}" style="--tc:${s.c}" aria-selected="false">
      <span class="e">${s.e}</span><b><span class="long">${s.name}</span><span class="short">${s.short || s.name}</span></b><span>${s.tile}</span>
    </button>`).join(arrow);

  let step = -1, view = 0;
  // Phones show one screen at a time. Each step/chip starts on the screen it's about; the switch overrides.
  const MOBILE = matchMedia('(max-width: 600px)');
  let show = 'monitor';

  function renderShow() {
    $('stage').dataset.show = show;
    document.querySelectorAll('#viewSwitch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === show)));
  }

  function swapImg(img, name, alt) {
    const src = IMG(name);
    if (img.getAttribute('src') === src) return;
    if (!img.getAttribute('src')) { img.src = src; img.alt = alt; return; }
    img.classList.add('fade');
    setTimeout(() => { img.src = src; img.alt = alt; img.classList.remove('fade'); }, 180);
  }

  function renderView() {
    const s = STEPS[step], v = s.views[view];
    const stage = $('stage');
    stage.dataset.focus = v.focus;
    stage.style.setProperty('--fc', s.c);
    $('monitor').classList.toggle('dim', !MOBILE.matches && v.focus === 'phone');
    $('phone').classList.toggle('dim', !MOBILE.matches && v.focus === 'monitor');
    $('viewSwitch').style.setProperty('--fc', s.c);
    show = v.focus === 'phone' ? 'phone' : 'monitor';
    renderShow();
    swapImg($('monImg'), v.mon, `The kids' screen: ${v.m[0]}`);
    swapImg($('phoneImg'), v.phone, `Your phone: ${v.p[0]}`);

    $('text').style.setProperty('--fc', s.c);

    document.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('on', i === view));
    const ct = document.querySelector('.chip-text');
    if (ct) ct.innerHTML = v.text;
  }

  function textHtml(i) {
    const s = STEPS[i];
    return `
      <div>
        <span class="n">STEP ${i + 1} OF ${STEPS.length}</span>
        <h3>${s.title}</h3>
        <p>${s.lead}</p>
      </div>
      <div class="example">
        ${s.views.length > 1 ? `<div class="chips">${s.views.map((v, n) => `<button class="chip" data-v="${n}">${v.chip}</button>`).join('')}</div>` : ''}
        <p class="chip-text"></p>
      </div>`;
  }

  // Desktop: hold the text area at the height of the tallest step/chip, so the box never jumps.
  // Each version is rendered into a hidden copy of the text area and measured.
  function holdTextHeight() {
    const text = $('text');
    text.style.minHeight = '';
    if (matchMedia('(max-width: 900px)').matches) return;
    const probe = Object.assign(document.createElement('div'), { className: 'text' });
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;animation:none;width:${text.offsetWidth}px`;
    text.parentElement.appendChild(probe);
    let max = 0;
    STEPS.forEach((st, i) => st.views.forEach((v) => {
      probe.innerHTML = textHtml(i);
      probe.querySelector('.chip-text').innerHTML = v.text;
      max = Math.max(max, probe.offsetHeight);
    }));
    probe.remove();
    text.style.minHeight = max + 'px';
  }

  function go(i) {
    if (i === step) return;
    step = i; view = 0;
    const s = STEPS[step];
    document.querySelectorAll('.tile').forEach((t, n) => t.setAttribute('aria-selected', String(n === i)));
    $('text').setAttribute('aria-labelledby', 'tab-' + s.id);
    $('text').innerHTML = textHtml(i);
    // Restart the text's entrance animation.
    $('text').style.animation = 'none'; void $('text').offsetWidth; $('text').style.animation = '';
    renderView();
  }

  $('tiles').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    SITE.play('tap', 0.35);
    go(+t.dataset.i);
  });
  // Arrow keys move between tabs.
  $('tiles').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = (step + (e.key === 'ArrowRight' ? 1 : STEPS.length - 1)) % STEPS.length;
    go(i);
    $('tab-' + STEPS[i].id).focus();
  });
  $('text').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      const v = +chip.dataset.v;
      if (v === view) return;
      SITE.play('whoosh', 0.25);
      view = v;
      renderView();
    }
  });

  $('viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.show === show) return;
    SITE.play('whoosh', 0.25);
    show = b.dataset.show;
    renderShow();
  });
  MOBILE.addEventListener('change', renderView);

  // ?step=2 opens on a step (0-based), handy for comparing.
  go(Math.min(STEPS.length - 1, Math.max(0, +new URLSearchParams(location.search).get('step') || 0)));
  document.fonts.ready.then(holdTextHeight);
  addEventListener('resize', holdTextHeight);
})();

(() => {
  const $ = (id) => document.getElementById(id);
  const board = $('board'), spy = $('spy');
  const K = 0.98, W = 86 * K, H = 72 * K; // the figure is drawn 86 × 72 and shown at 0.98×
  // How far the figure rises above a card's top edge to show his hat and sunglasses.
  const EYES = 36 * K;
  // Side peeks: how far he leans (deg), and how far inside the card edge his base sits, hidden and leaning.
  const LEAN = 42, IN_HIDDEN = 48 * K, IN_LEANING = 24 * K;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  let run = 0, onScreen = false, pos = { x: 0, y: 0, r: 0 };

  function cards() {
    return [...board.querySelectorAll('.rule')].map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
  }
  const rowOf = (cs, c) => cs.filter((o) => o.y === c.y);
  const tf = (p) => `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg)`;
  function place(x, y, r = 0) { pos = { x, y, r }; spy.style.transform = tf(pos); }
  async function move(x, y, ms, easing = 'ease-in-out', r = 0) {
    const a = spy.animate([{ transform: tf(pos) }, { transform: tf({ x, y, r }) }], { duration: ms, easing });
    place(x, y, r);
    await a.finished.catch(() => {});
  }
  // The drawing faces left; facing right mirrors it.
  const face = (dir) => spy.classList.toggle('right', dir === 'right');
  const flip = () => face(spy.classList.contains('right') ? 'left' : 'right');
  async function glance(ms) { spy.classList.add('glance'); await sleep(ms); spy.classList.remove('glance'); }

  // Each peek starts and ends hidden behind a card.
  const hidden = (c) => c.y + 30;
  function appear(x, y) { place(x, y); spy.hidden = false; }

  async function peek() {
    const cs = cards(), c = pick(cs), row = rowOf(cs, c);
    // Side peeks only from a row's outer edges, and only when there's room beside the board.
    const sides = innerWidth > 700
      ? [c.x === Math.min(...row.map((o) => o.x)) && 'left', c.x + c.w === Math.max(...row.map((o) => o.x + o.w)) && 'right'].filter(Boolean)
      : [];
    if (sides.length && Math.random() < 0.4) {
      // Lean out round the card's edge, pivoting at his base (which stays behind the card), so only
      // his head shows; at the same time his base slides a little towards the edge.
      const side = pick(sides), dir = side === 'left' ? -1 : 1;
      const y = c.y + rand(0.35, 0.75) * c.h - H;
      const edge = side === 'left' ? c.x : c.x + c.w;
      const baseX = (inset) => edge - dir * inset - W / 2;
      face(side);
      appear(baseX(IN_HIDDEN), y);
      await move(baseX(IN_LEANING), y, 420, 'ease-out', dir * LEAN);
      await sleep(900); await glance(600); await sleep(300);
      await move(baseX(IN_HIDDEN), y, 240, 'ease-in', 0);
      return;
    }
    face(pick(['left', 'right']));
    appear(c.x + rand(10, c.w - W - 10), hidden(c));
    await move(pos.x, c.y - EYES, 420, 'ease-out');
    await sleep(600); flip();
    await sleep(700); await glance(500);
    await move(pos.x, hidden(c), 220, 'ease-in');
  }

  async function loop(id) {
    await sleep(1200);
    while (id === run) {
      if (!onScreen) { await sleep(500); continue; }
      await peek();
      if (id !== run) return;
      spy.hidden = true;
      await sleep(rand(2500, 5000));
    }
  }

  new IntersectionObserver(([e]) => (onScreen = e.isIntersecting), { threshold: 0.3 }).observe(board);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) loop(run);
})();

// ---- 04 · Lifetime access ----
(() => {
  const $ = (id) => document.getElementById(id);
  const fill = (cls, v) => document.querySelectorAll('.' + cls).forEach((el) => (el.textContent = v));
  fill('of-p', SITE.money(SITE.priceCents));
  fill('of-total', SITE.spotsTotal);
  fill('of-n', SITE.spotsTaken + 1);
  $('ofLeft').textContent = SITE.spotsLeft;
  $('ofBar').style.width = (SITE.spotsTaken / SITE.spotsTotal) * 100 + '%';

  const email = $('ofEmail');
  const emailOk = () => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim());
  email.addEventListener('input', () => email.classList.remove('bad'));

  // familyNumber: the buyer's place in the queue, or null if it isn't known yet (the key email is still on its way).
  function paid(addr, familyNumber) {
    $('ofCo').style.display = 'none';
    $('ofDiy').style.display = 'none';
    if (familyNumber == null) {
      $('ofDoneTitle').textContent = "You're in! 🎉";
      document.querySelector('.of-next').style.visibility = 'hidden';
      $('ofDoneLine').innerHTML = 'Your key and download link are on their way to <b id="ofEmailDone"></b>.';
    } else {
      fill('of-n', familyNumber);
    }
    $('ofEmailDone').textContent = addr;
    $('ofDone').classList.add('show');
    SITE.play('fanfare', .5);
    const r = $('ofDone').getBoundingClientRect();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      confetti({ particleCount: 140, spread: 80, origin: { x: (r.left + r.width / 2) / innerWidth, y: Math.max(.1, r.top / innerHeight) }, colors: ['#ffd43b', '#37e28c', '#9d6bff', '#eef0ff'] });
  }

  // The real checkout (cards and wallets) is assets/checkout.js: it calls OFFER_UI.paid() and soldOut().

  // Sold out: the bar fills, no spots left, and the note replaces the checkout.
  function soldOut() {
    document.querySelector('.of-card').classList.add('sold');
    $('ofLeft').textContent = 0;
    $('ofBar').style.width = '100%';
  }
  if (SITE.soldOut) soldOut();

  window.OFFER_UI = { paid, soldOut };
})();

// ---- 06 · Footer ----
(() => {
  const $ = (id) => document.getElementById(id);

  // ---- Facts ----
  document.querySelectorAll('.ft-hello').forEach((a) => { a.href = 'mailto:' + SITE.emails.hello; a.textContent = SITE.emails.hello; });
  document.querySelectorAll('.ft-support').forEach((a) => { a.href = 'mailto:' + SITE.emails.support; a.textContent = SITE.emails.support; });
  document.querySelectorAll('.ft-diy').forEach((a) => (a.href = SITE.github));
  document.querySelectorAll('.ft-year').forEach((el) => (el.textContent = new Date().getFullYear()));

  $('ftTop').addEventListener('click', () => { SITE.play('whoosh', .4); window.scrollTo({ top: 0, behavior: 'smooth' }); });


  // ---- Pixel night sky (the hero's, unchanged): square stars that twinkle and drift slowly left ----
  (function sky() {
    const cv = $('ftSky'), ctx = cv.getContext('2d'), area = cv.parentElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const COLOURS = ['#eef0ff', '#eef0ff', '#eef0ff', '#ffd43b', '#9d6bff', '#37e28c'];
    const rand = (a, b) => a + Math.random() * (b - a);
    let w, h, stars, last = performance.now();
    function size() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = area.clientWidth; h = area.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: Math.round((w * h) / 9000) }, () => ({
        x: rand(0, w), y: rand(0, h), size: [1, 2, 2, 3][Math.floor(Math.random() * 4)],
        c: COLOURS[Math.floor(Math.random() * COLOURS.length)], ph: rand(0, 6.3), sp: rand(0.6, 2),
      }));
    }
    function frame(now) {
      const t = now / 1000, dt = Math.min(50, now - last) / 1000;
      last = now;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.x -= s.size * 2.5 * dt; // bigger stars drift faster: a hint of depth
        if (s.x < -4) s.x = w + 4;
        ctx.globalAlpha = 0.15 + 0.45 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
        ctx.fillStyle = s.c;
        ctx.fillRect(Math.round(s.x), Math.round(s.y), s.size, s.size);
      }
      if (!still) requestAnimationFrame(frame);
    }
    size();
    new ResizeObserver(size).observe(area);
    requestAnimationFrame(frame);
  })();
})();

// ---- 07 · Small print ----
(() => {
  // ---- Page fade: links marked data-page fade this page out, then go; the next page fades in ----
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-page]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const url = new URL(a.href);
    try { sessionStorage.setItem('pmp-fade', url.hash.slice(1)); url.hash = ''; } catch {} // no #: the browser won't scroll by itself
    document.body.classList.add('pg-out');
    setTimeout(() => (location.href = url.href), still ? 0 : 200);
  });
  // Arriving through one of those links: jump (not glide) to where it pointed, or the very top, then fade in.
  const root = document.documentElement;
  if (root.classList.contains('pg-in')) {
    const el = root.dataset.pgTo && document.getElementById(root.dataset.pgTo);
    scrollTo({ top: el ? scrollY + el.getBoundingClientRect().top : 0, behavior: 'instant' });
    root.classList.add('pg-go');
    setTimeout(() => root.classList.remove('pg-in', 'pg-go'), 600);
  }
  // Coming back with the browser's Back button can restore the faded-out page: show it again.
  addEventListener('pageshow', (e) => { if (e.persisted) document.body.classList.remove('pg-out'); });
})();
