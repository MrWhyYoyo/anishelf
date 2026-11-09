// Manga shelf at #/manga: a search box for adding manga, status tabs and a cover grid.
import { api } from '../api.js';
import {
  html, setHTML, toElement, skeletonCards, emptyState, errorBox, toast, icon, displayTitle, plural,
} from '../ui.js';
import {
  MANGA_STATUS_ORDER, MANGA_STATUS_LABELS, mangaStatusMenu, mangaCard,
} from '../manga-common.js';
import { saveViewState, readViewState, cameFromDetail, restoreScroll } from '../view-memory.js';

const SORTS = {
  updated: { label: 'Recently updated', fn: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) },
  title: { label: 'Title (A–Z)', fn: (a, b) => displayTitle(a.meta).localeCompare(displayTitle(b.meta)) },
  score: { label: 'My score', fn: (a, b) => (b.score ?? -1) - (a.score ?? -1) },
  chapters: { label: 'Chapters read', fn: (a, b) => b.chapters_read - a.chapters_read },
};

const EMPTY_TEXT = {
  all: ['No manga yet', 'Search above and add a manga. Your reading shelf starts here.'],
  reading: ['Not reading anything', 'Mark a manga as Reading and its next chapter will wait here.'],
  completed: ['Nothing completed yet', 'Read the last chapter of a finished manga and it lands here.'],
  plan_to_read: ['Your reading list is empty', 'Add manga you want to read later.'],
  on_hold: ['Nothing on hold', 'Manga you paused will wait here.'],
  dropped: ['Nothing dropped', 'Good taste, or great patience.'],
};

function searchResultCard(meta) {
  const status = meta.library_status;
  const actions = html`<button type="button" class="btn btn-sm ${status ? '' : 'btn-accent'}" data-add="${meta.anilist_id}" aria-haspopup="menu">
    ${status ? MANGA_STATUS_LABELS[status] : html`${icon('plus')} Add`}
  </button>`;
  return mangaCard(meta, { actions, status });
}

export function render(root, params, query) {
  const fromQuery = query.get('status');
  let status = MANGA_STATUS_ORDER.includes(fromQuery) ? fromQuery : 'all';
  // Back from a manga page: keep the sort and scroll position (view-memory.js)
  const memory = cameFromDetail() ? readViewState('manga') : null;
  let sort = memory && SORTS[memory.sort] ? memory.sort : 'updated';
  let scrollToRestore = memory ? memory.scrollY : 0;
  if (memory && !fromQuery && MANGA_STATUS_ORDER.includes(memory.status)) status = memory.status;
  let entries = [];
  let loaded = false;
  let results = [];
  let timer = null;
  let controller = null;
  let lastQuery = null;

  setHTML(root, html`
    <header class="page-head">
      <h1>Manga</h1>
      <p id="m-sub">Everything you're reading, have read, or want to read.</p>
    </header>
    <div class="search-box">
      ${icon('search')}
      <input id="manga-q" type="search" placeholder="Search manga to add… e.g. Frieren, Berserk, Chainsaw Man"
        autocomplete="off" spellcheck="false" aria-label="Search manga">
    </div>
    <section id="m-results-wrap" class="manga-results" aria-label="Search results" hidden>
      <div class="section-head"><h2>Search results</h2><button type="button" class="link-btn" id="m-clear">Clear</button></div>
      <div id="m-results" class="grid"></div>
    </section>
    <div class="toolbar">
      <div class="tabs" id="m-tabs" role="tablist" aria-label="Filter by status"></div>
      <div class="toolbar-right">
        <select id="m-sort" aria-label="Sort">
          ${Object.entries(SORTS).map(([key, s]) => html`<option value="${key}" ${key === sort ? 'selected' : ''}>${s.label}</option>`)}
        </select>
      </div>
    </div>
    <div id="m-grid" class="grid">${skeletonCards(8)}</div>
  `);

  const input = root.querySelector('#manga-q');
  const resultsWrap = root.querySelector('#m-results-wrap');
  const resultsEl = root.querySelector('#m-results');
  const tabsEl = root.querySelector('#m-tabs');
  const gridEl = root.querySelector('#m-grid');
  const subEl = root.querySelector('#m-sub');
  const sortEl = root.querySelector('#m-sort');

  /* ---------------------------------------------------------------- shelf */
  function drawTabs() {
    const counts = Object.fromEntries(MANGA_STATUS_ORDER.map((s) => [s, 0]));
    entries.forEach((e) => { if (counts[e.status] !== undefined) counts[e.status] += 1; });
    const tabs = [['all', 'All', entries.length], ...MANGA_STATUS_ORDER.map((s) => [s, MANGA_STATUS_LABELS[s], counts[s]])];
    setHTML(tabsEl, html`${tabs.map(([key, label, count]) => html`<button type="button" role="tab" data-status="${key}"
      class="${key === status ? 'active' : ''}" aria-selected="${key === status ? 'true' : 'false'}">
      ${key !== 'all' ? html`<span class="dot status-${key}"></span>` : ''}${label}${loaded ? html`<span class="count">${count}</span>` : ''}
    </button>`)}`);
  }

  function drawGrid() {
    if (!loaded) return;
    const list = entries.filter((e) => status === 'all' || e.status === status).sort(SORTS[sort].fn);
    if (!list.length) {
      const [title, text] = EMPTY_TEXT[status];
      setHTML(gridEl, emptyState({ title, text }));
      return;
    }
    setHTML(gridEl, html`${list.map((e) => mangaCard(e.meta, { entry: e }))}`);
  }

  function drawAll() {
    const chapters = entries.reduce((sum, e) => sum + (e.chapters_read || 0), 0);
    subEl.textContent = entries.length
      ? `${plural(entries.length, 'manga', 'manga')} on your shelf · ${chapters.toLocaleString()} chapters read`
      : "Everything you're reading, have read, or want to read.";
    drawTabs();
    drawGrid();
  }

  async function load() {
    try {
      const data = await api.mangaLibrary();
      if (!root.isConnected) return;
      entries = data.entries || [];
      loaded = true;
      drawAll();
      if (scrollToRestore) { restoreScroll(scrollToRestore); scrollToRestore = 0; }
    } catch (err) {
      if (root.isConnected) errorBox(gridEl, err.message, load);
    }
  }

  tabsEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    status = button.dataset.status;
    history.replaceState(null, '', status === 'all' ? '#/manga' : `#/manga?status=${status}`);
    drawTabs();
    drawGrid();
  });
  sortEl.addEventListener('change', () => { sort = sortEl.value; drawGrid(); });

  /* ---------------------------------------------------------------- search to add */
  function hideResults() {
    if (controller) controller.abort();
    lastQuery = null;
    resultsWrap.hidden = true;
    setHTML(resultsEl, '');
  }

  async function runSearch() {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hideResults(); return; }
    if (q === lastQuery) return;
    lastQuery = q;
    if (controller) controller.abort();
    controller = new AbortController();
    const mine = controller;
    resultsWrap.hidden = false;
    setHTML(resultsEl, skeletonCards(6));
    try {
      const data = await api.mangaSearch(q, mine.signal);
      if (mine.signal.aborted || !root.isConnected) return;
      results = data.results || [];
      setHTML(resultsEl, results.length
        ? html`${results.map(searchResultCard)}`
        : emptyState({ title: 'No results', text: `Nothing matched "${q}". Try another spelling or the Japanese title.` }));
    } catch (err) {
      if (err.name === 'AbortError') return;
      lastQuery = null;
      errorBox(resultsEl, err.message, runSearch);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 400); // wait until typing pauses: one request, not one per key
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); lastQuery = null; runSearch(); }
  });
  root.querySelector('#m-clear').addEventListener('click', () => { input.value = ''; hideResults(); input.focus(); });

  resultsEl.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-add]');
    if (!button) return;
    event.preventDefault();
    const id = Number(button.dataset.add);
    const meta = results.find((m) => m.anilist_id === id);
    if (!meta) return;
    const chosen = await mangaStatusMenu(button, meta.library_status);
    if (!chosen || chosen === meta.library_status) return;
    button.disabled = true;
    try {
      const { entry } = await api.addManga(id, chosen);
      meta.library_status = entry ? entry.status : chosen;
      toast(`Added to ${MANGA_STATUS_LABELS[meta.library_status]}`, 'success');
      const card = button.closest('.card');
      const replacement = toElement(searchResultCard(meta));
      if (card && replacement) card.replaceWith(replacement);
      load(); // the shelf below shows the new manga straight away
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    }
  });

  drawTabs();
  load();

  return () => {
    clearTimeout(timer);
    if (controller) controller.abort();
    saveViewState('manga', { status, sort, scrollY: window.scrollY });
  };
}
