// Small editors for the profile page: banner picker, Top 5 editor and badge showcase editor.
// Each one opens a modal, saves through PATCH /api/me itself and resolves to the updated
// "me" object (or undefined when the user cancels).
import { api } from './api.js';
import { html, setHTML, imgUrl, toast, icon, coverHtml, displayTitle } from './ui.js';

const TOP5_MAX = 5;
const SHOWCASE_MAX = 3;

/**
 * A generic modal "sheet". `setup(sheet, close)` fills it and wires the events.
 * Returns a Promise that resolves with whatever is passed to close().
 */
function openSheet({ title, className = '', setup }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    setHTML(overlay, html`<div class="modal pfe-modal ${className}" role="dialog" aria-modal="true" aria-labelledby="pfe-title">
      <div class="pfe-head">
        <h3 id="pfe-title">${title}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="pfe-body"></div>
      <div class="pfe-foot"></div>
    </div>`);

    const previousFocus = document.activeElement;
    let finished = false;
    function close(value) {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onHash);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(undefined);
      }
    };
    const onHash = () => close(undefined);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-close]')) close(undefined);
    });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    setup(overlay.querySelector('.pfe-modal'), close);
    const firstButton = overlay.querySelector('.pfe-body button, .pfe-body input');
    (firstButton || overlay.querySelector('[data-close]')).focus();
  });
}

/** Saves a profile change, shows a toast, and returns the new "me" (or null on error). */
async function saveMe(fields, message) {
  try {
    const me = await api.patchMe(fields);
    toast(message, 'success', 2200);
    return me;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

/* ===================================================================== banner */
export function openBannerPicker(me) {
  const current = me && me.banner ? me.banner : null;
  return openSheet({
    title: 'Choose a banner',
    className: 'pfe-wide',
    setup(sheet, close) {
      const body = sheet.querySelector('.pfe-body');
      const foot = sheet.querySelector('.pfe-foot');
      let choices = [];
      let unchecked = 0;
      let selected = current ? current.mal_id : null;
      let saving = false;

      function drawFoot() {
        const changed = selected !== null && (!current || selected !== current.mal_id);
        setHTML(foot, html`
          ${current ? html`<button type="button" class="btn btn-ghost" data-remove>Remove banner</button>` : ''}
          <span class="pfe-spacer"></span>
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-save ${changed && !saving ? '' : 'disabled'}>Save</button>`);
      }

      function drawGrid() {
        if (!choices.length) {
          setHTML(body, html`<div class="pfe-empty">
            <p>${unchecked
              ? 'None of the shows checked so far have an AniList banner.'
              : 'None of the shows in your library have an AniList banner yet. Add a few more and try again.'}</p>
            ${unchecked ? html`<button type="button" class="btn btn-sm" data-more>Check ${unchecked} more</button>` : ''}
          </div>`);
          return;
        }
        setHTML(body, html`
          <div class="pfe-banner-grid" role="listbox" aria-label="Banners">
            ${choices.map((c, i) => html`<button type="button" role="option" class="pfe-banner-option ${c.mal_id === selected ? 'selected' : ''}"
                data-i="${i}" aria-selected="${c.mal_id === selected ? 'true' : 'false'}">
              <span class="pfe-banner-pic"><img src="${imgUrl(c.image)}" alt="" loading="lazy" decoding="async" draggable="false"></span>
              <span class="pfe-banner-name">${displayTitle(c)}</span>
            </button>`)}
          </div>
          ${unchecked ? html`<p class="pfe-note">${unchecked} more ${unchecked === 1 ? 'show hasn\'t' : 'shows haven\'t'} been checked yet.
            <button type="button" class="btn btn-sm" data-more>Check more</button></p>` : ''}`);
      }

      async function load() {
        setHTML(body, html`<div class="pfe-banner-grid">${[0, 1, 2, 3].map(() => html`<div class="pfe-banner-option"><span class="pfe-banner-pic shimmer"></span></div>`)}</div>`);
        try {
          const data = await api.meBanners();
          choices = Array.isArray(data.choices) ? data.choices : [];
          unchecked = Number(data.unchecked) || 0;
          drawGrid();
        } catch (err) {
          setHTML(body, html`<div class="pfe-empty"><p>${err.message}</p><button type="button" class="btn btn-sm" data-more>Try again</button></div>`);
        }
      }

      async function save(banner, message) {
        if (saving) return;
        saving = true;
        drawFoot();
        const updated = await saveMe({ banner }, message);
        saving = false;
        if (updated) close(updated);
        else drawFoot();
      }

      sheet.addEventListener('click', (event) => {
        const option = event.target.closest('.pfe-banner-option[data-i]');
        if (option) {
          selected = choices[Number(option.dataset.i)].mal_id;
          body.querySelectorAll('.pfe-banner-option').forEach((o) => {
            const on = o === option;
            o.classList.toggle('selected', on);
            o.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          drawFoot();
          return;
        }
        if (event.target.closest('[data-more]')) { load(); return; }
        if (event.target.closest('[data-remove]')) { save(null, 'Banner removed'); return; }
        if (event.target.closest('[data-save]')) {
          const choice = choices.find((c) => c.mal_id === selected);
          if (!choice) return;
          // A new banner starts centred; the user can adjust it on the profile afterwards.
          save({ mal_id: choice.mal_id, image: choice.image, position_y: 50, color: choice.color || null }, 'Banner saved');
        }
      });
      sheet.addEventListener('dblclick', (event) => {
        if (event.target.closest('.pfe-banner-option[data-i]')) {
          const saveBtn = foot.querySelector('[data-save]');
          if (saveBtn && !saveBtn.disabled) saveBtn.click();
        }
      });

      drawFoot();
      load();
    },
  });
}

/* ===================================================================== Top 5 */
export function openTop5Editor(me, library) {
  const entries = Array.isArray(library) ? library : [];
  const byId = new Map(entries.map((e) => [e.mal_id, e]));
  // Start from the saved list, skipping anime that have left the library since.
  const startIds = ((me && me.top5) || []).filter((id) => byId.has(id));

  return openSheet({
    title: 'Edit your Top 5',
    className: 'pfe-wide',
    setup(sheet, close) {
      const body = sheet.querySelector('.pfe-body');
      const foot = sheet.querySelector('.pfe-foot');
      let picks = [...startIds];
      let query = '';
      let saving = false;

      setHTML(body, html`
        <ol class="pfe-picks" id="pfe-picks"></ol>
        <div class="pfe-search">
          <input type="search" id="pfe-q" placeholder="Search your library…" autocomplete="off" spellcheck="false" aria-label="Search your library">
        </div>
        <div class="pfe-lib" id="pfe-lib"></div>`);
      const picksEl = body.querySelector('#pfe-picks');
      const libEl = body.querySelector('#pfe-lib');

      function drawPicks() {
        const rows = picks.map((id, i) => {
          const entry = byId.get(id);
          const title = displayTitle(entry.meta);
          return html`<li class="pfe-pick">
            <span class="pfe-rank">${i + 1}</span>
            ${coverHtml(entry.meta.image, title, 'pfe-pick-cover')}
            <span class="pfe-pick-title">${title}</span>
            <span class="pfe-pick-tools">
              <button type="button" class="btn btn-sm btn-ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${title} up">Up</button>
              <button type="button" class="btn btn-sm btn-ghost" data-down="${i}" ${i === picks.length - 1 ? 'disabled' : ''} aria-label="Move ${title} down">Down</button>
              <button type="button" class="btn btn-sm btn-ghost" data-drop="${i}" aria-label="Remove ${title}">Remove</button>
            </span>
          </li>`;
        });
        // Empty slots keep their frame, so it's clear how many are left.
        for (let i = picks.length; i < TOP5_MAX; i += 1) {
          rows.push(html`<li class="pfe-pick empty"><span class="pfe-rank">${i + 1}</span><span class="faint">Pick a series below</span></li>`);
        }
        setHTML(picksEl, html`${rows}`);
      }

      function drawLibrary() {
        const q = query.trim().toLowerCase();
        const pool = entries.filter((e) => {
          if (picks.includes(e.mal_id)) return false;
          if (!q) return true;
          const titles = `${e.meta.title || ''} ${e.meta.title_english || ''}`.toLowerCase();
          return titles.includes(q);
        });
        if (!entries.length) {
          setHTML(libEl, html`<p class="pfe-note">Your library is empty. Add some anime first.</p>`);
          return;
        }
        if (!pool.length) {
          setHTML(libEl, html`<p class="pfe-note">No matches.</p>`);
          return;
        }
        const full = picks.length >= TOP5_MAX;
        // Cap how many we draw at once; searching narrows it down.
        setHTML(libEl, html`${pool.slice(0, 60).map((e) => html`<button type="button" class="pfe-lib-item" data-add="${e.mal_id}" ${full ? 'disabled' : ''}>
          ${coverHtml(e.meta.image, displayTitle(e.meta), 'pfe-lib-cover')}
          <span>${displayTitle(e.meta)}</span>
        </button>`)}`);
      }

      function drawFoot() {
        const changed = picks.join(',') !== ((me && me.top5) || []).join(',');
        setHTML(foot, html`<span class="pfe-note">${picks.length} of ${TOP5_MAX} picked</span>
          <span class="pfe-spacer"></span>
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-save ${changed && !saving ? '' : 'disabled'}>Save</button>`);
      }

      function redraw() {
        drawPicks();
        drawLibrary();
        drawFoot();
      }

      // Swap two places in the list (used by Up and Down).
      function swap(a, b) {
        const temp = picks[a];
        picks[a] = picks[b];
        picks[b] = temp;
      }

      sheet.addEventListener('click', async (event) => {
        const t = event.target;
        const add = t.closest('[data-add]');
        if (add && picks.length < TOP5_MAX) { picks.push(Number(add.dataset.add)); redraw(); return; }
        const up = t.closest('[data-up]');
        if (up) { const i = Number(up.dataset.up); if (i > 0) swap(i, i - 1); redraw(); return; }
        const down = t.closest('[data-down]');
        if (down) { const i = Number(down.dataset.down); if (i < picks.length - 1) swap(i, i + 1); redraw(); return; }
        const drop = t.closest('[data-drop]');
        if (drop) { picks.splice(Number(drop.dataset.drop), 1); redraw(); return; }
        if (t.closest('[data-save]') && !saving) {
          saving = true;
          drawFoot();
          const updated = await saveMe({ top5: picks }, 'Top 5 saved');
          saving = false;
          if (updated) close(updated);
          else drawFoot();
        }
      });
      body.querySelector('#pfe-q').addEventListener('input', (event) => {
        query = event.target.value;
        drawLibrary();
      });

      redraw();
    },
  });
}

/* ===================================================================== badge showcase */
export function openShowcaseEditor(me, badges) {
  const earned = (Array.isArray(badges) ? badges : []).filter((b) => b && b.earned);
  const known = new Set(earned.map((b) => b.id));
  const startIds = ((me && me.showcase) || []).filter((id) => known.has(id));

  return openSheet({
    title: 'Feature your badges',
    setup(sheet, close) {
      const body = sheet.querySelector('.pfe-body');
      const foot = sheet.querySelector('.pfe-foot');
      let picks = [...startIds];
      let saving = false;

      function draw() {
        if (!earned.length) {
          setHTML(body, html`<p class="pfe-note">Unlock a badge first, then you can feature it here.</p>`);
        } else {
          const full = picks.length >= SHOWCASE_MAX;
          setHTML(body, html`<p class="pfe-note">Pick up to ${SHOWCASE_MAX}. They show at the top of your profile in the order you pick them.</p>
            <div class="pfe-badges">${earned.map((b) => {
              const place = picks.indexOf(b.id);
              const on = place !== -1;
              return html`<button type="button" class="pfe-badge ${on ? 'selected' : ''}" data-badge="${b.id}" aria-pressed="${on ? 'true' : 'false'}"
                ${!on && full ? 'disabled' : ''}>
                <span class="pfe-badge-place">${on ? place + 1 : ''}</span>
                <span><strong>${b.name}</strong><small>${b.description || ''}</small></span>
              </button>`;
            })}</div>`);
        }
        const changed = picks.join(',') !== ((me && me.showcase) || []).join(',');
        setHTML(foot, html`<span class="pfe-note">${picks.length} of ${SHOWCASE_MAX} featured</span>
          <span class="pfe-spacer"></span>
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-save ${changed && !saving ? '' : 'disabled'}>Save</button>`);
      }

      sheet.addEventListener('click', async (event) => {
        const badge = event.target.closest('[data-badge]');
        if (badge) {
          const id = badge.dataset.badge;
          if (picks.includes(id)) picks = picks.filter((p) => p !== id);
          else if (picks.length < SHOWCASE_MAX) picks.push(id);
          draw();
          const again = sheet.querySelector(`[data-badge="${CSS.escape(id)}"]`);
          if (again) again.focus();
          return;
        }
        if (event.target.closest('[data-save]') && !saving) {
          saving = true;
          draw();
          const updated = await saveMe({ showcase: picks }, 'Showcase saved');
          saving = false;
          if (updated) close(updated);
          else draw();
        }
      });

      draw();
    },
  });
}
