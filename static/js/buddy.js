// The buddy: ONE small anime character that lives along the bottom edge of the app.
//
// It is a real character from AniList (official art), shown as a cute die-cut STICKER: the
// portrait clipped to a soft rounded shape with a white outline and a shadow on the "ground".
// There is only one picture, so every reaction is done with MOTION (waddle, hop, spin) and
// small EMOTE bubbles drawn in SVG above its head (a heart, a "!", a "zZ", a music note).
//
// The rules that keep it out of the way:
// * It walks only along the bottom of the window, to the right of the sidebar.
// * The wrapper never takes clicks (pointer-events: none); only its own small body does.
// * When your mouse lingers nearby (or rushes towards it) it scoots away, or ducks below the
//   window edge if it is cornered, so it never covers what you are reaching for.
// * It hides during mini games, on phone-width screens, and whenever a modal, menu or toast
//   is open over its spot.
//
// The choice lives in localStorage under `anishelf.buddy` (per device, like the theme):
//   { kind: 'character', id, name, image, anime, talk }   a character you picked
//   { kind: 'none', talk }                                 buddy turned off
//   nothing saved (or an old setting): use your profile avatar's character, or no buddy.

import { confetti, imgUrl } from './ui.js';
import { playSound } from './sound.js';
import { api } from './api.js';

const STORE_KEY = 'anishelf.buddy';
const OLD_KEY = 'anishelf.companions'; // the old companions setting, removed once

const SIZE = 60;                 // the buddy's box is 60 px wide (its lane maths uses this)
const HEIGHT = 68;               // ...and 68 px tall: the sticker
const GROUND = 4;                // px between its feet and the window's bottom edge
const FRAME_MS = 1000 / 30;      // at most 30 frames per second
const SLEEP_AFTER_MS = 45 * 1000; // no input for 45 s: time for a nap
const NEAR_PX = 120;             // "the mouse is close" radius
const WALK_SPEED = 38;           // px per second, a stroll
const FLEE_SPEED = 190;          // px per second, a scoot
const FAST_MOUSE = 900;          // px per second: the mouse is clearly rushing somewhere
const PHONE_QUERY = '(max-width: 640px)';

/* ------------------------------------------------------------------ what it says */
const LINES = ['Episode time?', 'Go touch grass... after this episode', 'Psst, your quest is almost done', 'One more episode. I believe in you.'];
// Lines with the character's name in them. A function, because the name is only known later.
const namedLines = (name) => [
  `${name} wants you to watch an episode`,
  `${name} saved your place`,
  `${name} is cheering for you`,
  `${name} thinks one more episode is fine`,
];

/* ------------------------------------------------------------------ the pictures */
/** The sticker: the character's portrait in a soft rounded frame with a white outline. */
export function stickerHtml(character) {
  const src = character && character.image ? imgUrl(character.image) : '';
  // escape the few characters that could break out of the attribute (the URL comes from AniList)
  const safe = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<span class="buddy-sticker">${safe ? `<img src="${safe}" alt="" draggable="false" decoding="async">` : ''}</span>`;
}

// Emote bubbles: a small round speech bubble with a tail, and a symbol inside. Drawn in SVG so
// they stay crisp at any zoom and need no image files.
const BUBBLE = '<path d="M14 2 C21.7 2 26 6.6 26 12.5 C26 18.4 21.7 23 14 23 L11.5 23 L8 27 L8.4 22.4 C4.3 21 2 17.3 2 12.5 C2 6.6 6.3 2 14 2Z" fill="#fff" stroke="#1d1a22" stroke-width="1.6"/>';
const EMOTES = {
  heart: '<path d="M14 18.5 C9 15 7.2 12.6 7.2 10.4 C7.2 8.5 8.7 7.2 10.4 7.2 C11.9 7.2 13.2 8.1 14 9.4 C14.8 8.1 16.1 7.2 17.6 7.2 C19.3 7.2 20.8 8.5 20.8 10.4 C20.8 12.6 19 15 14 18.5Z" fill="#ff5a7a"/>',
  surprise: '<rect x="12.4" y="5.6" width="3.2" height="9.4" rx="1.6" fill="#ff7a2e"/><circle cx="14" cy="18.4" r="1.9" fill="#ff7a2e"/>',
  sleep: '<path d="M8 8.5 h6 l-6 7 h6" stroke="#6b7bd6" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.2 12 h4 l-4 4.6 h4" stroke="#6b7bd6" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  note: '<path d="M11.5 16.5 V7.5 L19 6 V15" stroke="#9a5ae0" stroke-width="1.7" fill="none" stroke-linejoin="round"/><ellipse cx="10" cy="16.8" rx="2.4" ry="1.9" fill="#9a5ae0"/><ellipse cx="17.5" cy="15.3" rx="2.4" ry="1.9" fill="#9a5ae0"/>',
};
function emoteSvg(kind) {
  return `<svg viewBox="0 0 28 29" width="28" height="29" aria-hidden="true">${BUBBLE}${EMOTES[kind] || ''}</svg>`;
}

/* ------------------------------------------------------------------ settings */
function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
export { reducedMotion as buddyPrefersReducedMotion };

function readSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

/** A character object is usable if it has an id, a name and an https image. */
function validCharacter(c) {
  return Boolean(c && c.id && typeof c.name === 'string' && c.name && typeof c.image === 'string' && c.image.startsWith('https://'));
}

/**
 * { kind: 'character' | 'none' | 'default', character: {id, name, image, anime} | null, talk }
 * 'default' means "nothing chosen yet": the buddy then uses your profile avatar's character.
 * Old settings from the drawn buddies (e.g. { character: 'cat' }) count as nothing chosen yet.
 */
export function getBuddySettings() {
  const saved = readSaved();
  const talk = saved && typeof saved.talk === 'boolean' ? saved.talk : true;
  if (saved && saved.kind === 'character' && validCharacter(saved)) {
    const { id, name, image, anime = '' } = saved;
    return { kind: 'character', character: { id, name, image, anime }, talk };
  }
  if (saved && (saved.kind === 'none' || saved.character === 'none')) return { kind: 'none', character: null, talk };
  return { kind: 'default', character: null, talk };
}

/**
 * Save the choice and apply it straight away (no reload).
 *   setBuddySettings({ character: {id, name, image, anime} })  use that character
 *   setBuddySettings({ kind: 'none' })                          turn the buddy off
 *   setBuddySettings({ kind: 'default' })                       follow the profile avatar
 *   setBuddySettings({ talk: false })                           keep the choice, change talking
 */
export function setBuddySettings(patch) {
  const current = getBuddySettings();
  let next;
  if (patch.character && validCharacter(patch.character)) {
    const { id, name, image, anime = '' } = patch.character;
    next = { kind: 'character', id, name, image, anime };
  } else if (patch.kind === 'none' || patch.kind === 'default') {
    next = { kind: patch.kind };
  } else {
    next = current.kind === 'character' ? { kind: 'character', ...current.character } : { kind: current.kind };
  }
  next.talk = typeof patch.talk === 'boolean' ? patch.talk : current.talk;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  apply();
}

/** The character the buddy will really show: your pick, else your avatar, else null (no buddy). */
export async function resolveBuddyCharacter() {
  const { kind, character } = getBuddySettings();
  if (kind === 'character') return character;
  if (kind === 'none') return null;
  try {
    const profile = await api.me();
    return profile && validCharacter(profile.avatar) ? profile.avatar : null;
  } catch {
    return null; // server unreachable: no buddy for now
  }
}

/* ------------------------------------------------------------------ the engine */
// Everything the buddy knows about itself lives in this one object.
const me = {
  enabled: false,
  characterId: null,
  name: '',
  still: false,      // reduced motion: stands still, only fades away when the mouse is near
  hidden: true,      // hidden by a game, a modal, a toast, phone width or a hidden tab
  state: 'idle',
  until: 0,          // when the current state is over (performance.now() time)
  start: 0,          // when the current state began (for hop / dance progress)
  x: 0,              // left edge of the buddy, in px from the window's left
  targetX: 0,
  dir: 1,            // 1 = moving right, -1 = moving left
  phase: 0,          // walk cycle (advances with distance, so faster steps when it runs)
  sink: 0,           // 0 = standing, 1 = fully below the window edge (peeking)
  hovered: false,    // mouse is on its body: it stays so you can pet it
  nearSince: 0,
  laneLeft: 0,
  laneRight: 0,
};
const mouse = { x: -9999, y: -9999, speed: 0, at: 0 };
let lastInputAt = performance.now();
let layer = null;
let buddyEl = null;
let bodyEl = null;
let squashEl = null;
let bubbleEl = null;
let emoteEl = null;
let shadowEl = null;
let rafId = 0;
let lastFrame = 0;
let checkTimer = 0;
let talkTimer = 0;
let bubbleTimer = 0;
let emoteTimer = 0;
let drag = null;
let listening = false;
let applyToken = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** The strip it may walk on: from the content area's left edge to the window's right edge. */
function updateLane() {
  const main = document.getElementById('view');
  const left = (main ? Math.max(0, main.getBoundingClientRect().left) : 0) + 12;
  me.laneLeft = left;
  me.laneRight = Math.max(left, window.innerWidth - 12 - SIZE);
  me.x = clamp(me.x, me.laneLeft, me.laneRight);
  me.targetX = clamp(me.targetX, me.laneLeft, me.laneRight);
}

/** Switch to a new state. `ms` is how long it lasts before think() picks the next one. */
function setState(state, ms = 0) {
  const now = performance.now();
  const before = me.state;
  me.state = state;
  me.start = now;
  me.until = now + ms;
  if (!buddyEl) return;
  buddyEl.classList.toggle('is-walking', state === 'walk' || state === 'flee');
  buddyEl.classList.toggle('is-sitting', state === 'sit');
  buddyEl.classList.toggle('is-asleep', state === 'sleep');
  buddyEl.classList.toggle('is-happy', state === 'hop' || state === 'dance' || state === 'wiggle');
  buddyEl.classList.toggle('is-dancing', state === 'dance'); // spins around its middle, not its feet
  // Emotes that belong to a state: "zZ" while asleep, "!" when startled.
  if (state === 'drowsy') hideEmote();
  if (state === 'sleep') emote('sleep', Infinity);
  else if (before === 'sleep') hideEmote();
  if ((state === 'flee' || state === 'peek') && before !== state) emote('surprise', 900);
}

/* The state machine, in plain words:
 *   idle   stands and breathes. When its time is up it picks: walk somewhere, sit down, or keep idling.
 *   walk   waddles to a random spot on its strip, then goes back to idle.
 *   sit    settles down for a while, then idle again.
 *   drowsy a slow sway just before falling asleep.
 *   sleep  45 s without any input from you: it leans over, dims a little and shows "zZ". The
 *          animation loop stops completely (only a slow CSS "breathing" runs) to save battery.
 *          Any mouse move wakes it.
 *   flee   your mouse came close: "!" and it scoots away from the cursor.
 *   peek   it was cornered against an edge, so it ducks below the window edge until the mouse leaves.
 *   hop / dance / wiggle  short happy reactions (marking episodes, celebrations, petting).
 *   drag   you are carrying it to a new spot.
 * Why a state machine? Each state only has to answer "what do I do now, and what comes next?",
 * which keeps the behaviour easy to follow and easy to change. */
function think(now) {
  if (now < me.until) return;
  switch (me.state) {
    case 'idle': {
      const roll = Math.random();
      if (roll < 0.5) {
        // pick a spot 80-260 px away, in whichever direction has room
        let dir = Math.random() < 0.5 ? -1 : 1;
        if (me.x + dir * 80 > me.laneRight || me.x + dir * 80 < me.laneLeft) dir = -dir;
        me.targetX = clamp(me.x + dir * rand(80, 260), me.laneLeft, me.laneRight);
        setState('walk', 60 * 1000); // ends on arrival; the long timeout is only a safety net
      } else if (roll < 0.8) {
        setState('sit', rand(4000, 9000));
      } else {
        setState('idle', rand(2000, 5000));
      }
      break;
    }
    case 'drowsy':
      setState('sleep', Infinity);
      draw(now);   // one last frame so the sleeping pose is in place
      stopLoop();
      break;
    case 'sit': case 'hop': case 'dance': case 'wiggle': case 'flee': case 'walk':
      setState('idle', rand(2000, 5000));
      break;
    default:
      break;
  }
}

/** Is the mouse close? Then move away (or duck) so it never covers what the user reaches for. */
function checkMouse(now) {
  // (Also not while drowsy: it is nodding off, and a startle would undo the yawn every second.)
  if (['drag', 'hop', 'dance', 'wiggle', 'flee', 'sleep', 'drowsy'].includes(me.state)) return;
  const cx = me.x + SIZE / 2;
  const cy = window.innerHeight - GROUND - HEIGHT / 2;
  const dist = Math.hypot(mouse.x - cx, mouse.y - cy);
  if (me.state === 'peek') {
    if (dist > NEAR_PX + 50) setState('idle', rand(1500, 3000)); // coast is clear: pop back up
    return;
  }
  // Mouse resting on its body = you want to pet it, so it stays put.
  if (dist > NEAR_PX || me.hovered) { me.nearSince = 0; return; }
  if (!me.nearSince) me.nearSince = now;
  // Rushing past, or lingering nearby for 0.7 s without touching it: get out of the way.
  // (Reaching it within that time lets you pet it.)
  if (mouse.speed < FAST_MOUSE && now - me.nearSince < 700) return;
  me.nearSince = 0;
  const away = mouse.x < cx ? 1 : -1;
  const target = clamp(me.x + away * 240, me.laneLeft, me.laneRight);
  if (Math.abs(target - me.x) < 70) {
    setState('peek', Infinity); // cornered against an edge: duck below it instead
  } else {
    me.targetX = target;
    setState('flee', 10 * 1000);
  }
}

/** Move one step towards targetX. Returns true on arrival. */
function moveTowards(speed, dt) {
  const gap = me.targetX - me.x;
  if (Math.abs(gap) < 1) return true;
  me.dir = gap > 0 ? 1 : -1;
  const step = Math.min(Math.abs(gap), speed * dt);
  me.x += me.dir * step;
  me.phase += step * 0.16; // the waddle follows the distance travelled
  return false;
}

/** One frame of thinking and moving. dt = seconds since the last frame. */
function step(dt, now) {
  if (performance.now() - mouse.at > 120) mouse.speed = 0; // the mouse stopped moving
  if (me.state !== 'sleep' && me.state !== 'drowsy' && me.state !== 'drag'
      && now - lastInputAt > SLEEP_AFTER_MS) {
    setState('drowsy', 1600);
  }
  checkMouse(now);
  if (me.state === 'walk' && moveTowards(WALK_SPEED, dt)) setState('idle', rand(2500, 6000));
  if (me.state === 'flee' && moveTowards(FLEE_SPEED, dt)) setState('idle', rand(3000, 6000));
  // Sinking eases towards its goal instead of jumping, so peeking looks smooth.
  const sinkGoal = me.state === 'peek' ? 0.7 : 0;
  me.sink += (sinkGoal - me.sink) * Math.min(1, dt * 7);
  think(now);
  draw(now);
}

/* Drawing: squash and stretch.
 * A cartoon body feels soft when it gets wider as it gets shorter (and the other way round),
 * keeping roughly the same "volume". So every pose below sets a width scale sx and a height
 * scale sy that move in opposite directions, plus a lift (px off the ground) and a tilt.
 * The shadow stays on the ground and shrinks as the sticker lifts, which sells the jump. */
function draw(now) {
  let lift = 0;
  let sx = 1;
  let sy = 1;
  let tilt = 0;
  const t = now / 1000;
  const p = Math.min(1, (now - me.start) / Math.max(1, me.until - me.start)); // 0..1 through a reaction
  if (me.still) {
    // reduced motion: no bounce at all
  } else if (me.state === 'walk' || me.state === 'flee') {
    // The waddle: sin(phase) swings between -1 and 1, so the tilt rocks left/right once per two
    // steps, while |sin| (0 = foot down, 1 = mid-step) gives a small bob on every step.
    const swing = Math.sin(me.phase);
    const s = Math.abs(swing);
    tilt = swing * (me.state === 'flee' ? 5 : 8);
    lift = s * (me.state === 'flee' ? 5 : 3);
    const squash = (1 - s) * 0.06;            // squashed a little each time it lands
    sx = 1 + squash; sy = 1 - squash;
  } else if (me.state === 'hop') {
    lift = Math.sin(p * Math.PI) * 18;
    const edge = p < 0.15 || p > 0.85;          // take-off and landing squash, stretch in the air
    sx = edge ? 1.12 : 0.93; sy = edge ? 0.86 : 1.09;
  } else if (me.state === 'dance') {
    // spin once (in the middle of the dance) while bouncing to the beat
    const beat = Math.abs(Math.sin(p * Math.PI * 6));
    lift = beat * 9;
    sx = 1 + (1 - beat) * 0.05; sy = 1 - (1 - beat) * 0.05;
    tilt = p < 0.25 ? Math.sin(p * Math.PI * 8) * 8 : p < 0.75 ? (p - 0.25) * 2 * 360 : Math.sin(p * Math.PI * 8) * 8;
  } else if (me.state === 'wiggle') {
    // being petted: a quick happy wiggle that calms down (the (1 - p) shrinks the swing)
    tilt = Math.sin(p * Math.PI * 8) * 13 * (1 - p);
    sx = 1 + 0.05 * Math.abs(Math.sin(p * Math.PI * 8)); sy = 2 - sx;
  } else if (me.state === 'drag') {
    lift = 10; sx = 0.95; sy = 1.06;            // dangling a little while carried
    tilt = clamp(drag ? drag.vx * 0.6 : 0, -18, 18);
  } else if (me.state === 'drowsy') {
    tilt = Math.sin(t * 2) * 5;                 // nodding off
  } else {
    const breathe = Math.sin(t * 2.4);         // idle / sit / peek: slow breathing
    const sitting = me.state === 'sit' ? 0.93 : 1;
    sy = sitting + 0.02 * breathe;
    sx = (2 - sitting) - 0.014 * breathe;
  }
  buddyEl.style.transform = `translate3d(${me.x.toFixed(1)}px, ${(me.sink * HEIGHT).toFixed(1)}px, 0)`;
  squashEl.style.transform = `translateY(${(-lift).toFixed(1)}px) rotate(${tilt.toFixed(1)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
  const shadow = 1 - Math.min(lift, 20) / 34;  // smaller and fainter the higher it is
  shadowEl.style.transform = `translateX(-50%) scale(${shadow.toFixed(3)})`;
  shadowEl.style.opacity = (0.25 + 0.75 * shadow).toFixed(2);
}

/* The animation loop.
 * requestAnimationFrame asks the browser to call us right before it paints the next frame
 * (usually 60 times a second). We skip every other call, which caps us at 30 fps: plenty for a
 * small character, and half the work. The loop also stops itself when nothing needs drawing
 * (tab hidden, buddy hidden, asleep, or reduced-motion mode). */
function frame(now) {
  rafId = 0;
  if (!wantLoop()) return;
  rafId = requestAnimationFrame(frame);
  if (now - lastFrame < FRAME_MS - 2) return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000); // after a pause, don't teleport
  lastFrame = now;
  step(dt, now);
}
function wantLoop() {
  return me.enabled && !me.hidden && !me.still && me.state !== 'sleep' && !document.hidden;
}
function startLoop() {
  if (rafId || !wantLoop()) return;
  lastFrame = performance.now();
  rafId = requestAnimationFrame(frame);
}
function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/* ------------------------------------------------------------------ hiding */
function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Hide during games, on phones, under modals/menus/toasts. Checked a few times a second. */
function checkHidden() {
  if (!layer) return;
  updateLane();
  const h = window.innerHeight;
  const spot = { left: me.x - 16, right: me.x + SIZE + 16, top: h - 130, bottom: h };
  let hide = document.hidden
    || window.location.hash.startsWith('#/games/')
    || window.matchMedia(PHONE_QUERY).matches
    || document.body.classList.contains('nav-open')
    || Boolean(document.querySelector('.modal-overlay'))
    || Boolean(document.querySelector('#splash:not([hidden])'));
  if (!hide) {
    for (const el of document.querySelectorAll('.menu, .toast, .prompt-card')) {
      if (overlaps(spot, el.getBoundingClientRect())) { hide = true; break; }
    }
  }
  if (hide !== me.hidden) {
    me.hidden = hide;
    layer.classList.toggle('is-hidden', hide);
    if (hide && drag) drag = null;
    if (!hide) draw(performance.now()); // put it in place right away, before the first frame
  }
  if (hide) stopLoop(); else startLoop();
  if (me.still) draw(performance.now());
}

/* ------------------------------------------------------------------ little effects */
/** Show an emote bubble above the head for `ms` milliseconds (Infinity = until hidden). */
function emote(kind, ms = 1200) {
  if (!emoteEl) return;
  clearTimeout(emoteTimer);
  emoteEl.innerHTML = emoteSvg(kind);
  emoteEl.dataset.emote = kind;
  emoteEl.classList.remove('show');
  void emoteEl.offsetWidth; // restart the pop-in animation
  emoteEl.classList.add('show');
  if (Number.isFinite(ms)) emoteTimer = setTimeout(hideEmote, ms);
}
function hideEmote() {
  clearTimeout(emoteTimer);
  if (emoteEl) emoteEl.classList.remove('show');
}

function fx(className, text, dx = 0, dy = 0) {
  if (!layer) return;
  const el = document.createElement('span');
  el.className = `buddy-fx ${className}`;
  el.textContent = text;
  el.style.left = `${me.x + SIZE / 2 + dx}px`;
  el.style.bottom = `${GROUND + HEIGHT - 14 + dy}px`;
  layer.appendChild(el);
  const done = () => el.remove();
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, 2500); // safety net if the animation never runs
}

function hearts() {
  [-16, 0, 16].forEach((dx, i) => setTimeout(() => fx('buddy-heart', '♥', dx, i * 3), i * 90));
}
function sparkle() {
  [[-22, -6], [20, 0], [-8, 14], [12, 18]].forEach(([dx, dy], i) => setTimeout(() => fx('buddy-sparkle', '✦', dx, dy), i * 60));
}

/** Wake up (if asleep) and do a short happy reaction. */
function react(kind) {
  if (!me.enabled || me.hidden || me.state === 'drag') return;
  wake();
  if (me.still) { if (kind === 'dance') confetti(bodyEl); emote(kind === 'dance' ? 'note' : 'heart'); return; }
  if (kind === 'hop') { setState('hop', 560); sparkle(); emote('heart'); }
  if (kind === 'dance') { setState('dance', 1900); confetti(bodyEl); emote('note', 1900); }
  startLoop();
}

function wake() {
  lastInputAt = performance.now();
  if (me.state === 'sleep' || me.state === 'drowsy') {
    setState('idle', rand(1500, 3000));
    startLoop();
  }
}

/* ------------------------------------------------------------------ talking */
function scheduleTalk(first = false) {
  clearTimeout(talkTimer);
  // Every few minutes at most: 2.5-5 min for the first line, then 3-6 min between lines.
  const ms = first ? rand(150, 300) * 1000 : rand(180, 360) * 1000;
  talkTimer = setTimeout(() => {
    const ok = getBuddySettings().talk && !me.hidden && !['sleep', 'drowsy', 'drag', 'flee', 'peek'].includes(me.state);
    if (ok) {
      const pool = [...LINES, ...(me.name ? namedLines(me.name) : [])];
      say(pool[Math.floor(Math.random() * pool.length)]);
      scheduleTalk();
    } else {
      talkTimer = setTimeout(() => scheduleTalk(), 60 * 1000); // busy right now: try again later
    }
  }, ms);
}

function say(text) {
  if (!bubbleEl) return;
  if (!me.still && (me.state === 'walk' || me.state === 'idle' || me.state === 'sit')) setState('idle', 4200); // stand still while talking
  hideEmote(); // one bubble at a time
  bubbleEl.textContent = text;
  bubbleEl.style.removeProperty('--shift');
  bubbleEl.classList.add('show');
  // Keep the bubble inside the strip: shift it sideways if it would poke past either edge.
  const half = bubbleEl.offsetWidth / 2;
  const centre = me.x + SIZE / 2;
  const wanted = clamp(centre, me.laneLeft + half, window.innerWidth - 8 - half);
  bubbleEl.style.setProperty('--shift', `${(wanted - centre).toFixed(0)}px`);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl && bubbleEl.classList.remove('show'), 4000);
}

/* ------------------------------------------------------------------ petting and dragging */
function onPointerDown(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  // "Capture" keeps the pointer events coming to the buddy even when the mouse outruns it.
  try { bodyEl.setPointerCapture(event.pointerId); } catch { /* not a real pointer: fine */ }
  drag = { id: event.pointerId, startX: event.clientX, grab: event.clientX - me.x, moved: false, lastX: event.clientX, vx: 0 };
  wake();
}
function onPointerMove(event) {
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved && Math.abs(event.clientX - drag.startX) > 5) {
    drag.moved = true;
    if (!me.still) setState('drag', Infinity);
  }
  if (!drag.moved) return;
  drag.vx = event.clientX - drag.lastX;
  drag.lastX = event.clientX;
  if (drag.vx) me.dir = drag.vx > 0 ? 1 : -1;
  me.x = clamp(event.clientX - drag.grab, me.laneLeft, me.laneRight);
  me.targetX = me.x;
  if (me.still) draw(performance.now());
  startLoop();
}
function onPointerUp(event) {
  if (!drag || drag.id !== event.pointerId) return;
  const wasDrag = drag.moved;
  drag = null;
  if (wasDrag) {
    if (!me.still) setState('hop', 300); // a little landing bounce
  } else {
    // A click (no real movement) is a pet: hearts, a happy wiggle and a squeak (silent unless sounds are on).
    hearts();
    emote('heart', 1300);
    playSound('tick');
    if (!me.still) setState('wiggle', 900);
  }
  startLoop();
}

/* ------------------------------------------------------------------ building it */
function build() {
  layer = document.createElement('div');
  layer.className = 'buddy-layer is-hidden';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `<div class="buddy">
      <div class="buddy-bubble"></div>
      <div class="buddy-emote"></div>
      <div class="buddy-shadow"></div>
      <div class="buddy-body" title="Pet me, or drag me somewhere else"><div class="buddy-squash"></div></div>
    </div>`;
  document.body.appendChild(layer);
  buddyEl = layer.querySelector('.buddy');
  bodyEl = layer.querySelector('.buddy-body');
  squashEl = layer.querySelector('.buddy-squash');
  bubbleEl = layer.querySelector('.buddy-bubble');
  emoteEl = layer.querySelector('.buddy-emote');
  shadowEl = layer.querySelector('.buddy-shadow');
  bodyEl.addEventListener('pointerdown', onPointerDown);
  bodyEl.addEventListener('pointermove', onPointerMove);
  bodyEl.addEventListener('pointerup', onPointerUp);
  bodyEl.addEventListener('pointercancel', onPointerUp);
  bodyEl.addEventListener('pointerenter', () => { me.hovered = true; });
  bodyEl.addEventListener('pointerleave', () => { me.hovered = false; });
  updateLane();
  me.x = me.laneLeft + 40; // start bottom-left, away from the toasts in the bottom-right corner
  me.targetX = me.x;
}

function teardown() {
  stopLoop();
  [checkTimer, talkTimer, bubbleTimer, emoteTimer].forEach((id) => { clearTimeout(id); clearInterval(id); });
  if (layer) layer.remove();
  layer = buddyEl = bodyEl = squashEl = bubbleEl = emoteEl = shadowEl = null;
  me.enabled = false;
  me.characterId = null;
  me.name = '';
  me.hidden = true;
}

/** Read the settings and (re)build the buddy to match. Called on start and on every change. */
async function apply() {
  // Finding the character can wait on the server (profile avatar), so remember which call
  // is the newest: if settings change again meanwhile, the older answer is simply dropped.
  const token = ++applyToken;
  const character = await resolveBuddyCharacter();
  if (token !== applyToken) return;
  if (!character) { teardown(); return; }
  if (!layer) build();
  me.enabled = true;
  // With reduced motion the user still gets their buddy, but it stands still.
  me.still = reducedMotion();
  layer.classList.toggle('is-still', me.still);
  if (character.id !== me.characterId) {
    me.characterId = character.id;
    me.name = character.name;
    squashEl.innerHTML = stickerHtml(character);
    const img = squashEl.querySelector('img');
    // If the picture can't load, show a soft placeholder with the name's first letter.
    if (img) img.addEventListener('error', () => { img.remove(); squashEl.firstElementChild.dataset.initial = Array.from(me.name)[0] || '?'; }, { once: true });
  }
  setState('idle', rand(1500, 3000));
  me.hidden = true; // checkHidden() decides right away
  checkHidden();
  clearInterval(checkTimer);
  checkTimer = setInterval(checkHidden, 400);
  scheduleTalk(true);
}

function listen() {
  if (listening) return;
  listening = true;
  // Any input counts as "you're here": it resets the sleep timer and wakes the buddy.
  window.addEventListener('pointermove', (event) => {
    const now = performance.now();
    const dt = Math.max(1, now - mouse.at) / 1000;
    const v = Math.hypot(event.clientX - mouse.x, event.clientY - mouse.y) / dt;
    mouse.speed = mouse.at ? mouse.speed * 0.6 + Math.min(v, 5000) * 0.4 : 0; // smoothed speed
    mouse.x = event.clientX;
    mouse.y = event.clientY;
    mouse.at = now;
    if (me.enabled) wake();
    // Reduced-motion mode has no loop, so it handles "mouse is near" right here: fade, don't move.
    if (me.still && buddyEl) {
      const near = Math.hypot(mouse.x - (me.x + SIZE / 2), mouse.y - (window.innerHeight - HEIGHT / 2)) < NEAR_PX;
      buddyEl.classList.toggle('is-shy', near && !me.hovered);
    }
  }, { passive: true });
  document.addEventListener('pointerout', (event) => { if (!event.relatedTarget) { mouse.x = -9999; mouse.y = -9999; } });
  ['keydown', 'wheel', 'pointerdown', 'touchstart'].forEach((name) => window.addEventListener(name, () => { if (me.enabled) wake(); }, { passive: true }));
  document.addEventListener('visibilitychange', checkHidden);
  window.addEventListener('hashchange', checkHidden);
  window.addEventListener('resize', checkHidden);
  // Reactions to the rest of the app (the views don't know the buddy exists).
  window.addEventListener('anishelf:changed', (event) => {
    const path = String((event.detail && event.detail.path) || '');
    if (path.includes('/episodes') || path.includes('/progress')) react('hop');
    // A new profile avatar changes the default buddy.
    if (path === '/api/me' && getBuddySettings().kind === 'default') apply();
  });
  window.addEventListener('anishelf:celebrate', () => react('dance'));
  try {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', apply);
  } catch { /* older browsers: picked up on the next start */ }
}

/** Start the buddy (called once from main.js). */
export function startBuddy() {
  // One-time clean-up: the old companions setting is no longer used.
  try { localStorage.removeItem(OLD_KEY); } catch { /* storage unavailable */ }
  listen();
  apply();
}
