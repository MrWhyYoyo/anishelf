// Extra Library tools, kept out of views/library.js so that file stays readable:
//  1. a collection filter (a dropdown next to the other filters) + "Manage collections..."
//  2. bulk edit: a "Select" toggle, click cards to select them (shift-click = a range),
//     and a sticky action bar: set status, set tier, add to collection, mark all watched, remove.
// A grouped series card counts as ONE card on screen but applies to every season in it.
import { api } from './api.js';
import {
  html, setHTML, toast, confirmDialog, pickMenu, statusMenu, plural, STATUS_LABELS, TIERS,
} from './ui.js';
import { createCollectionFlow, openCollectionsManager } from './collections-ui.js';

const MAX_BULK = 500; // the server refuses more than this in one request

/**
 * Set up the tools. library.js passes small functions instead of its variables, so this file
 * never reaches into the Library's internals:
 *   toolbar      the .toolbar-right element (our controls are added at its end)
 *   gridEl       the grid / list element the cards are drawn into
 *   getItems()   the current display items (from franchise.js buildItems)
 *   redraw()     draw the grid again (after the collection filter changes)
 *   reload()     fetch the library again (after a bulk change)
 *   initialCollection  a collection id to start filtered on (from the URL or saved state), or null
 * Returns { matches(item), collectionId(), destroy() }.
 */
export function setupLibraryTools({ root, toolbar, gridEl, getItems, redraw, reload, initialCollection = null }) {
  let collections = [];
  let collectionsLoaded = false; // until the list arrives we can't tell if a saved collection still exists
  let collectionId = initialCollection;
  let selecting = false;
  const selected = new Set(); // mal_ids of the selected cards (the card's lead anime)
  let lastClickedIndex = null; // for shift-click ranges

  /* ---------------------------------------------------------------- controls in the toolbar */
  const collectionSelect = document.createElement('select');
  collectionSelect.id = 'lib-collection';
  collectionSelect.setAttribute('aria-label', 'Filter by collection');
  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'btn btn-sm';
  selectButton.id = 'lib-select';
  selectButton.setAttribute('aria-pressed', 'false');
  selectButton.textContent = 'Select';
  toolbar.append(collectionSelect, selectButton);

  // The sticky action bar sits right after the grid, so it scrolls away with the page.
  const bar = document.createElement('div');
  bar.className = 'bulk-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Bulk edit');
  gridEl.after(bar);

  function drawCollectionSelect() {
    // If the chosen collection was deleted, fall back to "All collections"
    if (collectionsLoaded && collectionId !== null && !collections.some((c) => c.id === collectionId)) collectionId = null;
    setHTML(collectionSelect, html`
      <option value="">All collections</option>
      ${collections.map((c) => html`<option value="${c.id}" ${c.id === collectionId ? 'selected' : ''}>${c.name} (${c.count})</option>`)}
      <option value="manage">Manage collections…</option>`);
    collectionSelect.value = collectionId === null ? '' : String(collectionId);
  }

  async function loadCollections() {
    try {
      collections = (await api.collections()).collections || [];
      collectionsLoaded = true;
    } catch (err) {
      collections = [];
      console.warn('Collections unavailable:', err.message);
    }
    if (!root.isConnected) return;
    drawCollectionSelect();
    redraw();
  }

  collectionSelect.addEventListener('change', async () => {
    if (collectionSelect.value === 'manage') {
      drawCollectionSelect(); // put the dropdown back on the current choice
      await openCollectionsManager();
      if (root.isConnected) loadCollections();
      return;
    }
    collectionId = collectionSelect.value ? Number(collectionSelect.value) : null;
    redraw();
  });

  /** Does an item belong in the current collection filter? A series matches if any season is in it. */
  function matches(item) {
    if (collectionId === null) return true;
    const collection = collections.find((c) => c.id === collectionId);
    if (!collection) return true; // not loaded yet: don't hide everything
    return item.members.some((m) => collection.mal_ids.includes(m.mal_id));
  }

  /* ---------------------------------------------------------------- selecting cards */
  /** Every card element on screen, in screen order, with the anime id it stands for. */
  function cardElements() {
    return Array.from(gridEl.querySelectorAll('.card[data-id], a.lib-row'));
  }

  function idOf(card) {
    if (card.dataset.id) return Number(card.dataset.id);
    const match = (card.getAttribute('href') || '').match(/#\/anime\/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  /** The display item that contains this anime (a single show, or the series it belongs to). */
  function itemFor(malId) {
    return getItems().find((item) => item.members.some((m) => m.mal_id === malId)) || null;
  }

  /** Every anime id the selection covers: grouped series bring all their seasons along. */
  function selectedAnimeIds() {
    const ids = new Set();
    for (const id of selected) {
      const item = itemFor(id);
      if (item) item.members.forEach((m) => ids.add(m.mal_id));
    }
    return Array.from(ids);
  }

  /** Add the check box and the selected look to the cards (runs after every grid draw). */
  function decorate() {
    gridEl.classList.toggle('is-selecting', selecting);
    for (const card of cardElements()) {
      let box = card.querySelector(':scope > .sel-box');
      if (!selecting) {
        if (box) box.remove();
        card.classList.remove('is-selected');
        continue;
      }
      if (!box) {
        box = document.createElement('span');
        box.className = 'sel-box';
        box.setAttribute('aria-hidden', 'true');
        card.prepend(box);
      }
      card.classList.toggle('is-selected', selected.has(idOf(card)));
    }
  }

  // The grid is redrawn with setHTML (filters, sorts, reloads). Watching it for new children
  // means we never have to change library.js's drawing code to keep the check boxes.
  const observer = new MutationObserver(() => { if (selecting) decorate(); });
  observer.observe(gridEl, { childList: true });

  function setSelecting(on) {
    selecting = on;
    selected.clear();
    lastClickedIndex = null;
    selectButton.classList.toggle('active', on);
    selectButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    selectButton.textContent = on ? 'Done' : 'Select';
    decorate();
    drawBar();
  }

  selectButton.addEventListener('click', () => setSelecting(!selecting));

  // "capture: true" runs this before the card's own link, so in select mode a click selects
  // instead of opening the anime page.
  gridEl.addEventListener('click', (event) => {
    if (!selecting) return;
    const card = event.target.closest('.card[data-id], a.lib-row');
    if (!card || !gridEl.contains(card)) return;
    event.preventDefault();
    event.stopPropagation();
    const cards = cardElements();
    const index = cards.indexOf(card);
    const id = idOf(card);
    const turnOn = !selected.has(id);
    if (event.shiftKey && lastClickedIndex !== null) {
      // shift-click: give every card between the last click and this one the same state
      const [from, to] = [Math.min(lastClickedIndex, index), Math.max(lastClickedIndex, index)];
      for (let i = from; i <= to; i += 1) {
        const cardId = idOf(cards[i]);
        if (turnOn) selected.add(cardId); else selected.delete(cardId);
      }
    } else if (turnOn) selected.add(id);
    else selected.delete(id);
    lastClickedIndex = index;
    decorate();
    drawBar();
  }, true);

  function onKey(event) {
    if (event.key === 'Escape' && selecting && !document.querySelector('.modal-overlay, .menu')) setSelecting(false);
  }
  document.addEventListener('keydown', onKey);

  /* ---------------------------------------------------------------- the action bar */
  function drawBar() {
    bar.hidden = !selecting;
    if (!selecting) return;
    const cards = selected.size;
    const anime = selectedAnimeIds().length;
    const label = cards
      ? `${plural(cards, 'selected', 'selected')}${anime > cards ? ` (${plural(anime, 'anime', 'anime')})` : ''}`
      : 'Click cards to select them. Shift-click selects a range.';
    const off = cards ? '' : 'disabled';
    setHTML(bar, html`
      <span class="bulk-count num" aria-live="polite">${label}</span>
      <div class="bulk-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-bulk="all">Select all shown</button>
        ${cards ? html`<button type="button" class="btn btn-sm btn-ghost" data-bulk="none">Clear</button>` : ''}
        <button type="button" class="btn btn-sm" data-bulk="status" aria-haspopup="menu" ${off}>Set status</button>
        <button type="button" class="btn btn-sm" data-bulk="tier" aria-haspopup="menu" ${off}>Set tier</button>
        <button type="button" class="btn btn-sm" data-bulk="collection" aria-haspopup="menu" ${off}>Add to collection</button>
        <button type="button" class="btn btn-sm" data-bulk="watch_all" ${off}>Mark all watched</button>
        <button type="button" class="btn btn-sm btn-danger" data-bulk="remove" ${off}>Remove</button>
      </div>`);
  }

  /** Send one bulk request, tell the user what happened, then reload the shelf. */
  async function run(action, value, doneText) {
    const ids = selectedAnimeIds();
    if (!ids.length) return;
    if (ids.length > MAX_BULK) {
      toast(`Select at most ${MAX_BULK} anime at once`, 'error');
      return;
    }
    try {
      const result = await api.bulk(ids, action, value);
      const changed = (result.changed || []).length;
      const skipped = (result.skipped || []).length;
      let message = `${doneText}: ${plural(changed, 'anime', 'anime')}`;
      if (skipped && action === 'watch_all') message += ` (${skipped} skipped: episode count unknown or already done)`;
      else if (skipped) message += ` (${skipped} already like that)`;
      toast(message, 'success');
      selected.clear();
      lastClickedIndex = null;
      drawBar();
      reload();
      if (action === 'collection' || action === 'remove') loadCollections();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  bar.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-bulk]');
    if (!button) return;
    const kind = button.dataset.bulk;
    if (kind === 'all') {
      cardElements().forEach((card) => selected.add(idOf(card)));
      decorate();
      drawBar();
    } else if (kind === 'none') {
      selected.clear();
      decorate();
      drawBar();
    } else if (kind === 'status') {
      const status = await statusMenu(button);
      if (status) run('status', status, `Moved to ${STATUS_LABELS[status]}`);
    } else if (kind === 'tier') {
      const options = [...TIERS.map((t) => ({ value: t, label: `Tier ${t}` })), { value: 'none', label: 'No tier' }];
      const tier = await pickMenu(button, options);
      if (tier) run('tier', tier === 'none' ? null : tier, tier === 'none' ? 'Tier cleared' : `Placed in tier ${tier}`);
    } else if (kind === 'collection') {
      const options = [...collections.map((c) => ({ value: c.id, label: c.name })), { value: 'new', label: 'New collection…' }];
      let id = await pickMenu(button, options);
      if (id === undefined) return;
      let name = (collections.find((c) => c.id === id) || {}).name;
      if (id === 'new') {
        const created = await createCollectionFlow();
        if (!created) return;
        ({ id, name } = created);
      }
      run('collection', id, `Added to ${name}`);
    } else if (kind === 'watch_all') {
      const count = selectedAnimeIds().length;
      const ok = await confirmDialog(
        `Mark every episode of ${plural(count, 'anime', 'anime')} as watched? Shows whose episode count isn't known yet are skipped.`,
        { title: 'Mark all watched?', okText: 'Mark watched' },
      );
      if (ok) run('watch_all', null, 'Marked watched');
    } else if (kind === 'remove') {
      const count = selectedAnimeIds().length;
      const ok = await confirmDialog(
        `Remove ${plural(count, 'anime', 'anime')} from your library? Their episodes, scores and notes will be deleted.`,
        { title: 'Remove from library?', okText: 'Remove', danger: true },
      );
      if (ok) run('remove', null, 'Removed');
    }
  });

  drawCollectionSelect();
  loadCollections();

  return {
    matches,
    collectionId: () => collectionId,
    destroy() {
      observer.disconnect();
      document.removeEventListener('keydown', onKey);
    },
  };
}
