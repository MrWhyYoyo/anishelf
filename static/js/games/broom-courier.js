// Broom Courier: a young witch flies letters across a painted countryside.
// Hold Space or the mouse to rise, let go to sink. Collect rune orbs and letters, dodge crows,
// thorn vines and lightning clouds. Three hearts. Score = distance flown + pickups.
//
// How the world moves: the witch stays at a fixed spot on the screen and the WORLD scrolls left.
// `dist` is how far the camera has travelled (in px). Every object has a world x; on screen it is
// drawn at (x - dist). Background layers use (dist * factor) with a factor below 1 (parallax).
import { html, setHTML } from '../ui.js';
import { finishRun, startScreen, clamp } from './common.js';
import { playSound } from '../sound.js';
import {
  TintLayer, Particles, Floaters, Shake, makeCanvas, ridge, drawTiled, drawGlow,
  mixRgb, rgb, lerp, smoothstep, gameFont, reducedMotion,
} from './art.js';

const H = 420;
const MAX_W = 960;
const TILE = 1280;          // width of one repeating background tile
const HEARTS = 3;
const PLAYER_R = 12;        // the witch's hit circle (a bit smaller than her drawing: feels fair)
// The momentum model: holding sets a TARGET vertical speed, and the real speed eases toward it.
const RISE = 300;           // px/s upward target while holding
const SINK = 250;           // px/s downward target while not holding
const RESPONSE = 3.2;       // how quickly the speed catches up with the target (per second)
const SPEED_START = 230;    // px/s the world scrolls at first
const SPEED_RAMP = 4;       // px/s added every second
const SPEED_MAX = 560;
const CYCLE = 52000;        // px for one full day → sunset → night → dawn loop
const MAX_SCORE = 10_000_000;

export const broomCourier = {
  id: 'broom-courier',
  title: 'Broom Courier',
  blurb: 'Fly the evening post on a broomstick. Collect runes and letters, dodge crows, thorns and storms.',
  unit: 'pts',
  theme: { label: 'Witch Hat Atelier', match: /witch hat atelier|tongari boushi/i },
  mount,
};

// ---------------------------------------------------------------------------------------------
// The day cycle. Each keyframe is a full "look" of the sky. `at` is the position in the cycle
// (0..1). Between two keyframes every number (and every colour channel) is blended, so the sky
// drifts smoothly from one look to the next.
const KEYS = [
  { at: 0.00, top: [92, 158, 224], bot: [200, 230, 244], far: [140, 170, 205], mid: [92, 138, 128], near: [44, 84, 70], fore: [22, 46, 38], cloud: [255, 255, 255], sunY: 80, moonY: 520, stars: 0, lamps: 0 },
  { at: 0.25, top: [92, 158, 224], bot: [200, 230, 244], far: [140, 170, 205], mid: [92, 138, 128], near: [44, 84, 70], fore: [22, 46, 38], cloud: [255, 255, 255], sunY: 110, moonY: 520, stars: 0, lamps: 0 },
  { at: 0.42, top: [70, 58, 130], bot: [255, 156, 98], far: [140, 98, 140], mid: [92, 66, 98], near: [46, 34, 56], fore: [24, 16, 30], cloud: [255, 196, 180], sunY: 300, moonY: 520, stars: 0.15, lamps: 0.5 },
  { at: 0.58, top: [8, 10, 36], bot: [38, 46, 104], far: [38, 46, 88], mid: [24, 30, 60], near: [12, 15, 34], fore: [6, 7, 16], cloud: [120, 130, 180], sunY: 520, moonY: 90, stars: 1, lamps: 1 },
  { at: 0.80, top: [8, 10, 36], bot: [38, 46, 104], far: [38, 46, 88], mid: [24, 30, 60], near: [12, 15, 34], fore: [6, 7, 16], cloud: [120, 130, 180], sunY: 520, moonY: 110, stars: 1, lamps: 1 },
  { at: 0.92, top: [72, 92, 168], bot: [252, 192, 170], far: [118, 116, 160], mid: [74, 88, 104], near: [32, 44, 54], fore: [16, 22, 28], cloud: [255, 220, 214], sunY: 330, moonY: 520, stars: 0.2, lamps: 0.4 },
  { at: 1.00, top: [92, 158, 224], bot: [200, 230, 244], far: [140, 170, 205], mid: [92, 138, 128], near: [44, 84, 70], fore: [22, 46, 38], cloud: [255, 255, 255], sunY: 80, moonY: 520, stars: 0, lamps: 0 },
];

function skyAt(dist) {
  const u = (dist / CYCLE) % 1;
  let i = 0;
  while (KEYS[i + 1].at < u) i += 1;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = smoothstep((u - a.at) / (b.at - a.at));
  const out = {};
  for (const k of Object.keys(a)) out[k] = Array.isArray(a[k]) ? mixRgb(a[k], b[k], t) : lerp(a[k], b[k], t);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Background layers, drawn ONCE into offscreen canvases (see art.js for why).
// Every item near a tile edge is drawn three times (x - TILE, x, x + TILE) so the copy that
// spills over one edge appears at the other edge: the seams line up when the tile repeats.

function wrapDraw(drawAt, x) {
  drawAt(x - TILE);
  drawAt(x);
  drawAt(x + TILE);
}

function buildLayers(dpr) {
  const rnd = Math.random;

  // Stars: tiny dots in the top part of the sky, plus a few with a soft halo.
  const stars = makeCanvas(TILE, 260, dpr);
  for (let i = 0; i < 160; i += 1) {
    const x = rnd() * TILE;
    const y = rnd() * 250;
    const r = rnd() < 0.08 ? 1.6 : 0.5 + rnd() * 0.8;
    stars.ctx.fillStyle = `rgba(255,255,240,${0.4 + rnd() * 0.6})`;
    stars.ctx.beginPath(); stars.ctx.arc(x, y, r, 0, Math.PI * 2); stars.ctx.fill();
  }

  // Far mountains: two sharp ridges. Math.abs(sin) makes pointy peaks instead of round hills.
  const farH = 230;
  const farPeaks = ridge(TILE, [[3, 40, 0.3], [7, 18, 1.1], [17, 6, 2.0]]);
  const far = new TintLayer(TILE, farH, dpr, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, farH);
    for (let x = 0; x <= TILE; x += 4) {
      const peak = Math.abs(Math.sin((x / TILE) * Math.PI * 2 * 5)) * 46;
      ctx.lineTo(x, 110 - peak + farPeaks(x));
    }
    ctx.lineTo(TILE, farH);
    ctx.fill();
  });

  // Mid hills with little houses. Their windows go on a separate canvas that is NOT tinted, so
  // the lamps can glow warm yellow at night while the hills turn dark blue.
  const midH = 190;
  const hill = ridge(TILE, [[2, 22, 0.7], [5, 12, 2.2], [11, 4, 0.4]]);
  const hillY = (x) => 96 + hill(x);
  const houses = [];
  for (let i = 0; i < 16; i += 1) {
    houses.push({ x: (i + rnd() * 0.6) * (TILE / 16), w: 14 + rnd() * 10, h: 10 + rnd() * 10, tower: rnd() < 0.15 });
  }
  const mid = new TintLayer(TILE, midH, dpr, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, midH);
    for (let x = 0; x <= TILE; x += 4) ctx.lineTo(x, hillY(x));
    ctx.lineTo(TILE, midH);
    ctx.fill();
    for (const hs of houses) {
      wrapDraw((x) => {
        const base = hillY(hs.x) + 4;
        const h = hs.tower ? hs.h + 22 : hs.h;
        ctx.fillRect(x, base - h, hs.w, h);
        ctx.beginPath(); // roof
        ctx.moveTo(x - 3, base - h);
        ctx.lineTo(x + hs.w / 2, base - h - (hs.tower ? 16 : 9));
        ctx.lineTo(x + hs.w + 3, base - h);
        ctx.fill();
      }, hs.x);
    }
  });
  const midLamps = makeCanvas(TILE, midH, dpr);
  for (const hs of houses) {
    wrapDraw((x) => {
      const base = hillY(hs.x) + 4;
      const h = hs.tower ? hs.h + 22 : hs.h;
      const c = midLamps.ctx;
      const g = c.createRadialGradient(x + hs.w / 2, base - h / 2, 0, x + hs.w / 2, base - h / 2, 16);
      g.addColorStop(0, 'rgba(255,190,90,0.35)');
      g.addColorStop(1, 'rgba(255,190,90,0)');
      c.fillStyle = g;
      c.fillRect(x - 12, base - h - 12, hs.w + 24, h + 24);
      c.fillStyle = '#ffd27a';
      c.fillRect(x + 3, base - h + 3, 3, 3);
      if (hs.w > 18) c.fillRect(x + hs.w - 6, base - h + 3, 3, 3);
    }, hs.x);
  }

  // Near layer: pine trees, round trees and the odd witch tower.
  const nearH = 260;
  const ground = ridge(TILE, [[4, 8, 0.2], [9, 4, 1.4]]);
  const groundY = (x) => nearH - 34 + ground(x);
  const items = [];
  for (let x = 0; x < TILE; x += 26 + rnd() * 40) {
    const roll = rnd();
    items.push({ x, kind: roll < 0.06 ? 'tower' : roll < 0.6 ? 'pine' : 'round', s: 0.7 + rnd() * 0.7 });
  }
  const towers = items.filter((it) => it.kind === 'tower');
  const near = new TintLayer(TILE, nearH, dpr, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, nearH);
    for (let x = 0; x <= TILE; x += 4) ctx.lineTo(x, groundY(x));
    ctx.lineTo(TILE, nearH);
    ctx.fill();
    for (const it of items) {
      wrapDraw((x) => {
        const gy = groundY(it.x) + 6;
        if (it.kind === 'pine') {
          const h = 70 * it.s;
          for (let k = 0; k < 3; k += 1) { // three stacked triangles make a fir tree
            const top = gy - h + k * h * 0.22;
            const half = 10 * it.s + k * 5 * it.s;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x - half, top + h * 0.45); ctx.lineTo(x + half, top + h * 0.45); ctx.fill();
          }
          ctx.fillRect(x - 2, gy - 12, 4, 12);
        } else if (it.kind === 'round') {
          const r = 14 * it.s;
          ctx.fillRect(x - 2, gy - r * 2, 4, r * 2);
          for (const [dx, dy, rr] of [[0, -2.4, 1], [-0.7, -1.8, 0.75], [0.7, -1.8, 0.75]]) {
            ctx.beginPath(); ctx.arc(x + dx * r, gy + dy * r, rr * r, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          ctx.fillRect(x - 9, gy - 110, 18, 110);
          ctx.beginPath(); ctx.moveTo(x - 15, gy - 110); ctx.lineTo(x + 2, gy - 160); ctx.lineTo(x + 15, gy - 110); ctx.fill();
        }
      }, it.x);
    }
  });
  const nearLamps = makeCanvas(TILE, nearH, dpr);
  for (const t of towers) {
    wrapDraw((x) => {
      const gy = groundY(t.x) + 6;
      for (const wy of [gy - 90, gy - 60]) {
        const g = nearLamps.ctx.createRadialGradient(x, wy, 0, x, wy, 18);
        g.addColorStop(0, 'rgba(255,200,110,0.4)');
        g.addColorStop(1, 'rgba(255,200,110,0)');
        nearLamps.ctx.fillStyle = g;
        nearLamps.ctx.fillRect(x - 18, wy - 18, 36, 36);
        nearLamps.ctx.fillStyle = '#ffdb8a';
        nearLamps.ctx.fillRect(x - 2, wy - 4, 4, 7);
      }
    }, t.x);
  }

  // Foreground: grass tufts that rush past faster than the witch (factor above 1).
  const foreH = 50;
  const fore = new TintLayer(TILE, foreH, dpr, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, foreH - 12, TILE, 12);
    for (let x = 0; x < TILE; x += 6) {
      const h = 8 + Math.abs(Math.sin(x * 0.07)) * 18 + (x % 5) * 2;
      ctx.beginPath(); ctx.moveTo(x - 4, foreH - 10); ctx.lineTo(x + 1, foreH - 10 - h); ctx.lineTo(x + 4, foreH - 10); ctx.fill();
    }
  });

  // Clouds: three puffy shapes made of overlapping circles.
  const clouds = [0, 1, 2].map(() => new TintLayer(180, 70, dpr, (ctx) => {
    ctx.fillStyle = '#fff';
    for (let k = 0; k < 7; k += 1) {
      const x = 30 + k * 20 + rnd() * 10;
      const r = 14 + Math.sin((k / 6) * Math.PI) * 18 + rnd() * 6;
      ctx.beginPath(); ctx.arc(x, 52 - r * 0.6, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillRect(20, 46, 150, 12);
  }));

  // The storm cloud is one fixed dark shape.
  const storm = makeCanvas(120, 70, dpr);
  for (const [x, y, r, c] of [[30, 40, 22, '#3a3550'], [60, 30, 28, '#433d5c'], [90, 40, 22, '#3a3550'], [60, 48, 24, '#2c2840']]) {
    storm.ctx.fillStyle = c;
    storm.ctx.beginPath(); storm.ctx.arc(x, y, r, 0, Math.PI * 2); storm.ctx.fill();
  }

  return { stars, far, mid, midLamps, near, nearLamps, fore, clouds, storm };
}

// ---------------------------------------------------------------------------------------------
// Drawing the witch. Everything is relative to her centre (0, 0); ctx is already moved there.
function drawWitch(ctx, t, vy) {
  const tilt = clamp(vy / 700, -0.3, 0.3); // nose up when rising, down when sinking
  ctx.rotate(tilt);

  // Cape: its back edge is a wave. sin(time + position) moves the bumps backwards along the cloth.
  ctx.fillStyle = '#3b2a6b';
  ctx.beginPath();
  ctx.moveTo(4, -12);
  for (let i = 0; i <= 6; i += 1) {
    const x = -4 - i * 5;
    const y = -10 + i * 2.6 + Math.sin(t * 11 - i * 0.9) * (1 + i * 0.7);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(-10, 4);
  ctx.lineTo(4, 0);
  ctx.fill();

  // Broom handle and bristles
  ctx.strokeStyle = '#8a5a32';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-26, 7); ctx.lineTo(26, 3); ctx.stroke();
  ctx.fillStyle = '#d8a54a';
  ctx.beginPath(); ctx.moveTo(-24, 5); ctx.lineTo(-42, 0); ctx.lineTo(-44, 9); ctx.lineTo(-40, 15); ctx.lineTo(-24, 10); ctx.fill();
  ctx.strokeStyle = '#a77a2c';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-26, 7); ctx.lineTo(-42, 4); ctx.moveTo(-26, 8); ctx.lineTo(-41, 12); ctx.stroke();

  // Body: dress, legs forward on the broom
  ctx.fillStyle = '#26214a';
  ctx.beginPath(); ctx.moveTo(-6, 5); ctx.lineTo(-2, -12); ctx.lineTo(6, -12); ctx.lineTo(10, 5); ctx.fill();
  ctx.strokeStyle = '#1b1733';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(6, 4); ctx.lineTo(14, 9); ctx.stroke();
  ctx.fillStyle = '#5a3a28';
  ctx.fillRect(13, 8, 5, 3); // boot

  // Head and hair
  ctx.fillStyle = '#f2d2b6';
  ctx.beginPath(); ctx.arc(3, -17, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e8b04a';
  ctx.beginPath(); ctx.arc(0, -17, 5, Math.PI * 0.5, Math.PI * 1.4); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-3, -16); ctx.quadraticCurveTo(-9, -12 + Math.sin(t * 9) * 2, -12, -9); ctx.lineTo(-3, -13); ctx.fill();

  // Hat: a wide brim and a tall cone whose tip bends back and wobbles in the wind
  const wob = Math.sin(t * 7) * 2.5;
  ctx.fillStyle = '#1f1a3d';
  ctx.beginPath(); ctx.ellipse(2, -21, 13, 3.2, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-5, -22);
  ctx.quadraticCurveTo(-1, -36, -14, -42 + wob);
  ctx.quadraticCurveTo(4, -38, 9, -22);
  ctx.fill();
  ctx.strokeStyle = '#e8c35a';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-4, -24.5); ctx.lineTo(8, -24.5); ctx.stroke();
}

// ---------------------------------------------------------------------------------------------
function mount(el) {
  let raf = 0;
  let endTimer = null;
  let cleanupInput = () => {};

  function start() {
    setHTML(el, html`<div class="bc">
      <div class="odm-head"><p class="num"><span data-score>0</span> pts</p><p class="faint small">Hold mouse or Space to rise · release to sink</p></div>
      <canvas class="bc-canvas" height="${H}" aria-label="Broom Courier game"></canvas>
    </div>`);
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = el.querySelector('[data-score]');
    const font = gameFont();
    const calm = reducedMotion();

    let W = 0;
    let layers = null;
    const resize = () => {
      W = Math.min(MAX_W, canvas.clientWidth || 800);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layers = buildLayers(dpr); // rebuilt only on resize, never per frame
    };
    resize();

    // --- game state ---
    const witch = { y: H * 0.45, vy: 0 };
    let holding = false;
    let dist = 0;
    let speed = SPEED_START;
    let time = 0;
    let hearts = HEARTS;
    let invuln = 0;
    let pickups = 0;
    let letters = 0;
    let chain = 0;
    let lastOrbAt = -10;
    let nextChunk = 500;   // world x of the next spawn
    let nextLetter = 3200;
    let flash = 0;         // white screen flash after a lightning strike
    let dying = 0;         // > 0 while the witch tumbles after the last heart
    let paused = false;
    const objects = [];    // orbs, letters, crows, vines, storms
    const sparks = new Particles(300);
    const floaters = new Floaters();
    const shake = new Shake();
    const cloudList = Array.from({ length: 6 }, (_, i) => ({ x: i * 260 + Math.random() * 200, y: 30 + Math.random() * 130, k: i % 3, s: 0.6 + Math.random() * 0.6 }));

    const playerX = () => W * 0.24;            // screen x
    const worldPX = () => dist + playerX();      // world x
    const score = () => Math.min(MAX_SCORE, Math.floor(dist / 20) + pickups);

    // --- input ---
    const press = () => { holding = true; };
    const release = () => { holding = false; };
    const onKeyDown = (ev) => { if (ev.code === 'Space') { ev.preventDefault(); press(); } };
    const onKeyUp = (ev) => { if (ev.code === 'Space') { ev.preventDefault(); release(); } };
    const onDown = (ev) => { ev.preventDefault(); press(); };
    const onVisibility = () => {
      paused = document.hidden;
      if (paused) release(); // a key let go while the tab was hidden never sends its keyup
      last = performance.now();
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', release);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    cleanupInput = () => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };

    // --- spawning ---
    // The world is made of "chunks": one hazard plus a line of orbs placed AWAY from it, so there
    // is always a safe, rewarding path. Difficulty d goes 0 → 1 over the first ~30,000 px.
    function orbLine(x, y, n = 5, wave = 30) {
      for (let i = 0; i < n; i += 1) {
        objects.push({ type: 'orb', x: x + i * 42, y: clamp(y + Math.sin(i * 0.9) * wave, 40, H - 60), r: 14, seed: Math.random() * 6 });
      }
    }

    function spawnChunk(x) {
      const d = clamp(dist / 30000, 0, 1);
      const roll = Math.random();
      if (dist > 9000 && roll < 0.22 + d * 0.1) {
        // Storm cloud high up; its bolt hangs down to `tip`. Fly under it.
        const y = 40 + Math.random() * 50;
        const tip = y + 150 + d * 70 + Math.random() * 40;
        objects.push({ type: 'storm', x, y, tip, state: 'warn', boltSeed: 0, boltTimer: 0 });
        orbLine(x - 40, Math.min(H - 70, tip + 50), 4, 10);
      } else if (dist > 800 && roll < 0.62) {
        // Thorn vine from the top or bottom, longer as you go.
        const fromTop = Math.random() < 0.5;
        const len = 110 + d * 90 + Math.random() * 50;
        objects.push({ type: 'vine', x, fromTop, len, seed: Math.random() * 6 });
        orbLine(x - 60, fromTop ? H - 110 : 90, 5, 20);
      } else if (dist > 1500) {
        // One or two crows; they fly toward you a bit faster than the world scrolls.
        const n = d > 0.4 && Math.random() < 0.5 ? 2 : 1;
        const ys = [];
        for (let i = 0; i < n; i += 1) {
          const y = 60 + Math.random() * (H - 160);
          ys.push(y);
          objects.push({ type: 'crow', x: x + i * 120, y, baseY: y, vx: -(70 + d * 90), seed: Math.random() * 6 });
        }
        const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
        orbLine(x - 20, avg < H / 2 ? avg + 130 : avg - 130, 5, 25);
      } else {
        orbLine(x, 80 + Math.random() * (H - 200), 6, 40);
      }
    }

    function spawn() {
      const ahead = dist + W + 80;
      while (nextChunk < ahead) {
        spawnChunk(nextChunk);
        const d = clamp(dist / 30000, 0, 1);
        nextChunk += lerp(560, 330, d) + Math.random() * 120;
      }
      if (nextLetter < ahead) {
        objects.push({ type: 'letter', x: nextLetter, y: 70 + Math.random() * (H - 180), r: 18, seed: Math.random() * 6 });
        nextLetter += 3500 + Math.random() * 2500;
      }
    }

    // --- collisions ---
    // Everything is checked as circles: two circles touch when the distance between centres is
    // less than the sum of their radii. We compare SQUARED distances to skip a square root.
    const touches = (x, y, r) => {
      const dx = x - worldPX();
      const dy = y - witch.y;
      const rr = r + PLAYER_R;
      return dx * dx + dy * dy < rr * rr;
    };

    // A vine is a wobbling curve; we sample points along it and treat each as a small circle.
    function vinePoints(v) {
      const pts = [];
      const n = 10;
      for (let i = 0; i <= n; i += 1) {
        const f = i / n;
        const sway = Math.sin(time * 1.6 + v.seed + f * 3) * 10 * f;
        const y = v.fromTop ? f * v.len : H - f * v.len;
        pts.push([v.x + sway, y]);
      }
      return pts;
    }

    function burst(x, y, colour, n, spread = 180, glow = true) {
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const s = Math.random() * spread;
        sparks.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.4, size: 1.5 + Math.random() * 2, colour, glow, drag: 3 });
      }
    }

    function hurt(x, y) {
      if (invuln > 0 || dying) return;
      hearts -= 1;
      invuln = 1.6;
      shake.hit(12);
      playSound('error');
      burst(x, y, 'rgb(255,110,130)', 26, 220);
      for (let i = 0; i < 8; i += 1) { // a few dark feathers / leaves
        sparks.add({ x: worldPX(), y: witch.y, vx: (Math.random() - 0.5) * 160, vy: -Math.random() * 120, life: 1, size: 2.5, colour: '#2a2440', gravity: 260, drag: 1 });
      }
      chain = 0;
      if (hearts <= 0) dying = 0.001;
    }

    // --- update ---
    function update(dt) {
      time += dt;
      if (dying) {
        // the witch tumbles down; the world slows to a stop
        dying += dt;
        speed = Math.max(0, speed - 500 * dt);
        witch.vy += 700 * dt;
        witch.y = Math.min(H + 40, witch.y + witch.vy * dt);
      } else {
        speed = Math.min(SPEED_MAX, SPEED_START + time * SPEED_RAMP);
        // The momentum model. Instead of setting the speed directly (which feels twitchy), we move
        // the speed a FRACTION of the way toward the target each step. 1 - e^(-k·dt) is that
        // fraction; using exp makes the result the same whether the game runs at 60 or 144 fps.
        const target = holding ? -RISE : SINK;
        witch.vy += (target - witch.vy) * (1 - Math.exp(-RESPONSE * dt));
        witch.y += witch.vy * dt;
        if (witch.y < 24) { witch.y = 24; witch.vy = Math.max(0, witch.vy); }
        if (witch.y > H - 30) { witch.y = H - 30; witch.vy = Math.min(0, witch.vy); }
      }
      dist += speed * dt;
      invuln = Math.max(0, invuln - dt);
      flash = Math.max(0, flash - dt * 3);
      shake.update(dt);
      spawn();

      // the glowing broom trail: sparks left behind in the world, so they stream away
      if (!dying || dying < 0.5) {
        for (let i = 0; i < 2; i += 1) {
          sparks.add({
            x: worldPX() - 40 + Math.random() * 4, y: witch.y + 6 + (Math.random() - 0.5) * 8,
            vx: -20 - Math.random() * 40, vy: (Math.random() - 0.5) * 30,
            life: 0.5 + Math.random() * 0.4, size: 1.2 + Math.random() * 1.6,
            colour: Math.random() < 0.5 ? 'rgb(255,214,120)' : 'rgb(180,150,255)', glow: true, drag: 1.5, grow: -1.5,
          });
        }
      }

      for (const o of objects) {
        if (o.type === 'crow') {
          o.x += o.vx * dt;
          o.y = o.baseY + Math.sin(time * 3 + o.seed) * 18;
          if (touches(o.x, o.y, 15)) hurt(o.x, o.y);
        } else if (o.type === 'orb' || o.type === 'letter') {
          if (touches(o.x, o.y + Math.sin(time * 3 + o.seed) * 5, o.r)) collect(o);
        } else if (o.type === 'vine') {
          for (const [x, y] of vinePoints(o)) if (touches(x, y, 8)) { hurt(x, y); break; }
        } else if (o.type === 'storm') {
          const sx = o.x - dist;
          // Telegraph: while still more than 150 px ahead the cloud only crackles (warning).
          // Close to the witch it strikes until it has passed her.
          const was = o.state;
          o.state = sx - playerX() > 150 ? 'warn' : 'strike';
          if (o.state === 'strike' && was === 'warn') { flash = calm ? 0.3 : 0.6; shake.hit(5); playSound('tick'); }
          o.boltTimer -= dt;
          if (o.boltTimer <= 0) { o.boltSeed = Math.random() * 1000; o.boltTimer = 0.06; }
          if (touches(o.x, o.y, 26)) hurt(o.x, o.y);
          // the bolt is a narrow column from the cloud down to its tip: a rectangle-vs-circle test
          if (o.state === 'strike' && Math.abs(o.x - worldPX()) < 10 + PLAYER_R && witch.y > o.y && witch.y < o.tip + PLAYER_R) {
            hurt(worldPX(), witch.y);
          }
        }
      }
      // Forget what has scrolled off the left edge (or been collected).
      for (let i = objects.length - 1; i >= 0; i -= 1) {
        if (objects[i].gone || objects[i].x < dist - 120) objects.splice(i, 1);
      }

      for (const c of cloudList) { // clouds also drift on their own a little
        c.x -= 12 * dt;
        if (c.x - dist * 0.45 < -200) { c.x += W + 400 + Math.random() * 200; c.y = 30 + Math.random() * 130; }
      }
      sparks.update(dt);
      floaters.update(dt);
    }

    function collect(o) {
      o.gone = true;
      if (o.type === 'orb') {
        // A chain: orbs taken within 0.9 s of each other are worth more and more (up to 60).
        chain = time - lastOrbAt < 0.9 ? chain + 1 : 1;
        lastOrbAt = time;
        const pts = Math.min(60, 10 + (chain - 1) * 5);
        pickups += pts;
        burst(o.x, o.y, 'rgb(140,220,255)', 14, 150);
        floaters.add(chain >= 3 ? `+${pts} ×${chain}` : `+${pts}`, o.x, o.y - 14, '#bfe9ff', chain >= 3 ? 18 : 15);
        playSound('tick');
      } else {
        pickups += 250;
        letters += 1;
        burst(o.x, o.y, 'rgb(255,214,120)', 40, 260);
        floaters.add('Delivered! +250', o.x, o.y - 18, '#ffe08a', 20);
        playSound('chime');
      }
    }

    // --- drawing ---
    function drawSky(sky) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgb(sky.top));
      g.addColorStop(1, rgb(sky.bot));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      if (sky.stars > 0.01) {
        ctx.globalAlpha = sky.stars * (0.85 + Math.sin(time * 2) * 0.15); // a slow twinkle
        drawTiled(ctx, layers.stars, dist * 0.02, 0, W);
        ctx.globalAlpha = 1;
      }
      // The sun and moon barely move sideways (they are "infinitely" far away), only up and down.
      ctx.globalCompositeOperation = 'lighter';
      if (sky.sunY < 440) {
        drawGlow(ctx, 'rgb(255,200,120)', W * 0.78, sky.sunY, 110, 0.55);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgb(255,236,190)';
        ctx.beginPath(); ctx.arc(W * 0.78, sky.sunY, 26, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'lighter';
      }
      if (sky.moonY < 440) {
        drawGlow(ctx, 'rgb(170,190,255)', W * 0.7, sky.moonY, 90, 0.4);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#f1efe2';
        ctx.beginPath(); ctx.arc(W * 0.7, sky.moonY, 20, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgb(sky.top); // a second circle in the sky colour carves the crescent
        ctx.beginPath(); ctx.arc(W * 0.7 + 9, sky.moonY - 5, 17, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawLayers(sky) {
      // Parallax factors: far mountains move at 12% of the camera speed, hills 30%, trees 65%.
      layers.far.tint(rgb(sky.far));
      drawTiled(ctx, layers.far, dist * 0.12, H - 260, W);

      for (const c of cloudList) {
        const layer = layers.clouds[c.k];
        layer.tint(rgb(sky.cloud));
        ctx.globalAlpha = 0.75;
        ctx.drawImage(layer.canvas, c.x - dist * 0.45, c.y, layer.w * c.s, layer.h * c.s);
      }
      ctx.globalAlpha = 1;

      layers.mid.tint(rgb(sky.mid));
      drawTiled(ctx, layers.mid, dist * 0.3, H - 190, W);
      if (sky.lamps > 0.01) {
        ctx.globalAlpha = sky.lamps;
        drawTiled(ctx, layers.midLamps, dist * 0.3, H - 190, W);
        ctx.globalAlpha = 1;
      }
      layers.near.tint(rgb(sky.near));
      drawTiled(ctx, layers.near, dist * 0.65, H - 260, W);
      if (sky.lamps > 0.01) {
        ctx.globalAlpha = sky.lamps;
        drawTiled(ctx, layers.nearLamps, dist * 0.65, H - 260, W);
        ctx.globalAlpha = 1;
      }
    }

    function drawOrb(o) {
      const x = o.x - dist;
      const y = o.y + Math.sin(time * 3 + o.seed) * 5;
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, 'rgb(110,190,255)', x, y, 30, 0.7);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#dff4ff';
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      // a rotating rune ring: three short arcs
      ctx.strokeStyle = 'rgba(200,235,255,0.9)';
      ctx.lineWidth = 1.5;
      for (let k = 0; k < 3; k += 1) {
        const a = time * 2 + o.seed + (k * Math.PI * 2) / 3;
        ctx.beginPath(); ctx.arc(x, y, 11, a, a + 1.2); ctx.stroke();
      }
    }

    function drawLetter(o) {
      const x = o.x - dist;
      const y = o.y + Math.sin(time * 3 + o.seed) * 5;
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, 'rgb(255,210,120)', x, y, 42, 0.6 + Math.sin(time * 6) * 0.15);
      ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(time * 2 + o.seed) * 0.15);
      ctx.fillStyle = '#f6ecd2';
      ctx.fillRect(-14, -9, 28, 18);
      ctx.strokeStyle = '#b89a6a';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-14, -9); ctx.lineTo(0, 2); ctx.lineTo(14, -9); ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(0, 2, 3.5, 0, Math.PI * 2); ctx.fill(); // wax seal
      ctx.restore();
    }

    function drawCrow(o) {
      const x = o.x - dist;
      const flap = Math.sin(time * 14 + o.seed); // -1..1: wings up and down
      ctx.fillStyle = '#17142a';
      ctx.beginPath(); ctx.ellipse(x, o.y, 13, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x - 11, o.y - 3, 5.5, 0, Math.PI * 2); ctx.fill(); // head (facing left)
      ctx.fillStyle = '#e0a33a';
      ctx.beginPath(); ctx.moveTo(-16 + x, o.y - 4); ctx.lineTo(-23 + x, o.y - 2); ctx.lineTo(-16 + x, o.y - 1); ctx.fill();
      ctx.fillStyle = '#17142a';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x - 4, o.y - 2);
        ctx.lineTo(x + 8, o.y - 2 + flap * 16 * side * (side < 0 ? 1 : 0.6));
        ctx.lineTo(x + 12, o.y);
        ctx.fill();
      }
      ctx.beginPath(); ctx.moveTo(x + 12, o.y); ctx.lineTo(x + 22, o.y - 4); ctx.lineTo(x + 22, o.y + 4); ctx.fill(); // tail
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, 'rgb(255,70,90)', x - 12, o.y - 4, 7, 0.9); // a glowing storm-crow eye
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawVine(o) {
      const pts = vinePoints(o).map(([x, y]) => [x - dist, y]);
      ctx.strokeStyle = '#2d4a2a';
      ctx.lineCap = 'round';
      for (let i = 0; i < pts.length - 1; i += 1) { // thick at the root, thin at the tip
        ctx.lineWidth = 12 - i * 0.8;
        ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
      }
      ctx.fillStyle = '#a63a6a';
      for (let i = 1; i < pts.length - 1; i += 1) { // thorns alternate left and right
        const side = i % 2 ? 1 : -1;
        const w = 6 - i * 0.3;
        ctx.beginPath();
        ctx.moveTo(pts[i][0] + side * w, pts[i][1] - 3);
        ctx.lineTo(pts[i][0] + side * (w + 9), pts[i][1] + (o.fromTop ? 4 : -4));
        ctx.lineTo(pts[i][0] + side * w, pts[i][1] + 3);
        ctx.fill();
      }
      const [tx, ty] = pts[pts.length - 1];
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, 'rgb(255,80,200)', tx, ty, 18, 0.6 + Math.sin(time * 5 + o.seed) * 0.25);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#ff7ad1';
      ctx.beginPath(); ctx.arc(tx, ty, 4, 0, Math.PI * 2); ctx.fill();
    }

    // A jagged lightning line: the same seed gives the same zigzag, a new seed every 60 ms makes it crackle.
    function boltPath(x, y0, y1, seed) {
      let s = seed;
      const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
      ctx.beginPath();
      ctx.moveTo(x, y0);
      for (let y = y0 + 16; y < y1; y += 16) ctx.lineTo(x + (rand() - 0.5) * 18, y);
      ctx.lineTo(x, y1);
    }

    function drawStorm(o) {
      const x = o.x - dist;
      if (o.state === 'warn') {
        // Warning: the danger column blinks so you can see where the bolt will fall.
        const blink = 0.18 + 0.18 * Math.sin(time * 18);
        ctx.fillStyle = `rgba(190,160,255,${blink})`;
        ctx.fillRect(x - 10, o.y, 20, o.tip - o.y);
        ctx.strokeStyle = `rgba(230,210,255,${blink + 0.25})`;
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 10, o.y, 20, o.tip - o.y);
        ctx.setLineDash([]);
      } else {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(170,140,255,0.5)';
        ctx.lineWidth = 9;
        boltPath(x, o.y + 10, o.tip, o.boltSeed); ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        boltPath(x, o.y + 10, o.tip, o.boltSeed); ctx.stroke();
        drawGlow(ctx, 'rgb(200,180,255)', x, o.tip, 26, 0.8);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(layers.storm.canvas, x - 60, o.y - 40, 120, 70);
      ctx.globalCompositeOperation = 'lighter';
      const crackle = o.state === 'warn' ? 0.25 + Math.random() * 0.3 : 0.8;
      drawGlow(ctx, 'rgb(170,150,255)', x, o.y, 40, crackle);
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawHearts() {
      for (let i = 0; i < HEARTS; i += 1) {
        const x = 18 + i * 24;
        const y = 18;
        ctx.fillStyle = i < hearts ? '#ff5c7a' : 'rgba(255,255,255,0.22)';
        ctx.beginPath(); // a heart: two circles on top of a triangle
        ctx.arc(x - 4, y, 4.5, Math.PI, 0);
        ctx.arc(x + 4, y, 4.5, Math.PI, 0);
        ctx.lineTo(x, y + 10);
        ctx.closePath();
        ctx.fill();
      }
      if (chain >= 3 && time - lastOrbAt < 0.9) {
        ctx.font = `700 13px ${font}`;
        ctx.fillStyle = '#bfe9ff';
        ctx.fillText(`Chain ×${chain}`, 96, 23);
      }
    }

    function draw() {
      const sky = skyAt(dist);
      const [sx, sy] = shake.offset();
      ctx.save();
      ctx.translate(sx, sy);
      drawSky(sky);
      drawLayers(sky);

      for (const o of objects) {
        if (o.x - dist < -80 || o.x - dist > W + 80) continue;
        if (o.type === 'orb') drawOrb(o);
        else if (o.type === 'letter') drawLetter(o);
        else if (o.type === 'crow') drawCrow(o);
        else if (o.type === 'vine') drawVine(o);
        else drawStorm(o);
      }

      sparks.draw(ctx, dist);
      // While invulnerable the witch blinks (drawn only on every other 1/12 s).
      if (!(invuln > 0 && Math.floor(invuln * 12) % 2 === 0)) {
        ctx.save();
        ctx.translate(playerX(), witch.y);
        if (dying) ctx.rotate(dying * 4); // tumbling
        drawWitch(ctx, time, witch.vy);
        ctx.restore();
      }
      floaters.draw(ctx, dist, font);

      layers.fore.tint(rgb(sky.fore));
      drawTiled(ctx, layers.fore, dist * 1.25, H - 50, W); // faster than the camera: right in front of us
      ctx.restore();

      if (flash > 0) {
        ctx.fillStyle = `rgba(235,225,255,${flash * 0.5})`;
        ctx.fillRect(0, 0, W, H);
      }
      drawHearts();
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

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000); // a long gap (slow frame) counts as at most 50 ms
      last = now;
      if (!paused) update(dt);
      draw();
      scoreEl.textContent = score().toLocaleString();

      if (dying > 1.1) {
        cleanupInput();
        const final = score();
        endTimer = setTimeout(() => finishRun(el, broomCourier, {
          score: final,
          headline: letters ? 'The post went through' : 'Grounded by the storm',
          detail: `You flew ${Math.round(dist / 20).toLocaleString()} m and delivered ${letters} ${letters === 1 ? 'letter' : 'letters'}.`,
          again: start,
        }), 200);
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  startScreen(el, {
    title: 'Broom Courier',
    rules: [
      'Hold the mouse button (or Space) to rise; let go to sink. The broom has momentum, so steer early.',
      'Rune orbs give points; grab several in a row for a chain bonus. Letters are worth 250.',
      'Dodge storm crows and thorn vines. Later, storm clouds flash a warning column before they strike: fly under the bolt.',
      'Three hearts. The flight gets faster the further you go.',
    ],
    onStart: start,
  });

  return () => { cancelAnimationFrame(raf); clearTimeout(endTimer); cleanupInput(); };
}
