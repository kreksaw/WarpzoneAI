/**
 * Warpzone Fund OS — Investor Control Panel.
 *
 * Lightweight, dependency-free component that drives four small visualisations
 * inside the "For Investors" section:
 *
 *   1. Signal Score   — a number that drifts between 86 and 94 with a radial
 *                       arc and 16-bar sparkline.
 *   2. Deal Flow      — DOM tokens travel along a 5-stage pipeline. Bad
 *                       signals (Hype / Thin Wrapper / High CAC) get filtered
 *                       partway through.
 *   3. Capital Deploy — three milestone bars; the fill animation is CSS, this
 *                       file just decides when to start it.
 *   4. DPI Timeline   — a small SVG line chart whose path is built here and
 *                       drawn via stroke-dashoffset on intersection.
 *
 * All animation is gated on IntersectionObserver so it stays cheap when the
 * section is off-screen, and on `prefers-reduced-motion` so users who opt out
 * still get a static, fully-readable dashboard.
 */
(function () {
  'use strict';

  const card = document.getElementById('fund-os');
  if (!card) return;

  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --------------------------------------------------------------------
  // 1. Signal Score
  // --------------------------------------------------------------------
  const scoreEl  = document.getElementById('fund-os-score');
  const arcEl    = document.getElementById('fund-os-arc');
  const sparkEl  = document.getElementById('fund-os-spark');

  // Arc geometry: full circumference for r=26 is 2π·26 ≈ 163.36.
  // We render a 70%-arc to keep the gauge visually anchored at the bottom.
  const ARC_FULL = 163.36;
  const ARC_VISIBLE_FRACTION = 0.7;

  // Build a 16-bar sparkline.
  const SPARK_BARS = 16;
  const sparkBars = [];
  const sparkHistory = [];
  for (let i = 0; i < SPARK_BARS; i++) {
    const bar = document.createElement('span');
    sparkEl.appendChild(bar);
    sparkBars.push(bar);
    sparkHistory.push(0.4 + Math.random() * 0.4);
  }
  applySparks();

  function applySparks() {
    for (let i = 0; i < sparkBars.length; i++) {
      const v = Math.max(0.18, Math.min(1, sparkHistory[i]));
      sparkBars[i].style.transform = `scaleY(${v.toFixed(3)})`;
    }
  }

  let currentScore = 90;

  function setScore(v) {
    currentScore = v;
    if (scoreEl) scoreEl.textContent = String(Math.round(v));
    // Map score (86..94) → arc fraction (0..ARC_VISIBLE_FRACTION).
    const t = Math.max(0, Math.min(1, (v - 86) / 8));
    const visible = ARC_VISIBLE_FRACTION * (0.55 + t * 0.45);
    if (arcEl) arcEl.style.strokeDashoffset = String(ARC_FULL * (1 - visible));
  }

  /**
   * Easing tween from currentScore → a fresh target in [86, 94]. We also
   * shift the sparkline by one slot so it visibly "lives" alongside the
   * number. No setInterval inside — the scheduler is a single rAF loop set
   * up by `startSchedulers`.
   */
  function scoreTick() {
    const target = 86 + Math.random() * 8;
    if (reduceMotion) {
      setScore(target);
      sparkHistory.shift();
      sparkHistory.push(0.45 + (target - 86) / 8 * 0.5);
      applySparks();
      return;
    }
    const start = currentScore;
    const startTs = performance.now();
    const dur = 900;
    function step(ts) {
      const k = Math.min(1, (ts - startTs) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setScore(start + (target - start) * eased);
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    sparkHistory.shift();
    // Newly arrived data point reflects the target value plus a touch of noise.
    sparkHistory.push(0.45 + (target - 86) / 8 * 0.5 + (Math.random() - 0.5) * 0.18);
    applySparks();
  }

  // --------------------------------------------------------------------
  // 2. Deal Flow pipeline
  // --------------------------------------------------------------------
  const track = document.getElementById('fund-os-track');

  const GOOD = ['Studio', 'UGC', 'Retention', 'Distribution', 'ARR'];
  const BAD  = ['Hype', 'Thin Wrapper', 'High CAC'];

  /**
   * Spawn one token. Good signals travel the full length of the rail;
   * bad signals make it ~25% in, then get rejected (drop + fade).
   * Idempotent and self-cleaning: each token removes itself from the DOM
   * after its lifetime ends.
   */
  function spawnToken(opts) {
    if (reduceMotion || !track) return;
    const isBad = !!(opts && opts.bad);
    const labels = isBad ? BAD : GOOD;
    const label = labels[(Math.random() * labels.length) | 0];

    const wrap = document.createElement('div');
    wrap.className = 'fund-os-token-wrap';
    const t = document.createElement('div');
    t.className = 'fund-os-token' + (isBad ? ' is-bad' : '');
    t.textContent = label;
    wrap.appendChild(t);
    wrap.style.left = '-12%';
    track.appendChild(wrap);

    // Hover speeds the conveyor up — this matches the user expectation that
    // hover = "more activity" without changing the layout.
    const hover = card.classList.contains('is-hover');
    const goodDuration = (hover ? 2200 : 3200);
    const badDuration  = (hover ? 1400 : 2000);
    const duration = isBad ? badDuration : goodDuration;

    // Slight vertical offset so multiple in-flight tokens don't overlap
    // exactly on the rail.
    const yJitter = (Math.random() - 0.5) * 6;
    wrap.style.transform = `translateY(calc(-50% + ${yJitter.toFixed(1)}px))`;

    // Two animation frames to ensure the starting state is committed before
    // we kick off the transition (otherwise some browsers collapse it).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrap.classList.add('is-visible');
        wrap.style.transition = `left ${duration}ms linear`;
        wrap.style.left = isBad ? '28%' : '108%';
      });
    });

    if (isBad) {
      // Reject mid-pipeline: drop down and fade.
      setTimeout(() => {
        t.classList.add('is-rejected');
      }, duration * 0.55);
    }

    setTimeout(() => {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }, duration + 900);
  }

  // --------------------------------------------------------------------
  // 4. DPI Timeline chart
  // --------------------------------------------------------------------
  // SVG viewBox is 0..300 wide × 0..80 tall. Lower y = higher DPI. We pin
  // 4 "narrative" anchor points (Entry, Launch, Cashflow, DPI) plus two
  // extra control points so the smoothed curve has natural endpoints.
  const linePath = document.getElementById('fund-os-line-path');
  const areaPath = document.getElementById('fund-os-area-path');
  const dot      = document.getElementById('fund-os-dot');

  const points = [
    [   0, 70],
    [  60, 60],   // Entry  (~x=0)
    [ 130, 56],   // Launch (~x=100)
    [ 200, 38],   // Cashflow (~x=200)
    [ 280, 18],   // DPI    (~x=300)
    [ 300, 14],
  ];

  /** Smooth a sequence of points into a Bezier path using Catmull-Rom. */
  function catmullRom(pts) {
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  }

  if (linePath && areaPath && dot) {
    const lineD = catmullRom(points);
    linePath.setAttribute('d', lineD);
    areaPath.setAttribute('d', lineD + ' L 300 80 L 0 80 Z');
    // getTotalLength gives us the precise dasharray to use for the draw-on
    // animation. Falls back to 600 in environments where it's not available.
    let len = 600;
    try { len = linePath.getTotalLength() || 600; } catch (_) { /* no-op */ }
    linePath.style.strokeDasharray  = String(len);
    linePath.style.strokeDashoffset = String(len);
    // Anchor the pulsing dot to the last "real" point (DPI at index 4).
    dot.setAttribute('cx', String(points[4][0]));
    dot.setAttribute('cy', String(points[4][1]));
  }

  // --------------------------------------------------------------------
  // Schedulers — all timing flows through a single rAF loop so we can
  // throttle/pause cheaply and avoid overlapping setInterval handlers.
  // --------------------------------------------------------------------
  let running = false;
  let lastScoreT = 0;
  let lastDealT  = 0;
  let dealCount  = 0;

  function loop(now) {
    if (!running) return;

    const hover = card.classList.contains('is-hover');

    // Score tick: every 2.2s idle, 1.3s on hover.
    const scoreEvery = hover ? 1300 : 2200;
    if (now - lastScoreT >= scoreEvery) {
      lastScoreT = now;
      scoreTick();
    }

    // Deal flow tick: every 1.4s idle, 0.9s on hover.
    const dealEvery = hover ? 900 : 1400;
    if (now - lastDealT >= dealEvery) {
      lastDealT = now;
      // ~30% of tokens are bad signals (filtered out).
      spawnToken({ bad: Math.random() < 0.3 });
      dealCount++;
    }

    requestAnimationFrame(loop);
  }

  function startSchedulers() {
    if (running) return;
    running = true;
    // Stagger the first ticks so the panel comes alive smoothly.
    lastScoreT = performance.now() - 1800;
    lastDealT  = performance.now() - 1100;
    requestAnimationFrame(loop);
  }

  function stopSchedulers() {
    running = false;
  }

  // --------------------------------------------------------------------
  // Activate when the panel becomes visible. We unobserve once started so
  // re-scrolling past it doesn't restart animations.
  // --------------------------------------------------------------------
  function activate() {
    card.classList.add('is-active');
    // Two rAFs: first to commit `is-active` (which triggers bar animations),
    // second to add `is-drawn` so the chart line draws on top.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => card.classList.add('is-drawn'));
    });
    if (!reduceMotion) startSchedulers();
    else {
      // For reduced-motion users we still want the values to be meaningful.
      setScore(90);
    }
  }

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          activate();
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });
    io.observe(card);
  } else {
    activate();
  }

  // --------------------------------------------------------------------
  // Hover interaction — speeds up score + deal flow, brightens the line.
  // CSS handles the visual glow; here we just toggle a class so the loop
  // picks up the new cadences.
  // --------------------------------------------------------------------
  card.addEventListener('mouseenter', () => card.classList.add('is-hover'));
  card.addEventListener('mouseleave', () => card.classList.remove('is-hover'));

  // Pause when the tab is hidden — saves battery on long tabs.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopSchedulers();
    } else if (card.classList.contains('is-active') && !reduceMotion) {
      startSchedulers();
    }
  });
})();
