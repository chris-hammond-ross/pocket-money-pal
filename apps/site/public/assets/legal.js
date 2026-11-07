(() => {
  const $ = (id) => document.getElementById(id);
  $('lpYear').textContent = new Date().getFullYear();
  $('lpMail').href = 'mailto:' + SITE.emails.support;
  $('lpMail').textContent = SITE.emails.support;

  // ---- Render (prototype only: real page would have this as plain HTML) ----
  const fill = (h) => LEGAL.fill(h, 'lp-tbc');

  const tocList = (cls = '') => LEGAL.docs.map((d) => `
    <ol><li><a class="doc" href="#${d.id}" data-to="${d.id}">${d.long}</a></li>
    ${d.sections.map((s) => `<li><a href="#${s.id}" data-to="${s.id}">${s.title}</a></li>`).join('')}</ol>`).join('');
  $('lpToc').innerHTML = `<p class="t">CONTENTS</p>${tocList()}`;
  $('lpMlist').innerHTML = tocList();

  $('lpDocs').innerHTML = LEGAL.docs.map((d) => `
    <article class="lp-doc" id="${d.id}">
      <header>
        <h2>${d.long}</h2>
        <div class="lp-meta"><span>Last updated ${LEGAL.updated}</span></div>
        <p class="lp-intro">${d.intro}</p>
      </header>
      ${d.sections.map((s, i) => `
        <section class="lp-sec" id="${s.id}">
          <h3><span class="n">${String(i + 1).padStart(2, '0')}</span>${s.title}<button class="anchor" data-link="${s.id}" aria-label="Copy a link to this section">🔗 Link</button></h3>
          <div class="lp-words">${fill(s.body)}</div>
          <aside class="lp-plain"><span class="k">IN PLAIN WORDS</span>${fill(s.plain)}</aside>
        </section>`).join('')}
      <div class="lp-tools">
        <button data-print>🖨 Print or save as PDF</button>
        <a href="#top-of-page" data-top>↑ Back to the top</a>
      </div>
    </article>`).join('');

  // ---- Contents: light up the section being read ----
  const tocLinks = [...document.querySelectorAll('[data-to]')];
  const targets = [...document.querySelectorAll('.lp-doc, .lp-sec')];
  const label = Object.fromEntries(LEGAL.docs.flatMap((d) => [[d.id, d.title], ...d.sections.map((s) => [s.id, `${d.title} · ${s.title}`])]));
  function spy() {
    const line = innerHeight * 0.3;
    let cur = targets[0];
    for (const t of targets) if (t.getBoundingClientRect().top <= line) cur = t;
    const id = cur.id, doc = cur.closest('.lp-doc').id;
    tocLinks.forEach((a) => a.classList.toggle('on', a.dataset.to === id || (a.classList.contains('doc') && a.dataset.to === doc)));
    $('lpCur').textContent = label[id];
  }
  addEventListener('scroll', spy, { passive: true });
  spy();
  $('lpMlist').addEventListener('click', (e) => { if (e.target.closest('a')) $('lpMtoc').open = false; });

  // Arriving at (or jumping to) a section flashes its plain-words note.
  function flash() {
    const sec = document.getElementById(location.hash.slice(1));
    if (sec && sec.classList.contains('lp-sec')) { sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash'); }
  }
  addEventListener('hashchange', flash);
  if (location.hash) { const el = document.getElementById(location.hash.slice(1)); if (el) scrollTo({ top: scrollY + el.getBoundingClientRect().top - 20 }); flash(); } // rendered after load, so the browser couldn't jump there itself

  // ---- Tools ----
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-link]');
    if (link) {
      const url = location.href.split('#')[0] + '#' + link.dataset.link;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
        () => { SITE.play('pop', .35); SITE.toast('Link copied: send it to anyone who asks.'); },
        () => SITE.toast(url),
      );
    }
    if (e.target.closest('[data-print]')) window.print();
    if (e.target.closest('[data-top]')) { e.preventDefault(); scrollTo({ top: 0 }); history.replaceState(null, '', location.pathname); }
  });

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

  // ---- Pixel night sky (the hero's, unchanged): square stars that twinkle and drift slowly left ----
  (function sky() {
    const cv = $('lpSky'), ctx = cv.getContext('2d'), area = cv.parentElement;
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
})();
