import { api } from '../api.js';
import {
  html, setHTML, toElement, animeCard, skeletonCards, emptyState, errorBox, toast, statusMenu, icon, STATUS_LABELS,
} from '../ui.js';
import { saveViewState, readViewState, cameFromDetail, restoreScroll } from '../view-memory.js';

function resultCard(meta) {
  const status = meta.library_status;
  const actions = html`<button type="button" class="btn btn-sm ${status ? '' : 'btn-accent'}" data-add="${meta.mal_id}" aria-haspopup="menu">
    ${status ? STATUS_LABELS[status] : html`${icon('plus')} Add`}
  </button>`;
  return animeCard(meta, { actions });
}

export function render(root, params, query) {
  const initial = query.get('q') || '';
  setHTML(root, html`
    <header class="page-head">
      <h1>Search</h1>
      <p>Find any anime on MyAnimeList and add it to your shelf.</p>
    </header>
    <div class="search-box">
      ${icon('search')}
      <input id="q" type="search" placeholder="Search anime… e.g. Frieren, One Piece, Mob Psycho" value="${initial}"
        autocomplete="off" spellcheck="false" aria-label="Search anime">
    </div>
    <div id="results" class="grid"></div>
  `);

  const input = root.querySelector('#q');
  const resultsEl = root.querySelector('#results');
  let results = [];
  let timer = null;
  let controller = null;
  let lastQuery = null;
  // Back from an anime page with the same search: scroll to where you were (view-memory.js)
  const memory = cameFromDetail() ? readViewState('search') : null;
  let scrollToRestore = memory && memory.q === initial.trim() ? memory.scrollY : 0;

  function showHint() {
    setHTML(resultsEl, emptyState({
      title: 'Search for an anime',
      text: 'Type at least 2 characters. Tip: press / anywhere to jump here.',
    }));
  }

  async function run() {
    clearTimeout(timer);
    const q = input.value.trim();
    history.replaceState(null, '', q ? `#/search?q=${encodeURIComponent(q)}` : '#/search');
    if (q.length < 2) {
      if (controller) controller.abort();
      lastQuery = null;
      showHint();
      return;
    }
    if (q === lastQuery) return;
    lastQuery = q;

    if (controller) controller.abort();
    controller = new AbortController();
    const mine = controller;
    setHTML(resultsEl, skeletonCards(10));
    try {
      const data = await api.search(q, mine.signal);
      if (mine.signal.aborted) return;
      results = data.results || [];
      setHTML(resultsEl, results.length
        ? html`${results.map(resultCard)}`
        : emptyState({ title: 'No results', text: `Nothing matched "${q}". Try another spelling or the Japanese title.` }));
      if (scrollToRestore) { restoreScroll(scrollToRestore); scrollToRestore = 0; }
    } catch (err) {
      if (err.name === 'AbortError') return;
      lastQuery = null;
      errorBox(resultsEl, err.message, run);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); lastQuery = null; run(); }
  });

  resultsEl.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-add]');
    if (!button) return;
    event.preventDefault();
    const id = Number(button.dataset.add);
    const meta = results.find((m) => m.mal_id === id);
    if (!meta) return;
    const status = await statusMenu(button, meta.library_status);
    if (!status || status === meta.library_status) return;
    button.disabled = true;
    try {
      const { entry } = await api.add(id, status);
      meta.library_status = entry ? entry.status : status;
      toast(`Added to ${STATUS_LABELS[meta.library_status]}`, 'success');
      const card = button.closest('.card');
      const replacement = toElement(resultCard(meta));
      if (card && replacement) card.replaceWith(replacement);
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    }
  });

  input.focus();
  if (initial.trim().length >= 2) run();
  else showHint();

  return () => {
    clearTimeout(timer);
    if (controller) controller.abort();
    saveViewState('search', { q: input.value.trim(), scrollY: window.scrollY });
  };
}
