// Small sound effects, made on the fly with the Web Audio API (no audio files to download).
//
// Sounds are OFF by default. The choice (on/off + volume) is a per-device preference, so it lives
// in localStorage, not in the database. Every storage access is wrapped in try/catch because
// private windows or blocked storage can make localStorage throw.
//
// How a sound is made: an "oscillator" produces a pure tone at a frequency (Hz), and a "gain" node
// turns its loudness up and down. Ramping the gain quickly up and then smoothly down (an "envelope")
// is what turns a beep into a soft blip or a bell-like chime.

const STORE_KEY = 'anishelf.sound';
const DEFAULTS = { on: false, volume: 0.5 };
const MIN_GAP_MS = 120; // the same sound twice within this window plays once (e.g. 3 badges at once)

let audioCtx = null; // created lazily: browsers only allow audio after the user has interacted
const lastPlayed = {};

/** True when the browser can make sounds at all. */
export function soundSupported() {
  return typeof window !== 'undefined' && Boolean(window.AudioContext || window.webkitAudioContext);
}

/** The system asks for less motion; we treat that as a hint to keep sounds off by default. */
export function prefersQuiet() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Read the saved settings, falling back to the defaults for anything missing or broken. */
export function getSoundSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    saved = null;
  }
  const settings = { ...DEFAULTS };
  if (saved && typeof saved.on === 'boolean') settings.on = saved.on;
  if (saved && typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
    settings.volume = Math.min(1, Math.max(0, saved.volume));
  }
  return settings;
}

/** Save a change, e.g. setSoundSettings({ on: true }) or setSoundSettings({ volume: 0.3 }). */
export function setSoundSettings(patch) {
  const next = { ...getSoundSettings(), ...patch };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the change just won't be remembered */
  }
  return next;
}

function getContext() {
  if (!soundSupported()) return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  // A context can start "suspended" until a user gesture; resume() is harmless if it's running.
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/**
 * Play one tone.
 * freq: pitch in Hz, start: seconds from now, length: seconds, peak: loudness 0..1,
 * type: wave shape ('sine' is softest, 'triangle' is a little brighter), slideTo: optional end pitch.
 */
function tone(ctx, out, { freq, start = 0, length = 0.12, peak = 1, type = 'sine', slideTo = null }) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + length);
  // Exponential ramps can't reach exactly 0, so we fade from and to a tiny number instead.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.01); // fast attack
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + length); // smooth decay
  osc.connect(gain);
  gain.connect(out);
  osc.start(t0);
  osc.stop(t0 + length + 0.02);
}

// Each sound is a short recipe of tones. Frequencies are musical notes (A5 = 880 Hz, etc.).
const RECIPES = {
  // +1 episode: one tiny, high blip.
  tick: (ctx, out) => {
    tone(ctx, out, { freq: 1320, length: 0.06, peak: 0.5, type: 'triangle' });
  },
  // Level up / badge: two bell-like notes going up (A5 then E6).
  chime: (ctx, out) => {
    tone(ctx, out, { freq: 880, length: 0.45, peak: 0.6 });
    tone(ctx, out, { freq: 1318.5, start: 0.12, length: 0.6, peak: 0.5 });
  },
  // Personal best: a quick rising arpeggio (C5 E5 G5 C6).
  success: (ctx, out) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      tone(ctx, out, { freq, start: i * 0.08, length: 0.28, peak: 0.45, type: 'triangle' });
    });
  },
  // Soft error: a low note that slides down a little. No harsh buzz.
  error: (ctx, out) => {
    tone(ctx, out, { freq: 240, slideTo: 170, length: 0.22, peak: 0.5 });
  },
};

/**
 * Play a named sound ('tick', 'chime', 'success', 'error') if sounds are on.
 * `force` plays it even when off (used by the "Test" button in Settings).
 * Never throws: a sound is decoration, so a failure must not break the app.
 */
export function playSound(name, { force = false } = {}) {
  try {
    const settings = getSoundSettings();
    if (!force && !settings.on) return;
    if (settings.volume <= 0 || !RECIPES[name]) return;

    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < MIN_GAP_MS) return;
    lastPlayed[name] = now;

    const ctx = getContext();
    if (!ctx) return;
    // One master gain per sound sets the overall volume. 0.18 keeps even full volume quiet.
    const master = ctx.createGain();
    master.gain.value = 0.18 * settings.volume;
    master.connect(ctx.destination);
    RECIPES[name](ctx, master);
  } catch {
    /* no sound is fine */
  }
}
