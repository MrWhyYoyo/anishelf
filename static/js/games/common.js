// Helpers shared by the mini-games.
import { html, setHTML, displayTitle, imgUrl, fmtNumber, toast } from '../ui.js';
import { api } from '../api.js';
import { playSound } from '../sound.js';

/** Fisher-Yates shuffle on a copy: every order is equally likely. */
export function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Seasons of one show share a franchise id; standalone entries are their own series. */
export function seriesKey(entry) {
  return entry.franchise && entry.franchise.id ? `f${entry.franchise.id}` : `a${entry.mal_id}`;
}

export function seriesTitle(entry) {
  return entry.franchise ? displayTitle(entry.franchise) : displayTitle(entry.meta);
}

/** One random entry per series, so "Season 2" and "Season 3" never compete as answers. */
export function onePerSeries(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = seriesKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.values()].map((group) => group[Math.floor(Math.random() * group.length)]);
}

/** Load a same-origin image (through /img) so a canvas can draw it without being "tainted". */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const src = imgUrl(url);
    if (!src) { reject(new Error('no image')); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = src;
  });
}

/** Format a score the way each game counts it. */
export function scoreText(game, value) {
  if (value === null || value === undefined) return '—';
  return `${fmtNumber(value)} ${game.unit}`;
}

/**
 * Save a finished run and show the result screen inside `el`.
 * `again` restarts the game. Returns the server's answer (or null when offline).
 */
export async function finishRun(el, game, { score, headline, detail = '', again }) {
  setHTML(el, html`<div class="game-result">
    <h2>${headline}</h2>
    <p class="game-result-score num">${scoreText(game, score)}</p>
    ${detail ? html`<p class="muted">${detail}</p>` : ''}
    <p class="faint small" data-best>Saving…</p>
    <div class="game-result-actions">
      <button type="button" class="btn btn-primary" data-again>Play again</button>
      <a class="btn" href="#/games">All games</a>
    </div>
  </div>`);
  // A key still held from the game (Space in ODM Swing, a letter in Zoltraak) could "click" the
  // freshly focused button. Ignore clicks for a moment after the screen appears.
  const shownAt = performance.now();
  el.querySelector('[data-again]').addEventListener('click', () => {
    if (performance.now() - shownAt > 500) again();
  });
  el.querySelector('[data-again]').focus();
  const bestEl = el.querySelector('[data-best]');
  try {
    const result = await api.submitScore(game.id, score);
    if (result && result.new_best) playSound('success'); // only audible when sounds are on
    if (result && result.xp_awarded > 0) toast(`+${result.xp_awarded} XP for a new best`, 'success');
    if (!bestEl.isConnected) return result;
    bestEl.textContent = result.new_best && result.plays > 1
      ? 'New personal best'
      : `Best: ${scoreText(game, result.best)} · ${fmtNumber(result.plays)} ${result.plays === 1 ? 'play' : 'plays'}`;
    if (result.new_best && result.plays > 1) bestEl.classList.add('game-new-best');
    return result;
  } catch {
    bestEl.textContent = "Couldn't save this score.";
    return null;
  }
}

/** A start screen with the rules and one button. `onStart` runs when it is pressed (or Enter). */
export function startScreen(el, { title, rules, button = 'Start', onStart }) {
  setHTML(el, html`<div class="game-start">
    <h2>${title}</h2>
    <ul class="game-rules">${rules.map((r) => html`<li>${r}</li>`)}</ul>
    <button type="button" class="btn btn-primary btn-lg" data-start>${button}</button>
  </div>`);
  const btn = el.querySelector('[data-start]');
  btn.addEventListener('click', onStart, { once: true });
  btn.focus();
}
