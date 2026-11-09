// The "feel" layer (AniShelf 1.2.1): makes every click answer back.
//
//  - press + ripple: buttons, tabs, rows and cards dip and ripple from where you clicked
//  - busy + done:    a button you clicked shows a spinner while it saves, then a little ✓ pops up
//                    (or the button shakes if saving failed)
//  - loading line:   a thin line runs along the top whenever the app is fetching something
//  - page enter:     each page slides in instead of just appearing
//  - click sounds:   optional soft ticks (Settings > Feel, needs sound effects on)
//
// It's one module that listens to the whole page (event delegation), so no view had to change.
// Settings > Feel can switch it to "Calm", and "reduce motion" in Windows always wins.
import { playSound } from './sound.js';

const STORE_KEY = 'anishelf.feel';
const DEFAULTS = { motion: 'lively', clicks: false };

// What counts as "pressable". Ripples go on anything bigger than a tiny icon.
const PRESSABLE = [
  'button', '.btn', 'a.card-link', 'a.lib-row', '.nav a', '.inbox-item', '[role="tab"]',
  '[role="menuitem"]', '.fc-card', '.chip', 'summary', 'select', 'label.check',
].join(',');
const RIPPLE_MIN_SIZE = 22; // px; smaller things only get the press dip
const BUSY_DELAY_MS = 150;  // only show a spinner if saving takes longer than this (no flicker)
const CLICK_LINK_MS = 500;  // a save that starts this soon after a click belongs to that click

/* ---------------------------------------------------------------- settings */
export function getFeel() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  const feel = { ...DEFAULTS };
  if (saved && (saved.motion === 'lively' || saved.motion === 'calm')) feel.motion = saved.motion;
  if (saved && typeof saved.clicks === 'boolean') feel.clicks = saved.clicks;
  return feel;
}

export function setFeel(patch) {
  const next = { ...getFeel(), ...patch };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  applyFeel(next);
  return next;
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function lively() {
  return getFeel().motion === 'lively' && !reducedMotion();
}

function applyFeel(feel = getFeel()) {
  document.documentElement.dataset.motion = feel.motion;
}

/* ---------------------------------------------------------------- press + ripple */
let lastPress = { el: null, at: 0, x: 0, y: 0 };

function ripple(target, event) {
  const rect = target.getBoundingClientRect();
  if (rect.width < RIPPLE_MIN_SIZE || rect.height < RIPPLE_MIN_SIZE) return;
  if (target.matches('select, input, textarea')) return; // native controls: their own feedback
  // A host that clips the ripple to the element's rounded shape, without changing the
  // element's own overflow (which could cut off badges that hang over the edge).
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  let host = target.querySelector(':scope > .ripple-host');
  if (!host) {
    host = document.createElement('span');
    host.className = 'ripple-host';
    host.setAttribute('aria-hidden', 'true');
    target.appendChild(host);
  }
  const size = Math.max(rect.width, rect.height) * 2.2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${event.clientX - rect.left - size / 2}px`;
  dot.style.top = `${event.clientY - rect.top - size / 2}px`;
  host.appendChild(dot);
  setTimeout(() => {
    dot.remove();
    if (!host.childElementCount) host.remove();
  }, 650);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const target = event.target.closest(PRESSABLE);
  if (!target || target.disabled || target.closest('[data-no-feel], canvas')) return;
  lastPress = { el: target, at: performance.now(), x: event.clientX, y: event.clientY };
  if (lively()) ripple(target, event);
  if (getFeel().clicks) playSound('tick');
}

// Keyboard presses (Enter/Space on a focused button) count as clicks too, for busy/done.
function onKeyDown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = document.activeElement && document.activeElement.closest && document.activeElement.closest(PRESSABLE);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  lastPress = { el: target, at: performance.now(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/* ---------------------------------------------------------------- busy / done / failed */
const pending = new Map(); // request id -> { el, timer, x, y }

function onRequestStart(event) {
  const { id, method } = event.detail || {};
  bumpLoading(+1);
  if (method === 'GET') return;
  const press = lastPress;
  if (!press.el || performance.now() - press.at > CLICK_LINK_MS) return;
  const entry = { el: press.el, x: press.x, y: press.y, timer: null };
  entry.timer = setTimeout(() => {
    if (entry.el.isConnected && entry.el.matches('button, .btn')) {
      entry.el.classList.add('is-busy');
      entry.el.setAttribute('aria-busy', 'true');
    }
  }, BUSY_DELAY_MS);
  pending.set(id, entry);
}

function onRequestEnd(event) {
  const { id, ok } = event.detail || {};
  bumpLoading(-1);
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  const el = entry.el;
  el.classList.remove('is-busy');
  el.removeAttribute('aria-busy');
  if (ok) {
    tick(entry.x, entry.y);
  } else if (el.isConnected && lively()) {
    el.classList.remove('is-failed');
    void el.offsetWidth; // restart the animation if it's still running
    el.classList.add('is-failed');
    setTimeout(() => el.classList.remove('is-failed'), 420);
  }
}

/** A small ✓ that floats up from where you clicked: "saved". Works even if the page redrew. */
function tick(x, y) {
  if (!lively()) return;
  const mark = document.createElement('span');
  mark.className = 'feel-tick';
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
  mark.style.left = `${x}px`;
  mark.style.top = `${y}px`;
  document.body.appendChild(mark);
  setTimeout(() => mark.remove(), 750);
}

/* ---------------------------------------------------------------- loading line */
let active = 0;
let lineTimer = null;
let line = null;

function bumpLoading(delta) {
  active = Math.max(0, active + delta);
  if (!line) return;
  if (active > 0) {
    if (lineTimer || line.classList.contains('on')) return;
    // Only show it for loads that take a moment: instant answers shouldn't blink the line.
    lineTimer = setTimeout(() => {
      lineTimer = null;
      if (active > 0) {
        line.classList.remove('done');
        line.classList.add('on');
      }
    }, 180);
  } else {
    clearTimeout(lineTimer);
    lineTimer = null;
    if (line.classList.contains('on')) {
      line.classList.add('done');
      setTimeout(() => { if (!active) line.classList.remove('on', 'done'); }, 320);
    }
  }
}

/* ---------------------------------------------------------------- page enter */
function pageEnter() {
  const view = document.getElementById('view');
  if (!view || !lively()) return;
  view.classList.remove('view-enter');
  void view.offsetWidth; // forget the old animation so it plays again
  view.classList.add('view-enter');
}

/* ---------------------------------------------------------------- start */
export function startFeel() {
  applyFeel();
  line = document.createElement('div');
  line.className = 'load-line';
  line.setAttribute('aria-hidden', 'true');
  document.body.appendChild(line);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('anishelf:request-start', onRequestStart);
  window.addEventListener('anishelf:request-end', onRequestEnd);
  window.addEventListener('hashchange', () => requestAnimationFrame(pageEnter));
}
