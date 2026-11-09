// #/diary: the watch diary as a vertical timeline, grouped by month, filterable by mood.
import { api } from '../api.js';
import {
  html, setHTML, coverHtml, displayTitle, emptyState, errorBox, toast, confirmDialog, plural,
} from '../ui.js';
import { MOODS, MOOD_LABELS, moodMark, openDiaryEditor } from '../diary-note.js';

export function render(root, _params, query) {
  const state = {
    mood: MOODS.includes(query.get('mood')) ? query.get('mood') : '',
    data: null,
  };

  setHTML(root, html`<div class="diary-view">
    <header class="page-head">
      <h1>Watch diary</h1>
      <p>One line and a mood for every show you finish.</p>
    </header>
    <div id="diary-filter"></div>
    <div id="diary-body"><div class="sk-line shimmer"></div><div class="sk-line short shimmer"></div></div>
  </div>`);
  const filterEl = root.querySelector('#diary-filter');
  const bodyEl = root.querySelector('#diary-body');

  async function load() {
    try {
      const data = await api.diary({ mood: state.mood });
      if (!root.isConnected) return;
      state.data = data;
      draw();
    } catch (err) {
      if (root.isConnected) errorBox(bodyEl, err.message, load);
    }
  }

  function monthKey(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'Unknown' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthName(key) {
    if (key === 'Unknown') return 'Undated';
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function dayText(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function drawFilter() {
    const counts = state.data.mood_counts || {};
    const total = state.data.total || 0;
    setHTML(filterEl, html`<div class="tabs diary-tabs" role="group" aria-label="Filter by mood">
      <button type="button" data-filter="" class="${state.mood ? '' : 'active'}" aria-pressed="${state.mood ? 'false' : 'true'}">All <span class="count">${total}</span></button>
      ${MOODS.map((m) => html`<button type="button" data-filter="${m}" class="${state.mood === m ? 'active' : ''}"
        aria-pressed="${state.mood === m ? 'true' : 'false'}">${MOOD_LABELS[m]} <span class="count">${counts[m] || 0}</span></button>`)}
    </div>`);
  }

  function noteHtml(note) {
    const title = displayTitle(note);
    return html`<li class="diary-item" data-note="${note.id}">
      <span class="diary-day">${dayText(note.created_at)}</span>
      <a class="diary-thumb" href="#/anime/${note.mal_id}" tabindex="-1" aria-hidden="true">${coverHtml(note.image, title, 'diary-cover')}</a>
      <div class="diary-text">
        <div class="diary-line">
          <a class="diary-title" href="#/anime/${note.mal_id}">${title}</a>
          ${moodMark(note.mood)}
        </div>
        ${note.text ? html`<p>${note.text}</p>` : html`<p class="faint">No words, just a mood.</p>`}
      </div>
      <div class="diary-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-edit="${note.id}">Edit</button>
        <button type="button" class="btn btn-sm btn-ghost" data-delete="${note.id}">Delete</button>
      </div>
    </li>`;
  }

  function draw() {
    drawFilter();
    const notes = state.data.entries || [];
    if (!notes.length) {
      setHTML(bodyEl, emptyState({
        title: state.mood ? `No ${MOOD_LABELS[state.mood].toLowerCase()} notes yet` : 'Your diary is empty',
        text: state.mood
          ? 'Try another mood, or show everything.'
          : 'When you finish a show, AniShelf asks for a one-line reaction. You can also add a note from any anime page.',
        action: html`<a class="btn btn-primary" href="#/library">Open your library</a>`,
      }));
      return;
    }
    // Group by month, newest first (the server already sorts newest first)
    const groups = [];
    for (const note of notes) {
      const key = monthKey(note.created_at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.notes.push(note);
      else groups.push({ key, notes: [note] });
    }
    setHTML(bodyEl, html`<div class="diary-timeline">
      ${groups.map((g) => html`<section class="diary-month">
        <h2>${monthName(g.key)} <span class="faint">${plural(g.notes.length, 'note')}</span></h2>
        <ol class="diary-list">${g.notes.map(noteHtml)}</ol>
      </section>`)}
    </div>`);
  }

  function findNote(id) {
    return (state.data.entries || []).find((n) => n.id === id) || null;
  }

  root.addEventListener('click', async (event) => {
    const filterBtn = event.target.closest('[data-filter]');
    if (filterBtn) {
      state.mood = filterBtn.dataset.filter;
      // Keep the filter in the address so Back/refresh remember it
      const hash = state.mood ? `#/diary?mood=${encodeURIComponent(state.mood)}` : '#/diary';
      window.history.replaceState(null, '', hash);
      load();
      return;
    }
    const editBtn = event.target.closest('[data-edit]');
    if (editBtn) {
      const note = findNote(Number(editBtn.dataset.edit));
      if (!note) return;
      const saved = await openDiaryEditor({ malId: note.mal_id, animeTitle: displayTitle(note), note });
      if (saved && root.isConnected) load();
      return;
    }
    const deleteBtn = event.target.closest('[data-delete]');
    if (deleteBtn) {
      const ok = await confirmDialog('Delete this diary note?', { title: 'Delete note?', okText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api.deleteDiary(Number(deleteBtn.dataset.delete));
        toast('Note deleted', 'success', 2200);
        if (root.isConnected) load();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  load();
}
