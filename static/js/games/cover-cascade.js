// Cover Cascade: a match-3 puzzle where the tiles are covers from your own shelf.
// Swap two neighbouring tiles to line up 3 or more of the same cover. Matches clear, the tiles
// above fall down, and new ones drop in from the top; if those make new matches it's a cascade,
// and every cascade step multiplies the points. 60 seconds on the clock, +1 s for every match.
//
// The board is a grid[row][col] of tile objects. Each tile also has a *visual* position (x, y in
// grid units, can be fractional) that animates towards its real grid slot. The rules only ever
// look at the grid; the drawing only looks at the visual positions. That split is what lets the
// tiles slide and fall smoothly while the logic stays simple.
import { html, setHTML } from '../ui.js';
import { playSound } from '../sound.js';
import { finishRun, startScreen, loadImage, onePerSeries, shuffle, seriesTitle } from './common.js';
import { createParticles, createPopups, createShake, fitCanvas, ease, lerp, roundRectPath, drawCover } from './fx.js';

export const coverCascade = {
  id: 'cover-cascade',
  title: 'Cover Cascade',
  blurb: 'Match three or more of your own covers. Chain cascades for big combos before the clock runs out.',
  unit: 'pts',
  minEntries: 6,
  mount,
};

const N = 8;              // 8 × 8 board
const KINDS = 6;          // six different covers
const HUD = 64;           // space above the board for the score and the time bar
const GRAVITY = 38;       // rows per second², used for the falling tiles
const START_TIME = 60;
const HINT_AFTER = 6;     // seconds of doing nothing before a hint pulses
const FALLBACK = ['#ff4d6d', '#ffb703', '#4cc9f0', '#80ed99', '#c77dff', '#ff8fab'];

/** '#rrggbb' → [r, g, b]; null for anything else. */
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Give each series a border colour: its AniList colour when it has one that isn't too close to a
 * colour already used, otherwise a colour from a fixed palette. Distinct borders keep the tiles
 * readable even if a cover picture fails to load.
 */
function pickColours(picks) {
  const used = [];
  const tooClose = (c) => used.some((u) => Math.hypot(c[0] - u[0], c[1] - u[1], c[2] - u[2]) < 90);
  const colours = picks.map((e) => {
    const c = rgb(e && e.meta.anilist && e.meta.anilist.color);
    if (c && !tooClose(c) && c[0] + c[1] + c[2] > 160) { used.push(c); return e.meta.anilist.color; }
    return null;
  });
  return colours.map((c) => {
    if (c) return c;
    const free = FALLBACK.find((f) => !tooClose(rgb(f))) || FALLBACK[used.length % FALLBACK.length];
    used.push(rgb(free));
    return free;
  });
}

function mount(el, { entries }) {
  let raf = 0;
  let endTimer = null;
  let cleanupRun = () => {};
  let gone = false;

  // Six different series, preferring ones with a cover. If the shelf has fewer than six series,
  // top up with other entries so there are always six kinds of tile.
  const withCover = entries.filter((e) => e.meta.image);
  let picks = shuffle(onePerSeries(withCover)).slice(0, KINDS);
  for (const e of shuffle(entries)) {
    if (picks.length >= KINDS) break;
    if (!picks.includes(e)) picks.push(e);
  }
  picks = picks.slice(0, KINDS);
  const colours = pickColours(picks);
  const images = new Array(KINDS).fill(null);
  const loading = Promise.all(picks.map((e, i) => loadImage(e.meta.image).then((img) => { images[i] = img; }).catch(() => {})));

  function start() {
    cleanupRun();
    setHTML(el, html`<div class="cascade">
      <canvas class="cascade-canvas" aria-label="Cover Cascade game"></canvas>
      <p class="faint small">Drag a tile onto a neighbour, or click one tile and then a neighbour, to swap them.</p>
    </div>`);
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');

    // Board geometry, recomputed on resize. `cell` is the size of one tile in CSS pixels.
    const geo = { cell: 56, bx: 0, by: HUD };
    const faces = []; // pre-drawn tile pictures, one small canvas per kind
    const heightFor = (w) => {
      // The board is square, so it must fit the window's HEIGHT too (top bar, title and panel
      // padding take about 240 px). Otherwise the bottom rows end up below the fold.
      const fitsHeight = Math.max(280, window.innerHeight - 240 - HUD - 14);
      geo.cell = Math.floor(Math.min(w - 24, 560, fitsHeight) / N);
      return HUD + geo.cell * N + 14;
    };
    const onResize = (size) => {
      geo.bx = Math.round((size.w - geo.cell * N) / 2);
      paintFaces();
    };

    /**
     * Drawing a cover clipped into a rounded square is relatively slow (clip + image scaling),
     * and the board shows 64 of them every frame. So each of the 6 faces is drawn ONCE into a
     * small off-screen canvas, and the game then just copies those. Repainted on resize.
     */
    function paintFaces() {
      const dpr = window.devicePixelRatio || 1;
      const s = geo.cell;
      for (let k = 0; k < KINDS; k += 1) {
        const c = faces[k] || document.createElement('canvas');
        c.width = Math.round(s * dpr);
        c.height = Math.round(s * dpr);
        const f = c.getContext('2d');
        f.setTransform(dpr, 0, 0, dpr, 0, 0);
        f.clearRect(0, 0, s, s);
        const pad = 3;
        roundRectPath(f, pad, pad, s - pad * 2, s - pad * 2, s * 0.18);
        f.save();
        f.clip();
        f.fillStyle = colours[k];
        f.fillRect(0, 0, s, s);
        if (images[k]) {
          drawCover(f, images[k], pad, pad, s - pad * 2, s - pad * 2);
        } else { // no picture: a big initial on the colour
          f.fillStyle = 'rgba(0,0,0,0.55)';
          f.font = `800 ${Math.round(s * 0.45)}px system-ui, sans-serif`;
          f.textAlign = 'center';
          f.textBaseline = 'middle';
          f.fillText((seriesTitle(picks[k]) || '?').trim().charAt(0).toUpperCase(), s / 2, s / 2 + 1);
        }
        const shine = f.createLinearGradient(0, 0, 0, s); // a soft glossy highlight on top
        shine.addColorStop(0, 'rgba(255,255,255,0.22)');
        shine.addColorStop(0.45, 'rgba(255,255,255,0)');
        shine.addColorStop(1, 'rgba(0,0,0,0.25)');
        f.fillStyle = shine;
        f.fillRect(0, 0, s, s);
        f.restore();
        roundRectPath(f, pad, pad, s - pad * 2, s - pad * 2, s * 0.18);
        f.lineWidth = 3;
        f.strokeStyle = colours[k];
        f.stroke();
        faces[k] = c;
      }
    }

    const fit = fitCanvas(canvas, ctx, heightFor, 960, onResize);
    const S = fit.size;
    const particles = createParticles();
    const popups = createPopups();
    const shake = createShake();

    // ---------------------------------------------------------------- state
    let grid = [];
    let phase = 'fall';     // idle | swap | swapback | clear | fall | over
    let phaseTimer = 0;
    let pending = null;     // the two cells being swapped
    let selected = null;    // [r, c] after the first click of click-click
    let drag = null;        // {cell, x, y} while the pointer is held down
    let score = 0;
    let shownScore = 0;     // the number on screen counts up towards `score`
    let cascade = 0;
    let bestCascade = 0;
    let matches = 0;
    let timeLeft = START_TIME;
    let idleTime = 0;
    let hint = null;
    let time = 0;
    let comboText = null;   // {text, age}
    let paused = false;
    let nextId = 1;

    const makeTile = (kind, r, c, special = null) => ({ id: nextId++, kind, special, x: c, y: r, vy: 0, scale: 1, dying: false, squash: 0 });
    const inside = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
    const centre = (r, c) => [geo.bx + (c + 0.5) * geo.cell, geo.by + (r + 0.5) * geo.cell];

    /** Fill the board so that it starts with NO ready-made matches (and at least one move). */
    function newBoard() {
      for (let tries = 0; tries < 50; tries += 1) {
        grid = [];
        for (let r = 0; r < N; r += 1) {
          grid.push([]);
          for (let c = 0; c < N; c += 1) {
            // Avoid a kind that would complete 3 in a row with the two tiles to the left, or the two above.
            const banned = new Set();
            if (c >= 2 && grid[r][c - 1].kind === grid[r][c - 2].kind) banned.add(grid[r][c - 1].kind);
            if (r >= 2 && grid[r - 1][c].kind === grid[r - 2][c].kind) banned.add(grid[r - 1][c].kind);
            const options = [...Array(KINDS).keys()].filter((k) => !banned.has(k));
            grid[r].push(makeTile(options[Math.floor(Math.random() * options.length)], r, c));
          }
        }
        if (findMove()) return;
      }
    }

    // ---------------------------------------------------------------- match detection
    /**
     * Find every run of 3+ equal tiles. Scan each row left to right: keep extending the run while
     * the next tile has the same kind; when it changes (or the row ends), a run of length ≥ 3 is a
     * match. Then do the same down each column. Colour bombs (kind -1) never match by kind.
     */
    function findRuns() {
      const runs = [];
      for (const dir of ['h', 'v']) {
        for (let a = 0; a < N; a += 1) {
          let startB = 0;
          for (let b = 1; b <= N; b += 1) {
            const cur = b < N ? (dir === 'h' ? grid[a][b] : grid[b][a]) : null;
            const first = dir === 'h' ? grid[a][startB] : grid[startB][a];
            if (cur && first && cur.kind === first.kind && cur.kind >= 0) continue; // run goes on
            if (b - startB >= 3 && first && first.kind >= 0) {
              const cells = [];
              for (let k = startB; k < b; k += 1) cells.push(dir === 'h' ? [a, k] : [k, a]);
              runs.push({ dir, cells, kind: first.kind });
            }
            startB = b;
          }
        }
      }
      return runs;
    }

    function swapGrid(a, b) {
      const t = grid[a[0]][a[1]];
      grid[a[0]][a[1]] = grid[b[0]][b[1]];
      grid[b[0]][b[1]] = t;
    }

    /** A swap that would make a match (or a swap with a bomb), or null when the board is stuck. */
    function findMove() {
      for (let r = 0; r < N; r += 1) {
        for (let c = 0; c < N; c += 1) {
          if (grid[r][c].special === 'bomb') return [[r, c], inside(r, c + 1) ? [r, c + 1] : [r, c - 1]];
          for (const [dr, dc] of [[0, 1], [1, 0]]) {
            const o = [r + dr, c + dc];
            if (!inside(o[0], o[1])) continue;
            swapGrid([r, c], o); // try it, look, and undo it
            const ok = findRuns().length > 0;
            swapGrid([r, c], o);
            if (ok) return [[r, c], o];
          }
        }
      }
      return null;
    }

    // ---------------------------------------------------------------- swapping
    function tween(tile, tr, tc, d = 0.16) {
      tile.tw = { fx: tile.x, fy: tile.y, tx: tc, ty: tr, t: 0, d };
    }

    function trySwap(a, b) {
      if (phase !== 'idle' || timeLeft <= 0) return;
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) !== 1) return; // neighbours only
      idleTime = 0;
      hint = null;
      swapGrid(a, b);
      tween(grid[a[0]][a[1]], a[0], a[1]);
      tween(grid[b[0]][b[1]], b[0], b[1]);
      pending = [a, b];
      phase = 'swap';
      phaseTimer = 0.16;
      playSound('tick');
    }

    function afterSwap() {
      const [a, b] = pending;
      const ta = grid[a[0]][a[1]];
      const tb = grid[b[0]][b[1]];
      // A colour bomb swapped with a tile clears every tile of that tile's cover.
      if (ta.special === 'bomb' || tb.special === 'bomb') {
        cascade = 1;
        const clear = new Set();
        const other = ta.special === 'bomb' ? tb : ta;
        clear.add(a[0] * N + a[1]);
        clear.add(b[0] * N + b[1]);
        const all = other.special === 'bomb'; // two bombs: the whole board
        ta.fired = true; // the bomb has done its job here; don't let it fire a second time below
        tb.fired = tb.special === 'bomb' || tb.fired;
        if (ta.special !== 'bomb') ta.fired = false;
        for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) {
          if (all || grid[r][c].kind === other.kind) clear.add(r * N + c);
        }
        shake.add(0.6);
        clearCells(clear, [], 1);
        return;
      }
      if (findRuns().length) { cascade = 0; resolve(pending); return; }
      // No match: slide them back where they were.
      swapGrid(a, b);
      tween(grid[a[0]][a[1]], a[0], a[1]);
      tween(grid[b[0]][b[1]], b[0], b[1]);
      phase = 'swapback';
      phaseTimer = 0.18;
      playSound('error');
    }

    // ---------------------------------------------------------------- clearing
    /** One step of the cascade: find matches, clear them (or stop when there are none). */
    function resolve(swapped) {
      const runs = findRuns();
      if (!runs.length) {
        cascade = 0;
        phase = 'idle';
        idleTime = 0;
        if (!findMove()) reshuffle();
        return;
      }
      cascade += 1;
      bestCascade = Math.max(bestCascade, cascade);
      const clear = new Set();
      const creates = [];
      for (const run of runs) {
        matches += 1;
        for (const [r, c] of run.cells) clear.add(r * N + c);
        if (run.cells.length >= 4) {
          // The special tile appears where you swapped (if that was in the run), else mid-run.
          const at = (swapped || []).find(([sr, sc]) => run.cells.some(([r, c]) => r === sr && c === sc))
            || run.cells[Math.floor(run.cells.length / 2)];
          const special = run.cells.length >= 5 ? 'bomb' : run.dir === 'h' ? 'row' : 'col';
          if (!creates.some((k) => k.r === at[0] && k.c === at[1])) creates.push({ r: at[0], c: at[1], kind: run.kind, special });
        }
      }
      timeLeft += runs.length; // +1 s per match
      const [px, py] = centre(runs[0].cells[0][0], runs[0].cells[0][1]);
      popups.add(px, py - 20, `+${runs.length}s`, '#9be7ff', 14, 0.8);
      clearCells(clear, creates, runs.length);
    }

    /**
     * Clear a set of cells (keys r*N+c). Special tiles caught in the blast fire too: a line tile
     * adds its whole row or column, a bomb adds every tile of a random cover. We keep a "queue"
     * of cells still to check, so a line that hits another line also fires that one.
     */
    function clearCells(clear, creates) {
      const queue = [...clear];
      while (queue.length) {
        const key = queue.pop();
        const r = Math.floor(key / N);
        const c = key % N;
        const t = grid[r][c];
        if (!t || !t.special || t.fired) continue;
        if (creates.some((k) => k.r === r && k.c === c)) continue;
        t.fired = true;
        const add = (rr, cc) => { const k = rr * N + cc; if (!clear.has(k)) { clear.add(k); queue.push(k); } };
        if (t.special === 'row') for (let cc = 0; cc < N; cc += 1) add(r, cc);
        if (t.special === 'col') for (let rr = 0; rr < N; rr += 1) add(rr, c);
        if (t.special === 'bomb') {
          const kind = Math.floor(Math.random() * KINDS);
          for (let rr = 0; rr < N; rr += 1) for (let cc = 0; cc < N; cc += 1) if (grid[rr][cc].kind === kind) add(rr, cc);
        }
        shake.add(0.3);
      }
      // The tiles that turn into special tiles stay on the board.
      for (const k of creates) clear.delete(k.r * N + k.c);
      for (const k of creates) {
        const t = grid[k.r][k.c];
        t.kind = k.special === 'bomb' ? -1 : k.kind;
        t.special = k.special;
        t.fired = false;
        t.scale = 1.5; // "pop" to show it's new
        const [x, y] = centre(k.r, k.c);
        particles.burst(x, y, '#ffffff', 20, { speed: 260, size: 3 });
      }

      // Score: 10 per tile, times the cascade step (×1, ×2, ×3 ...).
      const gained = clear.size * 10 * Math.max(1, cascade);
      score = Math.min(10_000_000, score + gained);
      let sx = 0;
      let sy = 0;
      for (const key of clear) {
        const r = Math.floor(key / N);
        const c = key % N;
        const t = grid[r][c];
        t.dying = true;
        const [x, y] = centre(r, c);
        sx += x; sy += y;
        particles.burst(x, y, t.kind >= 0 ? colours[t.kind] : '#ffffff', 8, { speed: 200, size: 3, life: 0.55 });
      }
      if (clear.size) popups.add(sx / clear.size, sy / clear.size, `+${gained}`, '#ffffff', 20, 1);
      if (cascade >= 2) {
        comboText = { text: `Combo x${cascade}`, age: 0 };
        shake.add(0.15 * cascade);
        playSound('chime');
      } else {
        playSound('success');
      }
      phase = 'clear';
      phaseTimer = 0.2;
    }

    /**
     * Gravity step. In each column, walk from the bottom up and move every surviving tile down
     * to the lowest free slot ("compacting" the column). Whatever is left at the top is empty,
     * so new tiles are created there, starting ABOVE the board so they visibly fall in.
     * The grid changes instantly; only the visual y lags behind and falls with real gravity.
     */
    function collapse() {
      for (let c = 0; c < N; c += 1) {
        let write = N - 1;
        for (let r = N - 1; r >= 0; r -= 1) {
          const t = grid[r][c];
          if (t && !t.dying) {
            grid[write][c] = t;
            write -= 1;
          }
        }
        const missing = write + 1;
        for (let r = write; r >= 0; r -= 1) {
          // New tile starts `missing` rows higher than its slot, so the whole stack drops together.
          const t = makeTile(Math.floor(Math.random() * KINDS), r - missing - 0.3, c);
          grid[r][c] = t;
        }
      }
      phase = 'fall';
    }

    function reshuffle() {
      popups.add(S.w / 2, geo.by + geo.cell * 4, 'No moves · shuffling', '#ffffff', 22, 1.3);
      newBoard();
      for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) grid[r][c].scale = 0;
    }

    // ---------------------------------------------------------------- update
    function update(dt) {
      time += dt;
      particles.update(dt);
      popups.update(dt);
      shake.update(dt);
      if (comboText) { comboText.age += dt; if (comboText.age > 1.1) comboText = null; }
      shownScore += (score - shownScore) * Math.min(1, dt * 10); // eases towards the real score
      if (phase === 'over') return;

      timeLeft = Math.max(0, timeLeft - dt);
      if (phase === 'idle') {
        idleTime += dt;
        if (idleTime > HINT_AFTER && !hint) hint = findMove();
        if (timeLeft <= 0) { endGame(); return; }
      }

      let moving = false;
      for (let r = 0; r < N; r += 1) {
        for (let c = 0; c < N; c += 1) {
          const t = grid[r][c];
          if (t.tw) { // sliding (swap)
            t.tw.t += dt;
            const k = ease.inOutCubic(Math.min(1, t.tw.t / t.tw.d));
            t.x = lerp(t.tw.fx, t.tw.tx, k);
            t.y = lerp(t.tw.fy, t.tw.ty, k);
            if (t.tw.t >= t.tw.d) t.tw = null;
          }
          if (t.dying) t.scale = Math.max(0, t.scale - dt * 6);
          else t.scale += (1 - t.scale) * Math.min(1, dt * 12); // ease back to normal size
          // Falling: speed grows with gravity (v += g·dt, y += v·dt). When it reaches its slot it
          // stops and gets a little squash, which reads as a soft landing.
          if (phase === 'fall' && t.y < r) {
            t.vy += GRAVITY * dt;
            t.y += t.vy * dt;
            if (t.y >= r) { t.y = r; t.vy = 0; t.squash = 1; } else moving = true;
          }
          t.squash = Math.max(0, t.squash - dt * 5);
        }
      }

      if (phase === 'swap' || phase === 'swapback' || phase === 'clear') {
        phaseTimer -= dt;
        if (phaseTimer <= 0) {
          if (phase === 'swap') afterSwap();
          else if (phase === 'swapback') { phase = 'idle'; idleTime = 0; }
          else collapse();
        }
      } else if (phase === 'fall' && !moving) {
        resolve(null); // landed: did the new tiles make more matches? (that's a cascade)
      }
    }

    function endGame() {
      phase = 'over';
      selected = null;
      endTimer = setTimeout(() => {
        cleanupRun();
        finishRun(el, coverCascade, {
          score: Math.round(score),
          headline: "Time's up",
          detail: `${matches} ${matches === 1 ? 'match' : 'matches'} · best combo x${Math.max(1, bestCascade)}`,
          again: start,
        });
      }, 900);
    }

    // ---------------------------------------------------------------- drawing
    function drawBackground() {
      ctx.fillStyle = '#07070a';
      ctx.fillRect(0, 0, S.w, S.h);
      // Soft coloured lights drifting behind the board, one per cover colour (parallax depth).
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < KINDS; k += 1) {
        const x = S.w / 2 + Math.cos(time * 0.2 + k * 1.05) * S.w * 0.38;
        const y = S.h / 2 + Math.sin(time * 0.27 + k * 2.1) * S.h * 0.35;
        const g = ctx.createRadialGradient(x, y, 0, x, y, S.h * 0.45);
        g.addColorStop(0, `${colours[k]}26`); // hex alpha 0x26 ≈ 15 %
        g.addColorStop(1, `${colours[k]}00`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S.w, S.h);
      }
      ctx.restore();
      // The board well
      roundRectPath(ctx, geo.bx - 6, geo.by - 6, geo.cell * N + 12, geo.cell * N + 12, 14);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) {
        if ((r + c) % 2) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fillRect(geo.bx + c * geo.cell, geo.by + r * geo.cell, geo.cell, geo.cell);
      }
    }

    function drawTile(t, r, c) {
      const s = geo.cell;
      let scale = t.scale;
      const isSel = selected && selected[0] === r && selected[1] === c;
      const isHint = hint && hint.some(([hr, hc]) => hr === r && hc === c);
      if (isSel) scale *= 1.08;
      if (isHint) scale *= 1 + 0.07 * Math.sin(time * 7);
      if (scale <= 0.01) return;
      const cx = geo.bx + (t.x + 0.5) * s;
      const cy = geo.by + (t.y + 0.5) * s;
      if (cy < geo.by - s / 2) return; // still above the board, waiting to fall in
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale * (1 + t.squash * 0.08), scale * (1 - t.squash * 0.1));
      if (t.special === 'bomb') {
        // Colour bomb: a dark orb with a spinning ring made of all six cover colours.
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = s * 0.09;
        for (let k = 0; k < KINDS; k += 1) {
          const a0 = time * 3 + (k / KINDS) * Math.PI * 2;
          ctx.strokeStyle = colours[k];
          ctx.beginPath(); ctx.arc(0, 0, s * 0.32, a0, a0 + (Math.PI * 2) / KINDS - 0.08); ctx.stroke();
        }
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.22);
        g.addColorStop(0, '#fff');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, s * 0.22 * (1 + 0.15 * Math.sin(time * 8)), 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.drawImage(faces[t.kind], -s / 2, -s / 2, s, s);
        if (t.special === 'row' || t.special === 'col') {
          // Line tile: glowing stripes that shimmer along the direction it will clear.
          ctx.save();
          if (t.special === 'col') ctx.rotate(Math.PI / 2);
          ctx.globalCompositeOperation = 'lighter';
          const glow = 0.5 + 0.3 * Math.sin(time * 10);
          ctx.fillStyle = `rgba(255,255,255,${glow})`;
          ctx.fillRect(-s * 0.42, -s * 0.12, s * 0.84, s * 0.07);
          ctx.fillRect(-s * 0.42, s * 0.05, s * 0.84, s * 0.07);
          ctx.restore();
        }
      }
      if (isSel || isHint) {
        roundRectPath(ctx, -s / 2 + 1, -s / 2 + 1, s - 2, s - 2, s * 0.2);
        ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawHud() {
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.font = '700 24px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(Math.round(shownScore).toLocaleString(), geo.bx, 22);
      ctx.textAlign = 'right';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = timeLeft < 10 ? '#ff6b6b' : '#bbb';
      ctx.fillText(`${Math.ceil(timeLeft)} s`, geo.bx + geo.cell * N, 22);
      // Time bar: full at 60 s (it can go over with bonus seconds; the bar just stays full).
      const w = geo.cell * N;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRectPath(ctx, geo.bx, 42, w, 6, 3); ctx.fill();
      const k = Math.min(1, timeLeft / START_TIME);
      ctx.fillStyle = timeLeft < 10 ? '#ff6b6b' : '#ffffff';
      if (k > 0) { roundRectPath(ctx, geo.bx, 42, Math.max(6, w * k), 6, 3); ctx.fill(); }
      ctx.restore();
    }

    function draw() {
      ctx.save();
      shake.apply(ctx);
      drawBackground();
      // Clip to the board so tiles that are falling in from above stay hidden until they arrive.
      ctx.save();
      ctx.beginPath();
      ctx.rect(geo.bx - 6, geo.by - 6, geo.cell * N + 12, geo.cell * N + 12);
      ctx.clip();
      for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) drawTile(grid[r][c], r, c);
      ctx.restore();
      particles.draw(ctx);
      popups.draw(ctx);
      ctx.restore();
      drawHud();
      if (comboText) {
        const t = comboText.age / 1.1;
        ctx.save();
        ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.round(30 + 18 * ease.outBack(Math.min(1, t * 4)))}px system-ui, sans-serif`;
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        const y = geo.by + geo.cell * N * 0.42;
        ctx.strokeText(comboText.text, S.w / 2, y);
        ctx.fillStyle = '#ffe066';
        ctx.fillText(comboText.text, S.w / 2, y);
        ctx.restore();
      }
      if (paused) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, S.w, S.h);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = '700 22px system-ui, sans-serif';
        ctx.fillText('Paused', S.w / 2, S.h / 2);
      }
    }

    // ---------------------------------------------------------------- input
    const cellAt = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (S.w / rect.width);
      const y = (ev.clientY - rect.top) * (S.h / rect.height);
      const c = Math.floor((x - geo.bx) / geo.cell);
      const r = Math.floor((y - geo.by) / geo.cell);
      return { r, c, x, y, ok: inside(r, c) };
    };
    const onDown = (ev) => {
      ev.preventDefault();
      const p = cellAt(ev);
      if (!p.ok || phase !== 'idle' || timeLeft <= 0) return;
      idleTime = 0;
      hint = null;
      if (selected && Math.abs(selected[0] - p.r) + Math.abs(selected[1] - p.c) === 1) {
        trySwap(selected, [p.r, p.c]); // second click on a neighbour: swap
        selected = null;
        return;
      }
      selected = selected && selected[0] === p.r && selected[1] === p.c ? null : [p.r, p.c];
      drag = { cell: [p.r, p.c], x: p.x, y: p.y };
    };
    const onMove = (ev) => {
      if (!drag) return;
      const p = cellAt(ev);
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < geo.cell * 0.4) return; // not far enough yet
      // Drag direction = whichever axis moved more.
      const [r, c] = drag.cell;
      const target = Math.abs(dx) > Math.abs(dy) ? [r, c + Math.sign(dx)] : [r + Math.sign(dy), c];
      drag = null;
      selected = null;
      if (inside(target[0], target[1])) trySwap([r, c], target);
    };
    const onUp = () => { drag = null; };
    const onVisibility = () => { paused = document.hidden; };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.addEventListener('visibilitychange', onVisibility);
    cleanupRun = () => {
      cancelAnimationFrame(raf);
      fit.dispose();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.removeEventListener('visibilitychange', onVisibility);
      cleanupRun = () => {};
    };

    // ---------------------------------------------------------------- the loop
    newBoard();
    for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) grid[r][c].y = r - N - 0.5 - c * 0.15; // opening drop
    let last = performance.now();
    function frame(now) {
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!paused) {
        // Two half-steps per frame keep fast falls smooth without a full fixed-step loop.
        update(elapsed / 2);
        update(elapsed / 2);
      }
      draw();
      if (!gone) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  startScreen(el, {
    title: 'Cover Cascade',
    rules: [
      'Swap two neighbouring covers (drag, or click one then the other) to line up 3 or more of the same show.',
      'New covers fall in from the top. Matches they make by themselves are cascades: x2, x3, x4 the points.',
      'Match 4 for a line tile that clears its row or column; match 5 for a colour bomb that clears every tile of one show.',
      'You have 60 seconds, and every match adds a second.',
    ],
    onStart: () => { loading.then(() => { if (!gone) start(); }); },
  });

  return () => { gone = true; clearTimeout(endTimer); cleanupRun(); };
}
