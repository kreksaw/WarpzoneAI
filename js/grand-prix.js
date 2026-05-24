/**
 * Warpzone Grand Prix — automatic top-down arcade racing scene.
 *
 * A self-contained canvas animation that loops four small race cars around
 * a closed circuit. The user does not control anything; the goal is purely
 * decorative — make the "For Studios" panel feel alive with a premium,
 * 80s/90s arcade-flavoured racing scene (Super Sprint / Micro Machines).
 *
 * Architecture:
 *   - One main <canvas> rendered with a single requestAnimationFrame loop.
 *   - Two offscreen canvases:
 *       bgCanvas   — the static track (asphalt, kerbs, lane lines,
 *                    start/finish, decorations) baked once on resize.
 *       skidCanvas — accumulating tyre-skid layer that fades over time.
 *   - Track shape is a smoothed superellipse, arc-length resampled so cars
 *     travel at uniform speed regardless of curvature.
 *   - Cars are drawn from canvas primitives only — no external assets.
 *
 * Performance:
 *   - Heavy work (track build, kerbs) runs only on resize.
 *   - The hot loop only does cheap arithmetic + a handful of drawImage / fill
 *     calls per car. Easily holds 60 fps on modest hardware.
 *   - Pauses entirely when the section is off-screen or the tab is hidden.
 *
 * Accessibility:
 *   - prefers-reduced-motion → cars freeze in their starting positions and
 *     the static track is still rendered.
 *   - The wrapper has role="img" with a descriptive aria-label.
 */
(function () {
  'use strict';

  const wrap = document.getElementById('grand-prix-wrap');
  const canvas = document.getElementById('grand-prix');
  if (!wrap || !canvas) return;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const lapEl = document.getElementById('gp-lap-val');
  const leaderEl = document.getElementById('gp-leaderboard');

  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------

  /** 4 cars with neon arcade liveries. */
  const CAR_DEFS = [
    { name: 'WZ-01', primary: '#22d3ee', light: '#67e8f9', dark: '#0e7490' },
    { name: 'WZ-02', primary: '#f472b6', light: '#fbcfe8', dark: '#9d174d' },
    { name: 'WZ-03', primary: '#fbbf24', light: '#fde68a', dark: '#92400e' },
    { name: 'WZ-04', primary: '#34d399', light: '#a7f3d0', dark: '#065f46' },
  ];

  // Car dimensions in CSS pixels (drawn at this size regardless of canvas size).
  // F1-style cars are longer than they are wide; we draw the silhouette below.
  // Tuned to read clearly inside a single bento cell (~360×280 CSS px).
  const CAR_LENGTH = 30;
  const CAR_WIDTH  = 17;

  // Track lane geometry. Cars sit in 4 lanes at ±0.5·LW and ±1.5·LW from the
  // centerline; the asphalt is wide enough to let two cars run side-by-side
  // without their wheels colliding.
  const LANE_WIDTH   = 18;
  const N_LANES      = 4;
  const TRACK_WIDTH  = LANE_WIDTH * N_LANES + 12; // total asphalt width
  const KERB_WIDTH   = 7;                         // red/white kerb on each side

  // Number of resampled track samples — smoother = more, slower = more.
  // 600 is well within budget; cars use linear interpolation between samples.
  const TRACK_SAMPLES = 600;

  // Speed (track-units, i.e. CSS pixels along the path, per second).
  // Lower than the original wide-arena speed because the track perimeter
  // shrinks ~40% when we move into a single bento cell — same lap pacing.
  const BASE_SPEED       = 68;
  const SPEED_VARIANCE   = 13;
  const HOVER_MULT       = 1.35;
  const BOOST_MULT       = 1.7;
  const BOOST_DURATION   = 1.4; // seconds
  const BOOST_INTERVAL   = 4.5; // seconds between checks

  // Skid layer fade: smaller = longer-lived skids.
  const SKID_FADE_BASE = 0.012;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  let dpr  = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  let cssW = 0, cssH = 0;

  let bgCanvas = null, bgCtx = null;       // baked static track
  let skidCanvas = null, skidCtx = null;   // accumulating skids
  let trackSamples = [];                   // [[x,y], ...] uniformly spaced
  let trackPerimeter = 0;                  // total length in CSS px
  let startSampleIdx = 0;                  // where the start/finish line sits

  const cars = [];
  let lastFrame = performance.now();
  let active = false;          // visible in viewport
  let hover  = false;          // mouse over the panel
  let lapCounter = 1;          // shown in HUD
  let lastLeaderLap = 0;

  // ------------------------------------------------------------------
  // Tiny helpers
  // ------------------------------------------------------------------

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** Rounded rectangle path (no fill/stroke — caller decides). */
  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.lineTo(x + w - rr, y);
    c.quadraticCurveTo(x + w, y, x + w, y + rr);
    c.lineTo(x + w, y + h - rr);
    c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    c.lineTo(x + rr, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - rr);
    c.lineTo(x, y + rr);
    c.quadraticCurveTo(x, y, x + rr, y);
    c.closePath();
  }

  // ------------------------------------------------------------------
  // Track building
  // ------------------------------------------------------------------

  /**
   * Hand-crafted closed-loop centerline inspired by classic top-down arcade
   * tracks (Super Sprint / Micro Machines). Defined as a small set of
   * normalized [0..1] waypoints that wrap around an internal "island", then
   * smoothed with a Catmull-Rom spline and arc-length resampled so cars
   * travel at uniform speed regardless of curvature.
   *
   *      ┌──────────────── top straight ────────────────┐
   *      │                                              │
   *      │                                          right
   *   left                                          turn
   *      │                                              │
   *      └─────chicane out─────┐         ┌──────────────┘
   *                            └─chicane┘
   *
   * Waypoint count is intentionally generous (~18) so the spline tension
   * stays gentle — we don't want kinks that would throw the lane offsets
   * off the asphalt at sharp corners.
   */
  const TRACK_WAYPOINTS_NORM = [
    [0.10, 0.22],   // 0  upper-left corner entry
    [0.20, 0.16],   // 1  top-left straight start
    [0.40, 0.13],   // 2
    [0.58, 0.13],   // 3  middle of long top straight
    [0.74, 0.15],   // 4
    [0.86, 0.20],   // 5  top-right corner entry
    [0.93, 0.32],   // 6  right-side sweeper
    [0.94, 0.50],   // 7  right straight middle
    [0.91, 0.66],   // 8
    [0.84, 0.78],   // 9  bottom-right corner
    [0.72, 0.84],   // 10 entering bottom straight
    [0.60, 0.85],   // 11 chicane approach
    [0.50, 0.74],   // 12 chicane apex (kinks inward)
    [0.40, 0.85],   // 13 chicane exit
    [0.26, 0.86],   // 14 bottom-left straight
    [0.14, 0.82],   // 15 bottom-left corner
    [0.06, 0.68],   // 16 left straight start
    [0.05, 0.48],   // 17 left straight middle
    [0.07, 0.32],   // 18 upper-left corner approach
  ];

  /** Catmull-Rom spline through a closed loop of waypoints. */
  function catmullRomClosed(waypoints, samplesPerSegment) {
    const n = waypoints.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = waypoints[(i - 1 + n) % n];
      const p1 = waypoints[i];
      const p2 = waypoints[(i + 1) % n];
      const p3 = waypoints[(i + 2) % n];
      for (let j = 0; j < samplesPerSegment; j++) {
        const t = j / samplesPerSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        // Standard centripetal-ish Catmull-Rom formula.
        const x = 0.5 * (
          (2 * p1[0]) +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
        );
        const y = 0.5 * (
          (2 * p1[1]) +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
        );
        out.push([x, y]);
      }
    }
    return out;
  }

  function buildTrackCenterline(w, h) {
    // Convert normalized waypoints to canvas pixels.
    const wp = TRACK_WAYPOINTS_NORM.map(([nx, ny]) => [nx * w, ny * h]);
    // Smooth into a dense polyline, then uniformly resample by arc length.
    const dense = catmullRomClosed(wp, 24);
    return arcLengthResample(dense, TRACK_SAMPLES);
  }

  /**
   * Take a closed polyline and resample it so the new points are uniformly
   * spaced along its arc length. Returns { samples, perimeter }.
   */
  function arcLengthResample(points, count) {
    const n = points.length;
    const accum = new Float32Array(n + 1);
    for (let i = 1; i < n; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      accum[i] = accum[i - 1] + Math.hypot(dx, dy);
    }
    // Wrap-around segment to close the loop.
    const wdx = points[0][0] - points[n - 1][0];
    const wdy = points[0][1] - points[n - 1][1];
    accum[n] = accum[n - 1] + Math.hypot(wdx, wdy);

    const total = accum[n];
    const out = new Array(count);
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      const target = (i / count) * total;
      while (cursor < n && accum[cursor + 1] < target) cursor++;
      const segStart = accum[cursor];
      const segEnd   = accum[cursor + 1];
      const segLen   = segEnd - segStart;
      const t = segLen > 0 ? (target - segStart) / segLen : 0;
      const a = points[cursor];
      const b = points[(cursor + 1) % n];
      out[i] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    trackPerimeter = total;
    return out;
  }

  /** Returns { x, y, dx, dy } for a given distance along the track. */
  function pointAtDistance(d) {
    const n = trackSamples.length;
    // Wrap distance into [0, perimeter)
    let dd = d % trackPerimeter;
    if (dd < 0) dd += trackPerimeter;
    const f = (dd / trackPerimeter) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    const a = trackSamples[i0];
    const b = trackSamples[i1];
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    // Direction = vector to the next sample (close enough for our purposes).
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const mag = Math.hypot(dx, dy) || 1;
    return { x, y, dx: dx / mag, dy: dy / mag };
  }

  /** Path the centerline through the given context. */
  function tracePath(c, samples) {
    c.beginPath();
    c.moveTo(samples[0][0], samples[0][1]);
    for (let i = 1; i < samples.length; i++) c.lineTo(samples[i][0], samples[i][1]);
    c.closePath();
  }

  /**
   * Bake the static track to bgCanvas. This is the most expensive single
   * routine in the file; it only runs on resize.
   */
  function bakeBackground(w, h, samples) {
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = Math.round(w * dpr);
    bgCanvas.height = Math.round(h * dpr);
    bgCtx = bgCanvas.getContext('2d');
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = bgCtx;

    // 1) Background grass / outer area
    const bg = c.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0a0e1c');
    bg.addColorStop(1, '#070912');
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    // 2) Faint dot grid for tech feel (kept very subtle)
    c.fillStyle = 'rgba(120, 140, 220, 0.04)';
    const step = 28;
    for (let x = step / 2; x < w; x += step) {
      for (let y = step / 2; y < h; y += step) c.fillRect(x, y, 1, 1);
    }

    // 3) Track build — multiple stroked passes over the same closed path.
    c.lineCap = 'butt';
    c.lineJoin = 'round';

    // (a) Red kerb base — wider than the asphalt
    c.strokeStyle = '#a02a32';
    c.lineWidth = TRACK_WIDTH + KERB_WIDTH * 2;
    tracePath(c, samples);
    c.stroke();

    // (b) White dashed kerb pattern — paints at the same width, the dashed
    // gaps reveal the red base. Asphalt drawn next will hide the centre,
    // leaving only the red/white pattern visible at the kerbs.
    c.strokeStyle = '#f1f1f4';
    c.lineWidth = TRACK_WIDTH + KERB_WIDTH * 2;
    c.setLineDash([18, 18]);
    tracePath(c, samples);
    c.stroke();
    c.setLineDash([]);

    // (c) Asphalt
    c.strokeStyle = '#15182a';
    c.lineWidth = TRACK_WIDTH;
    tracePath(c, samples);
    c.stroke();

    // (d) Subtle inner lighter ring on the asphalt for depth
    c.strokeStyle = 'rgba(255, 255, 255, 0.025)';
    c.lineWidth = TRACK_WIDTH - 4;
    tracePath(c, samples);
    c.stroke();

    // (e) Inner edge line (white)
    c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    c.lineWidth = 1;
    tracePath(c, samples);
    c.stroke();

    // (f) Dashed white centerline (Super Sprint style)
    c.strokeStyle = 'rgba(245, 245, 250, 0.78)';
    c.lineWidth = 1.6;
    c.setLineDash([12, 16]);
    tracePath(c, samples);
    c.stroke();
    c.setLineDash([]);

    // 4) Start/finish line: a 6×4 checkered band perpendicular to the track.
    drawStartFinish(c, samples);

    // 5) Subtle vignette so the far corners feel a bit darker, like CRT.
    const vg = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3,
                                      w / 2, h / 2, Math.max(w, h) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);
  }

  /** Draw a checkered start/finish line at sample index `startSampleIdx`. */
  function drawStartFinish(c, samples) {
    const i = startSampleIdx;
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);

    const cells = 6;
    const cellH = TRACK_WIDTH / cells;
    const bandLen = 14;

    c.save();
    c.translate(a[0], a[1]);
    c.rotate(angle);
    // Two rows of checkers across the asphalt, perpendicular to travel.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < cells; col++) {
        const dark = (row + col) % 2 === 0;
        c.fillStyle = dark ? '#0e1120' : '#f5f5f7';
        c.fillRect(
          -bandLen / 2 + row * (bandLen / 2),
          -TRACK_WIDTH / 2 + col * cellH,
          bandLen / 2,
          cellH,
        );
      }
    }
    // "START" tag plate above the line — small dark chip with neon edge.
    // We position it perpendicular to the track (above the asphalt), then
    // counter-rotate so the label always reads upright regardless of where
    // the start line sits on the loop.
    c.translate(0, -TRACK_WIDTH / 2 - 12);
    c.rotate(-angle);
    c.fillStyle = 'rgba(8, 10, 22, 0.85)';
    roundRectPath(c, -22, -8, 44, 14, 4);
    c.fill();
    c.strokeStyle = 'rgba(251, 191, 36, 0.7)';
    c.lineWidth = 0.8;
    c.stroke();
    c.fillStyle = '#fbbf24';
    c.font = '700 8.5px "Instrument Sans", system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('START', 0, -1);
    c.restore();
  }

  // ------------------------------------------------------------------
  // Cars
  // ------------------------------------------------------------------

  function buildCars() {
    cars.length = 0;
    for (let i = 0; i < CAR_DEFS.length; i++) {
      const def = CAR_DEFS[i];
      cars.push({
        def,
        // Even spacing on the start grid: ~12% of the track between cars.
        distance: -i * trackPerimeter * 0.045,
        // Slight per-car speed bias so the order changes over time.
        baseSpeed: BASE_SPEED + (Math.random() * 2 - 1) * SPEED_VARIANCE,
        // Lane offset is signed perpendicular distance from the centerline.
        // Cars line up: -1.5L, -0.5L, +0.5L, +1.5L (where L = LANE_WIDTH).
        laneOffset: (i - (N_LANES - 1) / 2) * LANE_WIDTH,
        // Turn rate from the previous frame, used to tint skid emission.
        prevHeading: 0,
        // Boost timer (seconds remaining); 0 = no boost.
        boostT: 0,
        // Last position (for trail rendering).
        trail: [],
        x: 0, y: 0, heading: 0,
        lap: 0, _lastDist: 0,
      });
    }
  }

  // ------------------------------------------------------------------
  // Resize — repositions everything for a new container size.
  // ------------------------------------------------------------------

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr  = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    trackSamples = buildTrackCenterline(cssW, cssH);
    // Place the start/finish line in the middle of the long top straight,
    // which corresponds to roughly 13% along the resampled path. The sample
    // index is the same regardless of canvas size because we resample
    // uniformly along arc length.
    startSampleIdx = Math.round(trackSamples.length * 0.13);

    bakeBackground(cssW, cssH, trackSamples);

    // Skid layer follows the canvas size; reset on resize.
    skidCanvas = document.createElement('canvas');
    skidCanvas.width = Math.round(cssW * dpr);
    skidCanvas.height = Math.round(cssH * dpr);
    skidCtx = skidCanvas.getContext('2d');
    skidCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (cars.length === 0) buildCars();
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(wrap);
  } else {
    window.addEventListener('resize', resize);
  }
  resize();

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  let nextBoostCheck = performance.now() / 1000 + BOOST_INTERVAL;

  function update(dt, nowSec) {
    // Occasionally elect one car to boost briefly. Adds variety without
    // ruining the steady-state lap pattern.
    if (nowSec >= nextBoostCheck) {
      nextBoostCheck = nowSec + BOOST_INTERVAL + Math.random() * 2.5;
      const target = cars[(Math.random() * cars.length) | 0];
      if (target.boostT <= 0) target.boostT = BOOST_DURATION;
    }

    const speedMult = (hover ? HOVER_MULT : 1);

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];

      if (car.boostT > 0) car.boostT = Math.max(0, car.boostT - dt);
      const carBoost = car.boostT > 0 ? BOOST_MULT : 1;

      const speed = car.baseSpeed * speedMult * carBoost;
      car.distance += speed * dt;

      // Lap detection: when distance crosses an integer multiple of
      // perimeter we've completed another lap.
      const newLap = Math.floor(car.distance / trackPerimeter);
      if (newLap !== car.lap) {
        car.lap = newLap;
      }

      // Position + heading along the track.
      const p = pointAtDistance(car.distance);
      // Perpendicular vector for lane offset (rotate dir 90° CCW, then we
      // negate so positive lane offsets sit "outside" of the loop).
      const perpX = -p.dy;
      const perpY =  p.dx;

      const x = p.x + perpX * car.laneOffset;
      const y = p.y + perpY * car.laneOffset;
      const heading = Math.atan2(p.dy, p.dx);

      // Detect curvature (change in heading) for skid emission.
      let dh = heading - car.prevHeading;
      while (dh >  Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const turnRate = Math.abs(dh) / Math.max(dt, 1e-3); // rad/s

      car.x = x;
      car.y = y;
      car.heading = heading;
      car.prevHeading = heading;

      // Push to motion-trail buffer (used for the brief streak behind cars).
      const trail = car.trail;
      trail.push([x, y]);
      if (trail.length > 8) trail.shift();

      // Emit skid marks if we're cornering hard or boosting.
      if (skidCtx && (turnRate > 0.9 || car.boostT > 0.05)) {
        emitSkid(car, turnRate);
      }
    }

    // Lap counter on the HUD shows the current leader's lap (1-based).
    let leaderLap = 0;
    for (let i = 0; i < cars.length; i++) {
      if (cars[i].lap > leaderLap) leaderLap = cars[i].lap;
    }
    if (leaderLap !== lastLeaderLap) {
      lastLeaderLap = leaderLap;
      lapCounter = leaderLap + 1;
      if (lapEl) lapEl.textContent = String(lapCounter).padStart(2, '0');
    }
  }

  /** Draw two short tyre marks at the car's rear wheel positions. */
  function emitSkid(car, turnRate) {
    const cosH = Math.cos(car.heading);
    const sinH = Math.sin(car.heading);
    // Rear-axle position offset along -heading.
    const rearX = car.x - cosH * (CAR_LENGTH * 0.4);
    const rearY = car.y - sinH * (CAR_LENGTH * 0.4);
    // Lateral offset to each rear wheel.
    const latX = -sinH * (CAR_WIDTH * 0.45);
    const latY =  cosH * (CAR_WIDTH * 0.45);

    const intensity = clamp((turnRate - 0.6) * 0.4 + (car.boostT > 0 ? 0.25 : 0), 0.05, 0.45);

    skidCtx.fillStyle = `rgba(0, 0, 0, ${intensity.toFixed(3)})`;
    skidCtx.beginPath();
    skidCtx.arc(rearX + latX, rearY + latY, 1.3, 0, Math.PI * 2);
    skidCtx.arc(rearX - latX, rearY - latY, 1.3, 0, Math.PI * 2);
    skidCtx.fill();
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  function fadeSkidLayer(dt) {
    if (!skidCtx) return;
    // Scaled fade — frame-rate independent.
    const fade = clamp(SKID_FADE_BASE + dt * 0.6, 0.005, 0.15);
    skidCtx.save();
    skidCtx.setTransform(1, 0, 0, 1, 0, 0); // raw pixel coords
    skidCtx.globalCompositeOperation = 'destination-out';
    skidCtx.fillStyle = `rgba(0, 0, 0, ${fade.toFixed(3)})`;
    skidCtx.fillRect(0, 0, skidCanvas.width, skidCanvas.height);
    skidCtx.restore();
    // Restore transform so subsequent draws use CSS-pixel coords.
    skidCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawCarTrail(c, car) {
    const trail = car.trail;
    if (trail.length < 2) return;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      const t = i / trail.length;
      const a = trail[i - 1];
      const b = trail[i];
      c.strokeStyle = car.boostT > 0
        ? `rgba(254, 215, 170, ${(t * 0.45).toFixed(3)})`
        : `rgba(${hexToRgb(car.def.light)}, ${(t * 0.22).toFixed(3)})`;
      c.lineWidth = (car.boostT > 0 ? 4 : 2.5) * t + 0.5;
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]);
      c.stroke();
    }
  }

  /** "#22d3ee" → "34, 211, 238". Memoised because we call it a lot. */
  const _rgbCache = new Map();
  function hexToRgb(hex) {
    const cached = _rgbCache.get(hex);
    if (cached) return cached;
    const h = hex.replace('#', '');
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const out = `${r}, ${g}, ${b}`;
    _rgbCache.set(hex, out);
    return out;
  }

  /**
   * Draw an F1-style top-down race car. The silhouette is built from a
   * dozen primitives layered front-to-back so the recognisable F1 shapes
   * (front wing → exposed wheels → narrow nose → halo'd cockpit → side
   * pods → larger rear wheels → rear wing) all read clearly even at this
   * size.
   *
   * Local coordinates: +x = forward (nose), origin = chassis center.
   */
  function drawCar(c, car) {
    const def     = car.def;
    const primary = def.primary;
    const light   = def.light;
    const dark    = def.dark;

    c.save();
    c.translate(car.x, car.y);
    c.rotate(car.heading);

    const HL = CAR_LENGTH / 2;   // 18
    const HW = CAR_WIDTH  / 2;   // 10

    // ──────────────────────────────────────────────────────────────────
    // 1. Drop shadow (offset slightly so the car appears to sit above)
    // ──────────────────────────────────────────────────────────────────
    c.fillStyle = 'rgba(0, 0, 0, 0.5)';
    c.beginPath();
    c.ellipse(2, 2.5, HL * 0.95, HW * 0.85, 0, 0, Math.PI * 2);
    c.fill();

    // ──────────────────────────────────────────────────────────────────
    // 2. Front wing — wide bar that protrudes ahead of the front wheels
    // ──────────────────────────────────────────────────────────────────
    c.fillStyle = '#0a0a0d';
    c.fillRect(HL - 4, -HW + 1, 2.6, CAR_WIDTH - 2);
    // Coloured wing endplates at the tips
    c.fillStyle = primary;
    c.fillRect(HL - 4, -HW + 1, 2.6, 1.5);
    c.fillRect(HL - 4,  HW - 2.5, 2.6, 1.5);

    // ──────────────────────────────────────────────────────────────────
    // 3. Front wheels — black tyres, slightly inset behind the front wing
    //    and sticking out beyond the nose like a real open-wheeler.
    // ──────────────────────────────────────────────────────────────────
    const fw_l = 6;     // wheel length (front-back)
    const fw_w = 4.4;   // wheel width
    c.fillStyle = '#0d0d12';
    c.fillRect(HL - 11, -HW,        fw_l, fw_w);  // left front
    c.fillRect(HL - 11,  HW - fw_w, fw_l, fw_w);  // right front
    // Tread highlights
    c.fillStyle = 'rgba(90, 95, 110, 0.55)';
    c.fillRect(HL - 10.2, -HW + 0.7, fw_l - 1.4, 0.6);
    c.fillRect(HL - 10.2, -HW + 2.8, fw_l - 1.4, 0.6);
    c.fillRect(HL - 10.2,  HW - 3.4, fw_l - 1.4, 0.6);
    c.fillRect(HL - 10.2,  HW - 1.3, fw_l - 1.4, 0.6);

    // ──────────────────────────────────────────────────────────────────
    // 4. Nose cone — pointed taper between the front wing and the chassis
    // ──────────────────────────────────────────────────────────────────
    const noseGrad = c.createLinearGradient(0, -HW, 0, HW);
    noseGrad.addColorStop(0,    light);
    noseGrad.addColorStop(0.55, primary);
    noseGrad.addColorStop(1,    dark);

    c.beginPath();
    c.moveTo(HL - 1.4, -1.6);            // tip area (just behind the wing)
    c.lineTo(HL - 4.0, -3.0);
    c.lineTo(HL - 11.0, -3.0);           // meets front-wheel inner edge
    c.lineTo(HL - 11.0,  3.0);
    c.lineTo(HL - 4.0,  3.0);
    c.lineTo(HL - 1.4,  1.6);
    c.closePath();
    c.fillStyle = noseGrad;
    c.fill();
    c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    c.lineWidth = 0.7;
    c.stroke();

    // ──────────────────────────────────────────────────────────────────
    // 5. Main chassis / side-pods — wider than the nose to suggest the
    //    cooling ducts and bargeboards behind the cockpit
    // ──────────────────────────────────────────────────────────────────
    c.beginPath();
    c.moveTo(HL - 11, -3.5);
    c.lineTo(-HL + 7, -HW + 1);
    c.lineTo(-HL + 7,  HW - 1);
    c.lineTo(HL - 11,  3.5);
    c.closePath();
    c.fillStyle = noseGrad;
    c.fill();
    c.stroke();

    // Side-pod highlight strips (catch the eye and read as F1 cooling vents)
    c.fillStyle = dark;
    c.fillRect(-HL + 7.5, -HW + 1.2, 9, 1.0);
    c.fillRect(-HL + 7.5,  HW - 2.2, 9, 1.0);

    // ──────────────────────────────────────────────────────────────────
    // 6. Cockpit — dark "tub" with a coloured halo strip above
    // ──────────────────────────────────────────────────────────────────
    c.fillStyle = 'rgba(8, 12, 22, 0.95)';
    roundRectPath(c, 0, -3.2, 8, 6.4, 1.8);
    c.fill();

    // Halo: thin black bar arcing in front of the helmet (visible from above
    // as a small forward-curving line)
    c.strokeStyle = '#0a0a0d';
    c.lineWidth = 1.0;
    c.beginPath();
    c.arc(4, 0, 3.6, -Math.PI * 0.42, Math.PI * 0.42, false);
    c.stroke();

    // Driver helmet — small dark circle with a coloured visor
    c.fillStyle = '#1a1a22';
    c.beginPath();
    c.arc(3.5, 0, 1.8, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = light;
    c.fillRect(2.8, -0.6, 1.7, 1.2);

    // ──────────────────────────────────────────────────────────────────
    // 7. Engine cover — narrow strip between cockpit and rear wing with a
    //    tiny dark "air intake" slit on top.
    // ──────────────────────────────────────────────────────────────────
    c.fillStyle = dark;
    roundRectPath(c, -HL + 5, -2.8, 7, 5.6, 1.2);
    c.fill();
    c.fillStyle = '#0a0a0d';
    c.fillRect(-HL + 6, -1.0, 5, 2.0);

    // ──────────────────────────────────────────────────────────────────
    // 8. Rear wheels — slightly larger than the fronts (real F1 spec) and
    //    sit just inside the rear wing.
    // ──────────────────────────────────────────────────────────────────
    const rw_l = 7;
    const rw_w = 4.8;
    c.fillStyle = '#0d0d12';
    c.fillRect(-HL + 2, -HW,        rw_l, rw_w);
    c.fillRect(-HL + 2,  HW - rw_w, rw_l, rw_w);
    // Tread highlights
    c.fillStyle = 'rgba(90, 95, 110, 0.55)';
    c.fillRect(-HL + 2.8, -HW + 0.7, rw_l - 1.4, 0.6);
    c.fillRect(-HL + 2.8, -HW + 2.8, rw_l - 1.4, 0.6);
    c.fillRect(-HL + 2.8, -HW + 4.0, rw_l - 1.4, 0.6);
    c.fillRect(-HL + 2.8,  HW - 4.6, rw_l - 1.4, 0.6);
    c.fillRect(-HL + 2.8,  HW - 1.3, rw_l - 1.4, 0.6);

    // ──────────────────────────────────────────────────────────────────
    // 9. Rear wing — wide bar with a coloured insert and tiny endplates
    // ──────────────────────────────────────────────────────────────────
    c.fillStyle = '#0a0a0d';
    c.fillRect(-HL - 1.2, -HW, 2.8, CAR_WIDTH);
    c.fillStyle = primary;
    c.fillRect(-HL - 0.9, -HW + 1.6, 2.2, CAR_WIDTH - 3.2);
    // Endplate highlight (thin light tab on each side of the wing)
    c.fillStyle = light;
    c.fillRect(-HL + 1.6, -HW,        0.7, 1.4);
    c.fillRect(-HL + 1.6,  HW - 1.4,  0.7, 1.4);

    // ──────────────────────────────────────────────────────────────────
    // 10. Tiny front position lights — F1 cars have small white markers.
    //     They also act as a subtle direction cue at this scale.
    // ──────────────────────────────────────────────────────────────────
    c.fillStyle = '#fff8d6';
    c.shadowColor = '#fde68a';
    c.shadowBlur = car.boostT > 0 ? 9 : 3;
    c.beginPath();
    c.arc(HL - 1.0, -1.0, 0.9, 0, Math.PI * 2);
    c.arc(HL - 1.0,  1.0, 0.9, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;

    // ──────────────────────────────────────────────────────────────────
    // 11. Boost flame out of the diffuser when boosting
    // ──────────────────────────────────────────────────────────────────
    if (car.boostT > 0) {
      const flick = 0.55 + Math.random() * 0.45;
      const len   = 7 + Math.random() * 4.5;
      c.fillStyle   = `rgba(254, 215, 170, ${flick.toFixed(3)})`;
      c.shadowColor = '#fbbf24';
      c.shadowBlur  = 12;
      c.beginPath();
      c.moveTo(-HL - 1.2, -3.2);
      c.lineTo(-HL - 1.2 - len, 0);
      c.lineTo(-HL - 1.2,  3.2);
      c.closePath();
      c.fill();
      c.shadowBlur = 0;
    }

    c.restore();
  }

  function frame(now) {
    let rawDt = (now - lastFrame) / 1000;
    lastFrame = now;
    // Clamp dt so a tab returning from background doesn't fast-forward laps.
    const dt = Math.min(rawDt, 0.06);

    if (active && !reduceMotion) update(dt, now / 1000);

    // Fade old skids — we still tick this even when idle so the layer slowly
    // clears rather than freezing mid-fade.
    if (skidCtx) fadeSkidLayer(dt);

    // ----- Render -----
    // 1. Static track
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0, cssW, cssH);
    // 2. Skid marks layer (under cars)
    if (skidCanvas) ctx.drawImage(skidCanvas, 0, 0, cssW, cssH);

    // 3. Car motion trails (under cars but on top of skids so the colour pops)
    for (let i = 0; i < cars.length; i++) drawCarTrail(ctx, cars[i]);

    // 4. Cars
    for (let i = 0; i < cars.length; i++) drawCar(ctx, cars[i]);

    // 5. Hover "neon haze" — a single radial highlight that subtly intensifies
    // when hovered. Cheap and adds life on hover.
    if (hover) {
      const g = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.2,
                                          cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.65);
      g.addColorStop(0, 'rgba(99, 102, 241, 0.06)');
      g.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cssW, cssH);
    }

    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Active-state plumbing — viewport visibility, hover, tab visibility.
  // ------------------------------------------------------------------

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => { active = entry.isIntersecting; });
    }, { threshold: 0.05 });
    io.observe(wrap);
  } else {
    active = true;
  }

  wrap.addEventListener('mouseenter', () => { hover = true; });
  wrap.addEventListener('mouseleave', () => { hover = false; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) active = false;
  });

  // Build a tiny per-car colour leaderboard chip in the bottom HUD so the
  // viewer can tell which colour is which "P1/P2/..." at a glance.
  if (leaderEl && CAR_DEFS.length) {
    leaderEl.innerHTML = '';
    CAR_DEFS.forEach((def, i) => {
      const dot = document.createElement('span');
      dot.className = 'gp-lb-dot';
      dot.style.color = def.primary;
      dot.style.background = def.primary;
      dot.title = def.name;
      leaderEl.appendChild(dot);
    });
  }

  lastFrame = performance.now();
  requestAnimationFrame(frame);
})();
