// Avatar rendering + the "Choose your avatar" picker modal.
import { api } from './api.js';
import { html, setHTML, imgUrl, toast, icon, prefersReducedMotion } from './ui.js';

const POPULAR_PAGES = 50;

export function initialOf(name) {
  const trimmed = String(name || '').trim();
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : '?';
}

/** Circular avatar: the character image, or the name's initial on an accent gradient. */
export function avatarHtml(avatar, displayName, extraClass = '') {
  const src = avatar ? imgUrl(avatar.image) : '';
  return html`<span class="avatar ${extraClass}" data-initial="${initialOf(displayName)}">${src
    ? html`<img class="fx-img" src="${src}" alt="" loading="lazy" decoding="async" draggable="false">`
    : ''}</span>`;
}

function skeletons(n = 12) {
  return html`${Array.from({ length: n }, () => html`<div class="avatar-option skeleton" aria-hidden="true"><span class="avatar shimmer"></span><span class="sk-line shimmer"></span></div>`)}`;
}

/**
 * Opens the picker. Saves through PATCH /api/me itself.
 * Resolves to the updated "me" object, or undefined when cancelled.
 *
 * `options` lets other features reuse the same picker (the buddy in Settings does):
 *   title       heading text
 *   startTab    'popular' | 'library' | 'search'
 *   removeLabel text of the "remove" button
 *   emptyLabel  footer text while nothing is selected
 *   onSave      async (character or null) => value; replaces the PATCH /api/me save,
 *               and the picker resolves to whatever it returns
 */
export function openAvatarPicker(current, options = {}) {
  return new Promise((resolve) => {
    const state = {
      tab: options.startTab || 'popular',
      page: 1,
      list: [],
      selected: current || null,     // Avatar object or null
      token: 0,
      controller: null,
      searchTimer: null,
      saving: false,
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    setHTML(overlay, html`<div class="modal avatar-modal" role="dialog" aria-modal="true" aria-labelledby="avatar-title">
      <div class="avatar-modal-head">
        <h3 id="avatar-title">${options.title || 'Choose your avatar'}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="avatar-modal-bar">
        <div class="tabs" role="tablist" aria-label="Avatar source">
          <button type="button" role="tab" data-tab="popular">Popular</button>
          <button type="button" role="tab" data-tab="library">From your shows</button>
          <button type="button" role="tab" data-tab="search">Search</button>
        </div>
        <div class="avatar-tools" id="av-tools"></div>
      </div>
      <div class="avatar-grid" id="av-grid" role="listbox" aria-label="Characters"></div>
      <div class="avatar-modal-foot">
        <div class="avatar-current" id="av-current"></div>
        <div class="avatar-foot-actions">
          ${current ? html`<button type="button" class="btn btn-ghost" data-remove>${options.removeLabel || 'Remove avatar'}</button>` : ''}
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-save disabled>Save</button>
        </div>
      </div>
    </div>`);

    const grid = overlay.querySelector('#av-grid');
    const tools = overlay.querySelector('#av-tools');
    const saveBtn = overlay.querySelector('[data-save]');
    const currentEl = overlay.querySelector('#av-current');
    const previousFocus = document.activeElement;
    let finished = false;

    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(state.searchTimer);
      if (state.controller) state.controller.abort();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onHash);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    }

    function sameAvatar(a, b) {
      return (a ? a.id : null) === (b ? b.id : null);
    }

    function drawFooter() {
      const sel = state.selected;
      setHTML(currentEl, sel
        ? html`${avatarHtml(sel, sel.name, 'avatar-sm')}<span><strong>${sel.name}</strong>${sel.anime ? html`<small>${sel.anime}</small>` : ''}</span>`
        : html`<span class="muted small">${options.emptyLabel || 'No avatar selected'}</span>`);
      saveBtn.disabled = state.saving || !state.selected || sameAvatar(state.selected, current);
    }

    function drawTabs() {
      overlay.querySelectorAll('[data-tab]').forEach((b) => {
        const active = b.dataset.tab === state.tab;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (state.tab === 'popular') {
        setHTML(tools, html`<span class="muted small" id="av-page">Page ${state.page}</span>
          <button type="button" class="btn btn-sm" data-shuffle><span class="shuffle-icon" aria-hidden="true"></span> Shuffle</button>`);
      } else if (state.tab === 'search') {
        setHTML(tools, html`<input type="search" id="av-q" placeholder="Search characters… e.g. Gojo" autocomplete="off" spellcheck="false" aria-label="Search characters">`);
        const input = tools.querySelector('#av-q');
        input.addEventListener('input', () => {
          clearTimeout(state.searchTimer);
          state.searchTimer = setTimeout(load, 400);
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(state.searchTimer); load(); } });
        input.focus();
      } else {
        setHTML(tools, '');
      }
    }

    function drawGrid() {
      if (!state.list.length) return;
      setHTML(grid, html`${state.list.map((a, i) => {
        const selected = state.selected && state.selected.id === a.id;
        return html`<button type="button" role="option" class="avatar-option ${selected ? 'selected' : ''}" data-i="${i}"
          aria-selected="${selected ? 'true' : 'false'}" title="${a.name}${a.anime ? ` — ${a.anime}` : ''}" style="--i:${Math.min(i, 23)}">
          <span class="avatar-option-pic">${avatarHtml(a, a.name)}<span class="avatar-check" aria-hidden="true">${icon('check')}</span></span>
          <span class="avatar-option-name">${a.name}</span>
          ${a.anime ? html`<span class="avatar-option-anime">${a.anime}</span>` : ''}
        </button>`;
      })}`);
    }

    function message(emoji, text) {
      setHTML(grid, html`<div class="avatar-message"><p>${text}</p></div>`);
    }

    async function load() {
      const token = ++state.token;
      if (state.controller) state.controller.abort();
      let params;
      if (state.tab === 'popular') params = { source: 'popular', page: state.page };
      else if (state.tab === 'library') params = { source: 'library' };
      else {
        const q = (tools.querySelector('#av-q') || {}).value || '';
        if (q.trim().length < 2) {
          state.list = [];
          message('', 'Type at least 2 characters to search, e.g. "Gojo" or "Frieren".');
          return;
        }
        params = { source: 'search', q: q.trim() };
      }
      state.controller = new AbortController();
      setHTML(grid, skeletons(state.tab === 'popular' ? 24 : 12));
      try {
        const data = await api.avatars(params, state.controller.signal);
        if (token !== state.token || finished) return;
        state.list = Array.isArray(data.characters) ? data.characters.filter((a) => a && a.id && a.name) : [];
        if (!state.list.length) {
          if (state.tab === 'library') message('', 'Add some anime to pick characters from your shows.');
          else if (state.tab === 'search') message('', 'No characters found. Try another name.');
          else message('', 'No characters on this page. Try Shuffle.');
          return;
        }
        drawGrid();
      } catch (err) {
        if (err.name === 'AbortError' || token !== state.token || finished) return;
        state.list = [];
        setHTML(grid, html`<div class="avatar-message"><p>${err.status === 404 ? 'Avatars are still being set up — try again in a moment.' : err.message}</p>
          <button type="button" class="btn btn-sm" data-retry>Try again</button></div>`);
      }
    }

    async function save(avatar) {
      if (state.saving) return;
      state.saving = true;
      drawFooter();
      overlay.querySelectorAll('[data-remove], [data-save]').forEach((b) => { b.disabled = true; });
      try {
        if (options.onSave) { finish(await options.onSave(avatar)); return; }
        const me = await api.patchMe({ avatar });
        toast(avatar ? `Avatar set to ${avatar.name}` : 'Avatar removed', 'success');
        finish(me);
      } catch (err) {
        toast(err.message, 'error');
        state.saving = false;
        overlay.querySelectorAll('[data-remove]').forEach((b) => { b.disabled = false; });
        drawFooter();
      }
    }

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-close]')) { finish(undefined); return; }
      const tab = event.target.closest('[data-tab]');
      if (tab && tab.dataset.tab !== state.tab) {
        state.tab = tab.dataset.tab;
        state.list = [];
        drawTabs();
        load();
        return;
      }
      if (event.target.closest('[data-shuffle]')) {
        let next = state.page;
        while (next === state.page) next = 1 + Math.floor(Math.random() * POPULAR_PAGES);
        state.page = next;
        const pageEl = tools.querySelector('#av-page');
        if (pageEl) pageEl.textContent = `Page ${state.page}`;
        const dice = tools.querySelector('.shuffle-icon');
        if (dice && !prefersReducedMotion()) {
          dice.classList.remove('spin-once');
          void dice.offsetWidth;
          dice.classList.add('spin-once');
        }
        load();
        return;
      }
      if (event.target.closest('[data-retry]')) { load(); return; }
      const option = event.target.closest('.avatar-option[data-i]');
      if (option) {
        state.selected = state.list[Number(option.dataset.i)];
        grid.querySelectorAll('.avatar-option').forEach((o) => {
          const on = o === option;
          o.classList.toggle('selected', on);
          o.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        drawFooter();
        return;
      }
      if (event.target.closest('[data-save]') && state.selected) { save(state.selected); return; }
      if (event.target.closest('[data-remove]')) save(null);
    });

    overlay.addEventListener('dblclick', (event) => {
      const option = event.target.closest('.avatar-option[data-i]');
      if (option && state.selected) save(state.selected);
    });

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(undefined);
      }
    };
    const onHash = () => finish(undefined);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', onHash);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    drawTabs();
    drawFooter();
    load();
    const first = overlay.querySelector(`[data-tab="${state.tab}"]`);
    if (first) first.focus();
  });
}
