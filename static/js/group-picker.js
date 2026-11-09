// "Group with..." picker on the anime page: join this anime to another series on your shelf,
// or keep it separate. Uses the shared modal styles from app.css.
import { api } from './api.js';
import { html, setHTML, coverHtml, displayTitle, toast } from './ui.js';

/** One row per series on the shelf (seasons collapsed), excluding the series this anime is in. */
function seriesChoices(entries, current) {
  const ownGroup = current.franchise && current.franchise.id;
  const seen = new Map();
  for (const e of entries) {
    const key = e.franchise && e.franchise.id ? e.franchise.id : e.mal_id;
    if (key === ownGroup || e.mal_id === current.mal_id || seen.has(key)) continue;
    const name = e.franchise ? displayTitle(e.franchise) : displayTitle(e.meta);
    seen.set(key, { mal_id: e.mal_id, name, image: e.meta.image });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Open the picker. Resolves with the new seasons data after a change, or null if cancelled.
 * `grouped` tells whether the anime currently sits in a series with other entries.
 */
export async function openGroupPicker(entry, { grouped = false } = {}) {
  const { entries = [] } = await api.library();
  const choices = seriesChoices(entries, entry);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    setHTML(overlay, html`<div class="modal group-picker" role="dialog" aria-modal="true" aria-labelledby="gp-title">
      <h3 id="gp-title">Group ${displayTitle(entry.meta)} with…</h3>
      <div class="modal-body">
        <p class="muted small">Pick the series this belongs to. It will show up as part of that anime everywhere: library, tier list and seasons.</p>
        <input type="search" class="gp-search" placeholder="Filter your shelf" aria-label="Filter series" autocomplete="off">
        <div class="gp-list" role="list">
          ${choices.map((c) => html`<button type="button" class="gp-row" role="listitem" data-with="${c.mal_id}" data-name="${c.name.toLowerCase()}">
            ${coverHtml(c.image, c.name, 'gp-cover')}<span>${c.name}</span></button>`)}
        </div>
      </div>
      <div class="modal-actions">
        ${grouped ? html`<button type="button" class="btn btn-ghost" data-separate>Keep it separate</button>` : ''}
        <button type="button" class="btn" data-cancel>Cancel</button>
      </div>
    </div>`);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      resolve(value);
    };
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } };

    async function apply(target) {
      overlay.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const seasons = await api.setGroup(entry.mal_id, target);
        const stillGrouped = (seasons.seasons || []).length > 1;
        if (target === null && stillGrouped) {
          toast('AniList links these as seasons of one show, so they stay together', 'info', 5000);
        } else {
          toast(target === null ? 'Kept separate' : `Grouped with ${displayTitle(seasons)}`, 'success');
        }
        finish(seasons);
      } catch (err) {
        toast(err.message, 'error');
        overlay.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    }

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-cancel]')) { finish(null); return; }
      if (event.target.closest('[data-separate]')) { apply(null); return; }
      const row = event.target.closest('[data-with]');
      if (row) apply(Number(row.dataset.with));
    });
    overlay.querySelector('.gp-search').addEventListener('input', (event) => {
      const q = event.target.value.trim().toLowerCase();
      overlay.querySelectorAll('.gp-row').forEach((row) => { row.hidden = Boolean(q) && !row.dataset.name.includes(q); });
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    overlay.querySelector('.gp-search').focus();
  });
}
