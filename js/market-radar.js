/* ============================================================== *
 *  Market Weather Radar                                            *
 *  -------------------------------------------------------------- *
 *  A premium, calm, weather-system inspired animated panel that   *
 *  sits in the For Investors section in place of the static       *
 *  investor image. Almost everything visual lives in the SVG +    *
 *  CSS — this script only:                                        *
 *                                                                 *
 *    1. Cycles the bottom "FORECAST" ticker every few seconds,    *
 *       reading the message list from a hidden translatable <ul>  *
 *       so the ticker stays language-aware after a language       *
 *       switch.                                                   *
 *    2. Rotates a "ping" highlight through the five signal        *
 *       clusters, so the radar feels alive without the user       *
 *       having to interact with it.                               *
 *    3. Pauses both timers when the panel scrolls off-screen and  *
 *       respects prefers-reduced-motion.                          *
 *                                                                 *
 *  No libraries, no canvas, no images.                            *
 * ============================================================== */
(function () {
  'use strict';

  const root = document.getElementById('market-radar');
  if (!root) return;

  const tickerEl  = root.querySelector('#mr-ticker-text');
  const tickerSrc = root.querySelector('.mr-ticker-data');
  const clusters  = Array.from(root.querySelectorAll('.mr-cluster'));
  const reduced   = window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------
  // Forecast ticker
  // ------------------------------------------------------------------
  // Reads the current translation values from the hidden <li> list every
  // tick, so a language switch is reflected on the next message change.
  function getMessages() {
    if (!tickerSrc) return [];
    return Array.from(tickerSrc.children)
      .map(li => (li.textContent || '').trim())
      .filter(Boolean);
  }

  let tickerIdx  = 0;
  let tickerJob  = null;

  function setTickerText(text) {
    if (!tickerEl) return;
    tickerEl.classList.add('is-out');
    // Allow the fade-out CSS transition to play before we swap the text.
    setTimeout(() => {
      tickerEl.textContent = text;
      // Force a reflow so the next class change re-triggers the transition.
      // eslint-disable-next-line no-unused-expressions
      tickerEl.offsetWidth;
      tickerEl.classList.remove('is-out');
    }, 320);
  }

  function tickTicker() {
    const msgs = getMessages();
    if (!msgs.length) return;
    tickerIdx = (tickerIdx + 1) % msgs.length;
    setTickerText(msgs[tickerIdx]);
  }

  // ------------------------------------------------------------------
  // Cluster ping rotation
  // ------------------------------------------------------------------
  // Adds an `is-pinged` class to one cluster at a time. CSS handles the
  // brief glow + scale-up animation; the class is removed automatically
  // when the animation ends so the next ping runs cleanly.
  let clusterIdx = 0;
  let clusterJob = null;

  function pingNextCluster() {
    if (!clusters.length) return;
    const target = clusters[clusterIdx];
    clusterIdx = (clusterIdx + 1) % clusters.length;
    target.classList.remove('is-pinged'); // restart any in-flight animation
    // Force a reflow so re-adding the class immediately retriggers it.
    // eslint-disable-next-line no-unused-expressions
    target.getBoundingClientRect();
    target.classList.add('is-pinged');
  }

  // Auto-clear the class once the CSS animation finishes (fallback in
  // case animationend doesn't fire on a particular browser).
  clusters.forEach(cl => {
    cl.addEventListener('animationend', (e) => {
      if (e.animationName && e.animationName.indexOf('mrClusterPing') !== -1) {
        cl.classList.remove('is-pinged');
      }
    });
  });

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------
  function start() {
    stop();
    // Slightly slower cadence under prefers-reduced-motion.
    tickerJob  = setInterval(tickTicker,    reduced ? 8000 : 4500);
    clusterJob = setInterval(pingNextCluster, reduced ? 4500 : 2200);
  }
  function stop() {
    if (tickerJob)  { clearInterval(tickerJob);  tickerJob  = null; }
    if (clusterJob) { clearInterval(clusterJob); clusterJob = null; }
  }

  // Pause when the panel scrolls out of view to save CPU on long pages.
  if (window.IntersectionObserver) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) start();
        else stop();
      }
    }, { threshold: 0.1 });
    io.observe(root);
  } else {
    start();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (root.getBoundingClientRect().bottom > 0) start();
  });
})();
