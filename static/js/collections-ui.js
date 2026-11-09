// Custom collections in the interface ("Comfort shows", "Watch with friends"...).
//  - mountCollections(): the small "Collections" panel on an anime page (chips + Add)
//  - askCollectionName(): a modal with one text box, used to create or rename a collection
//  - openCollectionsManager(): rename / recolour / delete, opened from the Library
// The backend is anishelf/user_collections.py (docs/API.md, "Collections").
import { api } from './api.js';
import {
  html, setHTML, toast, openModal, confirmDialog, pickMenu, icon, plural,
} from './ui.js';

// A few optional colours for the little dot next to a collection's name. null = no colour.
export const COLLECTION_COLORS = [
  { value: null, label: 'No colour' },
  { value: '#ff5a36', label: 'Vermilion' },
  { value: '#e5a93b', label: 'Amber' },
  { value: '#c6f24e', label: 'Lime' },
  { value: '#4ec9f2', label: 'Sky' },
  { value: '#b48cff', label: 'Lilac' },
  { value: '#ff8cc6', label: 'Pink' },
];

/** The coloured dot shown before a collection name (nothing when it has no colour). */
export function collectionDot(collection) {
  return collection.color
    ? html`<span class="coll-dot" style="background:${collection.color}" aria-hidden="true"></span>`
    : '';
}

/**
 * Ask for a collection name in a modal. Resolves to the trimmed name, or null when cancelled.
 * openModal() only knows about buttons, so we grab the text box right after it is added to the page.
 */
export async function askCollectionName({ title = 'New collection', initial = '', okText = 'Create' } = {}) {
  const promise = openModal({
    title,
    body: html`<label class="coll-name-field">Name
      <input type="text" class="coll-name-input" maxlength="40" value="${initial}" placeholder="e.g. Comfort shows" autocomplete="off">
    </label>`,
    actions: [
      { label: 'Cancel', value: null, className: 'btn-ghost' },
      { label: okText, value: 'ok', className: 'btn-primary' },
    ],
  });
  const overlays = document.querySelectorAll('.modal-overlay');
  const overlay = overlays[overlays.length - 1];
  const input = overlay && overlay.querySelector('.coll-name-input');
  if (input) {
    // Wait a moment before focusing: a menu that just closed (e.g. "New collection...") can
    // otherwise take the focus back after we set it.
    setTimeout(() => { if (input.isConnected) { input.focus(); input.select(); } }, 30);
    // Enter = press the OK button (the last button in the modal)
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const buttons = overlay.querySelectorAll('.modal-actions button');
      buttons[buttons.length - 1].click();
    });
  }
  const answer = await promise;
  const name = input ? input.value.trim() : '';
  return answer === 'ok' && name ? name : null;
}

/** Create a collection (asks for the name). Resolves to the new collection or null. */
export async function createCollectionFlow() {
  const name = await askCollectionName();
  if (!name) return null;
  try {
    const { collection } = await api.createCollection(name);
    toast(`Created "${collection.name}"`, 'success', 2200);
    return collection;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

/**
 * The "Collections" panel on an anime page.
 * `isInLibrary` is a function, because the page can add or remove the show while it's open.
 * The panel listens for changes itself and removes its listener once the page is gone.
 */
export function mountCollections(section, malId, isInLibrary) {
  if (!section) return;
  let collections = null; // null = not loaded yet

  async function load() {
    try {
      collections = (await api.collections()).collections || [];
    } catch (err) {
      collections = null;
      if (err.status !== 404) console.warn('Collections unavailable:', err.message);
    }
    draw();
  }

  function draw() {
    if (!section.isConnected) return;
    if (!isInLibrary() || collections === null) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const mine = collections.filter((c) => c.mal_ids.includes(malId));
    setHTML(section, html`
      <div class="panel-head"><h2>Collections</h2>
        <button type="button" class="btn btn-sm" data-coll-add aria-haspopup="menu">${icon('plus')} Add to collection</button>
      </div>
      ${mine.length
        ? html`<div class="coll-chips">${mine.map((c) => html`<span class="coll-chip">
            ${collectionDot(c)}<a href="#/library?collection=${c.id}">${c.name}</a>
            <button type="button" class="coll-chip-x" data-coll-remove="${c.id}" aria-label="Remove from ${c.name}" title="Remove from ${c.name}">×</button>
          </span>`)}</div>`
        : html`<p class="muted small">Not in any collection yet. Collections are your own lists, like "Comfort shows".</p>`}`);
  }

  async function onClick(event) {
    const removeBtn = event.target.closest('[data-coll-remove]');
    if (removeBtn) {
      const id = Number(removeBtn.dataset.collRemove);
      try {
        await api.removeFromCollection(id, malId);
      } catch (err) { toast(err.message, 'error'); }
      return; // the 'anishelf:changed' listener reloads the chips
    }
    const addBtn = event.target.closest('[data-coll-add]');
    if (!addBtn || !collections) return;
    const options = collections
      .filter((c) => !c.mal_ids.includes(malId))
      .map((c) => ({ value: c.id, label: `${c.name} (${c.count})` }));
    options.push({ value: 'new', label: 'New collection…' });
    const choice = await pickMenu(addBtn, options);
    if (choice === undefined) return;
    let id = choice;
    if (choice === 'new') {
      const created = await createCollectionFlow();
      if (!created) return;
      id = created.id;
    }
    try {
      const { collection } = await api.addToCollection(id, [malId]);
      toast(`Added to ${collection.name}`, 'success', 2200);
    } catch (err) { toast(err.message, 'error'); }
  }

  // Any change anywhere (add/remove the show, a collection edited) might change this panel.
  // setTimeout(0) waits until the page has updated its own state (e.g. state.entry after "Add").
  function onChanged() {
    if (!section.isConnected) {
      window.removeEventListener('anishelf:changed', onChanged);
      return;
    }
    setTimeout(load, 0);
  }

  section.addEventListener('click', onClick);
  window.addEventListener('anishelf:changed', onChanged);
  load();
}

/** Rename, recolour or delete collections. Resolves when the modal closes. */
export async function openCollectionsManager() {
  let collections = [];
  try {
    collections = (await api.collections()).collections || [];
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const promise = openModal({
    title: 'Your collections',
    body: html`<div class="coll-manage"></div>`,
    actions: [{ label: 'Done', value: null, className: 'btn-primary' }],
  });
  const overlays = document.querySelectorAll('.modal-overlay');
  const box = overlays[overlays.length - 1].querySelector('.coll-manage');

  function colorOptions(current) {
    return COLLECTION_COLORS.map((c) => html`<option value="${c.value || ''}" ${(c.value || null) === (current || null) ? 'selected' : ''}>${c.label}</option>`);
  }

  function draw() {
    setHTML(box, html`
      ${collections.length
        ? html`<ul class="coll-manage-list">${collections.map((c) => html`<li data-id="${c.id}">
            ${collectionDot(c)}
            <span class="coll-manage-name">${c.name}</span>
            <span class="faint small num">${plural(c.count, 'show')}</span>
            <select data-coll-color aria-label="Colour for ${c.name}">${colorOptions(c.color)}</select>
            <button type="button" class="btn btn-sm btn-ghost" data-coll-rename>Rename</button>
            <button type="button" class="btn btn-sm btn-danger" data-coll-delete>Delete</button>
          </li>`)}</ul>`
        : html`<p class="muted">No collections yet. Make one for any group of shows you like to keep together.</p>`}
      <button type="button" class="btn btn-sm" data-coll-new>${icon('plus')} New collection</button>`);
  }

  async function refresh() {
    try {
      collections = (await api.collections()).collections || [];
    } catch (err) { toast(err.message, 'error'); }
    if (box.isConnected) draw();
  }

  box.addEventListener('click', async (event) => {
    if (event.target.closest('[data-coll-new]')) {
      if (await createCollectionFlow()) refresh();
      return;
    }
    const row = event.target.closest('li[data-id]');
    if (!row) return;
    const collection = collections.find((c) => c.id === Number(row.dataset.id));
    if (!collection) return;
    if (event.target.closest('[data-coll-rename]')) {
      const name = await askCollectionName({ title: 'Rename collection', initial: collection.name, okText: 'Rename' });
      if (!name || name === collection.name) return;
      try {
        await api.patchCollection(collection.id, { name });
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    } else if (event.target.closest('[data-coll-delete]')) {
      const ok = await confirmDialog(
        `Delete the collection "${collection.name}"? The ${plural(collection.count, 'show')} in it stay in your library.`,
        { title: 'Delete collection?', okText: 'Delete', danger: true },
      );
      if (!ok) return;
      try {
        await api.deleteCollection(collection.id);
        toast(`Deleted "${collection.name}"`, 'success', 2200);
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  box.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-coll-color]');
    const row = event.target.closest('li[data-id]');
    if (!select || !row) return;
    try {
      await api.patchCollection(Number(row.dataset.id), { color: select.value || null });
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  draw();
  await promise;
}
