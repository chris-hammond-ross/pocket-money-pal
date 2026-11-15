// The FAQ page's script (faq.html). The cards, search and group chips are 08-faq/c's script unchanged;
// the year, page fade and pixel night sky are legal.html's. Needs faq-content.js (FAQ, FAQ_TEXT) first.
(() => {
  document.getElementById('lpYear').textContent = new Date().getFullYear();
})();

// ---- FAQ C "Everything on show": every answer as a card; a search box and group chips narrow them ----
(() => {
  const grid = document.getElementById('fqGrid');
  const tabs = document.getElementById('fqTabs');
  const q = document.getElementById('fqQ');
  const none = document.getElementById('fqNone');
  const cards = [];
  let group = 'All';

  for (const g of FAQ) for (const it of g.items) {
    const c = document.createElement('article');
    c.className = 'fq-card' + (it.proposal ? ' proposal' : '');
    c.innerHTML = `<span class="fq-tag">${g.group}</span><h3></h3><p></p>`;
    grid.append(c);
    cards.push({ el: c, g: g.group, it, h: c.querySelector('h3'), p: c.querySelector('p') });
  }

  for (const name of ['All', ...FAQ.map((g) => g.group)]) {
    const b = document.createElement('button');
    b.className = 'fq-tab';
    b.textContent = name;
    b.setAttribute('aria-pressed', String(name === group));
    b.addEventListener('click', () => {
      group = name;
      tabs.querySelectorAll('.fq-tab').forEach((t) => t.setAttribute('aria-pressed', String(t === b)));
      render();
    });
    tabs.append(b);
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Highlight in text only, never inside tags.
  const mark = (html, words) => {
    if (!words.length) return html;
    const re = new RegExp(`(${words.map(esc).join('|')})`, 'gi');
    return html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(re, '<mark>$1</mark>'))).join('');
  };

  function render() {
    const words = q.value.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    let shown = 0;
    for (const c of cards) {
      const hay = (c.it.q + ' ' + c.it.a + ' ' + c.it.tags).toLowerCase();
      const ok = (group === 'All' || c.g === group) && words.every((w) => hay.includes(w));
      c.el.hidden = !ok;
      if (ok) shown++;
      c.h.innerHTML = mark(c.it.q, words);
      c.p.innerHTML = mark(FAQ_TEXT(c.it.a), words);
    }
    none.hidden = shown > 0;
  }
  q.addEventListener('input', render);
  render();
})();

// ---- Page fade (legal.html's): links marked data-page fade this page out, then go; the next page fades in ----
(() => {
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

// ---- Pixel night sky (the hero's, unchanged): square stars that twinkle and drift slowly left ----
(function sky() {
  const cv = document.getElementById('lpSky'), ctx = cv.getContext('2d'), area = cv.parentElement;
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
      s.x -= s.size * 2.5 * dt;
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
