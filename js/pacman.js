/* ============================================================== *
 *  Warpzone Chase — Pac-Man-style auto-played mini scene          *
 *  -------------------------------------------------------------- *
 *  Lightweight, non-interactive arcade animation that fills the   *
 *  bento cell next to the For Studios steps. A yellow Pac-Man     *
 *  hunts four classic ghosts through a neon maze. The board is    *
 *  reseeded with dots whenever Pac-Man cleans it up so the maze   *
 *  always reads "alive" without becoming empty.                   *
 *                                                                 *
 *  - Vanilla JS + a single HTML5 <canvas> (no libs, no images)    *
 *  - Tile-based grid movement; AI re-evaluates at intersections   *
 *  - IntersectionObserver pauses the loop when off-screen         *
 *  - Respects prefers-reduced-motion by slowing everything down   *
 * ============================================================== */
(function () {
  'use strict';

  const canvas = document.getElementById('pacman');
  if (!canvas) return;

  const wrap     = document.getElementById('pacman-wrap');
  const scoreEl  = document.getElementById('pm-score-val');
  const c        = canvas.getContext('2d');
  const reduced  = window.matchMedia &&
                   window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------
  // Maze
  // ------------------------------------------------------------------
  // 17 cols × 17 rows, fully symmetric. '#' = wall, '.' = dot, ' ' = path.
  // A small set of "power pellet" cells is overlaid on top of the dots
  // for visual flavour (they are non-interactive in this version).
  const MAZE = [
    '#################',
    '#...............#',
    '#.###.#####.###.#',
    '#...............#',
    '#.##.##.#.##.##.#',
    '#....#.....#....#',
    '#.##.#.###.#.##.#',
    '#....#.....#....#',
    '#.##.#####.#.##.#',
    '#....#.....#....#',
    '#.##.#.###.#.##.#',
    '#....#.....#....#',
    '#.##.##.#.##.##.#',
    '#...............#',
    '#.###.#####.###.#',
    '#...............#',
    '#################',
  ];
  const ROWS = MAZE.length;
  const COLS = MAZE[0].length;

  // Parse maze into wall/dot grids.
  const isWall = [];
  const dots   = [];
  function seedDots() {
    for (let r = 0; r < ROWS; r++) {
      isWall[r] = isWall[r] || [];
      dots[r]   = dots[r]   || [];
      for (let cc = 0; cc < COLS; cc++) {
        isWall[r][cc] = MAZE[r][cc] === '#';
        dots[r][cc]   = MAZE[r][cc] === '.';
      }
    }
  }
  seedDots();

  // Big "power" pellets — purely decorative pulses near each corner.
  const POWER = [
    { x: 3,  y: 1  }, { x: COLS - 4, y: 1  },
    { x: 3,  y: ROWS - 2 }, { x: COLS - 4, y: ROWS - 2 },
  ];
  // Make sure they sit on dot cells (defensive, in case the maze changes).
  POWER.forEach(p => { if (!isWall[p.y][p.x]) dots[p.y][p.x] = true; });

  // ------------------------------------------------------------------
  // Entities
  // ------------------------------------------------------------------
  // Pac-Man starts in the middle of the maze; ghosts at the 4 corners.
  const PAC = {
    gx: 8, gy: 8,
    dx: 1, dy: 0,
    progress: 0,           // distance traveled into the current cell (0..CELL)
    speed:    0,           // CSS px/sec — set on resize
    mouth:    0,           // 0..MAX_MOUTH animation
    mouthDir: 1,
  };

  const GHOST_DEFS = [
    { name: 'Blinky', body: '#ef4444', glow: 'rgba(239,68,68,0.55)' },
    { name: 'Pinky',  body: '#ec4899', glow: 'rgba(236,72,153,0.55)' },
    { name: 'Inky',   body: '#22d3ee', glow: 'rgba(34,211,238,0.55)' },
    { name: 'Clyde',  body: '#fb923c', glow: 'rgba(251,146,60,0.55)' },
  ];
  const SPAWNS = [
    { x: 1,        y: 1        },
    { x: COLS - 2, y: 1        },
    { x: 1,        y: ROWS - 2 },
    { x: COLS - 2, y: ROWS - 2 },
  ];
  const ghosts = GHOST_DEFS.map((def, i) => ({
    ...def,
    gx: SPAWNS[i].x,
    gy: SPAWNS[i].y,
    dx: 0, dy: 1,
    progress: 0,
    speed: 0,
    state:    'alive',     // 'alive' | 'eaten'
    respawnT: 0,           // seconds left until back from "eaten"
    spawnIdx: i,
  }));

  // ------------------------------------------------------------------
  // Render state / sizing
  // ------------------------------------------------------------------
  let dpr  = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  let cssW = 0, cssH = 0;
  let CELL = 0;
  let offsetX = 0, offsetY = 0;
  let active   = false;
  let hover    = false;
  let caught   = 0;
  let dotResetT = 0;
  let pelletT   = 0;       // for the corner pellet pulse
  let lastFrame = performance.now();

  // ------------------------------------------------------------------
  // Sizing — keep the maze square and centered inside the canvas
  // ------------------------------------------------------------------
  function layout() {
    // The canvas is positioned absolutely (CSS handles the visual fill);
    // we just measure the panel and update the canvas's *internal* pixel
    // resolution. Setting `style.width/height` here would re-introduce the
    // border feedback loop, so we deliberately don't.
    const r = wrap.getBoundingClientRect();
    cssW = Math.max(1, Math.floor(r.width));
    cssH = Math.max(1, Math.floor(r.height));
    dpr  = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;

    CELL = Math.floor(Math.min(cssW / COLS, cssH / ROWS));
    const mazeW = COLS * CELL;
    const mazeH = ROWS * CELL;
    offsetX = Math.floor((cssW - mazeW) / 2);
    offsetY = Math.floor((cssH - mazeH) / 2);

    // Speeds are expressed in CSS px/sec, so they scale with CELL.
    const slow = reduced ? 0.45 : 1;
    PAC.speed = CELL * 5.0 * slow;
    for (const g of ghosts) g.speed = CELL * 4.4 * slow;
  }

  // Observe container size changes (theme changes, layout shifts, etc.).
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(layout);
    ro.observe(wrap);
  } else {
    window.addEventListener('resize', layout);
  }
  layout();

  // ------------------------------------------------------------------
  // Grid helpers
  // ------------------------------------------------------------------
  function inBounds(x, y) {
    return y >= 0 && y < ROWS && x >= 0 && x < COLS;
  }
  /** Returns the list of {dx,dy} unit vectors leading to non-wall neighbours. */
  function openDirs(gx, gy) {
    const out = [];
    if (inBounds(gx + 1, gy) && !isWall[gy][gx + 1]) out.push({ dx:  1, dy:  0 });
    if (inBounds(gx - 1, gy) && !isWall[gy][gx - 1]) out.push({ dx: -1, dy:  0 });
    if (inBounds(gx, gy + 1) && !isWall[gy + 1][gx]) out.push({ dx:  0, dy:  1 });
    if (inBounds(gx, gy - 1) && !isWall[gy - 1][gx]) out.push({ dx:  0, dy: -1 });
    return out;
  }
  /** Pixel position of an entity (interpolated between cells). */
  function pixelPos(e) {
    return {
      x: (e.gx + 0.5) * CELL + e.dx * e.progress,
      y: (e.gy + 0.5) * CELL + e.dy * e.progress,
    };
  }

  // ------------------------------------------------------------------
  // AI — Pac-Man chases the nearest alive ghost; ghosts flee Pac-Man.
  // Decisions only happen when an entity reaches a new cell.
  // ------------------------------------------------------------------
  function nearestAliveGhost(from) {
    let best = null, bestD = Infinity;
    for (const g of ghosts) {
      if (g.state !== 'alive') continue;
      const d = Math.abs(g.gx - from.gx) + Math.abs(g.gy - from.gy);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  function pacChooseDir(e) {
    const all  = openDirs(e.gx, e.gy);
    let opts   = all.filter(o => !(o.dx === -e.dx && o.dy === -e.dy));
    if (opts.length === 0) opts = all;
    if (opts.length === 1) return opts[0];

    const target = nearestAliveGhost(e);
    if (!target) return opts[0];

    let best = opts[0], bestD = Infinity;
    for (const o of opts) {
      const nx = e.gx + o.dx;
      const ny = e.gy + o.dy;
      const d  = Math.abs(nx - target.gx) + Math.abs(ny - target.gy);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  function ghostChooseDir(g) {
    const all  = openDirs(g.gx, g.gy);
    let opts   = all.filter(o => !(o.dx === -g.dx && o.dy === -g.dy));
    if (opts.length === 0) opts = all;
    if (opts.length === 1) return opts[0];

    // Maximize Manhattan distance from Pac-Man, with a tiny random tie-break
    // so different ghosts don't all pick the exact same path.
    let best = opts[0], bestS = -Infinity;
    for (const o of opts) {
      const nx = g.gx + o.dx;
      const ny = g.gy + o.dy;
      const d  = Math.abs(nx - PAC.gx) + Math.abs(ny - PAC.gy);
      const s  = d + Math.random() * 1.6;
      if (s > bestS) { bestS = s; best = o; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Stepping — advance an entity by `dt` along its current direction.
  // When it crosses a cell boundary, snap to the new cell and re-decide.
  // ------------------------------------------------------------------
  function step(e, dt, chooseDir) {
    let remaining = e.speed * dt;
    // In the rare case that dt × speed > CELL we keep crossing cells.
    while (remaining > 0) {
      const left = CELL - e.progress;
      if (remaining < left) {
        e.progress += remaining;
        remaining = 0;
      } else {
        // Snap to next cell
        remaining -= left;
        e.progress = 0;
        e.gx += e.dx;
        e.gy += e.dy;
        const dir = chooseDir(e);
        e.dx = dir.dx;
        e.dy = dir.dy;
      }
    }
  }

  // ------------------------------------------------------------------
  // Main update tick
  // ------------------------------------------------------------------
  function update(dt) {
    // Mouth animation runs even when the loop is otherwise paused-feeling
    PAC.mouth += PAC.mouthDir * dt * 7;
    if (PAC.mouth > 0.85) { PAC.mouth = 0.85; PAC.mouthDir = -1; }
    if (PAC.mouth < 0.02) { PAC.mouth = 0.02; PAC.mouthDir =  1; }

    pelletT += dt;

    // Hover speeds things up slightly for a "gimme more" feel.
    const hoverMult = hover ? 1.18 : 1;

    // Move Pac-Man, then eat the dot in its new cell (if any).
    const oldSpeed = PAC.speed;
    PAC.speed = oldSpeed * hoverMult;
    step(PAC, dt, pacChooseDir);
    PAC.speed = oldSpeed;
    if (dots[PAC.gy] && dots[PAC.gy][PAC.gx]) dots[PAC.gy][PAC.gx] = false;

    // Move ghosts (alive ones run; eaten ones are on a respawn timer).
    for (const g of ghosts) {
      if (g.state === 'eaten') {
        g.respawnT -= dt;
        if (g.respawnT <= 0) {
          // Respawn at the spawn corner that's currently farthest from Pac-Man
          // so the chase doesn't immediately end.
          let bestSpawn = SPAWNS[g.spawnIdx], bestD = -Infinity;
          for (const s of SPAWNS) {
            const d = Math.abs(s.x - PAC.gx) + Math.abs(s.y - PAC.gy);
            if (d > bestD) { bestD = d; bestSpawn = s; }
          }
          g.gx = bestSpawn.x;
          g.gy = bestSpawn.y;
          g.progress = 0;
          const choices = openDirs(g.gx, g.gy);
          if (choices.length) {
            const pick = choices[Math.floor(Math.random() * choices.length)];
            g.dx = pick.dx; g.dy = pick.dy;
          }
          g.state = 'alive';
        }
        continue;
      }
      const ghSpeed = g.speed * hoverMult;
      const prev = g.speed;
      g.speed = ghSpeed;
      step(g, dt, ghostChooseDir);
      g.speed = prev;
    }

    // Catch detection — pixel proximity rather than cell-equality so a ghost
    // and Pac-Man crossing each other in adjacent cells still "catches".
    const p = pixelPos(PAC);
    for (const g of ghosts) {
      if (g.state !== 'alive') continue;
      const gp = pixelPos(g);
      const dx = p.x - gp.x;
      const dy = p.y - gp.y;
      if (dx * dx + dy * dy < (CELL * 0.7) * (CELL * 0.7)) {
        g.state = 'eaten';
        g.respawnT = 1.6 + Math.random() * 0.5;
        caught++;
        if (scoreEl) scoreEl.textContent = String(caught).padStart(2, '0');
      }
    }

    // Reseed the maze with dots periodically so it doesn't go empty.
    dotResetT += dt;
    if (dotResetT > 12) {
      dotResetT = 0;
      let count = 0;
      for (let r = 0; r < ROWS; r++) {
        for (let cc = 0; cc < COLS; cc++) {
          if (dots[r][cc]) count++;
        }
      }
      if (count < 30) seedDots();
    }
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------
  function draw() {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Subtle vignette background that complements the parent card
    const grad = c.createRadialGradient(
      cssW / 2, cssH / 2, 0,
      cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.7
    );
    grad.addColorStop(0,   'rgba(8, 12, 28, 0.0)');
    grad.addColorStop(1,   'rgba(0, 0, 0, 0.45)');
    c.fillStyle = grad;
    c.fillRect(0, 0, cssW, cssH);

    c.translate(offsetX, offsetY);
    drawWalls();
    drawDots();
    drawPellets();
    for (const g of ghosts) drawGhost(g);
    drawPacman();
  }

  /** Outline-style walls — only edges between wall and corridor are drawn. */
  function drawWalls() {
    c.strokeStyle = '#3a5cff';
    c.lineWidth   = Math.max(1.4, CELL * 0.10);
    c.lineCap     = 'round';
    c.lineJoin    = 'round';
    c.shadowColor = 'rgba(99, 130, 255, 0.55)';
    c.shadowBlur  = 8;
    c.beginPath();
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (!isWall[r][cc]) continue;
        const x = cc * CELL;
        const y = r  * CELL;
        // For each side, only draw a segment if it borders a non-wall cell
        // (or the outer edge of the maze).
        const top    = r === 0          || !isWall[r - 1][cc];
        const bottom = r === ROWS - 1   || !isWall[r + 1][cc];
        const left   = cc === 0         || !isWall[r][cc - 1];
        const right  = cc === COLS - 1  || !isWall[r][cc + 1];

        // Insets keep the walls slightly inside their cell so the neon glow
        // reads as a tube rather than touching the next wall block.
        const ins = CELL * 0.18;
        if (top)    { c.moveTo(x + ins, y + ins);              c.lineTo(x + CELL - ins, y + ins); }
        if (bottom) { c.moveTo(x + ins, y + CELL - ins);       c.lineTo(x + CELL - ins, y + CELL - ins); }
        if (left)   { c.moveTo(x + ins, y + ins);              c.lineTo(x + ins, y + CELL - ins); }
        if (right)  { c.moveTo(x + CELL - ins, y + ins);       c.lineTo(x + CELL - ins, y + CELL - ins); }

        // Inner corner fillets — connect adjacent open edges so the wall
        // outline reads as a continuous tube rather than 4 disconnected
        // segments per cell.
        if (top && right)    { c.moveTo(x + CELL - ins, y + ins);        c.lineTo(x + CELL - ins, y + ins); }
        if (bottom && right) { c.moveTo(x + CELL - ins, y + CELL - ins); c.lineTo(x + CELL - ins, y + CELL - ins); }
      }
    }
    c.stroke();
    c.shadowBlur = 0;
  }

  /** Tiny corridor pellets. */
  function drawDots() {
    c.fillStyle    = '#fde68a';
    c.shadowColor  = 'rgba(253, 230, 138, 0.4)';
    c.shadowBlur   = 3;
    c.beginPath();
    const r = Math.max(1, CELL * 0.08);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (!dots[row][col]) continue;
        // Skip the cells that host an animated power pellet (drawn separately).
        if (POWER.some(p => p.x === col && p.y === row)) continue;
        const x = (col + 0.5) * CELL;
        const y = (row + 0.5) * CELL;
        c.moveTo(x + r, y);
        c.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    c.fill();
    c.shadowBlur = 0;
  }

  /** Big pulsing corner pellets. */
  function drawPellets() {
    const pulse = 0.5 + 0.5 * Math.sin(pelletT * 3.4);
    const baseR = CELL * 0.22;
    const r = baseR * (0.85 + 0.32 * pulse);
    c.fillStyle    = '#fff3b0';
    c.shadowColor  = 'rgba(255, 243, 176, 0.85)';
    c.shadowBlur   = 14 * pulse + 6;
    for (const p of POWER) {
      if (!dots[p.y][p.x]) continue; // hide if Pac-Man has eaten it
      const x = (p.x + 0.5) * CELL;
      const y = (p.y + 0.5) * CELL;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.shadowBlur = 0;
  }

  /**
   * Pac-Man, rendered as a stylised Warpzone "W".
   *
   * The W is drawn as a 5-point zigzag (A → B → C → D → E) so that its
   * three peaks (A, C, E) face +x in local coordinates — i.e. the
   * direction of motion / toward the ghost being chased — while the two
   * valleys (B, D) sit on the back side of the body.
   *
   *      A┐         ┌── direction of motion (+x)
   *       \   ┌C    │
   *        \ /      ▼
   *      B┤ │
   *        / \
   *       /   └C wait - sketch is illustrative, not to scale.
   *      E┘
   *
   * The "mouth" animation moves the two valleys (B, D) along the x axis:
   * when the mouth is closed they sit just behind the central peak so the
   * W reads as a fat, near-solid blob; when the mouth is wide-open they
   * recede deep into the body, carving out two sharp V-notches between
   * the peaks. PAC.mouth (already oscillating on every frame) drives the
   * normalised mouthD ∈ [0, 1] used here.
   */
  function drawPacman() {
    const p = pixelPos(PAC);
    const angle = Math.atan2(PAC.dy, PAC.dx);
    const r = CELL * 0.42;

    c.save();
    c.translate(p.x, p.y);
    c.rotate(angle);

    const mouthD  = (PAC.mouth - 0.02) / 0.83;       // 0 = closed, 1 = open
    const valleyX = 0.4 * r - mouthD * 1.15 * r;     // back-and-forth chomp

    // Body — thick yellow neon stroke that traces the W zigzag.
    c.strokeStyle = '#ffd84a';
    c.lineWidth   = r * 0.46;
    c.lineJoin    = 'round';
    c.lineCap     = 'round';
    c.shadowColor = 'rgba(255, 216, 74, 0.78)';
    c.shadowBlur  = 12;

    c.beginPath();
    c.moveTo(0.85 * r, -0.85 * r);   // A — outer-top peak
    c.lineTo(valleyX,  -0.45 * r);   // B — upper valley (animated)
    c.lineTo(0.55 * r,  0);          // C — central peak
    c.lineTo(valleyX,  +0.45 * r);   // D — lower valley (animated)
    c.lineTo(0.85 * r, +0.85 * r);   // E — outer-bottom peak
    c.stroke();

    // Pearly inner highlight along the same path so the W catches the
    // light like Pac-Man's body did.
    c.shadowBlur  = 0;
    c.strokeStyle = 'rgba(255, 252, 220, 0.55)';
    c.lineWidth   = r * 0.16;
    c.beginPath();
    c.moveTo(0.85 * r, -0.85 * r);
    c.lineTo(valleyX,  -0.45 * r);
    c.lineTo(0.55 * r,  0);
    c.lineTo(valleyX,  +0.45 * r);
    c.lineTo(0.85 * r, +0.85 * r);
    c.stroke();

    c.restore();
  }

  /** Classic Pac-Man-shaped ghost with eyes that look in the move direction. */
  function drawGhost(g) {
    const gp = pixelPos(g);
    const r  = CELL * 0.42;

    c.save();
    c.translate(gp.x, gp.y);

    if (g.state === 'eaten') {
      // While "eaten" we draw just the eyes drifting back — classic Pac-Man.
      drawGhostEyes(0, 0, r, g.dx, g.dy, 0.85);
      c.restore();
      return;
    }

    // Body: domed top + 3-bump wavy bottom
    c.fillStyle    = g.body;
    c.shadowColor  = g.glow;
    c.shadowBlur   = 12;
    c.beginPath();
    c.arc(0, -r * 0.08, r, Math.PI, 0, false);
    c.lineTo(r, r * 0.78);
    const bumps = 3;
    const w     = (2 * r) / bumps;
    for (let i = 0; i < bumps; i++) {
      const xMid = r - i * w - w / 2;
      const xEnd = r - (i + 1) * w;
      c.lineTo(xMid, r * 1.0);
      c.lineTo(xEnd, r * 0.78);
    }
    c.closePath();
    c.fill();
    c.shadowBlur = 0;

    drawGhostEyes(0, 0, r, g.dx, g.dy, 1);

    c.restore();
  }

  function drawGhostEyes(cx, cy, r, lookDx, lookDy, alpha) {
    const eyeR   = r * 0.30;
    const pupilR = r * 0.14;
    const sep    = r * 0.36;
    const yOff   = -r * 0.18;

    c.globalAlpha = alpha;
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(cx - sep, cy + yOff, eyeR, 0, Math.PI * 2);
    c.arc(cx + sep, cy + yOff, eyeR, 0, Math.PI * 2);
    c.fill();

    c.fillStyle = '#0a1234';
    const pdx = lookDx * eyeR * 0.42;
    const pdy = lookDy * eyeR * 0.42;
    c.beginPath();
    c.arc(cx - sep + pdx, cy + yOff + pdy, pupilR, 0, Math.PI * 2);
    c.arc(cx + sep + pdx, cy + yOff + pdy, pupilR, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Animation loop + lifecycle
  // ------------------------------------------------------------------
  function frame(now) {
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    if (active) {
      update(dt);
      draw();
      requestAnimationFrame(frame);
    }
  }

  // Pause when the panel is off-screen — saves CPU on long pages.
  if (window.IntersectionObserver) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const wasActive = active;
        active = e.isIntersecting;
        if (active && !wasActive) {
          lastFrame = performance.now();
          requestAnimationFrame(frame);
        }
      }
    }, { threshold: 0.05 });
    io.observe(wrap);
  } else {
    active = true;
    requestAnimationFrame(frame);
  }

  wrap.addEventListener('mouseenter', () => { hover = true;  });
  wrap.addEventListener('mouseleave', () => { hover = false; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) active = false;
  });
})();
