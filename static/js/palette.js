// Ctrl+K quick jump: a "command palette" for jumping to any anime on your shelf or to a page.
//
// - Ctrl+K (Cmd+K on a Mac) opens and closes it. "/" stays the search shortcut (main.js).
// - Typing filters your library right here in the browser (no server call per key).
// - Up/Down picks a row, Enter opens it, Shift+Enter marks the next episode (+1) like Home does.
// - Escape or a click outside closes it.
//
// Accessibility: the box is a dialog; the results are a "listbox". Focus stays in the text field
// and aria-activedescendant tells screen readers which row is picked (the usual combobox pattern).
import { api } from './api.js';
import {
  html, setHTML, toast, toastUndo, displayTitle, imgUrl, STATUS_LABELS,
} from './ui.js';
import { remember, undoEpisodes } from './undo.js';

const MAX_RESULTS = 30; // more rows than this is just noise in a quick-jump box

const COMMANDS = [
  { label: 'Go to Home', hash: '#/', keywords: 'home start continue' },
  { label: 'Go to Library', hash: '#/library', keywords: 'library shelf list' },
  { label: 'Go to Calendar', hash: '#/calendar', keywords: 'calendar airing schedule' },
  { label: 'Go to Stats', hash: '#/stats', keywords: 'stats statistics hours' },
  { label: 'Go to Settings', hash: '#/settings', keywords: 'settings backup theme' },
  { label: "Random: Tonight's pick", hash: '#/random', keywords: 'random pick tonight surprise' },
];

/* ---------------------------------------------------------------- matching
   A tiny fuzzy match. It returns a number (higher = better) or -1 for "no match":
   - the title starts with what you typed      -> best
   - a word in the title starts with it        -> good
   - the title contains it somewhere           -> ok
   - its letters appear in order ("fmab")      -> weakest (a "subsequence" match)  */
function matchScore(text, query) {
  const t = (text || '').toLowerCase();
  if (!t) return -1;
  if (t.startsWith(query)) return 400 - t.length / 100;
  if (t.includes(` ${query}`)) return 300 - t.length / 100;
  const at = t.indexOf(query);
  if (at >= 0) return 200 - at;
  // subsequence: walk through the title once, ticking off the typed letters in order
  let qi = 0;
  for (const ch of t) {
    if (ch === query[qi]) qi += 1;
    if (qi === query.length) return 100 - t.length / 100;
  }
  return -1;
}

function bestScore(texts, query) {
  let best = -1;
  for (const text of texts) best = Math.max(best, matchScore(text, query));
  return best;
}

/** The +1 request for an entry (the same body Home's +1 button sends), or null if there's nothing next. */
function plusOneBody(entry) {
  if (entry.rewatching) {
    return entry.rewatch_next_episode ? { action: 'toggle', episode: entry.rewatch_next_episode, target: 'rewatch' } : null;
  }
  return entry.next_episode ? { action: 'up_to', episode: entry.next_episode } : null;
}

/* ---------------------------------------------------------------- the palette */
let overlay = null;        // the open palette element, or null when closed
let entries = [];          // your library, loaded when the palette opens
let rows = [];             // what the list shows right now: { kind: 'anime'|'command', ... }
let active = 0;            // index of the picked row
let previousFocus = null;

function buildRows(query) {
  const q = query.trim().toLowerCase();
  const commands = COMMANDS
    .map((c) => ({ kind: 'command', command: c, score: q ? bestScore([c.label, c.keywords], q) : 0 }))
    .filter((r) => r.score >= 0);
  if (!q) {
    // Nothing typed yet: show what you're watching first, then the commands.
    const watching = entries.filter((e) => e.status === 'watching' || e.rewatching).slice(0, 8);
    return [...watching.map((entry) => ({ kind: 'anime', entry })), ...commands];
  }
  const anime = [];
  for (const entry of entries) {
    const m = entry.meta || {};
    const score = bestScore([m.title, m.title_english], q); // romaji + English titles
    if (score >= 0) anime.push({ kind: 'anime', entry, score });
  }
  anime.sort((a, b) => b.score - a.score);
  commands.sort((a, b) => b.score - a.score);
  return [...anime.slice(0, MAX_RESULTS), ...commands];
}

function rowHtml(row, i) {
  const selected = i === active;
  if (row.kind === 'command') {
    return html`<li class="qk-row qk-command" id="qk-opt-${i}" role="option" aria-selected="${selected ? 'true' : 'false'}" data-i="${i}">
      <span class="qk-cover qk-cover-blank" aria-hidden="true"></span>
      <span class="qk-text"><span class="qk-title">${row.command.label}</span></span>
      <span class="qk-hint">Page</span>
    </li>`;
  }
  const e = row.entry;
  const cover = imgUrl(e.meta && e.meta.image);
  const done = e.rewatching ? e.rewatch_watched_count : e.watched_count;
  const progress = `${done ?? 0} / ${e.total ?? '—'}`;
  const canPlus = Boolean(plusOneBody(e));
  return html`<li class="qk-row" id="qk-opt-${i}" role="option" aria-selected="${selected ? 'true' : 'false'}" data-i="${i}">
    ${cover ? html`<img class="qk-cover" src="${cover}" alt="" loading="lazy" decoding="async">` : html`<span class="qk-cover qk-cover-blank" aria-hidden="true"></span>`}
    <span class="qk-text">
      <span class="qk-title">${displayTitle(e.meta)}</span>
      <span class="qk-sub">${STATUS_LABELS[e.status] || e.status}${e.rewatching ? ' · rewatch' : ''} · <span class="qk-progress">${progress}</span></span>
    </span>
    ${canPlus ? html`<button type="button" class="qk-plus" data-plus="${i}" tabindex="-1" title="Mark the next episode (Shift+Enter)">+1</button>` : ''}
  </li>`;
}

function draw() {
  if (!overlay) return;
  const list = overlay.querySelector('#qk-list');
  const input = overlay.querySelector('#qk-input');
  const query = input.value;
  rows = buildRows(query);
  if (active >= rows.length) active = Math.max(rows.length - 1, 0);
  setHTML(list, rows.length
    ? html`${rows.map((row, i) => rowHtml(row, i))}`
    : html`<li class="qk-empty" role="presentation">Nothing on your shelf matches "${query}"</li>`);
  if (!rows.length) input.removeAttribute('aria-activedescendant');
  highlight();
}

/** Mark the picked row without redrawing the whole list (cheaper, and images don't flicker). */
function highlight() {
  if (!overlay || !rows.length) return;
  overlay.querySelectorAll('.qk-row').forEach((el) => {
    el.setAttribute('aria-selected', Number(el.dataset.i) === active ? 'true' : 'false');
  });
  overlay.querySelector('#qk-input').setAttribute('aria-activedescendant', `qk-opt-${active}`);
  const current = overlay.querySelector(`#qk-opt-${active}`);
  if (current) current.scrollIntoView({ block: 'nearest' });
}

function moveActive(step) {
  if (!rows.length) return;
  // % (modulo) wraps around: going down from the last row lands on the first one
  active = (active + step + rows.length) % rows.length;
  highlight();
}

function openRow(row) {
  if (!row) return;
  const hash = row.kind === 'command' ? row.command.hash : `#/anime/${row.entry.mal_id}`;
  closePalette();
  if (window.location.hash === hash || (hash === '#/' && !window.location.hash)) {
    window.dispatchEvent(new CustomEvent('anishelf:rerender')); // already there: just refresh
  } else {
    window.location.hash = hash;
  }
}

async function plusOne(row) {
  if (!row || row.kind !== 'anime') return;
  const body = plusOneBody(row.entry);
  if (!body) { toast('No next episode to mark', 'info', 2200); return; }
  const before = remember(row.entry);
  try {
    const result = await api.updateEpisodes(row.entry.mal_id, body);
    // keep the palette open and show the new progress on the same row
    entries = entries.map((e) => (e.mal_id === result.entry.mal_id ? { ...result.entry, franchise: e.franchise } : e));
    draw();
    const label = `${displayTitle(row.entry.meta)}: episode ${body.episode} watched`;
    if (result.rewatch_finished) toast(label, 'success');
    else toastUndo(label, () => undoEpisodes(before));
    if (result.status_changed) toast(`Moved to ${STATUS_LABELS[result.status_changed] || result.status_changed}`, 'success');
    window.dispatchEvent(new CustomEvent('anishelf:episodes-updated', { detail: { mal_id: row.entry.mal_id, entry: result.entry } }));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function onKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); closePalette(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) plusOne(rows[active]);
    else openRow(rows[active]);
    return;
  }
  if (event.key === 'Tab') event.preventDefault(); // keep focus inside the dialog (only the field takes focus)
}

export function openPalette() {
  if (overlay) return;
  previousFocus = document.activeElement;
  active = 0;
  overlay = document.createElement('div');
  overlay.className = 'qk-overlay';
  setHTML(overlay, html`<div class="qk" role="dialog" aria-modal="true" aria-label="Quick jump">
    <input type="text" id="qk-input" class="qk-input" placeholder="Jump to an anime or a page" autocomplete="off" spellcheck="false"
      role="combobox" aria-expanded="true" aria-controls="qk-list" aria-autocomplete="list">
    <ul class="qk-list" id="qk-list" role="listbox" aria-label="Results"></ul>
    <p class="qk-help"><span class="kbd">↑↓</span> pick <span class="kbd">Enter</span> open <span class="kbd">Shift+Enter</span> +1 episode <span class="kbd">Esc</span> close</p>
  </div>`);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { if (overlay) overlay.classList.add('show'); });

  const input = overlay.querySelector('#qk-input');
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) { closePalette(); return; }
    // clicking a row must not take focus away from the text field (clicks IN the field are fine)
    if (event.target !== overlay.querySelector('#qk-input')) event.preventDefault();
  });
  overlay.addEventListener('click', (event) => {
    const plus = event.target.closest('[data-plus]');
    if (plus) { plusOne(rows[Number(plus.dataset.plus)]); return; }
    const row = event.target.closest('[data-i]');
    if (row) openRow(rows[Number(row.dataset.i)]);
  });
  overlay.addEventListener('mousemove', (event) => {
    const row = event.target.closest('[data-i]');
    if (row && Number(row.dataset.i) !== active) { active = Number(row.dataset.i); highlight(); }
  });
  window.addEventListener('hashchange', closePalette);
  input.focus();
  draw(); // commands show straight away; anime appear once the library has loaded

  api.library()
    .then((data) => { entries = data.entries || []; draw(); })
    .catch((err) => toast(err.message, 'error'));
}

export function closePalette() {
  if (!overlay) return;
  const el = overlay;
  overlay = null;
  window.removeEventListener('hashchange', closePalette);
  el.classList.remove('show');
  setTimeout(() => el.remove(), 160);
  if (previousFocus && previousFocus.isConnected) previousFocus.focus();
}

/** Call once (from main.js): listens for Ctrl+K / Cmd+K everywhere. */
export function initPalette() {
  document.addEventListener('keydown', (event) => {
    const isK = event.key === 'k' || event.key === 'K';
    if (!isK || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault(); // stops the browser's own Ctrl+K (focus the address/search bar)
    if (overlay) closePalette();
    else openPalette();
  });
}
