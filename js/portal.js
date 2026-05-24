/* ============================================================== *
 *  Prototype Portal                                                *
 *  -------------------------------------------------------------- *
 *  A premium, calm warp-portal animation that lives in the final  *
 *  CTA section in place of the static team image. Almost          *
 *  everything visual is CSS — this script only:                   *
 *                                                                 *
 *    1. Spawns the "idea" inflow particles (small label pills     *
 *       drifting from the edges toward the central glow). Each    *
 *       particle is positioned via CSS custom properties; a       *
 *       single shared keyframe handles the actual translation.    *
 *    2. Cycles the tiny microcopy chip under the CTA button       *
 *       through the four forecast-style messages, reading the     *
 *       text from a hidden translatable list so language          *
 *       switching is reflected on the next change.                *
 *    3. Pauses both timers when the section scrolls off-screen    *
 *       and respects prefers-reduced-motion.                      *
 *                                                                 *
 *  No libraries, no canvas, no images.                            *
 * ============================================================== */
(function () {
  'use strict';

  const portal   = document.getElementById('prototype-portal');
  const tickerEl = document.getElementById('portal-ticker-text');
  // Either piece can be missing without the other (the ticker lives in the
  // text column, the portal in the image column), so each is guarded.
  if (!portal && !tickerEl) return;

  const particleLayer = portal && portal.querySelector('#portal-particles');
  const tickerSrc     = tickerEl && tickerEl.parentElement.querySelector('.portal-ticker-data');
  const reduced       = window.matchMedia &&
                        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------
  // Particle field — small "idea" pills that drift inward toward the
  // glowing core. We pre-spawn N particles at random angles/distances/
  // labels/timings; CSS handles the actual translate + fade animation
  // (see @keyframes portalInflow). Particles loop forever, so we never
  // need to add or remove DOM nodes after init.
  // ------------------------------------------------------------------
  const LABELS = [
    'demo', 'deck', 'MVP', 'concept', 'AI loop',
    'UA test', 'GenAI', 'prototype', 'pitch', 'beta',
    'KPI', 'signal', 'studio', 'ping', 'arr',
  ];

  function particleCount() {
    if (reduced) return 5;
    // Modest count on small viewports keeps mobile feeling calm.
    return window.innerWidth < 720 ? 9 : 14;
  }

  function spawnParticles() {
    if (!particleLayer) return;
    particleLayer.innerHTML = '';

    const count = particleCount();
    const rect  = particleLayer.getBoundingClientRect();
    // Reach is the longest distance a particle ever has to travel — we
    // bias it slightly past the visible edge so newly-spawned particles
    // fade in just outside the frame instead of popping in mid-stage.
    const reach = Math.max(140, Math.min(rect.width, rect.height) * 0.55);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = reach * (0.85 + Math.random() * 0.35);
      const sx    = Math.cos(angle) * dist;
      const sy    = Math.sin(angle) * dist;
      const dur   = 4.8 + Math.random() * 4.2;          // 4.8s–9s
      const delay = -Math.random() * dur;               // staggered phase

      const p = document.createElement('span');
      p.className = 'portal-particle';
      p.textContent = LABELS[i % LABELS.length];
      p.style.setProperty('--sx', sx.toFixed(1) + 'px');
      p.style.setProperty('--sy', sy.toFixed(1) + 'px');
      p.style.setProperty('--d',  dur.toFixed(2) + 's');
      p.style.setProperty('--dl', delay.toFixed(2) + 's');
      particleLayer.appendChild(p);
    }
  }

  if (portal) {
    spawnParticles();
    // Re-spawn on resize so the particle reach scales with the panel.
    let resizeJob = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeJob);
      resizeJob = setTimeout(spawnParticles, 250);
    });
  }

  // ------------------------------------------------------------------
  // Microcopy ticker — short status messages that cycle every few
  // seconds. Reads the current translation values from the hidden <li>
  // list every tick, so a language switch is reflected on the next
  // message change without us having to listen for it explicitly.
  // ------------------------------------------------------------------
  function getMessages() {
    if (!tickerSrc) return [];
    return Array.from(tickerSrc.children)
      .map(li => (li.textContent || '').trim())
      .filter(Boolean);
  }

  let idx = 0;
  let job = null;

  function setText(text) {
    if (!tickerEl) return;
    tickerEl.classList.add('is-out');
    setTimeout(() => {
      tickerEl.textContent = text;
      // Force reflow so the next class change re-triggers the transition.
      // eslint-disable-next-line no-unused-expressions
      tickerEl.offsetWidth;
      tickerEl.classList.remove('is-out');
    }, 320);
  }

  function tick() {
    const msgs = getMessages();
    if (!msgs.length) return;
    idx = (idx + 1) % msgs.length;
    setText(msgs[idx]);
  }

  function start() {
    if (job || !tickerEl) return;
    job = setInterval(tick, reduced ? 7000 : 3800);
  }
  function stop() {
    if (job) { clearInterval(job); job = null; }
  }

  // Pause the ticker when the CTA section scrolls out of view.
  const observeTarget = portal || (tickerEl && tickerEl.closest('section'));
  if (observeTarget && window.IntersectionObserver) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) start();
        else stop();
      }
    }, { threshold: 0.12 });
    io.observe(observeTarget);
  } else {
    start();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (observeTarget && observeTarget.getBoundingClientRect().bottom > 0) start();
  });
})();
