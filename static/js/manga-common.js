// Shared bits for the manga pages (AniShelf 1.15): statuses, progress text, the chapter bar, cards.
// Manga are keyed by their AniList id (many manga have no MyAnimeList id).
import { html, coverHtml, displayTitle, pickMenu, plural } from './ui.js';

export const MANGA_STATUS_ORDER = ['plan_to_read', 'reading', 'completed', 'on_hold', 'dropped'];
export const MANGA_STATUS_LABELS = {
  reading: 'Reading',
  completed: 'Done',
  plan_to_read: 'Want to read',
  on_hold: 'Paused',
  dropped: 'Dropped',
};

/** Small dropdown to pick a manga status (same look as the anime status menu). */
export function mangaStatusMenu(anchor, current = null) {
  return pickMenu(anchor, MANGA_STATUS_ORDER.map((s) => ({
    value: s,
    label: MANGA_STATUS_LABELS[s],
    current: s === current,
    statusClass: `status-${s}`,
  })));
}

/** "Ch 45 of 120", "Ch 45" while still publishing, or "Not started". */
export function chapterText(entry) {
  if (!entry) return '';
  const read = entry.chapters_read || 0;
  if (read === 0) return entry.total_chapters ? `Not started · ${plural(entry.total_chapters, 'chapter')}` : 'Not started';
  return entry.total_chapters ? `Ch ${read} of ${entry.total_chapters}` : `Ch ${read}`;
}

/**
 * The chapter bar. Manga can have 1000+ chapters, so instead of one cell per chapter (the anime
 * episode strip) it is one thin bar at the true ratio. No total yet (still publishing): no bar,
 * because a made-up ratio would be dishonest data.
 */
export function chapterBar(entry, size = '') {
  if (!entry || !entry.total_chapters) return html``;
  const pct = Math.min(100, Math.max(0, ((entry.chapters_read || 0) / entry.total_chapters) * 100));
  return html`<div class="ch-bar ${size}" role="img" aria-label="${entry.chapters_read || 0} of ${entry.total_chapters} chapters read"><span style="width:${pct.toFixed(1)}%"></span></div>`;
}

/** The subtitle under a search result: format, year, chapters. */
export function metaLine(meta) {
  return [meta.format, meta.year, meta.chapters ? plural(meta.chapters, 'chapter') : meta.publishing_status].filter(Boolean).join(' · ');
}

/**
 * A cover card for a manga. Pass `entry` for shelf cards (progress), or just `meta` with an
 * optional `actions` html`` for search results.
 */
export function mangaCard(meta, { entry = null, actions = '', status = null } = {}) {
  const shownStatus = entry ? entry.status : status;
  const inner = html`
    ${shownStatus ? html`<span class="badge status-${shownStatus}">${MANGA_STATUS_LABELS[shownStatus]}</span>` : ''}
    ${entry && entry.score ? html`<span class="score-pill">${entry.score}<small>/10</small></span>` : ''}`;
  return html`<article class="card manga-card" data-id="${meta.anilist_id}">
    <a class="card-link" href="#/manga/${meta.anilist_id}" title="${displayTitle(meta)}">
      ${coverHtml(meta.image, displayTitle(meta), '', inner)}
      <div class="card-title">${displayTitle(meta)}</div>
      <div class="card-sub">${entry ? chapterText(entry) : metaLine(meta)}</div>
      ${entry ? chapterBar(entry) : ''}
    </a>
    ${actions ? html`<div class="card-actions">${actions}</div>` : ''}
  </article>`;
}
