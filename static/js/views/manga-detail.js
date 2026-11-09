// Manga page at #/manga/<anilist_id>: banner + cover header, chapter progress, journal and anime links.
// Same look as the anime page (detail.js) but its own code, since manga track chapters, not episodes.
import { api } from '../api.js';
import {
  html, setHTML, coverHtml, animeCard, errorBox, toast, confirmDialog, setAccent, imgUrl, safeUrl, icon,
  displayTitle, altTitle, plural, SCORE_WORDS, confetti, openInBrowser,
} from '../ui.js';
import {
  MANGA_STATUS_ORDER, MANGA_STATUS_LABELS, chapterText, chapterBar,
} from '../manga-common.js';

// AniList format codes -> the words the anime side uses
const ANIME_FORMATS = { TV: 'TV', TV_SHORT: 'TV', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' };

export function render(root, { id }) {
  const state = { meta: null, entry: null, adaptations: [], volumeInfo: null };
  let els = {};
  let notesTimer = null;
  let busy = false; // one chapter change at a time, so fast double-clicks can't skip a chapter
  let volumesRequested = false; // the volume -> chapter table is fetched once per page

  setHTML(root, html`<div class="detail-view">
    <div class="hero shimmer"></div>
    <div class="detail-inner">
      <div class="detail-head">
        <div class="cover detail-cover shimmer"></div>
        <div class="detail-titles"><div class="sk-line shimmer" style="height:34px;width:60%"></div><div class="sk-line short shimmer"></div></div>
      </div>
    </div>
  </div>`);

  // Any [data-open-url] button (Where to read, AniList) opens in the user's own browser.
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-url]');
    if (!button) return;
    event.preventDefault();
    openInBrowser(button.dataset.openUrl, button.dataset.site);
  });

  load();

  async function load() {
    let data;
    try {
      data = await api.manga(id);
    } catch (err) {
      if (!root.isConnected) return;
      errorBox(root, err.status === 404 ? "Couldn't find that manga." : err.message, err.status === 404 ? null : load);
      return;
    }
    if (!root.isConnected) return;
    state.meta = data.meta;
    state.entry = data.entry || null;
    state.adaptations = data.adaptations || [];
    setAccent(state.meta.color); // the cover colour marks the data (progress bar), never buttons
    document.title = `${displayTitle(state.meta)} · AniShelf`;
    window.dispatchEvent(new CustomEvent('anishelf:context', { detail: { title: displayTitle(state.meta) } }));
    drawShell();
  }

  /* ---------------------------------------------------------------- layout */
  function drawShell() {
    const m = state.meta;
    const chips = [
      m.format, m.year, m.publishing_status,
      m.chapters ? plural(m.chapters, 'chapter') : null,
      m.volumes ? plural(m.volumes, 'volume') : null,
    ].filter(Boolean);
    const reading = (m.reading || []).filter((r) => safeUrl(r.url));

    setHTML(root, html`<div class="detail-view">
      <div class="hero">
        ${m.banner && imgUrl(m.banner)
          ? html`<img class="hero-img fx-img" src="${imgUrl(m.banner)}" alt="">`
          : (imgUrl(m.image) ? html`<img class="hero-img blurred fx-img" src="${imgUrl(m.image)}" alt="">` : '')}
        <div class="hero-shade"></div>
      </div>
      <div class="detail-inner">
        <div class="detail-head">
          ${coverHtml(m.image, displayTitle(m), 'detail-cover')}
          <div class="detail-titles">
            <h1>${displayTitle(m)}</h1>
            ${altTitle(m) ? html`<p class="alt-title">${altTitle(m)}</p>` : ''}
            ${m.title_japanese ? html`<p class="jp-title" lang="ja">${m.title_japanese}</p>` : ''}
            <div class="chips">
              ${chips.map((c) => html`<span class="chip">${c}</span>`)}
              ${typeof m.anilist_score === 'number' ? html`<span class="chip chip-score">AniList ${m.anilist_score.toFixed(1)}</span>` : ''}
              ${(m.genres || []).map((g) => html`<span class="chip chip-genre">${g}</span>`)}
            </div>
            ${reading.length ? html`<div class="watch-row" aria-label="Where to read">
              <span class="watch-label">Where to read</span>
              ${reading.map((r) => html`<button type="button" class="watch-pill" data-open-url="${r.url}" data-site="${r.site}"
                title="Open ${r.site} in your browser">${icon('external')}${r.site}</button>`)}
            </div>` : ''}
            <div id="m-actions" class="detail-actions"></div>
          </div>
        </div>

        <div class="detail-grid">
          <div class="detail-main">
            <section id="m-progress" class="panel" aria-label="Chapter progress"></section>
            <section id="m-journal" class="panel" aria-label="My notes"></section>
          </div>
          <aside class="detail-side">${aboutPanel(m)}</aside>
        </div>

        <section class="section" id="m-adaptations" aria-label="Anime adaptations"></section>
      </div>
    </div>`);

    els = {
      actions: root.querySelector('#m-actions'),
      progress: root.querySelector('#m-progress'),
      journal: root.querySelector('#m-journal'),
      adaptations: root.querySelector('#m-adaptations'),
    };
    els.actions.addEventListener('click', onActionsClick);
    els.actions.addEventListener('change', onActionsChange);
    els.progress.addEventListener('click', onProgressClick);
    els.progress.addEventListener('submit', onProgressSubmit);
    els.progress.addEventListener('input', onProgressInput);
    els.journal.addEventListener('click', onJournalClick);
    els.journal.addEventListener('change', onJournalChange);
    els.journal.addEventListener('input', onJournalInput);

    const toggle = root.querySelector('#m-syn-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const syn = root.querySelector('#m-synopsis');
        const clamped = syn.classList.toggle('clamp');
        toggle.textContent = clamped ? 'Read more' : 'Show less';
        toggle.setAttribute('aria-expanded', clamped ? 'false' : 'true');
      });
    }

    drawActions();
    drawProgress();
    drawJournal();
    drawAdaptations();
  }

  function aboutPanel(m) {
    const synopsis = (m.synopsis || '').trim();
    const paragraphs = synopsis ? synopsis.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
    const long = synopsis.length > 420;
    const authors = (m.authors || []).map((a) => `${a.name} (${a.role})`).join(', ');
    const rows = [
      ['Status', m.publishing_status],
      ['Format', m.format],
      // Honest data: an ongoing manga has no final count yet, so it shows a dash.
      ['Chapters', m.chapters ? String(m.chapters) : '—'],
      ['Volumes', m.volumes ? String(m.volumes) : '—'],
      ['Authors', authors || null],
      ['Started', m.year ? String(m.year) : null],
      ['AniList score', typeof m.anilist_score === 'number' ? `${m.anilist_score.toFixed(1)} / 10` : null],
    ].filter(([, value]) => value);
    const anilistUrl = safeUrl(m.url);
    return html`<section class="panel about">
      <h2 style="margin-bottom:12px">About</h2>
      ${paragraphs.length
        ? html`<div id="m-synopsis" class="synopsis ${long ? 'clamp' : ''}">${paragraphs.map((p) => html`<p>${p}</p>`)}</div>
          ${long ? html`<button type="button" class="link-btn" id="m-syn-toggle" aria-expanded="false" style="margin-top:8px">Read more</button>` : ''}`
        : html`<p class="muted">No synopsis available.</p>`}
      <dl class="info-list">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${anilistUrl ? html`<div class="link-row"><button type="button" class="btn btn-sm" data-open-url="${anilistUrl}" data-site="AniList">${icon('external')} AniList</button></div>` : ''}
    </section>`;
  }

  /* ---------------------------------------------------------------- status / add / remove */
  function drawActions() {
    const e = state.entry;
    if (!e) {
      setHTML(els.actions, html`<div class="add-box">
        <select id="m-add-status" aria-label="Status to add with">
          ${MANGA_STATUS_ORDER.map((s) => html`<option value="${s}" ${s === 'plan_to_read' ? 'selected' : ''}>${MANGA_STATUS_LABELS[s]}</option>`)}
        </select>
        <button type="button" class="btn btn-primary btn-lg" data-act="add">${icon('plus')} Add to shelf</button>
      </div>`);
      return;
    }
    setHTML(els.actions, html`<div class="action-row">
      <div class="action-fields">
        <label class="field-inline"><span class="sr-only">Status</span>
          <select id="m-status" class="status-select status-${e.status}">
            ${MANGA_STATUS_ORDER.map((s) => html`<option value="${s}" ${s === e.status ? 'selected' : ''}>${MANGA_STATUS_LABELS[s]}</option>`)}
          </select>
        </label>
      </div>
      <div class="action-icons">
        <button type="button" class="icon-btn danger" data-act="remove" title="Remove from shelf">${icon('trash')}</button>
      </div>
    </div>`);
  }

  function redrawEntryParts() {
    drawActions();
    drawProgress();
    syncJournalValues();
  }

  async function onActionsClick(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    if (button.dataset.act === 'add') {
      const status = root.querySelector('#m-add-status').value;
      button.disabled = true;
      try {
        const { entry } = await api.addManga(id, status);
        state.entry = entry;
        toast(`Added to ${MANGA_STATUS_LABELS[entry.status]}`, 'success');
        drawActions();
        drawProgress();
        drawJournal();
      } catch (err) {
        toast(err.message, 'error');
        if (button.isConnected) button.disabled = false;
      }
    } else if (button.dataset.act === 'remove') {
      const ok = await confirmDialog(
        `Remove "${displayTitle(state.meta)}" from your shelf? Your chapters, score and notes for it will be deleted.`,
        { title: 'Remove from shelf?', okText: 'Remove', danger: true },
      );
      if (!ok) return;
      try {
        await api.removeManga(id);
        state.entry = null;
        toast('Removed from your shelf', 'success');
        drawActions();
        drawProgress();
        drawJournal();
      } catch (err) { toast(err.message, 'error'); }
    }
  }

  async function onActionsChange(event) {
    if (event.target.id !== 'm-status') return;
    try {
      const { entry } = await api.patchManga(id, { status: event.target.value });
      state.entry = entry;
      toast(`Moved to ${MANGA_STATUS_LABELS[entry.status]}`, 'success', 2200);
    } catch (err) { toast(err.message, 'error'); }
    redrawEntryParts();
  }

  /* ---------------------------------------------------------------- chapters */
  function drawProgress() {
    const e = state.entry;
    const grid = els.progress.closest('.detail-grid');
    if (grid) grid.classList.toggle('solo', !e); // not on the shelf: About takes the full row
    els.progress.hidden = !e;
    if (!e) { setHTML(els.progress, ''); return; }

    const total = e.total_chapters;
    const read = e.chapters_read || 0;
    const left = total ? Math.max(0, total - read) : null;
    const done = total && read >= total;
    let hint = '';
    if (!total) hint = 'Still publishing, so there is no final chapter count yet.';
    else if (done) hint = 'All caught up.';
    else hint = `${plural(left, 'chapter')} to go`;

    setHTML(els.progress, html`
      <div class="panel-head"><h2>Chapters</h2>
        ${typeof e.progress === 'number' ? html`<span class="faint small num">${Math.round(e.progress * 100)}% read</span>` : ''}</div>
      <div class="m-progress">
        <div class="big num">${read === 0 ? 'Not started' : chapterText(e)}</div>
        ${chapterBar(e, 'lg')}
        <p class="muted small">${hint}</p>
        <div class="tracker-buttons">
          ${done ? '' : html`<button type="button" class="btn btn-primary" data-ch="plus">${icon('plus')} Read chapter ${read + 1}</button>`}
          ${read > 0 ? html`<button type="button" class="btn btn-sm btn-ghost" data-ch="minus" title="Undo one chapter">Undo</button>` : ''}
        </div>
        <div class="m-fields">
          <form class="m-set m-vol" data-form="volumes">
            <label for="m-vol-input">I've read</label>
            <input type="number" id="m-vol-input" min="0" ${e.total_volumes ? html`max="${e.total_volumes}"` : html`max="1000"`} value="${e.volumes_read || 0}" inputmode="numeric">
            <span>${e.total_volumes ? `of ${e.total_volumes} volumes` : 'volumes'}</span>
            <button type="submit" class="btn btn-sm btn-primary">Update</button>
            <span class="m-vol-hint faint small" id="m-vol-hint" aria-live="polite"></span>
          </form>
          <form class="m-set" data-form="chapter">
            <label for="m-ch-input">Set chapter</label>
            <input type="number" id="m-ch-input" min="0" ${total ? html`max="${total}"` : html`max="10000"`} value="${read}" inputmode="numeric">
            <button type="submit" class="btn btn-sm">Set</button>
          </form>
        </div>
      </div>`);
    loadVolumes();
    showVolumeHint();
  }

  /* ---------------------------------------------------------------- volumes -> chapters
     The server asks MangaDex once (cached for a week) which chapter each volume ends at.
     state.volumeInfo = { source, volumes: [{ volume, last_chapter, source }] } */
  async function loadVolumes() {
    if (volumesRequested || !state.entry) return;
    volumesRequested = true;
    try {
      state.volumeInfo = await api.mangaVolumes(id);
    } catch {
      state.volumeInfo = { source: null, volumes: [] }; // no hint, but typing volumes still works
    }
    if (root.isConnected) showVolumeHint();
  }

  // The chapter volume N ends at, from the server's table (or null when nobody knows)
  function volumeEnd(n) {
    const list = (state.volumeInfo && state.volumeInfo.volumes) || [];
    return list.find((v) => v.volume === n) || null;
  }

  function showVolumeHint() {
    const input = root.querySelector('#m-vol-input');
    const hint = root.querySelector('#m-vol-hint');
    if (!input || !hint) return;
    const n = Number.parseInt(input.value, 10);
    let text = '';
    if (Number.isInteger(n) && n > 0) {
      const end = volumeEnd(n);
      if (!state.volumeInfo) text = 'Looking up chapters…';
      else if (end && end.source === 'estimate') text = `→ about chapter ${end.last_chapter} (estimated)`;
      else if (end) text = `→ up to chapter ${end.last_chapter}`;
      else text = 'No chapter info for that volume';
    }
    hint.textContent = text; // textContent, not HTML: nothing here can inject markup
  }

  function volumesToast(info) {
    const { volume, chapter, source, kept_higher: keptHigher } = info;
    if (volume === 0) return `Volumes read: 0`;
    if (chapter === null || chapter === undefined) return "Couldn't find chapter info for that volume, volumes saved";
    const where = source === 'estimate' ? `about chapter ${chapter} (estimated)` : `chapter ${chapter}`;
    if (keptHigher) return `Volume ${volume} ends at ${where}. You're already further, so your chapters stay`;
    return `Volume ${volume} ends at ${where}, chapters set to ${chapter}`;
  }

  async function setChapters(body) {
    if (busy) return;
    busy = true;
    const before = state.entry.status;
    try {
      const result = await api.mangaProgress(id, body);
      const { entry, status_changed: changed, chapters_from_volumes: fromVolumes } = result;
      state.entry = entry;
      if (fromVolumes) toast(volumesToast(fromVolumes), fromVolumes.chapter === null ? 'info' : 'success', 3200);
      if (changed === 'completed') {
        toast('Finished! Moved to Done', 'success');
        confetti(els.progress.querySelector('.big'));
      } else if (changed && changed !== before) {
        toast(`Moved to ${MANGA_STATUS_LABELS[changed]}`, 'success', 2200);
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy = false;
    }
    if (root.isConnected) redrawEntryParts();
  }

  function onProgressClick(event) {
    const button = event.target.closest('[data-ch]');
    if (!button || !state.entry) return;
    if (button.dataset.ch === 'plus') setChapters({ action: 'increment' });
    else setChapters({ action: 'set', chapter: Math.max(0, state.entry.chapters_read - 1) });
  }

  function onProgressSubmit(event) {
    event.preventDefault();
    if (!state.entry) return;
    if (event.target.dataset.form === 'volumes') {
      const v = Number.parseInt(root.querySelector('#m-vol-input').value, 10);
      if (!Number.isInteger(v) || v < 0) { toast('Volumes must be a whole number (0 or more)', 'error'); return; }
      // the server turns volumes into chapters (and never lowers chapters you already read)
      setChapters({ action: 'volumes', volumes: v });
      return;
    }
    const n = Number.parseInt(root.querySelector('#m-ch-input').value, 10);
    if (!Number.isInteger(n) || n < 0) { toast('Type a chapter number (0 or more)', 'error'); return; }
    if (n === state.entry.chapters_read) return;
    setChapters({ action: 'set', chapter: n });
  }

  // While typing a volume number, show which chapter it means ("→ up to chapter 42")
  function onProgressInput(event) {
    if (event.target.id === 'm-vol-input') showVolumeHint();
  }

  /* ---------------------------------------------------------------- score + notes + dates */
  function drawJournal() {
    const e = state.entry;
    els.journal.hidden = !e;
    if (!e) { setHTML(els.journal, ''); return; }
    setHTML(els.journal, html`
      <div class="panel-head"><h2>My notes</h2><span class="save-ind" id="m-save-ind" aria-live="polite"></span></div>
      <div class="score-picker" role="group" aria-label="Your score" id="m-score"></div>
      <div class="journal-grid">
        <label class="field span-2"><span>Notes</span>
          <textarea data-field="notes" rows="5" maxlength="20000" placeholder="Favourite arc, theories, where you left off…">${e.notes || ''}</textarea>
        </label>
        <label class="field"><span>Started</span>
          <input type="date" data-field="started_on" value="${e.started_on || ''}">
        </label>
        <label class="field"><span>Finished</span>
          <input type="date" data-field="finished_on" value="${e.finished_on || ''}">
        </label>
      </div>`);
    drawScore();
  }

  function drawScore() {
    const holder = els.journal.querySelector('#m-score');
    if (!holder || !state.entry) return;
    const score = state.entry.score;
    setHTML(holder, html`
      <div class="score-head"><span class="label">Your score</span><span class="score-word">${score ? `${score}/10 · ${SCORE_WORDS[score]}` : 'Not scored'}</span></div>
      <span class="score-buttons">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`<button type="button" data-score="${n}"
        class="${score && n <= score ? 'filled' : ''} ${n === score ? 'selected' : ''}"
        aria-pressed="${n === score ? 'true' : 'false'}" title="${n} — ${SCORE_WORDS[n]}${n === score ? ' (click to clear)' : ''}">${n}</button>`)}</span>`);
  }

  function syncJournalValues() {
    if (!els.journal || !state.entry) return;
    els.journal.querySelectorAll('[data-field]').forEach((el) => {
      if (el === document.activeElement) return;
      const value = state.entry[el.dataset.field];
      el.value = value === null || value === undefined ? '' : String(value);
    });
    drawScore();
  }

  function showSaved(kind) {
    const ind = els.journal && els.journal.querySelector('#m-save-ind');
    if (!ind) return;
    ind.className = `save-ind show ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''}`;
    ind.textContent = kind === 'ok' ? 'Saved' : kind === 'err' ? 'Not saved' : 'Saving…';
    if (kind === 'ok') setTimeout(() => ind.classList.remove('show'), 1800);
  }

  async function onJournalClick(event) {
    const button = event.target.closest('[data-score]');
    if (!button || !state.entry) return;
    const n = Number(button.dataset.score);
    const next = state.entry.score === n ? null : n; // clicking your score again clears it
    try {
      const { entry } = await api.patchManga(id, { score: next });
      state.entry = entry;
      drawScore();
      toast(next ? `Scored ${next}/10 · ${SCORE_WORDS[next]}` : 'Score cleared', 'success', 2200);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function saveField(el) {
    if (!state.entry || !el.isConnected) return;
    const field = el.dataset.field;
    const value = field === 'notes' ? el.value : (el.value || null);
    if ((state.entry[field] ?? '') === (value ?? '')) return;
    showSaved('saving');
    try {
      const { entry } = await api.patchManga(id, { [field]: value });
      state.entry = entry;
      showSaved('ok');
    } catch (err) {
      showSaved('err');
      toast(err.message, 'error');
    }
  }

  function onJournalChange(event) {
    const el = event.target.closest('[data-field]');
    if (!el) return;
    if (el.dataset.field === 'notes') clearTimeout(notesTimer);
    saveField(el);
  }

  function onJournalInput(event) {
    const el = event.target.closest('[data-field="notes"]');
    if (!el) return;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => saveField(el), 1200); // save after a pause in typing
  }

  /* ---------------------------------------------------------------- anime adaptations */
  function drawAdaptations() {
    const list = state.adaptations;
    setHTML(els.adaptations, html`
      <div class="section-head"><h2>Anime adaptations</h2></div>
      ${list.length
        ? html`<div class="row-scroll">${list.map((a) => animeCard(
          { mal_id: a.mal_id, title: a.title, title_english: a.title_english, image: a.image, library_status: a.library_status },
          { subtitle: [ANIME_FORMATS[a.format] || a.format, a.year].filter(Boolean).join(' · ') },
        ))}</div>`
        : html`<p class="muted">No anime adaptation on AniList yet.</p>`}`);
  }

  /* ---------------------------------------------------------------- cleanup */
  return () => {
    if (notesTimer) {
      clearTimeout(notesTimer);
      const notes = els.journal && els.journal.querySelector('[data-field="notes"]');
      // Flush unsaved notes when leaving the page (fire and forget).
      if (notes && state.entry && notes.value !== (state.entry.notes || '')) {
        api.patchManga(id, { notes: notes.value }).catch((err) => toast(`Notes not saved: ${err.message}`, 'error'));
      }
    }
  };
}
