import { api } from '../api.js';
import {
  html, setHTML, animeCard, skeletonCards, emptyState, errorBox, STATUS_ORDER, STATUS_LABELS, displayTitle, plural, epStrip,
  coverHtml, toastUndo,
} from '../ui.js';
import { buildItems } from '../franchise.js';
import { showStateBadge, groupShowState } from '../show-state.js';
import { setupLibraryTools } from '../library-tools.js'; // collection filter + bulk edit
import { saveViewState, readViewState, cameFromDetail, restoreScroll } from '../view-memory.js';

const GROUP_KEY = 'anishelf.groupSeasons';

/** Title used for an item: the series title for grouped seasons, otherwise the anime's own title. */
const itemTitle = (item) => displayTitle(item.series || item.lead.meta);

const SORTS = {
  updated: { label: 'Recently updated', fn: (a, b) => String(b.updated).localeCompare(String(a.updated)) },
  title: { label: 'Title (A–Z)', fn: (a, b) => itemTitle(a).localeCompare(itemTitle(b)) },
  score: { label: 'My score', fn: (a, b) => (b.score ?? -1) - (a.score ?? -1) || itemTitle(a).localeCompare(itemTitle(b)) },
  progress: { label: 'Progress', fn: (a, b) => (b.progress ?? -1) - (a.progress ?? -1) || b.watched - a.watched },
  added: { label: 'Date added', fn: (a, b) => String(b.added).localeCompare(String(a.added)) },
  watched: { label: 'Last watched', fn: (a, b) => String(lastWatched(b)).localeCompare(String(lastWatched(a))) },
};

/** Newest "last episode marked" time of any season in the item ('' if never). */
function lastWatched(item) {
  return item.members.reduce((max, m) => (String(m.last_watched_at || '') > max ? String(m.last_watched_at) : max), '');
}

/* Smart filters (AniShelf 1.2): based on what the SHOW is doing, not the status you picked.
   They sit after the status tabs and only appear when something matches. */
const SMART_FILTERS = {
  new_season: { label: 'New season out', test: (state) => state && state.kind === 'new_season' },
  waiting: { label: 'Waiting for more', test: (state) => state && ['announced', 'airing', 'caught_up'].includes(state.kind) },
};
const itemState = (item) => groupShowState(item.members);

const EMPTY_TEXT = {
  all: ['', 'Your shelf is empty', 'Search for an anime and add it — your collection starts here.'],
  watching: ['', 'Not watching anything', 'Mark a show as Watching to keep track of your episodes.'],
  completed: ['', 'Nothing done yet', 'Finish a show and it will be celebrated here.'],
  plan_to_watch: ['', 'Your watch list is empty', 'Add shows you want to watch later.'],
  on_hold: ['⏸️', 'Nothing paused', 'Shows you take a break from wait here.'],
  new_season: ['', 'No new seasons right now', "When a sequel to something you finished comes out, it shows up here."],
  waiting: ['', 'Not waiting on anything', 'Shows with an announced season, or airing shows you are caught up on, show up here.'],
  dropped: ['', 'Nothing dropped', 'Good taste — or great patience.'],
};

function readGroupPref() {
  try {
    // 1.2.1: "Group seasons" got switched off by one stray click on the small checkbox. Turn it
    // back on once for everybody; after this, switching it off again sticks (and now gets an Undo).
    const FIX_KEY = 'anishelf.groupSeasons.fixed121';
    if (!localStorage.getItem(FIX_KEY)) {
      localStorage.removeItem(GROUP_KEY);
      localStorage.setItem(FIX_KEY, '1');
    }
    return localStorage.getItem(GROUP_KEY) !== 'off';
  } catch { return true; }
}

/** Episode strips under a card: one strip for a single season, one thin bar per season for a series. */
function stripsFor(item) {
  if (!item.grouped) {
    const e = item.lead;
    return epStrip({ watched: e.watched, total: e.total, next: e.status === 'watching' ? e.next_episode : null, max: 48 });
  }
  const seasons = bySeasonOrder(item.members);
  return html`<div class="series-strips">${seasons.map((m) => epStrip({
    watchedCount: m.watched_count, total: m.total, max: 0,
    label: `${(m.franchise && m.franchise.label) || displayTitle(m.meta)}: ${m.watched_count} of ${m.total ?? '?'} episodes`,
  }))}</div>`;
}

function itemCard(item) {
  const stateBadge = showStateBadge(itemState(item), 'small card-state');
  if (!item.grouped) return animeCard(item.lead.meta, { entry: item.lead, below: html`${stripsFor(item)}${stateBadge}`, showProgress: false });
  // A series card: lead season's cover + series title + combined progress.
  const meta = { ...item.lead.meta, title: item.series.title, title_english: item.series.title_english };
  const entryLike = {
    ...item.lead,
    status: item.status,
    score: item.score,
    favorite: item.favorite,
    progress: item.progress,
    watched_count: item.watched,
    total: item.totalKnown ? item.total : null,
  };
  const totalText = item.totalKnown ? item.total : `${item.total || '?'}+`;
  return animeCard(meta, {
    entry: entryLike,
    badge: plural(item.members.length, 'season'),
    below: html`${stripsFor(item)}${stateBadge}`,
    showProgress: false,
    subtitle: `${item.watched}/${totalText} eps · now: ${item.lead.franchise && item.lead.franchise.label ? item.lead.franchise.label : displayTitle(item.lead.meta)}`,
  });
}

/** Seasons in story order: by year, then by label ("Season 2" before "Season 10"). */
function bySeasonOrder(members) {
  const label = (m) => (m.franchise && m.franchise.label) || '';
  return members.slice().sort((a, b) => ((a.meta.year || 0) - (b.meta.year || 0))
    || label(a).localeCompare(label(b), undefined, { numeric: true }));
}

const VIEW_KEY = 'anishelf.libraryView';

function readView() {
  try { return localStorage.getItem(VIEW_KEY) === 'covers' ? 'covers' : 'list'; } catch { return 'list'; }
}

/** One row per show (or per series): cover, title, a strip per season, status, episodes. */
function listRow(item) {
  const lead = item.lead;
  const seriesMeta = item.grouped ? { ...lead.meta, title: item.series.title, title_english: item.series.title_english } : lead.meta;
  const seasons = item.grouped
    ? bySeasonOrder(item.members)
    : [lead];
  const meta = [
    item.grouped ? plural(item.members.length, 'season') : (lead.franchise && lead.franchise.label) || null,
    lead.meta.type, lead.meta.year,
  ].filter(Boolean).join(' · ');
  const totalText = item.total ? `${item.total}${item.totalKnown ? '' : '+'}` : '—';
  return html`<a class="lib-row" href="#/anime/${lead.mal_id}">
    ${coverHtml(lead.meta.image, displayTitle(seriesMeta), 'lib-cover')}
    <span class="lib-id">
      <span class="lib-title">${displayTitle(seriesMeta)}</span>
      <span class="lib-meta">${meta}</span>
    </span>
    <span class="lib-strips">${seasons.map((s) => html`<span class="lib-strip">
      ${item.grouped ? html`<span class="lib-strip-label">${(s.franchise && s.franchise.label) || displayTitle(s.meta)}</span>` : ''}
      ${s.total
        ? epStrip({ watched: s.watched, watchedCount: s.watched_count, total: s.total, next: s.status === 'watching' ? s.next_episode : null, max: 52 })
        : html`<span class="faint small">Episode count not announced</span>`}
    </span>`)}</span>
    <span class="lib-status"><span class="lib-status-main"><span class="dot status-${item.status}"></span>${STATUS_LABELS[item.status]}</span>${showStateBadge(itemState(item), 'small')}</span>
    <span class="lib-eps num">${item.watched}<span class="faint"> / ${totalText}</span></span>
  </a>`;
}

export function render(root, params, query) {
  const fromQuery = query.get('status');
  let status = STATUS_ORDER.includes(fromQuery) || SMART_FILTERS[fromQuery] ? fromQuery : 'all';
  let sort = SORTS[query.get('sort')] ? query.get('sort') : 'updated';
  let filter = '';
  let entries = [];
  let items = [];
  let loaded = false;
  let groupSeasons = readGroupPref();
  let view = readView();
  let refetchTimer = null;
  let refetched = false;

  // Remember where you were (view-memory.js): coming back from an anime page restores the tab,
  // sort, title filter, collection and scroll position. A status/sort in the URL still wins.
  const memory = cameFromDetail() ? readViewState('library') : null;
  if (memory) {
    if (!fromQuery && EMPTY_TEXT[memory.status]) status = memory.status;
    if (!query.get('sort') && SORTS[memory.sort]) sort = memory.sort;
    if (typeof memory.filter === 'string') filter = memory.filter;
  }
  let scrollToRestore = memory ? memory.scrollY : 0;

  setHTML(root, html`
    <header class="page-head">
      <h1>Library</h1>
      <p id="lib-sub">Everything you've watched, are watching, or want to watch.</p>
    </header>
    <div class="toolbar">
      <div class="tabs" id="lib-tabs" role="tablist" aria-label="Filter by status"></div>
      <div class="toolbar-right">
        <label class="check" title="Show all seasons of a series as one card">
          <input type="checkbox" id="lib-group" ${groupSeasons ? 'checked' : ''}> Group seasons
        </label>
        <div class="segmented" id="lib-view" role="group" aria-label="Library view">
          <button type="button" data-view="list">List</button>
          <button type="button" data-view="covers">Covers</button>
        </div>
        <input type="search" id="lib-filter" placeholder="Filter by title…" aria-label="Filter by title" autocomplete="off">
        <select id="lib-sort" aria-label="Sort">
          ${Object.entries(SORTS).map(([key, s]) => html`<option value="${key}" ${key === sort ? 'selected' : ''}>${s.label}</option>`)}
        </select>
      </div>
    </div>
    <div class="lib-ungrouped" id="lib-ungrouped" hidden>
      <span>Seasons are shown one by one right now.</span>
      <button type="button" class="btn btn-sm" id="lib-regroup">Group them again</button>
    </div>
    <div id="lib-grid" class="grid">${skeletonCards(12)}</div>
  `);

  const tabsEl = root.querySelector('#lib-tabs');
  const gridEl = root.querySelector('#lib-grid');
  const filterEl = root.querySelector('#lib-filter');
  const sortEl = root.querySelector('#lib-sort');
  const subEl = root.querySelector('#lib-sub');
  const groupEl = root.querySelector('#lib-group');
  const viewEl = root.querySelector('#lib-view');
  drawView();
  filterEl.value = filter;

  // Collection filter + bulk edit live in library-tools.js; we hand it a few small functions.
  const collectionFromUrl = Number(query.get('collection')) || null;
  const tools = setupLibraryTools({
    root,
    toolbar: root.querySelector('.toolbar-right'),
    gridEl,
    getItems: () => items,
    redraw: () => drawGrid(),
    reload: () => load(true),
    initialCollection: collectionFromUrl || (memory && Number(memory.collection)) || null,
  });

  function syncUrl() {
    const qs = new URLSearchParams();
    if (status !== 'all') qs.set('status', status);
    if (sort !== 'updated') qs.set('sort', sort);
    const s = qs.toString();
    history.replaceState(null, '', s ? `#/library?${s}` : '#/library');
  }

  function rebuild() {
    items = buildItems(entries, groupSeasons);
  }

  function drawTabs() {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    items.forEach((item) => { if (counts[item.status] !== undefined) counts[item.status] += 1; });
    const tabs = [['all', 'All', items.length], ...STATUS_ORDER.map((s) => [s, STATUS_LABELS[s], counts[s]])];
    // Smart filters only show up when they have something in them (or are selected).
    for (const [key, smart] of Object.entries(SMART_FILTERS)) {
      const count = items.filter((item) => smart.test(itemState(item))).length;
      if (count || status === key) tabs.push([key, smart.label, count]);
    }
    setHTML(tabsEl, html`${tabs.map(([key, label, count]) => html`<button type="button" role="tab" data-status="${key}"
      class="${key === status ? 'active' : ''}" aria-selected="${key === status ? 'true' : 'false'}">
      ${key !== 'all' && !SMART_FILTERS[key] ? html`<span class="dot status-${key}"></span>` : ''}${SMART_FILTERS[key] ? html`<span class="smart-mark" aria-hidden="true">✦</span>` : ''}${label}${loaded ? html`<span class="count">${count}</span>` : ''}
    </button>`)}`);
  }

  function matches(item, needle) {
    if (!needle) return true;
    const titles = [];
    if (item.series) titles.push(item.series.title, item.series.title_english);
    item.members.forEach((m) => {
      const meta = m.meta || {};
      titles.push(meta.title, meta.title_english, meta.title_japanese);
    });
    return titles.some((t) => t && t.toLowerCase().includes(needle));
  }

  function drawGrid() {
    if (!loaded) return;
    const needle = filter.trim().toLowerCase();
    const list = items
      .filter((item) => status === 'all' || item.status === status || (SMART_FILTERS[status] && SMART_FILTERS[status].test(itemState(item))))
      .filter((item) => matches(item, needle))
      .filter((item) => tools.matches(item)) // collection filter (library-tools.js)
      .sort(SORTS[sort].fn);

    if (!list.length) {
      if (needle) {
        setHTML(gridEl, emptyState({ title: 'No matches', text: `Nothing in this list matches "${filter.trim()}".` }));
      } else {
        const [, title, text] = EMPTY_TEXT[status];
        setHTML(gridEl, emptyState({ title, text, action: html`<a class="btn btn-primary" href="#/search">Find anime</a>` }));
      }
      return;
    }
    gridEl.className = view === 'list' ? 'lib-list' : 'grid';
    setHTML(gridEl, view === 'list' ? html`${list.map(listRow)}` : html`${list.map(itemCard)}`);
  }

  function drawView() {
    viewEl.querySelectorAll('[data-view]').forEach((b) => {
      const active = b.dataset.view === view;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function drawAll() {
    rebuild();
    const episodes = entries.reduce((sum, e) => sum + (e.watched_count || 0), 0);
    const series = items.filter((i) => i.grouped).length;
    subEl.textContent = entries.length
      ? `${plural(entries.length, 'anime', 'anime')} on your shelf${groupSeasons && series ? ` (${plural(series, 'series', 'series')} grouped)` : ''} · ${episodes.toLocaleString()} episodes watched`
      : "Everything you've watched, are watching, or want to watch.";
    drawTabs();
    drawGrid();
  }

  async function load(quiet = false) {
    if (!quiet) setHTML(gridEl, skeletonCards(12));
    try {
      const data = await api.library();
      if (!root.isConnected) return;
      entries = data.entries || [];
      loaded = true;
      drawAll();
      if (scrollToRestore) { restoreScroll(scrollToRestore); scrollToRestore = 0; } // back from an anime page
      // The server groups new seasons in the background: look once more a little later.
      if (!refetched && groupSeasons && entries.some((e) => !e.franchise)) {
        refetched = true;
        refetchTimer = setTimeout(() => { if (root.isConnected) load(true); }, 8000);
      }
    } catch (err) {
      if (!quiet) errorBox(gridEl, err.message, () => load());
    }
  }

  tabsEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    status = button.dataset.status;
    syncUrl();
    drawTabs();
    drawGrid();
  });
  filterEl.addEventListener('input', () => { filter = filterEl.value; drawGrid(); });
  viewEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button || button.dataset.view === view) return;
    view = button.dataset.view === 'covers' ? 'covers' : 'list';
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ }
    drawView();
    drawGrid();
  });
  sortEl.addEventListener('change', () => { sort = sortEl.value; syncUrl(); drawGrid(); });
  // Switching grouping on/off. Splitting seasons up changes the whole page, so it gets an Undo
  // toast and a notice above the list, in case the click was an accident.
  function setGrouping(on, { undoable = true } = {}) {
    groupSeasons = on;
    groupEl.checked = on;
    try { localStorage.setItem(GROUP_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
    ungroupedEl.hidden = on;
    if (loaded) drawAll();
    if (undoable) {
      toastUndo(on ? 'Seasons grouped into series' : 'Seasons now shown one by one', () => setGrouping(!on, { undoable: false }));
    }
  }
  const ungroupedEl = root.querySelector('#lib-ungrouped');
  ungroupedEl.hidden = groupSeasons;
  groupEl.addEventListener('change', () => setGrouping(groupEl.checked));
  root.querySelector('#lib-regroup').addEventListener('click', () => setGrouping(true));

  drawTabs();
  load();

  return () => {
    clearTimeout(refetchTimer);
    tools.destroy();
    // Saved every time we leave; only used when the next visit comes straight back from an anime page.
    saveViewState('library', { status, sort, filter, collection: tools.collectionId(), scrollY: window.scrollY });
  };
}
