// Small drawing helpers for the canvas games (Broom Courier, ODM Swing).
//
// The big idea in here is CACHING. Drawing a whole mountain range or a forest means hundreds of
// path operations. Doing that 60 times a second wastes the frame budget (about 16 ms), so we draw
// such things ONCE into an "offscreen canvas" (a canvas that is never put on the page) and then
// copy that finished picture onto the real canvas each frame with one drawImage call, which the
// graphics card does very quickly.

/** True when the user asked the system for less motion (we turn off screen shake and zooms). */
export function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const lerp = (a, b, t) => a + (b - a) * t;
/** An S-shaped 0→1 curve: starts and ends gently, so colour fades never "snap". */
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Blend two [r, g, b] colours. t = 0 gives a, t = 1 gives b. */
export function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** [r, g, b] (+ optional alpha) → a CSS colour string the canvas understands. */
export function rgb(c, alpha = 1) {
  const [r, g, b] = c.map((v) => Math.round(v));
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/**
 * A canvas that lives only in memory. It is sized at the device pixel ratio (dpr) so it stays sharp
 * on high-resolution screens, and its context is scaled so we can still draw in CSS pixels.
 */
export function makeCanvas(w, h, dpr = window.devicePixelRatio || 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * dpr));
  canvas.height = Math.max(1, Math.ceil(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, w, h };
}

/**
 * A wavy skyline that repeats perfectly every `width` pixels.
 * Each wave is a sine with a WHOLE number of cycles across the width, so the right edge ends at
 * exactly the same height as the left edge starts. That is what lets us tile the layer forever.
 * `waves` is a list of [cycles, amplitude, phase].
 */
export function ridge(width, waves) {
  return (x) => {
    let y = 0;
    for (const [cycles, amp, phase] of waves) y += Math.sin((x / width) * Math.PI * 2 * cycles + phase) * amp;
    return y;
  };
}

/**
 * Draw a horizontally repeating picture with parallax.
 * `scroll` is how far this layer has moved. Far-away layers get a small scroll (camera x times a
 * small factor like 0.1), near layers a big one (factor close to 1). That speed difference is what
 * the eye reads as depth, the same reason distant mountains seem to crawl past a train window.
 * The modulo (%) wraps the offset into one tile width, and we draw the tile as many times as needed
 * to cover the screen.
 */
export function drawTiled(ctx, layer, scroll, y, viewW) {
  const w = layer.w;
  const offset = ((scroll % w) + w) % w; // the extra "+ w) % w" keeps it positive for negative scroll
  for (let x = -offset; x < viewW; x += w) ctx.drawImage(layer.canvas, x, y, w, layer.h);
}

/**
 * A layer whose SHAPE is cached but whose COLOUR can change (for the day → night cycle).
 * `mask` holds the shape once. tint(colour) repaints `out` by copying the mask and filling it with
 * 'source-in', which keeps the new colour only where the mask has pixels (and keeps its soft edges).
 * The repaint only happens when the colour actually changed, so most frames it costs nothing.
 */
export class TintLayer {
  constructor(w, h, dpr, drawShape) {
    this.w = w;
    this.h = h;
    this.mask = makeCanvas(w, h, dpr);
    drawShape(this.mask.ctx, w, h);
    this.out = makeCanvas(w, h, dpr);
    this.canvas = this.out.canvas;
    this.key = '';
  }

  tint(colour) {
    if (colour === this.key) return;
    this.key = colour;
    const { ctx } = this.out;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.mask.canvas, 0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'source-over';
  }
}

// One soft round "glow" picture per colour, made once and reused. Stamping this image is much
// cheaper than the canvas shadowBlur option, which re-blurs every shape every frame.
const glowCache = new Map();
export function glowSprite(colour) {
  let sprite = glowCache.get(colour);
  if (!sprite) {
    sprite = makeCanvas(64, 64, 1);
    const g = sprite.ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, colour);
    g.addColorStop(0.35, colour.replace('rgb(', 'rgba(').replace(')', ',0.45)'));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    sprite.ctx.fillStyle = g;
    sprite.ctx.fillRect(0, 0, 64, 64);
    glowCache.set(colour, sprite);
  }
  return sprite.canvas;
}

/** Stamp a glow of radius r centred on (x, y). Use with ctx.globalCompositeOperation = 'lighter'. */
export function drawGlow(ctx, colour, x, y, r, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.drawImage(glowSprite(colour), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

/**
 * A capped particle system (sparks, dust, gas, feathers).
 * Particles live in WORLD coordinates, so when the camera moves on they naturally trail behind.
 * The cap matters: every particle costs a little each frame, and an explosion of thousands would
 * drop the frame rate. When full, new particles simply replace nothing (they are skipped).
 */
export class Particles {
  constructor(max = 300) {
    this.max = max;
    this.list = [];
  }

  /** opts: x, y, vx, vy, life (s), size, colour ('rgb(...)'), glow (bool), drag, gravity, grow */
  add(opts) {
    if (this.list.length >= this.max) return;
    this.list.push({ drag: 0, gravity: 0, grow: 0, glow: false, ...opts, age: 0 });
  }

  update(dt) {
    const keep = [];
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vx *= 1 - p.drag * dt;
      p.vy = p.vy * (1 - p.drag * dt) + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size = Math.max(0.1, p.size + p.grow * dt);
      keep.push(p);
    }
    this.list = keep;
  }

  /** Draw with the camera offset camX. Glowing ones are added together ('lighter') so they shine. */
  draw(ctx, camX) {
    for (const p of this.list) {
      const fade = 1 - p.age / p.life;
      const x = p.x - camX;
      if (p.glow) {
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, p.colour, x, p.y, p.size * 3, fade);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.globalAlpha = fade * (p.alpha ?? 1);
        ctx.fillStyle = p.colour;
        ctx.beginPath();
        ctx.arc(x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
}

/** Floating "+10" texts that rise and fade. */
export class Floaters {
  constructor() { this.list = []; }

  add(text, x, y, colour = '#fff', size = 16) {
    if (this.list.length > 30) this.list.shift();
    this.list.push({ text, x, y, colour, size, age: 0 });
  }

  update(dt) {
    for (const f of this.list) { f.age += dt; f.y -= 40 * dt; }
    this.list = this.list.filter((f) => f.age < 1);
  }

  draw(ctx, camX, font) {
    ctx.textAlign = 'center';
    for (const f of this.list) {
      // pop in: a quick scale-up during the first 0.15 s
      const pop = Math.min(1, f.age / 0.15);
      ctx.globalAlpha = 1 - f.age;
      ctx.font = `700 ${Math.round(f.size * (0.6 + 0.4 * pop))}px ${font}`;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(f.text, f.x - camX + 1, f.y + 1);
      ctx.fillStyle = f.colour;
      ctx.fillText(f.text, f.x - camX, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
  }
}

/** A screen shake that decays: hit() adds strength, offset() gives this frame's jiggle. */
export class Shake {
  constructor() { this.amount = 0; this.off = reducedMotion(); }
  hit(strength) { if (!this.off) this.amount = Math.max(this.amount, strength); }
  update(dt) { this.amount = Math.max(0, this.amount - this.amount * 6 * dt - 2 * dt); }
  offset() {
    if (this.amount < 0.2) return [0, 0];
    return [(Math.random() * 2 - 1) * this.amount, (Math.random() * 2 - 1) * this.amount];
  }
}

/** The page's font, so canvas text matches the app. */
export function gameFont() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
  return v || 'system-ui, sans-serif';
}
