// "Continue reading" for Home (AniShelf 1.15). The integrator places it:
//   import { mountMangaCard } from './manga-card.js';
//   mountMangaCard(someContainerElement);
// It shows the 1-3 most recently updated Reading manga with a +1 chapter button, and draws
// nothing at all when you aren't reading any manga (so Home stays clean for anime-only users).
import { api } from './api.js';
import { html, setHTML, coverHtml, displayTitle, toast, confetti } from './ui.js';
import { chapterText, chapterBar } from './manga-common.js';

const MAX_SHOWN = 3;

function leadBlock(entry) {
  const m = entry.meta;
  const done = entry.total_chapters && entry.chapters_read >= entry.total_chapters;
  return html`<div class="home-next">
    <a href="#/manga/${entry.anilist_id}" aria-label="${displayTitle(m)}">${coverHtml(m.image, displayTitle(m))}</a>
    <div class="next-body">
      <h2><a href="#/manga/${entry.anilist_id}">${displayTitle(m)}</a></h2>
      <p class="meta">${chapterText(entry)}</p>
      ${chapterBar(entry)}
      <div class="next-actions">
        ${done ? '' : html`<button type="button" class="btn btn-primary" data-read="${entry.anilist_id}">Read chapter ${entry.chapters_read + 1}</button>`}
        <a class="btn" href="#/manga/${entry.anilist_id}">Open</a>
      </div>
    </div>
  </div>`;
}

function smallRow(entry) {
  const m = entry.meta;
  return html`<div class="queue-row manga-queue-row">
    <a href="#/manga/${entry.anilist_id}" aria-label="${displayTitle(m)}">${coverHtml(m.image, displayTitle(m))}</a>
    <a class="q-text" href="#/manga/${entry.anilist_id}">
      <span class="q-title">${displayTitle(m)}</span>
      <span class="q-sub">${chapterText(entry)}</span>
    </a>
    <button type="button" class="btn btn-sm" data-read="${entry.anilist_id}" title="Read chapter ${entry.chapters_read + 1}">+1 ch</button>
  </div>`;
}

/** Draw "Continue reading" into `container`. Returns a cleanup function. */
export function mountMangaCard(container) {
  if (!container) return () => {};
  let entries = [];
  let busy = false;

  function draw() {
    if (!container.isConnected) return;
    if (!entries.length) {
      container.hidden = true;
      setHTML(container, '');
      return;
    }
    container.hidden = false;
    const [first, ...others] = entries;
    setHTML(container, html`<section class="panel manga-home" aria-label="Continue reading">
      <div class="panel-head"><h2>Continue reading</h2><a class="muted small" href="#/manga?status=reading">Manga</a></div>
      ${leadBlock(first)}
      ${others.length ? html`<div class="queue-list manga-queue">${others.map(smallRow)}</div>` : ''}
    </section>`);
  }

  async function load() {
    try {
      const data = await api.mangaLibrary('reading');
      // the server sorts by last updated, newest first
      entries = (data.entries || []).slice(0, MAX_SHOWN);
    } catch {
      entries = []; // offline or old server: just don't show the card
    }
    draw();
  }

  async function onClick(event) {
    const button = event.target.closest('[data-read]');
    if (!button || busy) return;
    busy = true;
    button.disabled = true;
    const id = Number(button.dataset.read);
    try {
      const { entry, status_changed: changed } = await api.mangaProgress(id, { action: 'increment' });
      toast(`${displayTitle(entry.meta)}: chapter ${entry.chapters_read} read`, 'success', 2200);
      if (changed === 'completed') { toast('Finished! Moved to Done', 'success'); confetti(null); }
      await load();
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    } finally {
      busy = false;
    }
  }

  container.addEventListener('click', onClick);
  load();
  return () => container.removeEventListener('click', onClick);
}
