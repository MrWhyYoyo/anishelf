// Up Next (#/queue): put your Want to watch shows in the order you'll watch them.
// Two ways to reorder, both saving the same way (PUT /api/queue with the full list of ids):
//   * drag a row (HTML5 drag and drop, mouse)
//   * the up/down/top buttons (keyboard and touch friendly)
import { api } from '../api.js';
import {
  html, setHTML, coverHtml, displayTitle, emptyState, errorBox, toast, STATUS_LABELS, plural,
} from '../ui.js';
import { queueFacts, startWatching } from '../upnext.js';

const GRIP = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>`;
const UP = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`;
const DOWN = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

function row(entry, index, count) {
  const m = entry.meta;
  const title = displayTitle(m);
  return html`<li class="upnext-row" draggable="true" data-id="${entry.mal_id}">
    <span class="upnext-grip" aria-hidden="true">${GRIP}</span>
    <span class="upnext-pos num">${index + 1}</span>
    <a href="#/anime/${entry.mal_id}" draggable="false" aria-label="${title}">${coverHtml(m.image, title)}</a>
    <span class="q-text">
      <a class="q-title" href="#/anime/${entry.mal_id}" draggable="false">${title}</a>
      <span class="q-sub">${queueFacts(entry)}</span>
    </span>
    <span class="upnext-actions">
      <button type="button" class="icon-btn" data-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Move ${title} up">${UP}</button>
      <button type="button" class="icon-btn" data-move="down" ${index === count - 1 ? 'disabled' : ''} aria-label="Move ${title} down">${DOWN}</button>
      ${index > 0 ? html`<button type="button" class="btn btn-sm btn-ghost" data-move="top">To top</button>` : ''}
      <button type="button" class="btn btn-sm" data-start>Start</button>
    </span>
  </li>`;
}

export function render(root) {
  setHTML(root, html`
    <header class="page-head">
      <h1>Up next</h1>
      <p id="upnext-sub">Your ${STATUS_LABELS.plan_to_watch} list, in the order you'll watch it. Drag a row, or use the arrows.</p>
    </header>
    <section class="panel">
      <ol class="upnext-list" id="upnext-list"><li class="sk-line" style="height:240px"></li></ol>
    </section>
    <p class="sr-only" aria-live="polite" id="upnext-live"></p>
  `);

  const list = root.querySelector('#upnext-list');
  const live = root.querySelector('#upnext-live');
  const sub = root.querySelector('#upnext-sub');
  let entries = [];

  function draw() {
    if (!entries.length) {
      setHTML(list, html`<li>${emptyState({
        title: 'Your queue is empty',
        text: `Shows you mark as ${STATUS_LABELS.plan_to_watch} line up here.`,
        action: html`<a class="btn btn-primary" href="#/season">Browse this season</a>`,
      })}</li>`);
      return;
    }
    setHTML(list, html`${entries.map((entry, i) => row(entry, i, entries.length))}`);
    sub.textContent = `${plural(entries.length, 'show')} lined up. Drag a row, or use the arrows.`;
  }

  async function load() {
    try {
      const data = await api.queue();
      if (!root.isConnected) return;
      entries = data.entries || [];
      draw();
    } catch (err) {
      if (root.isConnected) errorBox(list, err.message, load);
    }
  }

  /* ---------------------------------------------------------------- saving
     Clicking "down" five times quickly would send five requests that could arrive out of
     order. Instead only one request runs at a time, and it always sends the newest order. */
  let saving = false;
  let pendingOrder = null;

  async function save() {
    pendingOrder = entries.map((e) => e.mal_id);
    if (saving) return; // the running loop below will pick up the new order
    saving = true;
    while (pendingOrder) {
      const order = pendingOrder;
      pendingOrder = null;
      try {
        await api.reorderQueue(order);
      } catch (err) {
        toast(err.message, 'error');
        pendingOrder = null;
        await load(); // show what the server really has
      }
    }
    saving = false;
  }

  /** Move one entry from index `from` to index `to`, redraw and save. */
  function move(from, to) {
    if (to < 0 || to >= entries.length || from === to) return;
    const [picked] = entries.splice(from, 1); // take it out...
    entries.splice(to, 0, picked);            // ...and put it back at the new place
    draw();
    live.textContent = `${displayTitle(picked.meta)} moved to position ${to + 1} of ${entries.length}`;
    save();
  }

  /* ---------------------------------------------------------------- buttons */
  list.addEventListener('click', async (event) => {
    const item = event.target.closest('.upnext-row');
    if (!item) return;
    const id = Number(item.dataset.id);
    const index = entries.findIndex((e) => e.mal_id === id);
    const mover = event.target.closest('[data-move]');
    if (mover) {
      const direction = mover.dataset.move;
      const target = direction === 'top' ? 0 : index + (direction === 'up' ? -1 : 1);
      move(index, target);
      // Keep keyboard focus on the same button of the moved row (or its twin when at an end).
      const moved = list.querySelector(`.upnext-row[data-id="${id}"]`);
      if (moved) {
        const same = moved.querySelector(`[data-move="${direction === 'top' ? 'down' : direction}"]:not(:disabled)`);
        (same || moved.querySelector('[data-move]:not(:disabled)') || moved.querySelector('[data-start]')).focus();
      }
      return;
    }
    const start = event.target.closest('[data-start]');
    if (start) {
      start.disabled = true;
      if (await startWatching(id)) {
        entries = entries.filter((e) => e.mal_id !== id); // it left the queue on the server too
        draw();
      } else if (start.isConnected) {
        start.disabled = false;
      }
    }
  });

  /* ---------------------------------------------------------------- drag and drop
     While dragging, the row itself moves through the list (so you see where it lands).
     On drop the new DOM order becomes the saved order; a cancelled drag redraws the old one. */
  let dragged = null;
  let dropped = false;

  list.addEventListener('dragstart', (event) => {
    dragged = event.target.closest('.upnext-row');
    if (!dragged) return;
    dropped = false;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged.dataset.id); // Firefox needs some data to start a drag
    // Add the class a moment later, so the "ghost" image the browser takes still looks normal.
    requestAnimationFrame(() => { if (dragged) dragged.classList.add('dragging'); });
  });

  list.addEventListener('dragover', (event) => {
    if (!dragged) return;
    event.preventDefault(); // saying "a drop is allowed here"
    const over = event.target.closest('.upnext-row');
    if (!over || over === dragged) return;
    const box = over.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2; // lower half = put it after
    list.insertBefore(dragged, after ? over.nextSibling : over);
  });

  list.addEventListener('drop', (event) => {
    if (!dragged) return;
    event.preventDefault();
    dropped = true;
    const order = [...list.querySelectorAll('.upnext-row')].map((el) => Number(el.dataset.id));
    const byId = new Map(entries.map((e) => [e.mal_id, e]));
    const changed = order.some((id, i) => id !== entries[i].mal_id);
    entries = order.map((id) => byId.get(id)).filter(Boolean);
    const movedId = Number(dragged.dataset.id);
    const position = order.indexOf(movedId) + 1;
    draw();
    if (changed) {
      live.textContent = `${displayTitle(byId.get(movedId).meta)} moved to position ${position}`;
      save();
    }
  });

  list.addEventListener('dragend', () => {
    if (dragged) dragged.classList.remove('dragging');
    dragged = null;
    if (!dropped) draw(); // dropped outside the list (or Esc): put everything back
  });

  load();
}
