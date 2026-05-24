/**
 * Deal Runner — a tiny canvas mini-game embedded in the Warpzone AI hero.
 *
 * Concept: the player moves a small "scout" with the mouse (or touch) inside
 * the canvas. Good "deal" chips (AI-native, UGC, Retention, ...) score points,
 * bad "red-flag" chips (Hype, No Moat, Burn, ...) deduct points and flash the
 * screen. When the pointer leaves the canvas the game pauses and falls back to
 * a slow, ambient idle animation so the panel never feels static.
 *
 * Built with vanilla JS + a single HTML5 canvas. No external libraries, no
 * external assets. Drawing uses simple geometric shapes and text labels.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('deal-runner');
  if (!canvas) return;

  const wrap = document.getElementById('game-wrap');
  const scoreEl = document.getElementById('game-score');
  const bestEl = document.getElementById('game-best');
  const hintEl = document.getElementById('game-hint');
  const ctx = canvas.getContext('2d', { alpha: false });

  // Bail out gracefully if 2D rendering isn't supported.
  if (!ctx) return;

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------

  const GOOD_LABELS = ['AI-native', 'UGC', 'Retention', 'Game Loop', 'Distribution', 'ARR'];
  const BAD_LABELS  = ['Hype', 'No Moat', 'Thin Wrapper', 'High CAC', 'Burn'];

  // Spawn pacing (ms). We add a small jitter to feel less mechanical.
  const SPAWN_BASE_MS = 950;
  const SPAWN_JITTER_MS = 600;

  // Item movement speed in CSS pixels per second.
  const SPEED_MIN = 70;
  const SPEED_MAX = 140;

  // Avatar appearance + movement.
  const AVATAR_RADIUS = 13;        // CSS px
  const AVATAR_FOLLOW = 0.18;       // 0 = no follow, 1 = instant snap

  // Score balance.
  const SCORE_GOOD = 10;
  const SCORE_BAD  = -5;

  // Persisted best score key.
  const BEST_KEY = 'wz_deal_runner_best';

  // Detect touch-first devices so we can show a touch-specific hint.
  const isTouchDevice = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  // On very small screens we drop into pure-ambient mode (no scoring) so the
  // hero panel stays decorative without competing with content for attention.
  const isAmbientOnly = isTouchDevice && window.innerWidth < 520;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  let dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  let cssW = 0;   // logical (CSS px) width
  let cssH = 0;   // logical (CSS px) height

  /** Items currently alive on screen. */
  const items = [];

  /** Soft particle trail behind the avatar. */
  const trail = [];

  let lastSpawn = 0;
  let nextSpawnIn = SPAWN_BASE_MS;
  let lastFrame = performance.now();

  // Pointer state. `active` is true only while the pointer/touch is inside.
  let active = false;
  const pointer = { x: 0, y: 0 };
  const avatar = { x: 0, y: 0, glow: 0, idleT: Math.random() * 1000 };

  let score = 0;
  let best = 0;
  try {
    const stored = parseInt(localStorage.getItem(BEST_KEY), 10);
    if (!Number.isNaN(stored) && stored >= 0) best = stored;
  } catch (_) { /* localStorage may be unavailable in private mode */ }
  if (bestEl) bestEl.textContent = String(best);

  // Visual effects.
  let flashAlpha = 0;        // red flash on bad-hit, fades out
  let shake = 0;             // remaining shake intensity (px), decays
  let goodPop = 0;           // brief positive overlay on good-hit, fades

  // Decorative starfield in the background.
  const stars = [];

  // ------------------------------------------------------------------
  // Resizing — keep canvas sharp on HiDPI screens and responsive to the
  // wrapper. We use ResizeObserver so we react to both window resizes and
  // any layout-driven changes (e.g. nav becoming sticky on scroll).
  // ------------------------------------------------------------------

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    // Map drawing operations to CSS pixels so the rest of the code can
    // reason in logical units.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Place avatar at center on first sizing.
    if (!avatar._init) {
      avatar.x = cssW * 0.5;
      avatar.y = cssH * 0.5;
      pointer.x = avatar.x;
      pointer.y = avatar.y;
      avatar._init = true;
    }

    rebuildStars();
  }

  function rebuildStars() {
    stars.length = 0;
    const count = Math.round((cssW * cssH) / 9000); // density tuned by area
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * cssW,
        y: Math.random() * cssH,
        r: Math.random() * 1.1 + 0.2,
        a: Math.random() * 0.5 + 0.15,
        twT: Math.random() * Math.PI * 2,
      });
    }
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(wrap || canvas);
  } else {
    window.addEventListener('resize', resize);
  }
  resize();

  // ------------------------------------------------------------------
  // Pointer / touch input
  // ------------------------------------------------------------------

  function updatePointerFromEvent(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = Math.max(0, Math.min(cssW, clientX - rect.left));
    pointer.y = Math.max(0, Math.min(cssH, clientY - rect.top));
  }

  function setActive(on) {
    if (active === on) return;
    active = on;
    if (wrap) wrap.classList.toggle('is-active', on);
  }

  // Mouse: hover-driven gameplay on desktop.
  canvas.addEventListener('mouseenter', e => {
    if (isAmbientOnly) return;
    updatePointerFromEvent(e.clientX, e.clientY);
    setActive(true);
  });
  canvas.addEventListener('mousemove', e => {
    if (isAmbientOnly) return;
    updatePointerFromEvent(e.clientX, e.clientY);
    setActive(true);
  });
  canvas.addEventListener('mouseleave', () => setActive(false));

  // Touch: hold + drag to play. Releasing ends the round.
  canvas.addEventListener('touchstart', e => {
    if (isAmbientOnly) return;
    const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    updatePointerFromEvent(t.clientX, t.clientY);
    setActive(true);
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    if (isAmbientOnly) return;
    const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    updatePointerFromEvent(t.clientX, t.clientY);
  }, { passive: false });
  canvas.addEventListener('touchend', () => setActive(false));
  canvas.addEventListener('touchcancel', () => setActive(false));

  // Pause when the tab is hidden so we don't burn cycles in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setActive(false);
  });

  // Show the touch-specific hint if we detected a touch device.
  if (hintEl && isTouchDevice && !isAmbientOnly) {
    const dict = (window.WZ_I18N && window.WZ_I18N[document.documentElement.lang]) || {};
    if (dict['game.hint.touch']) {
      hintEl.textContent = dict['game.hint.touch'];
      hintEl.setAttribute('data-i18n', 'game.hint.touch');
    }
  }

  // ------------------------------------------------------------------
  // Items — "deal" chips and "red-flag" chips that drift across the canvas
  // ------------------------------------------------------------------

  function spawnItem() {
    const isGood = Math.random() < 0.6; // a touch more good than bad
    const labels = isGood ? GOOD_LABELS : BAD_LABELS;
    const label = labels[(Math.random() * labels.length) | 0];

    // Measure label so the chip can size itself naturally.
    ctx.font = '600 12px var(--font-body), system-ui, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const padX = 14;
    const padY = 7;
    const w = Math.ceil(textWidth + padX * 2 + 14); // +14 for the leading dot
    const h = 28;

    // Pick a side to enter from. Most items come from the right; a few drift
    // diagonally from the top so the field feels less linear.
    const fromRight = Math.random() < 0.78;
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);

    let x, y, vx, vy;
    if (fromRight) {
      x = cssW + w;
      y = 30 + Math.random() * Math.max(1, cssH - 60);
      vx = -speed;
      vy = (Math.random() - 0.5) * 18;
    } else {
      x = Math.random() * cssW;
      y = -h;
      vx = (Math.random() - 0.5) * 30;
      vy = speed * 0.85;
    }

    items.push({ x, y, w, h, vx, vy, label, good: isGood, alpha: 0, life: 0 });
  }

  function aabbCircle(item, cx, cy, r) {
    // Closest point on the item's bounding box to the avatar center.
    const closestX = Math.max(item.x - item.w / 2, Math.min(cx, item.x + item.w / 2));
    const closestY = Math.max(item.y - item.h / 2, Math.min(cy, item.y + item.h / 2));
    const dx = cx - closestX;
    const dy = cy - closestY;
    return (dx * dx + dy * dy) <= r * r;
  }

  // ------------------------------------------------------------------
  // Update + draw
  // ------------------------------------------------------------------

  function update(dt, now) {
    // Avatar follows pointer with smoothing; while paused it gently bobs.
    // idleT is tracked in milliseconds so the constants below behave as
    // gentle sub-Hz oscillations (period ≈ 5–8s for the bobbing,
    // ≈0.5s for the active-state pulse).
    avatar.idleT += dt * 1000;
    if (active) {
      avatar.x += (pointer.x - avatar.x) * AVATAR_FOLLOW;
      avatar.y += (pointer.y - avatar.y) * AVATAR_FOLLOW;
      avatar.glow = Math.min(1, avatar.glow + dt * 4);
    } else {
      const cx = cssW * 0.5;
      const cy = cssH * 0.5;
      const idleX = cx + Math.sin(avatar.idleT * 0.0008) * cssW * 0.05;
      const idleY = cy + Math.cos(avatar.idleT * 0.0011) * cssH * 0.04;
      avatar.x += (idleX - avatar.x) * 0.04;
      avatar.y += (idleY - avatar.y) * 0.04;
      avatar.glow = Math.max(0.35, avatar.glow - dt * 1.2);
    }

    // Trail: drop a small particle each frame the player is active.
    if (active && trail.length < 24) {
      trail.push({ x: avatar.x, y: avatar.y, life: 1 });
    }
    for (let i = trail.length - 1; i >= 0; i--) {
      trail[i].life -= dt * 1.4;
      if (trail[i].life <= 0) trail.splice(i, 1);
    }

    // Spawning. Idle mode spawns much more slowly.
    const spawnRate = active ? 1 : 0.35;
    lastSpawn += dt * 1000 * spawnRate;
    if (lastSpawn >= nextSpawnIn) {
      lastSpawn = 0;
      nextSpawnIn = SPAWN_BASE_MS + Math.random() * SPAWN_JITTER_MS;
      spawnItem();
    }

    // Move items + handle collisions.
    const speedScale = active ? 1 : 0.45; // slow drift while paused
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.x += it.vx * dt * speedScale;
      it.y += it.vy * dt * speedScale;
      it.life += dt;
      it.alpha = Math.min(1, it.alpha + dt * 4);

      // Collision only when the player is actively engaged.
      if (active && aabbCircle(it, avatar.x, avatar.y, AVATAR_RADIUS + 4)) {
        if (it.good) {
          score += SCORE_GOOD;
          goodPop = 1;
        } else {
          score = Math.max(0, score + SCORE_BAD);
          flashAlpha = 1;
          shake = 6;
        }
        if (scoreEl) {
          scoreEl.textContent = String(score);
          scoreEl.classList.remove('bump');
          // force reflow so the animation can replay
          // eslint-disable-next-line no-unused-expressions
          scoreEl.offsetWidth;
          scoreEl.classList.add('bump');
        }
        if (score > best) {
          best = score;
          if (bestEl) bestEl.textContent = String(best);
          try { localStorage.setItem(BEST_KEY, String(best)); } catch (_) {}
        }
        items.splice(i, 1);
        continue;
      }

      // Despawn off-screen with a small margin.
      if (it.x < -it.w - 20 || it.x > cssW + it.w + 20 ||
          it.y < -it.h - 20 || it.y > cssH + it.h + 20) {
        items.splice(i, 1);
      }
    }

    // Decay visual effects.
    flashAlpha = Math.max(0, flashAlpha - dt * 2.4);
    goodPop = Math.max(0, goodPop - dt * 2.0);
    shake = Math.max(0, shake - dt * 18);

    // Twinkle starfield.
    for (let i = 0; i < stars.length; i++) {
      stars[i].twT += dt * 1.4;
    }
  }

  function drawBackground() {
    // Solid base — radial gradient mimicking a soft display vignette.
    const grad = ctx.createRadialGradient(cssW * 0.15, cssH * 0.1, 0, cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH));
    grad.addColorStop(0, '#0e1530');
    grad.addColorStop(0.55, '#070912');
    grad.addColorStop(1, '#04050b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    // Subtle dot grid for tech feel.
    const step = 28;
    ctx.fillStyle = 'rgba(120, 140, 220, 0.08)';
    for (let x = step / 2; x < cssW; x += step) {
      for (let y = step / 2; y < cssH; y += step) {
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // Twinkly stars.
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const a = s.a * (0.5 + 0.5 * Math.sin(s.twT));
      ctx.fillStyle = `rgba(180, 195, 255, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function roundedRect(x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function drawItem(it) {
    const x = it.x - it.w / 2;
    const y = it.y - it.h / 2;
    const a = it.alpha * (active ? 1 : 0.7);

    ctx.save();
    ctx.globalAlpha = a;

    // Background pill.
    if (it.good) {
      const g = ctx.createLinearGradient(x, y, x + it.w, y + it.h);
      g.addColorStop(0, 'rgba(59, 130, 246, 0.28)');
      g.addColorStop(0.5, 'rgba(139, 92, 246, 0.32)');
      g.addColorStop(1, 'rgba(6, 182, 212, 0.28)');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = 'rgba(255, 90, 110, 0.18)';
    }
    roundedRect(x, y, it.w, it.h, it.h / 2);
    ctx.fill();

    // Border.
    ctx.lineWidth = 1;
    ctx.strokeStyle = it.good
      ? 'rgba(160, 180, 255, 0.55)'
      : 'rgba(255, 130, 150, 0.5)';
    ctx.stroke();

    // Leading status dot.
    const dotX = x + 12;
    const dotY = y + it.h / 2;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = it.good ? '#7dd3fc' : '#fb7185';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label.
    ctx.font = '600 12px "Instrument Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = it.good ? '#f5f7ff' : 'rgba(255, 220, 225, 0.95)';
    ctx.fillText(it.label, dotX + 9, dotY + 0.5);

    ctx.restore();
  }

  function drawTrail() {
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const a = Math.max(0, t.life) * 0.35;
      ctx.fillStyle = `rgba(140, 180, 255, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, AVATAR_RADIUS * 0.55 * t.life + 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawAvatar() {
    const r = AVATAR_RADIUS;
    // Outer glow (pulsing slightly while active).
    const glow = avatar.glow;
    const pulse = active ? (1 + Math.sin(avatar.idleT * 0.012) * 0.06) : 1;

    ctx.save();
    const grad = ctx.createRadialGradient(avatar.x, avatar.y, 0, avatar.x, avatar.y, r * 4 * pulse);
    grad.addColorStop(0, `rgba(140, 180, 255, ${0.45 * glow})`);
    grad.addColorStop(0.5, `rgba(120, 90, 240, ${0.18 * glow})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(avatar.x, avatar.y, r * 4 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Core disc with conic-style fake gradient (linear is fine here).
    const core = ctx.createLinearGradient(avatar.x - r, avatar.y - r, avatar.x + r, avatar.y + r);
    core.addColorStop(0, '#93c5fd');
    core.addColorStop(0.5, '#a78bfa');
    core.addColorStop(1, '#22d3ee');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(avatar.x, avatar.y, r * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Inner ring + highlight.
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(avatar.x, avatar.y, r * 0.55 * pulse, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(avatar.x - r * 0.25, avatar.y - r * 0.3, r * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawOverlays() {
    // Bad-hit red flash.
    if (flashAlpha > 0) {
      ctx.fillStyle = `rgba(255, 80, 100, ${(flashAlpha * 0.35).toFixed(3)})`;
      ctx.fillRect(0, 0, cssW, cssH);
    }

    // Good-hit subtle bloom.
    if (goodPop > 0) {
      const g = ctx.createRadialGradient(avatar.x, avatar.y, 0, avatar.x, avatar.y, 90);
      g.addColorStop(0, `rgba(140, 200, 255, ${(goodPop * 0.35).toFixed(3)})`);
      g.addColorStop(1, 'rgba(140, 200, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cssW, cssH);
    }

    // Scanline / vignette to keep the "screen" feel.
    const vg = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35,
                                        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  function frame(now) {
    const rawDt = (now - lastFrame) / 1000;
    // Clamp dt so a tab returning from background doesn't fast-forward the
    // simulation into chaos.
    const dt = Math.min(rawDt, 0.08);
    lastFrame = now;

    update(dt, now);

    // Apply optional screen-shake by translating the canvas.
    const sx = shake ? (Math.random() - 0.5) * shake : 0;
    const sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.save();
    ctx.translate(sx, sy);

    drawBackground();
    drawTrail();
    for (let i = 0; i < items.length; i++) drawItem(items[i]);
    drawAvatar();
    drawOverlays();

    ctx.restore();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
