(() => {
  const $ = (id) => document.getElementById(id);
  $('lpYear').textContent = new Date().getFullYear();

  // ---- Which view: Windows desktops get the download; phones, tablets and Macs get "open this there" ----
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
  const mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|Mobile/i.test(ua);
  const windows = !mobile && (platform === 'Windows' || /Windows NT/.test(ua));
  const show = (id) => { for (const v of ['dlWin', 'dlExe', 'dlOther']) $(v).hidden = v !== id; };
  show(windows ? 'dlWin' : 'dlOther');
  document.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { SITE.play('whoosh', .3); show(b.dataset.show); }));

  $('dlGet').addEventListener('click', () => SITE.play('coin', .5));
  $('dlGetExe').addEventListener('click', () => SITE.play('coin', .5));
  $('dlCopy').addEventListener('click', () => {
    const done = () => { SITE.play('pop', .35); SITE.toast('Link copied. Open it on the family computer.'); };
    navigator.clipboard.writeText('https://pocketmoneypal.com/download').then(done, () => {
      const r = document.createRange(); r.selectNodeContents($('dlAddr'));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
  });

  // ---- Pixel night sky behind the page (legal.html's, sized to the window instead of the nav) ----
  (function sky() {
    const cv = $('lpSky'), ctx = cv.getContext('2d'), area = document.documentElement;
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
    addEventListener('resize', size);
    requestAnimationFrame(frame);
  })();

  // ---- Page fade (legal.html's): links marked data-page fade out, the next page fades in ----
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-page]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const url = new URL(a.href);
    try { sessionStorage.setItem('pmp-fade', url.hash.slice(1)); url.hash = ''; } catch {}
    document.body.classList.add('pg-out');
    setTimeout(() => (location.href = url.href), still ? 0 : 200);
  });
  const root = document.documentElement;
  if (root.classList.contains('pg-in')) {
    const el = root.dataset.pgTo && document.getElementById(root.dataset.pgTo);
    scrollTo({ top: el ? scrollY + el.getBoundingClientRect().top : 0, behavior: 'instant' });
    root.classList.add('pg-go');
    setTimeout(() => root.classList.remove('pg-in', 'pg-go'), 600);
  }
  addEventListener('pageshow', (e) => { if (e.persisted) document.body.classList.remove('pg-out'); });
})();
