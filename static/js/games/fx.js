// Small "game feel" helpers for the canvas games: particles, floating score text, screen shake,
// easing curves and a canvas that follows its container's width at the device pixel ratio.
//
// Why pools with a hard cap? Every particle costs a little drawing time each frame. Capping the
// list (MAX_PARTICLES) means a huge explosion can never drop the game below 60 fps: when the list
// is full, new particles simply replace the oldest ones.

export const MAX_PARTICLES = 300;

/** True when the user asked the system for less motion: we then skip screen shake. */
export function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- easing
// An easing function maps progress t (0..1) to a "shaped" progress, so motion starts or ends softly.
export const ease = {
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t) => { const c = 1.7; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; }, // overshoots a bit
};
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- particles
export function createParticles() {
  const list = [];
  return {
    list,
    /** Spray `count` sparks from (x, y) in `color`. */
    burst(x, y, color, count = 16, { speed = 220, size = 3, life = 0.6, gravity = 0, glow = true } = {}) {
      for (let i = 0; i < count; i += 1) {
        if (list.length >= MAX_PARTICLES) list.shift(); // full: drop the oldest
        const angle = Math.random() * Math.PI * 2;
        const v = speed * (0.3 + Math.random() * 0.7);
        list.push({
          x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
          life: life * (0.6 + Math.random() * 0.4), age: 0,
          size: size * (0.6 + Math.random() * 0.8), color, gravity, glow,
        });
      }
    },
    update(dt) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const p = list[i];
        p.age += dt;
        if (p.age >= p.life) { list.splice(i, 1); continue; }
        p.vx *= 1 - 3 * dt; // air drag: sparks slow down instead of flying off forever
        p.vy = p.vy * (1 - 3 * dt) + p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    },
    draw(ctx) {
      // "lighter" blending adds colours together, so overlapping sparks glow brighter.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of list) {
        const k = 1 - p.age / p.life;
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (p.glow ? 0.5 + k : 1), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
    clear() { list.length = 0; },
  };
}

// ---------------------------------------------------------------- floating text ("+120", "Combo x3")
export function createPopups() {
  const list = [];
  return {
    list,
    add(x, y, text, color = '#fff', size = 18, life = 0.9) {
      if (list.length > 40) list.shift();
      list.push({ x, y, text, color, size, life, age: 0 });
    },
    update(dt) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const p = list[i];
        p.age += dt;
        p.y -= 40 * dt; // float upwards
        if (p.age >= p.life) list.splice(i, 1);
      }
    },
    draw(ctx) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of list) {
        const t = p.age / p.life;
        const pop = t < 0.15 ? ease.outBack(t / 0.15) : 1; // quick "pop" in, then fade
        ctx.globalAlpha = 1 - t * t;
        ctx.font = `700 ${Math.round(p.size * pop)}px system-ui, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.restore();
    },
  };
}

// ---------------------------------------------------------------- screen shake
// "trauma" goes up on a hit and decays over time; the offset grows with trauma² so small hits
// barely wobble while big ones really kick. Disabled when the system asks for reduced motion.
export function createShake() {
  const off = reducedMotion();
  let trauma = 0;
  return {
    add(amount) { if (!off) trauma = Math.min(1, trauma + amount); },
    update(dt) { trauma = Math.max(0, trauma - dt * 1.6); },
    /** Call between ctx.save() and drawing the world. */
    apply(ctx) {
      if (!trauma) return;
      const k = trauma * trauma * 14;
      ctx.translate((Math.random() * 2 - 1) * k, (Math.random() * 2 - 1) * k);
    },
  };
}

// ---------------------------------------------------------------- canvas sizing
/**
 * Keep a canvas as wide as its container (max `maxWidth`) and sharp on high-DPI screens.
 * The canvas has more real pixels than CSS pixels (× devicePixelRatio); setTransform scales
 * every drawing call so we can keep thinking in CSS pixels.
 * `heightFor(width)` returns the CSS height. Returns {size, dispose}.
 */
export function fitCanvas(canvas, ctx, heightFor, maxWidth = 960, onResize = null) {
  const size = { w: 0, h: 0 };
  const resize = () => {
    const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 800;
    size.w = Math.max(280, Math.min(maxWidth, parentW || 800));
    size.h = heightFor(size.w);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (onResize) onResize(size);
  };
  resize();
  window.addEventListener('resize', resize);
  return { size, dispose: () => window.removeEventListener('resize', resize) };
}

/** Trace a rounded rectangle path (ctx.roundRect is not in every WebView yet). */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw an image "object-fit: cover" style into a box (crop the middle, never stretch). */
export function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}
