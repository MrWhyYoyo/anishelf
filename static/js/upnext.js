// Up Next: shared bits for the queue page (views/queue.js) and the small card on Home.
// The queue is your Want to watch (plan_to_watch) list in your own order (GET/PUT /api/queue).
import { api } from './api.js';
import { html, setHTML, coverHtml, displayTitle, plural, toast, STATUS_LABELS } from './ui.js';

/** "TV · 12 episodes · 2024" for one queued entry. */
export function queueFacts(entry) {
  const m = entry.meta || {};
  const label = entry.franchise && entry.franchise.label && entry.franchise.size > 1 ? entry.franchise.label : null;
  return [label, m.type, entry.total ? plural(entry.total, 'episode') : null, m.year].filter(Boolean).join(' · ');
}

/** Move a show to Watching. Resolves true when it worked (shows a toast either way). */
export async function startWatching(malId) {
  try {
    await api.patch(malId, { status: 'watching' });
    toast(`Moved to ${STATUS_LABELS.watching}`, 'success');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function cardRow(entry) {
  const m = entry.meta;
  return html`<div class="queue-row upnext-mini">
    <a href="#/anime/${entry.mal_id}" aria-label="${displayTitle(m)}">${coverHtml(m.image, displayTitle(m))}</a>
    <span class="q-text">
      <a class="q-title" href="#/anime/${entry.mal_id}">${entry.queue_position}. ${displayTitle(m)}</a>
      <span class="q-sub">${queueFacts(entry)}</span>
    </span>
    <button type="button" class="btn btn-sm" data-upnext-start="${entry.mal_id}">Start</button>
  </div>`;
}

/**
 * The compact "Up next" card on Home: the top 3 of the queue, each with a Start button.
 * It hides itself when the queue is empty or can't be loaded. Returns a cleanup function.
 */
export function mountUpNextCard(section) {
  if (!section) return () => {};
  section.hidden = true;

  async function load() {
    try {
      const { entries = [], total = 0 } = await api.queue(3);
      if (!section.isConnected) return;
      if (!entries.length) { section.hidden = true; return; }
      section.className = 'panel upnext-card';
      setHTML(section, html`
        <div class="panel-head"><h2>Up next</h2><a class="muted small" href="#/queue">${total > 3 ? `All ${total} · reorder` : 'Reorder'}</a></div>
        <div class="queue-list">${entries.map(cardRow)}</div>`);
      section.hidden = false;
    } catch {
      section.hidden = true; // nice-to-have: never break Home over it
    }
  }

  async function onClick(event) {
    const button = event.target.closest('[data-upnext-start]');
    if (!button) return;
    button.disabled = true;
    if (await startWatching(Number(button.dataset.upnextStart))) {
      // Home's other blocks (Continue watching) change too, so redraw the whole page.
      window.dispatchEvent(new CustomEvent('anishelf:rerender'));
    } else if (button.isConnected) {
      button.disabled = false;
    }
  }

  section.addEventListener('click', onClick);
  load();
  return () => section.removeEventListener('click', onClick);
}
