// Devil Hunter Arena: an original top-down "survivor" game inspired by Chainsaw Man.
// You only move (WASD / arrows); the chainsaw blade swings at the nearest devil by itself.
// Devils come in waves from the edges. Kills drop blood shards (XP); every level-up pauses the
// game and offers three upgrade cards. Score = kills + a bonus for each wave cleared.
//
// Structure of the code:
//   update(dt)  moves everything forward by a small fixed time step (the "simulation").
//   draw()      paints the current state; it never changes the game, it only looks at it.
// Keeping those two apart is the classic game-loop pattern: the simulation stays the same speed
// on a 60 Hz and a 144 Hz screen, and drawing can't accidentally change the rules.
import { html, setHTML } from '../ui.js';
import { api } from '../api.js';
import { playSound } from '../sound.js';
import { finishRun, startScreen, loadImage, clamp } from './common.js';
import { createParticles, createPopups, createShake, fitCanvas, ease, drawCover } from './fx.js';

export const devilArena = {
  id: 'devil-arena',
  title: 'Devil Hunter Arena',
  blurb: 'Rev up and survive wave after wave of devils. Your blade swings on its own; you just move and pick upgrades.',
  unit: 'pts',
  theme: { label: 'Chainsaw Man', match: /chainsaw man/i },
  mount,
};

const STEP = 1 / 120;        // simulation step in seconds
const MAX_ENEMIES = 140;      // keeps the collision checks cheap
const MAX_SHARDS = 160;
const TAU = Math.PI * 2;

// Each devil type: colour, size, health, speed and how hard it hits.
const TYPES = {
  chaser:   { color: '#ff3b5c', dark: '#6e0f22', r: 13, hp: 18, speed: 80, dmg: 10 },
  dasher:   { color: '#ffa53b', dark: '#7a3d05', r: 11, hp: 14, speed: 58, dmg: 12 },
  splitter: { color: '#5be37d', dark: '#145c2a', r: 18, hp: 34, speed: 50, dmg: 12 },
  mini:     { color: '#b6f5c4', dark: '#2f7a45', r: 9,  hp: 7,  speed: 100, dmg: 6 },
  boss:     { color: '#b45cff', dark: '#3a0b6b', r: 42, hp: 380, speed: 44, dmg: 25 },
};

// Upgrade cards. `ok` hides a card once it can't get any better.
const UPGRADES = [
  { name: 'Rev the chain', text: 'Swing 15% faster', ok: (s) => s.attackEvery > 0.2, apply: (s) => { s.attackEvery *= 0.85; } },
  { name: 'Wide swing', text: 'Bigger blade arc and reach', ok: (s) => s.reach < 150, apply: (s) => { s.reach *= 1.12; s.arc = Math.min(Math.PI * 1.5, s.arc * 1.15); } },
  { name: 'Extra blade', text: 'One more blade, swinging another way', ok: (s) => s.blades < 6, apply: (s) => { s.blades += 1; } },
  { name: 'Sharper teeth', text: '+25% damage', ok: () => true, apply: (s) => { s.damage *= 1.25; } },
  { name: 'Light feet', text: '+12% move speed', ok: (s) => s.speed < 330, apply: (s) => { s.speed *= 1.12; } },
  { name: 'Blood transfusion', text: 'Heal 40 HP', ok: (s, p) => p.hp < p.maxHp, apply: (s, p) => { p.hp = Math.min(p.maxHp, p.hp + 40); } },
  { name: 'Tough hide', text: '+25 max HP (and heal 25)', ok: (s, p) => p.maxHp < 300, apply: (s, p) => { p.maxHp += 25; p.hp += 25; } },
  { name: 'Blood magnet', text: '+50% pickup range', ok: (s) => s.magnet < 320, apply: (s) => { s.magnet *= 1.5; } },
  { name: 'Regeneration', text: 'Heal 1 HP per second', ok: (s) => s.regen < 5, apply: (s) => { s.regen += 1; } },
];

/** Smallest signed difference between two angles (so 350° vs 10° is 20°, not 340°). */
function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function mount(el) {
  let raf = 0;
  let endTimer = null;
  let cleanupRun = () => {};
  let avatarImg = null;
  let gone = false;

  // Fetch the user's avatar once (if they picked one); the game works fine without it.
  api.me()
    .then((me) => (me && me.avatar && me.avatar.image ? loadImage(me.avatar.image) : null))
    .then((img) => { avatarImg = img; })
    .catch(() => {});

  function start() {
    cleanupRun();
    setHTML(el, html`<div class="arena">
      <canvas class="arena-canvas" aria-label="Devil Hunter Arena game" tabindex="0"></canvas>
      <p class="faint small">WASD or arrow keys to move (or hold the mouse where you want to go) · 1-3 or click to pick an upgrade</p>
    </div>`);
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    canvas.focus();

    // The floor (vignette + cracks) never changes, so it is drawn once into an off-screen canvas
    // and copied each frame. Copying one image is much cheaper than redrawing gradients.
    const floor = document.createElement('canvas');
    const paintFloor = (size) => {
      const dpr = window.devicePixelRatio || 1;
      floor.width = Math.round(size.w * dpr);
      floor.height = Math.round(size.h * dpr);
      const f = floor.getContext('2d');
      f.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = f.createRadialGradient(size.w / 2, size.h / 2, 40, size.w / 2, size.h / 2, Math.max(size.w, size.h) * 0.7);
      g.addColorStop(0, '#1c0b0e');
      g.addColorStop(1, '#050203');
      f.fillStyle = g;
      f.fillRect(0, 0, size.w, size.h);
      f.strokeStyle = 'rgba(255,60,80,0.06)';
      f.lineWidth = 1;
      for (let i = 0; i < 18; i += 1) { // a few random cracks
        let x = Math.random() * size.w;
        let y = Math.random() * size.h;
        f.beginPath(); f.moveTo(x, y);
        for (let k = 0; k < 5; k += 1) { x += (Math.random() - 0.5) * 70; y += (Math.random() - 0.5) * 70; f.lineTo(x, y); }
        f.stroke();
      }
    };
    const fit = fitCanvas(canvas, ctx, (w) => Math.round(clamp(w * 0.6, 360, 560)), 960, paintFloor);
    const S = fit.size; // S.w, S.h: the arena size in CSS pixels (updates on resize)

    const particles = createParticles();
    const popups = createPopups();
    const shake = createShake();

    // ---------------------------------------------------------------- state
    const player = { x: S.w / 2, y: S.h / 2, r: 15, hp: 100, maxHp: 100, inv: 0, face: 0, walk: 0 };
    const stats = { speed: 190, attackEvery: 0.8, reach: 80, arc: 1.7, blades: 1, damage: 18, magnet: 70, regen: 0 };
    const enemies = [];
    const shards = [];
    const swings = [];
    const splats = [];  // blood stains on the floor (decoration only)
    const embers = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random(), s: 0.5 + Math.random() * 1.5, v: 0.02 + Math.random() * 0.05 }));
    let attackTimer = 0.4;
    let kills = 0;
    let bonus = 0;
    let level = 1;
    let xp = 0;
    let xpNeed = 6;
    let pendingLevels = 0;
    let choices = null;     // the three upgrade cards while paused for a level-up
    let hoverCard = -1;
    let hurtFlash = 0;
    let dead = false;
    let time = 0;
    let banner = null;      // {text, age} big text in the middle ("Wave 3")
    const wave = { n: 0, toSpawn: 0, spawnTimer: 0, rest: 1.2, boss: null };

    const keys = new Set();
    let pointer = null;     // {x, y} while the mouse/finger is held on the arena

    // ---------------------------------------------------------------- waves & spawning
    function startWave() {
      wave.n += 1;
      wave.toSpawn = Math.min(70, 5 + wave.n * 3);
      wave.spawnTimer = 0;
      wave.boss = null;
      banner = { text: wave.n % 5 === 0 ? `Wave ${wave.n} · Boss` : `Wave ${wave.n}`, age: 0 };
      if (wave.n % 5 === 0) {
        wave.boss = spawn('boss');
        wave.toSpawn = Math.round(wave.toSpawn * 0.5);
        shake.add(0.5);
      }
      playSound('tick');
    }

    /** Make a devil just outside a random edge. Health grows a little every wave. */
    function spawn(type, x, y) {
      if (enemies.length >= MAX_ENEMIES) return null;
      const t = TYPES[type];
      if (x === undefined) {
        const side = Math.floor(Math.random() * 4);
        const m = t.r + 10;
        x = side === 0 ? -m : side === 1 ? S.w + m : Math.random() * S.w;
        y = side === 2 ? -m : side === 3 ? S.h + m : Math.random() * S.h;
        if (side < 2) y = Math.random() * S.h;
      }
      const hp = t.hp * (1 + (wave.n - 1) * 0.13) * (type === 'boss' ? 1 + wave.n / 10 : 1);
      const e = {
        type, x, y, r: t.r, hp, maxHp: hp, speed: t.speed * (1 + wave.n * 0.015), dmg: t.dmg,
        flash: 0, phase: Math.random() * TAU, state: 'walk', timer: 1 + Math.random(), dx: 0, dy: 0, blink: Math.random() * 4,
      };
      enemies.push(e);
      return e;
    }

    function pickType() {
      const roll = Math.random();
      if (wave.n >= 3 && roll < 0.25) return 'splitter';
      if (wave.n >= 2 && roll < 0.55) return 'dasher';
      return 'chaser';
    }

    // ---------------------------------------------------------------- combat
    function swing() {
      // Aim at the nearest devil. Only swing if one is close enough to be worth it.
      let target = null;
      let best = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.x - player.x, e.y - player.y) - e.r;
        if (d < best) { best = d; target = e; }
      }
      if (!target || best > stats.reach * 1.25) return false;
      const base = Math.atan2(target.y - player.y, target.x - player.x);
      player.face = base;
      for (let k = 0; k < stats.blades; k += 1) {
        const angle = base + (k * TAU) / stats.blades; // extra blades spread evenly around you
        swings.push({ angle, age: 0, life: 0.22 });
        // Hit test for a "pie slice": a devil is hit when it is close enough (distance) AND
        // inside the slice (its direction is within half the arc of the blade's direction).
        for (const e of enemies) {
          const dx = e.x - player.x;
          const dy = e.y - player.y;
          const dist = Math.hypot(dx, dy);
          if (dist - e.r > stats.reach) continue;
          const inside = Math.abs(angleDiff(Math.atan2(dy, dx), angle)) <= stats.arc / 2 || dist < player.r + e.r;
          if (inside) hit(e, stats.damage, dx / (dist || 1), dy / (dist || 1));
        }
      }
      playSound('tick');
      return true;
    }

    function hit(e, dmg, nx, ny) {
      if (e.hp <= 0) return;
      e.hp -= dmg;
      e.flash = 0.1; // drawn white for a moment: the "hit flash"
      const push = e.type === 'boss' ? 3 : 14;
      e.x += nx * push; // knockback
      e.y += ny * push;
      particles.burst(e.x, e.y, '#ff2a4a', 5, { speed: 160, size: 2.5, life: 0.4 });
      popups.add(e.x + (Math.random() - 0.5) * 10, e.y - e.r, String(Math.round(dmg)), '#ffd2d8', 13, 0.6);
      if (e.hp <= 0) kill(e);
    }

    function kill(e) {
      kills += 1;
      const t = TYPES[e.type];
      particles.burst(e.x, e.y, t.color, e.type === 'boss' ? 90 : 18, { speed: e.type === 'boss' ? 420 : 240, size: 3.5, life: 0.7 });
      particles.burst(e.x, e.y, '#ff1030', e.type === 'boss' ? 60 : 10, { speed: 180, size: 3, life: 0.9 });
      if (splats.length > 40) splats.shift();
      splats.push({ x: e.x, y: e.y, r: e.r * (1.2 + Math.random() * 0.6), a: Math.random() * TAU, life: 1 });
      shake.add(e.type === 'boss' ? 0.9 : 0.12);
      // XP shards: a few small ones, many for a boss.
      const count = e.type === 'boss' ? 14 : e.type === 'mini' ? 1 : 2;
      for (let i = 0; i < count; i += 1) dropShard(e.x, e.y, e.type === 'boss' ? 3 : 1);
      if (e.type === 'splitter') {
        for (let i = 0; i < 2; i += 1) spawn('mini', e.x + (i ? 10 : -10), e.y);
      }
      if (e.type === 'boss') {
        bonus += 50 * wave.n;
        popups.add(e.x, e.y - 50, `Boss down +${50 * wave.n}`, '#e7c6ff', 24, 1.4);
        playSound('success');
      }
    }

    function dropShard(x, y, value) {
      if (shards.length >= MAX_SHARDS) { shards[Math.floor(Math.random() * shards.length)].value += value; return; }
      const a = Math.random() * TAU;
      shards.push({ x, y, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, value, spin: Math.random() * TAU });
    }

    function gainXp(v) {
      xp += v;
      while (xp >= xpNeed) {
        xp -= xpNeed;
        level += 1;
        xpNeed = Math.round(xpNeed * 1.25 + 3);
        pendingLevels += 1;
      }
      if (pendingLevels && !choices) offerUpgrades();
    }

    function offerUpgrades() {
      const pool = UPGRADES.filter((u) => u.ok(stats, player));
      const pick = [];
      while (pick.length < 3 && pool.length) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      choices = { cards: pick, age: 0 };
      keys.clear(); // so you don't keep walking after the pause
      pointer = null;
      playSound('chime');
    }

    function choose(i) {
      if (!choices || !choices.cards[i] || choices.age < 0.25) return; // tiny delay: no accidental picks
      choices.cards[i].apply(stats, player);
      popups.add(player.x, player.y - 30, choices.cards[i].name, '#ffe08a', 16, 1.2);
      pendingLevels -= 1;
      choices = null;
      if (pendingLevels > 0) offerUpgrades();
    }

    // ---------------------------------------------------------------- update (one fixed step)
    function update(dt) {
      time += dt;
      shake.update(dt);
      particles.update(dt);
      popups.update(dt);
      if (banner) { banner.age += dt; if (banner.age > 1.6) banner = null; }
      if (choices) { choices.age += dt; return; } // paused for a level-up
      if (dead) return;

      // Movement: add up the pressed directions, then normalise so diagonals aren't faster.
      let mx = 0;
      let my = 0;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
      if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
      if (!mx && !my && pointer) {
        const dx = pointer.x - player.x;
        const dy = pointer.y - player.y;
        if (Math.hypot(dx, dy) > 8) { mx = dx; my = dy; }
      }
      const len = Math.hypot(mx, my);
      if (len) {
        player.x += (mx / len) * stats.speed * dt;
        player.y += (my / len) * stats.speed * dt;
        player.walk += dt * 10;
      }
      player.x = clamp(player.x, player.r, S.w - player.r);
      player.y = clamp(player.y, player.r, S.h - player.r);
      player.inv = Math.max(0, player.inv - dt);
      hurtFlash = Math.max(0, hurtFlash - dt);
      if (stats.regen) player.hp = Math.min(player.maxHp, player.hp + stats.regen * dt);

      // Auto-attack: when the timer runs out, swing (if something is in range).
      attackTimer -= dt;
      if (attackTimer <= 0) attackTimer = swing() ? stats.attackEvery : 0.05;
      for (let i = swings.length - 1; i >= 0; i -= 1) {
        swings[i].age += dt;
        if (swings[i].age >= swings[i].life) swings.splice(i, 1);
      }

      // Waves: spawn the wave's devils over time; when all are dead, rest a moment, then next wave.
      if (wave.toSpawn > 0) {
        wave.spawnTimer -= dt;
        if (wave.spawnTimer <= 0) {
          wave.spawnTimer = Math.max(0.22, 1.1 - wave.n * 0.06);
          const group = Math.min(wave.toSpawn, 1 + Math.floor(wave.n / 4)); // later waves spawn in groups
          for (let i = 0; i < group; i += 1) spawn(pickType());
          wave.toSpawn -= group;
        }
      } else if (enemies.length === 0) {
        if (wave.n > 0 && wave.rest <= 0) {
          bonus += wave.n * 10;
          popups.add(S.w / 2, S.h / 2 + 30, `Wave cleared +${wave.n * 10}`, '#ffe08a', 20, 1.3);
          wave.rest = 1.6;
        }
        wave.rest -= dt;
        if (wave.rest <= 0) startWave();
      }

      // Devils: each type has its own little "brain".
      for (const e of enemies) {
        e.flash = Math.max(0, e.flash - dt);
        e.timer -= dt;
        e.blink -= dt;
        if (e.blink < -0.12) e.blink = 2 + Math.random() * 4;
        const dx = player.x - e.x;
        const dy = player.y - e.y;
        const dist = Math.hypot(dx, dy) || 1;
        let speed = e.speed;
        let ux = dx / dist;
        let uy = dy / dist;
        if (e.type === 'dasher') {
          // Walk, then stop and shake ("wind-up") so you can see it coming, then charge in a
          // straight line in the direction it locked on to.
          if (e.state === 'walk' && e.timer <= 0 && dist < 280) { e.state = 'windup'; e.timer = 0.55; }
          else if (e.state === 'windup') { speed = 0; if (e.timer <= 0) { e.state = 'dash'; e.timer = 0.35; e.dx = ux; e.dy = uy; } }
          else if (e.state === 'dash') { speed = 440; ux = e.dx; uy = e.dy; if (e.timer <= 0) { e.state = 'walk'; e.timer = 1.6; } }
        } else if (e.type === 'boss') {
          // The boss calls in two helpers every few seconds and sometimes lunges.
          if (e.timer <= 0) {
            e.timer = 3.5;
            spawn('chaser', e.x + 40, e.y);
            spawn('chaser', e.x - 40, e.y);
            e.state = 'lunge';
            e.lunge = 0.5;
            shake.add(0.25);
          }
          if (e.state === 'lunge') { speed = 200; e.lunge -= dt; if (e.lunge <= 0) e.state = 'walk'; }
        }
        e.x += ux * speed * dt;
        e.y += uy * speed * dt;

        // Collision with the player: two circles overlap when the distance between their
        // centres is smaller than the sum of their radii.
        if (dist < player.r + e.r * 0.85 && player.inv <= 0) {
          player.hp -= e.dmg;
          player.inv = 0.6; // a moment of invincibility so one touch isn't 60 hits per second
          hurtFlash = 0.3;
          shake.add(0.45);
          particles.burst(player.x, player.y, '#ff4060', 14, { speed: 200, size: 3 });
          playSound('error');
          if (player.hp <= 0) die();
        }
      }
      // Clean out the dead (going backwards so removing doesn't skip an item).
      for (let i = enemies.length - 1; i >= 0; i -= 1) if (enemies[i].hp <= 0) enemies.splice(i, 1);

      // XP shards: drift and slow down; inside the magnet range they accelerate towards you.
      for (let i = shards.length - 1; i >= 0; i -= 1) {
        const s = shards[i];
        s.spin += dt * 4;
        const dx = player.x - s.x;
        const dy = player.y - s.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < stats.magnet) { s.vx += (dx / d) * 1400 * dt; s.vy += (dy / d) * 1400 * dt; }
        s.vx *= 1 - 4 * dt;
        s.vy *= 1 - 4 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (d < player.r + 6) {
          shards.splice(i, 1);
          particles.burst(s.x, s.y, '#ff6b81', 3, { speed: 80, size: 2, life: 0.3 });
          gainXp(s.value);
          if (choices) return; // a level-up just paused the game
        }
      }
      for (let i = splats.length - 1; i >= 0; i -= 1) {
        splats[i].life -= dt * 0.05;
        if (splats[i].life <= 0) splats.splice(i, 1);
      }
    }

    /** Push overlapping devils apart so they spread out instead of stacking into one blob. */
    function separate() {
      for (let i = 0; i < enemies.length; i += 1) {
        const a = enemies[i];
        for (let j = i + 1; j < enemies.length; j += 1) {
          const b = enemies[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r;
          if (Math.abs(dx) > min || Math.abs(dy) > min) continue; // quick reject before the square root
          const d = Math.hypot(dx, dy) || 0.01;
          if (d < min) {
            const push = (min - d) / 2;
            const wa = a.type === 'boss' ? 0.1 : 1; // the boss barely moves
            const wb = b.type === 'boss' ? 0.1 : 1;
            a.x -= (dx / d) * push * wa; a.y -= (dy / d) * push * wa;
            b.x += (dx / d) * push * wb; b.y += (dy / d) * push * wb;
          }
        }
      }
    }

    function die() {
      dead = true;
      player.hp = 0;
      particles.burst(player.x, player.y, '#ff2a4a', 80, { speed: 360, size: 4, life: 1 });
      shake.add(1);
      const score = Math.min(1_000_000, kills + bonus);
      endTimer = setTimeout(() => {
        cleanupRun();
        finishRun(el, devilArena, {
          score,
          headline: `Fell on wave ${wave.n}`,
          detail: `${kills} devils slain · level ${level} · ${bonus} wave bonus`,
          again: start,
        });
      }, 1200);
    }

    // ---------------------------------------------------------------- drawing
    function drawBlob(e) {
      const t = TYPES[e.type];
      const n = 14;
      const wob = e.type === 'boss' ? 0.06 : 0.1;
      ctx.save();
      ctx.translate(e.x, e.y);
      if (e.state === 'windup') ctx.translate((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.ellipse(0, e.r * 0.9, e.r * 0.9, e.r * 0.3, 0, 0, TAU); ctx.fill();
      // Wobbly body: a circle whose radius ripples with sine waves at each of n points.
      ctx.beginPath();
      for (let i = 0; i <= n; i += 1) {
        const a = (i / n) * TAU;
        const rr = e.r * (1 + wob * Math.sin(time * 6 + i * 1.7 + e.phase));
        if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      if (e.flash > 0) {
        ctx.fillStyle = '#fff';
      } else {
        const g = ctx.createRadialGradient(-e.r * 0.3, -e.r * 0.4, 1, 0, 0, e.r * 1.1);
        g.addColorStop(0, '#fff');
        g.addColorStop(0.25, t.color);
        g.addColorStop(1, t.dark);
        ctx.fillStyle = g;
      }
      if (e.type === 'boss') { ctx.shadowColor = t.color; ctx.shadowBlur = 24; }
      ctx.fill();
      ctx.shadowBlur = 0;
      if (e.state === 'windup') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      // Horns
      ctx.fillStyle = t.dark;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * e.r * 0.25, -e.r * 0.8);
        ctx.lineTo(side * e.r * 0.65, -e.r * 1.45);
        ctx.lineTo(side * e.r * 0.6, -e.r * 0.65);
        ctx.fill();
      }
      // Eyes look at the player; they close for a moment when blink < 0.
      const look = Math.atan2(player.y - e.y, player.x - e.x);
      const eyeH = e.blink < 0 ? 0.15 : 1;
      for (const side of [-1, 1]) {
        const ex = side * e.r * 0.35;
        const ey = -e.r * 0.15;
        ctx.fillStyle = e.state === 'windup' || e.type === 'boss' ? '#ffe14d' : '#fff';
        ctx.beginPath(); ctx.ellipse(ex, ey, e.r * 0.24, e.r * 0.3 * eyeH, 0, 0, TAU); ctx.fill();
        if (eyeH === 1) {
          ctx.fillStyle = '#000';
          ctx.beginPath(); ctx.arc(ex + Math.cos(look) * e.r * 0.1, ey + Math.sin(look) * e.r * 0.12, e.r * 0.11, 0, TAU); ctx.fill();
        }
      }
      // Mouth: a jagged grin
      ctx.strokeStyle = '#1a0006';
      ctx.lineWidth = Math.max(1.5, e.r * 0.08);
      ctx.beginPath();
      for (let i = 0; i <= 6; i += 1) {
        const x = -e.r * 0.4 + (i / 6) * e.r * 0.8;
        const y = e.r * 0.35 + (i % 2 ? e.r * 0.12 : 0);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawPlayer() {
      const p = player;
      if (p.inv > 0 && Math.floor(p.inv * 20) % 2 === 0 && !dead) return; // blink while invincible
      ctx.save();
      ctx.translate(p.x, p.y + Math.sin(p.walk) * 1.5); // a little bob while walking
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.ellipse(0, p.r + 2, p.r, p.r * 0.35, 0, 0, TAU); ctx.fill();
      // The chainsaw "nose" pointing where you last swung.
      ctx.save();
      ctx.rotate(p.face);
      ctx.fillStyle = '#c9c9c9';
      ctx.fillRect(p.r - 4, -4, 16, 8);
      ctx.fillStyle = '#ff7a1a';
      for (let i = 0; i < 4; i += 1) ctx.fillRect(p.r - 2 + i * 4 + ((time * 40) % 4), -6, 2, 2);
      ctx.restore();
      if (avatarImg) {
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU); ctx.clip(); // circle-shaped window for the picture
        drawCover(ctx, avatarImg, -p.r, -p.r, p.r * 2, p.r * 2);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ffb347'; // simple hero: orange head, dark coat, spiky hair
        ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU); ctx.fill();
        ctx.fillStyle = '#f6d36b';
        for (let i = -2; i <= 2; i += 1) {
          ctx.beginPath(); ctx.moveTo(i * 5 - 4, -p.r * 0.4); ctx.lineTo(i * 5, -p.r - 6); ctx.lineTo(i * 5 + 4, -p.r * 0.4); ctx.fill();
        }
        ctx.fillStyle = '#111';
        ctx.fillRect(-5, -2, 3, 4); ctx.fillRect(2, -2, 3, 4);
      }
      ctx.strokeStyle = hurtFlash > 0 ? '#fff' : '#ff3b5c';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#ff3b5c';
      ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(0, 0, p.r + 1.5, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    function drawSwings() {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const s of swings) {
        const k = s.age / s.life;
        // The slice "sweeps" open from one side to the other, then fades.
        const start = s.angle - stats.arc / 2;
        const end = start + stats.arc * ease.outCubic(Math.min(1, k * 1.8));
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = 'rgba(255,70,50,0.35)';
        ctx.beginPath();
        ctx.arc(player.x, player.y, stats.reach, start, end);
        ctx.arc(player.x, player.y, stats.reach * 0.45, end, start, true);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ffd0a0';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(player.x, player.y, stats.reach, start, end); ctx.stroke();
        // Saw teeth along the edge
        ctx.fillStyle = '#fff';
        for (let a = start; a < end; a += 0.18) {
          ctx.beginPath(); ctx.arc(player.x + Math.cos(a) * stats.reach, player.y + Math.sin(a) * stats.reach, 1.6, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawHud() {
      ctx.save();
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      // HP bar
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(14, 14, 184, 34);
      ctx.fillStyle = '#3a1016';
      ctx.fillRect(20, 20, 172, 10);
      ctx.fillStyle = '#ff3b5c';
      ctx.fillRect(20, 20, 172 * clamp(player.hp / player.maxHp, 0, 1), 10);
      ctx.fillStyle = '#2a2016';
      ctx.fillRect(20, 36, 172, 5);
      ctx.fillStyle = '#ffd25a';
      ctx.fillRect(20, 36, 172 * (xp / xpNeed), 5);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.ceil(player.hp)} / ${player.maxHp}`, 206, 25);
      ctx.fillStyle = '#ffd25a';
      ctx.fillText(`Lv ${level}`, 206, 40);
      // Wave and score
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fff';
      ctx.font = '700 18px system-ui, sans-serif';
      ctx.fillText(`${kills + bonus}`, S.w - 16, 24);
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#c9a0a8';
      ctx.fillText(`WAVE ${wave.n} · ${kills} KILLS`, S.w - 16, 44);
      // Boss bar
      if (wave.boss && wave.boss.hp > 0) {
        const bw = Math.min(360, S.w * 0.4);
        const x = (S.w - bw) / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 4, 12, bw + 8, 22);
        ctx.fillStyle = '#2a0f3f';
        ctx.fillRect(x, 24, bw, 6);
        ctx.fillStyle = '#b45cff';
        ctx.fillRect(x, 24, bw * (wave.boss.hp / wave.boss.maxHp), 6);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#e7c6ff';
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.fillText('ARCH-DEVIL', S.w / 2, 17);
      }
      ctx.restore();
    }

    /** Rectangles of the three upgrade cards (shared by drawing and click testing). */
    function cardRects() {
      const n = choices ? choices.cards.length : 0;
      const cw = Math.min(220, (S.w - 60) / 3);
      const ch = 150;
      const gap = 14;
      const total = n * cw + (n - 1) * gap;
      return Array.from({ length: n }, (_, i) => ({ x: (S.w - total) / 2 + i * (cw + gap), y: S.h / 2 - ch / 2 + 16, w: cw, h: ch }));
    }

    function drawChoices() {
      const appear = ease.outCubic(Math.min(1, choices.age / 0.3));
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${0.65 * appear})`;
      ctx.fillRect(0, 0, S.w, S.h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffd25a';
      ctx.font = '700 24px system-ui, sans-serif';
      ctx.fillText(`Level ${level - pendingLevels + 1}!`, S.w / 2, S.h / 2 - 100);
      ctx.fillStyle = '#ccc';
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.fillText('Pick an upgrade (1, 2, 3 or click)', S.w / 2, S.h / 2 - 74);
      cardRects().forEach((r, i) => {
        const c = choices.cards[i];
        const lift = (1 - appear) * 40 + (hoverCard === i ? -6 : 0); // cards slide up into place
        ctx.fillStyle = hoverCard === i ? '#2a1015' : '#160709';
        ctx.strokeStyle = hoverCard === i ? '#ff3b5c' : '#5a1a24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(r.x, r.y + lift, r.w, r.h);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ff3b5c';
        ctx.font = '700 22px system-ui, sans-serif';
        ctx.fillText(String(i + 1), r.x + r.w / 2, r.y + lift + 28);
        ctx.fillStyle = '#fff';
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.fillText(c.name, r.x + r.w / 2, r.y + lift + 66, r.w - 12);
        ctx.fillStyle = '#c9a0a8';
        ctx.font = '500 12px system-ui, sans-serif';
        wrapText(c.text, r.x + r.w / 2, r.y + lift + 96, r.w - 20, 16);
      });
      ctx.restore();
    }

    function wrapText(text, x, y, maxW, lineH) {
      const words = text.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, y); line = w; y += lineH; } else line = test;
      }
      ctx.fillText(line, x, y);
    }

    function draw() {
      ctx.save();
      shake.apply(ctx);
      ctx.drawImage(floor, 0, 0, S.w, S.h);
      // Parallax: embers drift up and shift slightly against your movement, which makes the
      // flat floor feel like it has depth.
      ctx.fillStyle = 'rgba(255,90,60,0.35)';
      for (const m of embers) {
        const x = ((m.x * S.w - (player.x - S.w / 2) * 0.15 * m.s) % S.w + S.w) % S.w;
        const y = (((m.y - time * m.v) * S.h - (player.y - S.h / 2) * 0.15 * m.s) % S.h + S.h) % S.h;
        ctx.fillRect(x, y, m.s * 1.5, m.s * 1.5);
      }
      for (const s of splats) {
        ctx.globalAlpha = 0.35 * s.life;
        ctx.fillStyle = '#5e0612';
        ctx.beginPath(); ctx.ellipse(s.x, s.y, s.r, s.r * 0.7, s.a, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
      // XP shards: little spinning red diamonds with a soft glow.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const s of shards) {
        ctx.fillStyle = 'rgba(255,40,70,0.25)';
        ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, TAU); ctx.fill();
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.spin);
        ctx.fillStyle = s.value > 1 ? '#ff7a8f' : '#ff2a4a';
        ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(3.5, 0); ctx.lineTo(0, 5); ctx.lineTo(-3.5, 0); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      for (const e of enemies) drawBlob(e);
      if (!dead) drawPlayer();
      drawSwings();
      particles.draw(ctx);
      popups.draw(ctx);
      ctx.restore();

      if (hurtFlash > 0) { // red edge flash when you get hit
        ctx.fillStyle = `rgba(255,0,40,${hurtFlash * 0.5})`;
        ctx.fillRect(0, 0, S.w, S.h);
      }
      drawHud();
      if (banner) {
        const k = banner.age / 1.6;
        ctx.save();
        ctx.globalAlpha = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.round(34 + 10 * ease.outBack(Math.min(1, k * 5)))}px system-ui, sans-serif`;
        ctx.fillStyle = '#ff3b5c';
        ctx.fillText(banner.text.toUpperCase(), S.w / 2, S.h * 0.32);
        ctx.restore();
      }
      if (choices) drawChoices();
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
    const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const toLocal = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (ev.clientX - rect.left) * (S.w / rect.width), y: (ev.clientY - rect.top) * (S.h / rect.height) };
    };
    const onKeyDown = (ev) => {
      if (MOVE_KEYS.includes(ev.code)) { ev.preventDefault(); if (!choices) keys.add(ev.code); }
      if (choices && ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].includes(ev.code)) {
        ev.preventDefault();
        if (!ev.repeat) choose(Number(ev.code.slice(-1)) - 1);
      }
    };
    const onKeyUp = (ev) => keys.delete(ev.code);
    const cardAt = (pt) => cardRects().findIndex((r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h);
    const onDown = (ev) => {
      ev.preventDefault();
      canvas.focus();
      const pt = toLocal(ev);
      if (choices) { const i = cardAt(pt); if (i >= 0) choose(i); return; }
      pointer = pt;
    };
    const onMove = (ev) => {
      const pt = toLocal(ev);
      if (choices) { hoverCard = cardAt(pt); canvas.style.cursor = hoverCard >= 0 ? 'pointer' : 'default'; return; }
      canvas.style.cursor = 'crosshair';
      if (pointer) pointer = pt;
    };
    const onUp = () => { pointer = null; };
    const onBlur = () => { keys.clear(); pointer = null; };
    let paused = false;
    const onVisibility = () => { paused = document.hidden; keys.clear(); };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    cleanupRun = () => {
      cancelAnimationFrame(raf);
      fit.dispose();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      cleanupRun = () => {};
    };

    // ---------------------------------------------------------------- the loop
    let last = performance.now();
    let acc = 0;
    function frame(now) {
      // Fixed time step: real time is collected in `acc`, and the simulation advances in equal
      // STEP-sized chunks. The cap (0.1 s) stops a long hiccup from making devils teleport.
      const elapsed = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!paused) {
        acc += elapsed;
        while (acc >= STEP) { update(STEP); acc -= STEP; }
        if (!choices && !dead) separate(); // once per frame is enough for spreading devils out
      }
      draw();
      if (!gone) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  startScreen(el, {
    title: 'Devil Hunter Arena',
    rules: [
      'Move with WASD or the arrow keys (or hold the mouse where you want to go). Your chainsaw swings at the nearest devil by itself.',
      'Red devils chase, orange ones stop, shake and then dash, green ones split in two. Every 5th wave an arch-devil boss shows up.',
      'Collect the blood shards to level up, then pick one of three upgrades with 1, 2, 3 or a click.',
      'Score is kills plus a bonus for every wave you clear. It is over when your HP hits 0.',
    ],
    onStart: start,
  });

  return () => { gone = true; clearTimeout(endTimer); cleanupRun(); };
}
