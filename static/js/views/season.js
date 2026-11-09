// Seasonal chart (#/season): every anime of one season as a cover grid.
// The server sends the whole season once (GET /api/season, cached); filtering and sorting
// happen here in the browser, so changing a filter never asks the server (or AniList) again.
import { api } from '../api.js';
import {
  html, setHTML, animeCard, skeletonCards, emptyState, errorBox, toast, toElement,
  STATUS_LABELS, plural, fmtNumber, icon, displayTitle,
} from '../ui.js';
import { localTime } from './calendar.js';

const FORMATS = ['all', 'TV', 'Movie', 'ONA'];
const SORTS = {
  popularity: 'Popularity',
  score: 'Score',
  start: 'Start date',
};
const STORE_KEY = 'anishelf.seasonFilters';

/* ---------------------------------------------------------------- remembered filters
   localStorage can be blocked (private window), so every read/write is wrapped in try/catch
   and the page simply uses the defaults when it fails. */
function loadFilters() {
  const defaults = { format: 'all', sort: 'popularity', hideOwned: false };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {};
    return {
      format: FORMATS.includes(saved.format) ? saved.format : defaults.format,
      sort: saved.sort in SORTS ? saved.sort : defaults.sort,
      hideOwned: saved.hideOwned === true,
    };
  } catch {
    return defaults;
  }
}

function saveFilters(filters) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(filters)); } catch { /* storage unavailable */ }
}

/* ---------------------------------------------------------------- small text helpers */
/** "Airs Sun 17:30" from the next episode's time, in the browser's own time zone. */
function airingText(item) {
  const next = item.anilist && item.anilist.next_airing;
  if (next && next.airing_at) {
    const day = new Date(next.airing_at * 1000).toLocaleDateString([], { weekday: 'short' });
    return `Airs ${day} ${localTime(next.airing_at)}`;
  }
  // Not airing yet: show the start date if AniList knows the day ("2026-10-03"; 99 = unknown)
  if (item.start_date && !item.start_date.includes('99') && item.airing_status === 'Not yet aired') {
    const start = new Date(`${item.start_date}T12:00:00`);
    return `Starts ${start.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  }
  return item.airing_status === 'Finished Airing' ? 'Finished' : '';
}

/** Compare function for Array.sort: missing values always go last. */
function byKey(getValue, descending) {
  return (a, b) => {
    const x = getValue(a);
    const y = getValue(b);
    if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
    if (y === null || y === undefined) return -1;
    if (x === y) return 0;
    const result = x < y ? -1 : 1;
    return descending ? -result : result;
  };
}

function sortItems(items, sort) {
  const list = [...items]; // copy, so the original (popularity) order is kept for next time
  if (sort === 'score') list.sort(byKey((m) => m.mal_score, true));
  else if (sort === 'start') list.sort(byKey((m) => m.start_date, false));
  else list.sort(byKey((m) => m.popularity_rank, false));
  return list;
}

/* ---------------------------------------------------------------- one card */
function seasonCard(item) {
  const facts = [item.type, item.episodes ? plural(item.episodes, 'ep') : null, airingText(item)].filter(Boolean);
  const genres = (item.genres || []).slice(0, 3).join(' · ');
  const owned = item.library_status;
  return animeCard(item, {
    subtitle: facts.join(' · '),
    below: genres ? html`<div class="season-genres">${genres}</div>` : '',
    actions: owned
      ? html`<span class="season-owned"><span class="dot status-${owned}"></span>${STATUS_LABELS[owned] || owned}</span>`
      : html`<button type="button" class="btn btn-sm" data-add="${item.mal_id}"
          aria-label="Add ${displayTitle(item)} to ${STATUS_LABELS.plan_to_watch}">${icon('plus')}${STATUS_LABELS.plan_to_watch}</button>`,
  });
}

/* ---------------------------------------------------------------- the page */
export function render(root, _params, query) {
  const filters = loadFilters();
  let data = null;

  setHTML(root, html`
    <div class="title-row">
      <header class="page-head">
        <h1 id="season-title">Seasonal chart</h1>
        <p id="season-sub">Everything airing this season.</p>
      </header>
      <div class="season-nav">
        <button type="button" class="btn btn-sm" id="season-prev" disabled>Previous season</button>
        <button type="button" class="btn btn-sm" id="season-now" hidden>This season</button>
        <button type="button" class="btn btn-sm" id="season-next" disabled>Next season</button>
      </div>
    </div>
    <div class="toolbar season-toolbar">
      <div class="segmented" role="group" aria-label="Format" id="season-format"></div>
      <div class="toolbar-right">
        <label class="check"><input type="checkbox" id="season-hide" ${filters.hideOwned ? 'checked' : ''}> Hide shows in my library</label>
        <label class="field-inline"><span class="muted">Sort</span>
          <select id="season-sort" aria-label="Sort by">
            ${Object.entries(SORTS).map(([value, text]) => html`<option value="${value}" ${value === filters.sort ? 'selected' : ''}>${text}</option>`)}
          </select>
        </label>
      </div>
    </div>
    <div id="season-grid" class="grid">${skeletonCards(18)}</div>
  `);

  const grid = root.querySelector('#season-grid');
  const formatEl = root.querySelector('#season-format');
  const sub = root.querySelector('#season-sub');

  /** Items after the format + "hide owned" filters, in the chosen order. */
  function visibleItems() {
    let items = data.items;
    if (filters.format !== 'all') items = items.filter((m) => m.type === filters.format);
    if (filters.hideOwned) items = items.filter((m) => !m.library_status);
    return sortItems(items, filters.sort);
  }

  function drawFormats() {
    const count = (format) => (format === 'all' ? data.items.length : data.items.filter((m) => m.type === format).length);
    setHTML(formatEl, html`${FORMATS.map((f) => html`<button type="button" data-format="${f}"
      class="${f === filters.format ? 'active' : ''}" aria-pressed="${f === filters.format ? 'true' : 'false'}">
      ${f === 'all' ? 'All' : f} <span class="faint num">${count(f)}</span></button>`)}`);
  }

  function drawGrid() {
    if (!data) return;
    drawFormats();
    const items = visibleItems();
    sub.textContent = `${plural(data.count, 'show')} · ${fmtNumber(data.in_library)} on your shelf`
      + (data.source === 'discover' ? ' · AniList is unreachable, showing a shorter list' : '');
    if (!items.length) {
      setHTML(grid, emptyState({
        title: data.items.length ? 'Nothing matches these filters' : 'Nothing listed for this season yet',
        text: data.items.length ? 'Try another format, or show the shows already in your library.' : (data.error || ''),
      }));
      return;
    }
    setHTML(grid, html`${items.map(seasonCard)}`);
  }

  function drawNav() {
    const title = root.querySelector('#season-title');
    title.textContent = data.label;
    document.title = `${data.label} · AniShelf`;
    const prev = root.querySelector('#season-prev');
    const next = root.querySelector('#season-next');
    const now = root.querySelector('#season-now');
    prev.disabled = !data.prev;
    next.disabled = !data.next;
    prev.textContent = data.prev ? `${data.prev.season[0].toUpperCase()}${data.prev.season.slice(1)} ${data.prev.year}` : 'Previous season';
    next.textContent = data.next ? `${data.next.season[0].toUpperCase()}${data.next.season.slice(1)} ${data.next.year}` : 'Next season';
    now.hidden = data.is_current;
  }

  function go(target) {
    if (target) window.location.hash = `#/season?season=${target.season}&year=${target.year}`;
  }

  async function load() {
    setHTML(grid, skeletonCards(18));
    try {
      data = await api.season(query.get('season'), query.get('year'));
      if (!root.isConnected) return;
      drawNav();
      drawGrid();
    } catch (err) {
      if (root.isConnected) errorBox(grid, err.message, load);
    }
  }

  root.querySelector('#season-prev').addEventListener('click', () => go(data && data.prev));
  root.querySelector('#season-next').addEventListener('click', () => go(data && data.next));
  root.querySelector('#season-now').addEventListener('click', () => { window.location.hash = '#/season'; });

  formatEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-format]');
    if (!button) return;
    filters.format = button.dataset.format;
    saveFilters(filters);
    drawGrid();
  });
  root.querySelector('#season-sort').addEventListener('change', (event) => {
    filters.sort = event.target.value;
    saveFilters(filters);
    drawGrid();
  });
  root.querySelector('#season-hide').addEventListener('change', (event) => {
    filters.hideOwned = event.target.checked;
    saveFilters(filters);
    drawGrid();
  });

  // One click adds the show as "Want to watch". Only that card is redrawn, so the grid doesn't jump.
  grid.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-add]');
    if (!button) return;
    const id = Number(button.dataset.add);
    button.disabled = true;
    try {
      await api.add(id, 'plan_to_watch');
      const item = data.items.find((m) => m.mal_id === id);
      if (item) {
        item.library_status = 'plan_to_watch';
        data.in_library += 1;
      }
      toast(`Added to ${STATUS_LABELS.plan_to_watch}`, 'success');
      const card = button.closest('.card');
      if (filters.hideOwned && card) card.remove();
      else if (card && item) card.replaceWith(toElement(seasonCard(item)));
      drawFormats();
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    }
  });

  load();
}
