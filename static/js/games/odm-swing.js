// ODM Swing: hold to fire a grapple at the nearest anchor ahead, release to let go.
// Stay off the ground, where the giants walk. Score is distance in metres.
//
// Physics: gravity pulls the player down; while hooked, the rope is a "distance constraint".
// If the player ends a step further than the rope length from the anchor, we pull them back onto
// the circle and remove the part of their velocity that points away from the anchor. Holding also
// reels the rope in a little, which pumps energy into the swing (like pulling up on a playground swing).
//
// Visuals: everything is drawn with the Canvas 2D API. The parts that never change shape (sky, the
// distant wall, the two forest layers, the grass) are painted once into offscreen canvases and
// copied in each frame; see art.js for why that is so much faster.
import { html, setHTML } from '../ui.js';
import { finishRun, startScreen, clamp } from './common.js';
import { playSound } from '../sound.js';
import {
  Particles, Shake, makeCanvas, ridge, drawTiled, drawGlow, lerp, gameFont, reducedMotion,
} from './art.js';

const H = 420;
const GROUND = H - 34;
const GRAVITY = 1500;      // px/s²
const REEL_SPEED = 140;    // px/s the rope shortens while held
const MIN_ROPE = 60;
const RANGE = 360;         // how far the grapple reaches
const PX_PER_M = 12;
const FIRE_MS = 80;        // how long the grapple takes to fly out (purely visual)
const SLOWMO_S = 1.6;      // the dramatic pause after touching the ground (real seconds)

export const odmSwing = {
  id: 'odm-swing',
  title: 'ODM Swing',
  blurb: 'Grapple from anchor to anchor above the treeline. Touch the ground and the giants get you.',
  unit: 'm',
  theme: { label: 'Attack on Titan', match: /attack on titan|shingeki/i },
  mount,
};

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// ---------------------------------------------------------------------------------------------
// The cached scenery. Parallax factors (how fast each layer follows the camera):
//   sky 0 (fixed) · wall 0.08 · far forest 0.25 · near forest 0.5 · giants 0.85 · trees/ground 1
function buildScene(W, dpr) {
  const rnd = Math.random;

  // Dusk sky: does not scroll at all, so it is exactly one screen wide.
  const sky = makeCanvas(W, H, dpr);
  const g = sky.ctx.createLinearGradient(0, 0, 0, GROUND);
  g.addColorStop(0, '#1b1838');
  g.addColorStop(0.45, '#4a2f5a');
  g.addColorStop(0.8, '#c4604a');
  g.addColorStop(1, '#f0a35c');
  sky.ctx.fillStyle = g;
  sky.ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i += 1) {
    sky.ctx.fillStyle = `rgba(255,240,230,${0.2 + rnd() * 0.5})`;
    sky.ctx.fillRect(rnd() * W, rnd() * 130, 1.2, 1.2);
  }
  sky.ctx.globalCompositeOperation = 'lighter';
  drawGlow(sky.ctx, 'rgb(255,150,80)', W * 0.72, GROUND - 70, 170, 0.6);
  sky.ctx.globalCompositeOperation = 'source-over';
  sky.ctx.fillStyle = '#ffcf8a';
  sky.ctx.beginPath(); sky.ctx.arc(W * 0.72, GROUND - 70, 30, 0, Math.PI * 2); sky.ctx.fill();

  // The city wall: a long, flat silhouette with battlements and the occasional gate tower.
  const wallW = 1400;
  const wall = makeCanvas(wallW, 90, dpr);
  wall.ctx.fillStyle = '#3a2a44';
  wall.ctx.fillRect(0, 40, wallW, 50);
  for (let x = 0; x < wallW; x += 14) wall.ctx.fillRect(x, 34, 8, 8); // battlements
  for (const tx of [180, 760, 1180]) {
    wall.ctx.fillRect(tx, 10, 46, 80);
    wall.ctx.beginPath(); wall.ctx.moveTo(tx - 6, 12); wall.ctx.lineTo(tx + 23, -8 + 10); wall.ctx.lineTo(tx + 52, 12); wall.ctx.fill();
  }

  // A forest layer: tall thin trunks with round crowns. Items near the edge are drawn twice
  // (at x and x ± width) so the tile repeats without a visible seam.
  function forest(width, height, trunkW, colour, count) {
    const layer = makeCanvas(width, height, dpr);
    const c = layer.ctx;
    c.fillStyle = colour;
    const floor = ridge(width, [[3, 6, 0.4], [7, 3, 1.3]]);
    c.beginPath();
    c.moveTo(0, height);
    for (let x = 0; x <= width; x += 6) c.lineTo(x, height - 18 + floor(x));
    c.lineTo(width, height);
    c.fill();
    for (let i = 0; i < count; i += 1) {
      const x = (i + rnd() * 0.7) * (width / count);
      const w = trunkW * (0.7 + rnd() * 0.6);
      const crown = 40 + rnd() * 50;
      const top = 30 + rnd() * 30;
      // Pick the random crown blobs ONCE, so all three copies of this tree look identical.
      const blobs = Array.from({ length: 4 }, () => [(rnd() - 0.5) * crown, 20 + rnd() * 50, crown * (0.35 + rnd() * 0.3)]);
      for (const ox of [x - width, x, x + width]) {
        c.fillRect(ox - w / 2, top, w, height);
        for (const [dx, y, r] of blobs) {
          c.beginPath(); c.arc(ox + dx, y, r, 0, Math.PI * 2); c.fill();
        }
      }
    }
    return layer;
  }
  const far = forest(1200, GROUND - 60, 10, '#2c2340', 14);
  const near = forest(1100, GROUND - 20, 18, '#1d1729', 9);

  // Haze: a see-through gradient laid over the far layers, so they look further away.
  const haze = makeCanvas(W, H, dpr);
  const hg = haze.ctx.createLinearGradient(0, GROUND - 160, 0, GROUND);
  hg.addColorStop(0, 'rgba(200,110,90,0)');
  hg.addColorStop(1, 'rgba(200,110,90,0.35)');
  haze.ctx.fillStyle = hg;
  haze.ctx.fillRect(0, 0, W, H);

  // Grass strip along the ground, with tufts poking up above the ground line.
  const grass = makeCanvas(600, H - GROUND + 12, dpr);
  grass.ctx.fillStyle = '#16241a';
  grass.ctx.fillRect(0, 12, 600, H - GROUND);
  grass.ctx.fillStyle = '#21382a';
  for (let x = 0; x < 600; x += 5) {
    const h = 4 + rnd() * 10;
    grass.ctx.beginPath(); grass.ctx.moveTo(x - 3, 13); grass.ctx.lineTo(x + 1, 13 - h); grass.ctx.lineTo(x + 3, 13); grass.ctx.fill();
  }

  return { sky, wall, far, near, haze, grass };
}

// ---------------------------------------------------------------------------------------------
// A giant: legs and arms swing on a sine wave (the walk cycle), the body bobs twice per stride,
// and the pupils are nudged toward the player so the eyes follow you.
function drawGiant(ctx, gx, giant, lookX, lookY, menace) {
  const h = giant.h;
  const step = Math.sin(giant.phase);           // -1..1 across one stride
  const bob = Math.abs(Math.cos(giant.phase)) * 3;
  const feet = GROUND + 6;
  const hipY = feet - h * 0.42 - bob;
  const neckY = hipY - h * 0.36;
  const headR = h * 0.11;
  const headY = neckY - headR * 0.9;
  const skin = '#7a5650';
  const shade = '#5a3d3a';

  ctx.lineCap = 'round';
  // legs (the back leg first, darker)
  ctx.strokeStyle = shade;
  ctx.lineWidth = h * 0.09;
  ctx.beginPath(); ctx.moveTo(gx, hipY); ctx.lineTo(gx - step * h * 0.14, feet); ctx.stroke();
  ctx.strokeStyle = skin;
  ctx.beginPath(); ctx.moveTo(gx, hipY); ctx.lineTo(gx + step * h * 0.14, feet); ctx.stroke();
  // back arm
  ctx.strokeStyle = shade;
  ctx.lineWidth = h * 0.06;
  ctx.beginPath(); ctx.moveTo(gx, neckY + 8); ctx.lineTo(gx + step * h * 0.12, neckY + h * 0.32); ctx.stroke();
  // torso: a trapezoid, wider at the shoulders
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(gx - h * 0.15, neckY + 4);
  ctx.lineTo(gx + h * 0.15, neckY + 4);
  ctx.lineTo(gx + h * 0.1, hipY + 4);
  ctx.lineTo(gx - h * 0.1, hipY + 4);
  ctx.fill();
  // front arm
  ctx.strokeStyle = skin;
  ctx.beginPath(); ctx.moveTo(gx, neckY + 8); ctx.lineTo(gx - step * h * 0.12, neckY + h * 0.32); ctx.stroke();
  // head and hair
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(gx, headY, headR, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a1c1a';
  ctx.beginPath(); ctx.arc(gx, headY - headR * 0.25, headR * 1.02, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
  // eyes that follow the player: offset = direction to the player, scaled to a small length
  for (const side of [-1, 1]) {
    const ex = gx + side * headR * 0.4;
    const ey = headY - headR * 0.05;
    const dx = lookX - ex;
    const dy = lookY - ey;
    const len = Math.hypot(dx, dy) || 1;
    ctx.fillStyle = menace > 0 ? `rgb(255,${Math.round(230 - 180 * menace)},${Math.round(200 - 180 * menace)})` : '#f1e6d6';
    ctx.beginPath(); ctx.arc(ex, ey, headR * 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#120c0c';
    ctx.beginPath(); ctx.arc(ex + (dx / len) * headR * 0.11, ey + (dy / len) * headR * 0.11, headR * 0.11, 0, Math.PI * 2); ctx.fill();
  }
  // the unsettling grin
  ctx.strokeStyle = '#3a2422';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(gx, headY + headR * 0.2, headR * 0.55, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
}

// The player: a small figure with a green cape. The cape trails OPPOSITE to the velocity (the air
// pushes it back) and flutters faster the faster you fly.
function drawPlayer(ctx, x, y, vx, vy, t) {
  const speed = Math.hypot(vx, vy);
  const dirX = speed > 1 ? -vx / speed : 0; // unit vector pointing backwards along the motion
  const dirY = speed > 1 ? -vy / speed : 1;
  const capeLen = 12 + Math.min(14, speed / 70);
  const flutter = Math.sin(t * (10 + speed / 60)) * (2 + speed / 300);
  // perpendicular to the trail direction, for the sideways flutter
  const px = -dirY;
  const py = dirX;
  const tipX = x + dirX * capeLen + px * flutter;
  const tipY = y - 4 + dirY * capeLen + py * flutter;

  ctx.fillStyle = '#2f6b3a';
  ctx.beginPath();
  ctx.moveTo(x - 4, y - 6);
  ctx.quadraticCurveTo(tipX + px * 6, tipY + py * 6, tipX, tipY);
  ctx.quadraticCurveTo(tipX - px * 6, tipY - py * 6, x + 4, y - 6);
  ctx.fill();

  const lean = clamp(vx / 1200, -0.4, 0.4); // lean into the direction of travel
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(lean);
  ctx.strokeStyle = '#e8dcc8'; // white trousers
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-1, 3); ctx.lineTo(-5, 10); ctx.moveTo(1, 3); ctx.lineTo(3, 10); ctx.stroke();
  ctx.fillStyle = '#6b4a2e'; // brown jacket
  ctx.fillRect(-3.5, -7, 7, 10);
  ctx.fillStyle = '#9aa3a8'; // gas canisters on the hips
  ctx.fillRect(-6.5, 0, 3, 5);
  ctx.fillRect(3.5, 0, 3, 5);
  ctx.fillStyle = '#f0d3b8';
  ctx.beginPath(); ctx.arc(0, -10, 3.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a1d16';
  ctx.beginPath(); ctx.arc(0, -11, 3.8, Math.PI, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
function mount(el) {
  let raf = 0;
  let endTimer = null;
  let cleanupInput = () => {};

  function start() {
    setHTML(el, html`<div class="odm">
      <div class="odm-head"><p class="num"><span data-dist>0</span> m</p><p class="faint small">Hold mouse or Space to grapple · release to fly</p></div>
      <canvas class="odm-canvas" height="${H}" aria-label="ODM Swing game"></canvas>
    </div>`);
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const distEl = el.querySelector('[data-dist]');
    const accent = css('--accent', '#ff5a36');
    const font = gameFont();
    const calm = reducedMotion();
    let W = 0;
    let scene = null;
    const resize = () => {
      W = canvas.clientWidth || 800;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene = buildScene(W, dpr); // only on resize: the sky is exactly one screen wide
    };
    resize();

    // Each anchor is a knot on a branch of a giant tree. `deco` only affects the drawing.
    const makeDeco = () => ({ side: Math.random() < 0.5 ? -1 : 1, off: 34 + Math.random() * 40, w: 20 + Math.random() * 14 });

    // World state. Anchors are generated ahead of the player as they travel.
    const anchors = [];
    let lastAnchorX = 0;
    function addAnchors(untilX) {
      while (lastAnchorX < untilX) {
        const gap = 150 + Math.random() * 90 + Math.min(120, lastAnchorX / 120); // sparser further on
        lastAnchorX += gap;
        anchors.push({ x: lastAnchorX, y: 40 + Math.random() * 150, deco: makeDeco() });
      }
    }
    anchors.push({ x: 120, y: 70, deco: makeDeco() });
    lastAnchorX = 120;
    addAnchors(2000);

    const p = { x: 120, y: 220, vx: 260, vy: 0 };
    let hook = anchors[0];
    let rope = Math.hypot(p.x - hook.x, p.y - hook.y);
    let holding = false; // you start hanging from the first anchor
    let maxX = p.x;
    let dead = false;
    const giants = Array.from({ length: 6 }, (_, i) => ({
      x: 400 + i * 380 + Math.random() * 200, h: 130 + Math.random() * 80, speed: 14 + Math.random() * 14, phase: Math.random() * 6,
    }));

    // Visual-only state
    let fireStart = -1e9;   // when the current grapple was fired (performance.now ms)
    let landed = true;      // has the grapple reached its anchor yet?
    let vtime = 0;          // animation clock (runs slower during the death slow-motion)
    let dying = 0;          // real seconds since touching the ground (0 = alive)
    let paused = false;
    const puffs = new Particles(300);
    const shake = new Shake();
    const streaks = Array.from({ length: 16 }, () => ({ x: Math.random() * 1000, y: Math.random() * H, len: 40 + Math.random() * 80 }));

    function nearestAnchor() {
      let best = null;
      let bestD = Infinity;
      for (const a of anchors) {
        if (a.x < p.x - 10 || a.y > p.y) continue; // ahead and above only
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d < RANGE && d < bestD) { best = a; bestD = d; }
      }
      return best;
    }

    function press() {
      if (dead) return;
      holding = true;
      const a = nearestAnchor();
      if (a) {
        hook = a; rope = Math.max(MIN_ROPE, Math.hypot(p.x - a.x, p.y - a.y));
        fireStart = performance.now(); landed = false;
      }
    }
    function release() { holding = false; hook = null; }

    const onKeyDown = (ev) => { if (ev.code === 'Space') { ev.preventDefault(); if (!ev.repeat) press(); } };
    const onKeyUp = (ev) => { if (ev.code === 'Space') { ev.preventDefault(); release(); } };
    const onDown = (ev) => { ev.preventDefault(); press(); };
    const onUp = () => release();
    const onVisibility = () => { paused = document.hidden; last = performance.now(); };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    cleanupInput = () => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };

    function physics(dt) {
      p.vy += GRAVITY * dt;
      p.vx *= 1 - 0.05 * dt; // a little air drag keeps speeds sane
      p.vy *= 1 - 0.05 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (hook) {
        if (holding) rope = Math.max(MIN_ROPE, rope - REEL_SPEED * dt);
        const dx = p.x - hook.x;
        const dy = p.y - hook.y;
        const dist = Math.hypot(dx, dy);
        if (dist > rope) {
          const nx = dx / dist;
          const ny = dy / dist;
          p.x = hook.x + nx * rope; // back onto the circle
          p.y = hook.y + ny * rope;
          const outward = p.vx * nx + p.vy * ny; // velocity along the rope
          if (outward > 0) { p.vx -= outward * nx; p.vy -= outward * ny; }
        }
      }
      if (p.y < 8) { p.y = 8; if (p.vy < 0) p.vy = 0; }
      if (p.y > GROUND - 6) dead = true;
      maxX = Math.max(maxX, p.x);
    }

    // Everything that moves only for looks: giants walking, gas, speed lines.
    function animate(dt) {
      vtime += dt;
      for (const g of giants) {
        g.x += g.speed * dt;
        g.phase += dt * (1.2 + g.speed / 30);
      }
      // Giants that fell off the left edge walk back in from the right (an endless crowd).
      const camX = p.x - W * 0.3;
      let furthest = Math.max(...giants.map((g) => g.x));
      for (const g of giants) {
        if (g.x - camX * 0.85 < -200) { g.x = furthest + 320 + Math.random() * 220; furthest = g.x; }
      }
      // Gas puffs from the hip canisters while reeling in, blown backwards and spreading out.
      if (holding && hook && !dead) {
        for (let i = 0; i < 2; i += 1) {
          puffs.add({
            x: p.x + (Math.random() - 0.5) * 6, y: p.y + 2,
            vx: -p.vx * 0.2 + (Math.random() - 0.5) * 60, vy: -p.vy * 0.2 + (Math.random() - 0.5) * 60,
            life: 0.5 + Math.random() * 0.3, size: 2, grow: 14, drag: 2, colour: '#e6e2dc', alpha: 0.45,
          });
        }
      }
      if (!landed && performance.now() - fireStart >= FIRE_MS && hook) {
        landed = true; // a tiny spark where the hook bites into the bark
        for (let i = 0; i < 8; i += 1) {
          const a = Math.random() * Math.PI * 2;
          puffs.add({ x: hook.x, y: hook.y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 0.3, size: 1.5, colour: 'rgb(255,220,160)', glow: true, drag: 4 });
        }
      }
      const speed = Math.hypot(p.vx, p.vy);
      for (const s of streaks) {
        s.x -= speed * 1.6 * dt;
        if (s.x + s.len < 0) { s.x = W + Math.random() * 200; s.y = Math.random() * H; }
      }
      puffs.update(dt);
      shake.update(dt);
    }

    function drawTrees(camX, target) {
      for (const a of anchors) {
        const tx = a.x + a.deco.side * a.deco.off - camX; // the trunk this branch grows from
        if (tx < -80 || tx > W + 80) continue;
        const w = a.deco.w;
        const bark = ctx.createLinearGradient(tx - w / 2, 0, tx + w / 2, 0);
        bark.addColorStop(0, '#20160f');
        bark.addColorStop(0.6, '#3d2a1c');
        bark.addColorStop(1, '#2a1c13');
        ctx.fillStyle = bark;
        ctx.fillRect(tx - w / 2, -10, w, GROUND + 10);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        for (const k of [-0.25, 0.1, 0.3]) {
          ctx.beginPath(); ctx.moveTo(tx + k * w, 0); ctx.lineTo(tx + k * w + 2, GROUND); ctx.stroke();
        }
        // the branch: a tapered shape from the trunk out to the anchor
        const ax = a.x - camX;
        ctx.fillStyle = '#35251a';
        ctx.beginPath();
        ctx.moveTo(tx, a.y - 9);
        ctx.quadraticCurveTo((tx + ax) / 2, a.y - 10, ax, a.y - 2);
        ctx.lineTo(ax, a.y + 2);
        ctx.quadraticCurveTo((tx + ax) / 2, a.y + 4, tx, a.y + 9);
        ctx.fill();
      }
      // Anchor knots on top, so they are never hidden by a neighbouring trunk.
      for (const a of anchors) {
        const ax = a.x - camX;
        if (ax < -20 || ax > W + 20) continue;
        if (a === target) {
          // The target must stand out: a white dot with a pulsing ring around it.
          const pulse = 10 + Math.sin(vtime * 8) * 2.5;
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(ctx, 'rgb(255,255,255)', ax, a.y, 22, 0.35);
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(ax, a.y, pulse, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.arc(ax, a.y, 5, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = a === hook ? accent : '#8a7a68';
          ctx.beginPath(); ctx.arc(ax, a.y, a === hook ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    function drawRope(camX) {
      if (!hook) return;
      const px = p.x - camX;
      const hx = hook.x - camX;
      // f goes 0 → 1 over FIRE_MS: the hook's flight from the player to the anchor.
      const f = clamp((performance.now() - fireStart) / FIRE_MS, 0, 1);
      const ex = lerp(px, hx, f);
      const ey = lerp(p.y, hook.y, f);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, p.y);
      if (f < 1) {
        // While flying out the cable is slack, so it sags: a curve whose middle hangs down.
        const sag = 24 * (1 - f);
        ctx.quadraticCurveTo((px + ex) / 2, (p.y + ey) / 2 + sag, ex, ey);
      } else {
        ctx.lineTo(hx, hook.y); // taut: a straight line
      }
      ctx.stroke();
      ctx.fillStyle = '#ddd';
      ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    function drawMarkers(camX) {
      // A post every 100 m. World x of marker k is the start (120) plus k × 100 m in pixels.
      const step = 100 * PX_PER_M;
      const first = Math.max(1, Math.ceil((camX - 120 - 40) / step));
      ctx.font = `600 11px ${font}`;
      ctx.textAlign = 'center';
      for (let k = first; ; k += 1) {
        const x = 120 + k * step - camX;
        if (x > W + 40) break;
        ctx.fillStyle = '#5a4430';
        ctx.fillRect(x - 1.5, GROUND - 26, 3, 26);
        ctx.fillStyle = '#d9c7a8';
        ctx.fillRect(x - 18, GROUND - 38, 36, 14);
        ctx.fillStyle = '#2a1d12';
        ctx.fillText(`${k * 100} m`, x, GROUND - 27);
      }
      ctx.textAlign = 'start';
    }

    // The death moment: a giant hand reaches down from above while the world crawls in slow motion.
    // k goes 0 → 1; (1 - (1 - k)²) is an "ease-out": fast at first, then slowing as it closes in.
    function drawHand(px, py, k) {
      const e = 1 - (1 - k) ** 2;
      const palmY = lerp(-150, py - 75, e);
      ctx.fillStyle = '#6e4d48';
      ctx.fillRect(px - 32, palmY - 200, 64, 200); // the wrist / forearm going up off-screen
      ctx.fillStyle = '#7a5650';
      ctx.beginPath(); ctx.ellipse(px, palmY, 58, 42, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#7a5650';
      ctx.lineWidth = 16;
      for (let i = 0; i < 4; i += 1) {
        const fx = px - 39 + i * 26;
        const curl = e * 12 * (i < 2 ? 1 : -1); // fingers close inward around the player
        ctx.beginPath(); ctx.moveTo(fx, palmY + 20); ctx.lineTo(fx + curl, palmY + 62 - Math.abs(i - 1.5) * 8); ctx.stroke();
      }
    }

    function draw() {
      const camX = p.x - W * 0.3;
      const target = !hook && !dead ? nearestAnchor() : null;
      const px = p.x - camX;
      const [sx, sy] = shake.offset();

      ctx.save();
      ctx.translate(sx, sy);
      // During the slow-motion the camera zooms toward the player: move the origin to the player,
      // scale, then move back, so the player stays in the same spot while the world grows.
      if (dying && !calm) {
        const z = 1 + 0.35 * clamp(dying / 0.6, 0, 1) ** 0.5;
        ctx.translate(px, p.y);
        ctx.scale(z, z);
        ctx.translate(-px, -p.y);
      }
      ctx.drawImage(scene.sky.canvas, 0, 0, W, H);
      drawTiled(ctx, scene.wall, camX * 0.08, GROUND - 120, W);
      drawTiled(ctx, scene.far, camX * 0.25, 110, W);
      ctx.drawImage(scene.haze.canvas, 0, 0, W, H);
      drawTiled(ctx, scene.near, camX * 0.5, 50, W);

      const menace = dying ? clamp(dying / 0.8, 0, 1) : 0;
      for (const g of giants) {
        const gx = g.x - camX * 0.85;
        if (gx < -120 || gx > W + 120) continue;
        drawGiant(ctx, gx, g, px, p.y, menace);
      }
      ctx.fillStyle = 'rgba(40,24,40,0.25)'; // a thin veil pushes the giants back behind the trees
      ctx.fillRect(0, 0, W, GROUND);

      drawTrees(camX, target);
      drawTiled(ctx, scene.grass, camX, GROUND - 12, W);
      drawMarkers(camX);
      puffs.draw(ctx, camX);
      drawRope(camX);
      drawPlayer(ctx, px, p.y, dead ? 0 : p.vx, dead ? 0 : p.vy, vtime);

      // Speed lines: faint streaks that appear once you are really flying.
      const speed = Math.hypot(p.vx, p.vy);
      const streakAlpha = dead ? 0 : clamp((speed - 650) / 600, 0, 0.5);
      if (streakAlpha > 0) {
        ctx.strokeStyle = `rgba(255,255,255,${streakAlpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const s of streaks) { ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + s.len, s.y); }
        ctx.stroke();
      }
      if (dying) drawHand(px, p.y, clamp(dying / SLOWMO_S, 0, 1));
      ctx.restore();

      if (dying) {
        // red vignette and cinema bars
        const k = clamp(dying / 0.5, 0, 1);
        const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7);
        v.addColorStop(0, 'rgba(120,0,0,0)');
        v.addColorStop(1, `rgba(120,0,0,${0.6 * k})`);
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, 34 * k);
        ctx.fillRect(0, H - 34 * k, W, 34 * k);
      }
      if (paused) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.font = `600 20px ${font}`;
        ctx.textAlign = 'center';
        ctx.fillText('Paused', W / 2, H / 2);
        ctx.textAlign = 'start';
      }
    }

    function onDeath() {
      cleanupInput();
      playSound('error');
      shake.hit(10);
      for (let i = 0; i < 30; i += 1) { // dust thrown up from the impact
        puffs.add({
          x: p.x, y: GROUND - 4, vx: (Math.random() - 0.5) * 260, vy: -Math.random() * 180,
          life: 1.5, size: 2 + Math.random() * 3, grow: 10, drag: 1.5, gravity: 120, colour: '#8a7058', alpha: 0.6,
        });
      }
    }

    let last = performance.now();
    function frame(now) {
      // Fixed small physics steps: the swing behaves the same at 60 Hz and 144 Hz.
      let elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (paused) { draw(); raf = requestAnimationFrame(frame); return; }
      const real = elapsed;
      while (elapsed > 0 && !dead) {
        const dt = Math.min(1 / 240, elapsed);
        physics(dt);
        elapsed -= dt;
      }
      if (dead && !dying) { dying = 1e-6; onDeath(); }
      if (dying) dying += real;
      // Slow motion: after death the animation clock runs at a fifth of real time.
      animate(dying ? real * 0.2 : real);
      addAnchors(p.x + W * 2);
      while (anchors.length && anchors[0].x < p.x - W) anchors.shift();
      draw();
      distEl.textContent = String(Math.round((maxX - 120) / PX_PER_M));

      if (dying > (calm ? 0.6 : SLOWMO_S)) {
        const metres = Math.round((maxX - 120) / PX_PER_M);
        endTimer = setTimeout(() => finishRun(el, odmSwing, {
          score: metres, headline: `${metres} metres`, detail: 'You touched the ground.', again: start,
        }), 100);
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  startScreen(el, {
    title: 'ODM Swing',
    rules: [
      'You start swinging from an anchor. Hold the mouse button (or Space) to grapple the nearest anchor ahead; the white ringed knot is your target.',
      'Release to let go. While you hold, the rope reels in, which speeds up your swing.',
      'Let go just after the bottom of the arc, on the way up, to fly the furthest.',
      'Touch the ground and it is over.',
    ],
    onStart: start,
  });

  return () => { cancelAnimationFrame(raf); clearTimeout(endTimer); cleanupInput(); };
}
