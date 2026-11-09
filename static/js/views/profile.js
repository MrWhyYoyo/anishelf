import { api } from '../api.js';
import {
  html, setHTML, errorBox, fmtNumber, countUp, imgUrl, toast, coverHtml, displayTitle, setAccent,
} from '../ui.js';
import { avatarHtml, openAvatarPicker } from '../avatar.js';
import { openBannerPicker, openTop5Editor, openShowcaseEditor } from '../profile-editors.js';
import { downloadProfileCard } from '../profile-card.js';

function levelCard(p) {
  const pct = Math.min(1, Math.max(0, Number(p.progress) || 0));
  const hasNext = typeof p.next_level_xp === 'number';
  const toNext = hasNext ? Math.max(0, p.next_level_xp - p.xp) : 0;
  const levelSpan = hasNext ? Math.max(1, p.next_level_xp - p.level_xp) : 1;
  const intoLevel = hasNext ? Math.max(0, p.xp - p.level_xp) : 0;
  return html`<section class="level-card">
    <div class="level-ring" aria-hidden="true">
      <svg viewBox="0 0 112 112"><circle class="lr-bg" cx="56" cy="56" r="52"></circle>
        <circle class="lr-fg" cx="56" cy="56" r="52" stroke-dasharray="${(2 * Math.PI * 52).toFixed(2)}" stroke-dashoffset="${(2 * Math.PI * 52 * (1 - pct)).toFixed(2)}"></circle></svg>
      <div class="level-ring-inner"><small>Level</small><span>${p.level}</span></div>
    </div>
    <div class="level-card-info">
      <h2 class="level-card-title">${p.title}</h2>
      <p class="level-total"><span data-count="${Number(p.xp) || 0}">${fmtNumber(p.xp)}</span> XP total</p>
      <div class="level-card-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"
        aria-label="Progress to the next level"><span style="width:${(pct * 100).toFixed(1)}%"></span></div>
      <div class="level-card-meta">
        ${hasNext
          ? html`<span><strong>${fmtNumber(toNext)} XP</strong> to level ${p.level + 1}</span><span class="faint">${fmtNumber(intoLevel)} / ${fmtNumber(levelSpan)}</span>`
          : html`<span><strong>Max level reached.</strong></span>`}
      </div>
      ${p.next_title ? html`<p class="level-next">Next title: <strong>${p.next_title.title}</strong> at level ${p.next_title.level}</p>` : ''}
    </div>
  </section>`;
}

function breakdown(items) {
  const list = Array.isArray(items) ? items.filter((b) => b && b.xp) : [];
  if (!list.length) return html`<p class="muted">Watch episodes, finish shows and rank your favourites to earn XP.</p>`;
  const total = list.reduce((sum, b) => sum + b.xp, 0) || 1;
  return html`<div class="xp-list">${list.map((b, i) => html`<div class="xp-row" style="--i:${i}">
    <div class="xp-row-top"><span>${b.label}</span><strong>${fmtNumber(b.xp)} XP</strong></div>
    <div class="xp-row-bar"><span style="width:${((b.xp / total) * 100).toFixed(1)}%"></span></div>
  </div>`)}</div>`;
}

function badgeGrid(badges) {
  const list = Array.isArray(badges) ? badges : [];
  if (!list.length) return html`<p class="muted">No badges yet.</p>`;
  const sorted = [...list].sort((a, b) => Number(b.earned) - Number(a.earned));
  return html`<div class="badge-grid">${sorted.map((b, i) => {
    const goal = Number(b.goal) || 0;
    const progress = Math.min(goal || 0, Number(b.progress) || 0);
    const pct = goal ? (progress / goal) * 100 : 0;
    return html`<div class="badge-card ${b.earned ? 'earned' : 'locked'}" style="--i:${Math.min(i, 20)}" title="${b.description || ''}">
      <strong class="badge-name">${b.name}</strong>
      <p class="badge-desc">${b.description || ''}</p>
      ${b.earned
        ? html`<span class="badge-earned">Unlocked</span>`
        : html`<div class="badge-progress"><span style="width:${pct.toFixed(1)}%"></span></div>
          <span class="badge-count">${fmtNumber(progress)} / ${fmtNumber(goal)}</span>`}
    </div>`;
  })}</div>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function memberSince(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `Member since ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ------------------------------------------------------------------ profile 1.1 pieces */

/** Up to two initials for a name ("Levi Ackerman" -> "LA"), used when there's no portrait. */
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('');
}

/** The featured badges, in the user's order. Unknown or no-longer-earned ids are skipped. */
function featuredBadges(me, level) {
  if (!me || !level || !Array.isArray(me.showcase) || !Array.isArray(level.badges)) return [];
  const out = [];
  for (const id of me.showcase) {
    const badge = level.badges.find((b) => b.id === id && b.earned);
    if (badge) out.push(badge);
  }
  return out;
}

/** The Top 5 as library entries, skipping anime that have left the library. */
function top5Entries(me, library) {
  if (!me || !Array.isArray(me.top5) || !Array.isArray(library)) return [];
  const out = [];
  for (const id of me.top5) {
    const entry = library.find((e) => e.mal_id === id);
    if (entry) out.push(entry);
  }
  return out;
}

function top5Shelf(me, library) {
  if (!Array.isArray(library)) {
    return html`<ol class="t5-shelf">${[1, 2, 3, 4, 5].map(() => html`<li class="t5-slot"><div class="cover shimmer"></div></li>`)}</ol>`;
  }
  const entries = top5Entries(me, library);
  const slots = [];
  for (let i = 0; i < 5; i += 1) {
    const entry = entries[i];
    if (entry) {
      const title = displayTitle(entry.meta);
      slots.push(html`<li class="t5-slot">
        <a class="t5-link" href="#/anime/${entry.mal_id}" title="${title}">
          ${coverHtml(entry.meta.image, title, 't5-cover', html`<span class="t5-rank">${i + 1}</span>`)}
          <span class="t5-title">${title}</span>
        </a>
      </li>`);
    } else {
      // empty slots keep their frame (honest empty state)
      slots.push(html`<li class="t5-slot">
        <button type="button" class="t5-empty" data-top5 aria-label="Pick series number ${i + 1}">
          <span class="t5-rank">${i + 1}</span><span class="t5-add">Add</span>
        </button>
      </li>`);
    }
  }
  return html`<ol class="t5-shelf">${slots}</ol>`;
}

function favWall(data) {
  if (!data) {
    return html`<div class="fc-grid">${[1, 2, 3, 4].map(() => html`<div class="fc-card"><span class="avatar fc-pic shimmer"></span><span class="sk-line shimmer"></span></div>`)}</div>`;
  }
  const cards = Array.isArray(data.characters) ? data.characters : [];
  if (!cards.length) {
    return html`<p class="muted">Open an anime and tap the ♥ next to a character in its Cast to add them here.</p>`;
  }
  const pending = Number(data.pending) || 0;
  return html`<div class="fc-grid">${cards.map((c) => {
    const src = c.image ? imgUrl(c.image) : '';
    const title = displayTitle(c);
    return html`<a class="fc-card" href="#/anime/${c.mal_id}" title="${c.matched_name || c.character} · ${title}">
      <span class="avatar fc-pic" data-initial="${initialsOf(c.character)}">${src
        ? html`<img class="fx-img" src="${src}" alt="" loading="lazy" decoding="async" draggable="false">`
        : ''}</span>
      <span class="fc-name">${c.character}</span>
      <span class="fc-anime">${title}</span>
    </a>`;
  })}</div>
  ${pending ? html`<p class="faint small fc-pending">${pending} more ${pending === 1 ? 'portrait loads' : 'portraits load'} next time you open this page.</p>` : ''}`;
}

export function render(root) {
  setHTML(root, html`
    <section class="pf-header" id="pf-header"><div class="pf-inner"><span class="avatar avatar-xl shimmer"></span></div></section>
    <section class="panel pf-top5" id="pf-top5"></section>
    <div id="profile-body"><div class="level-card shimmer" style="min-height:200px"></div></div>
    <section class="panel pf-favs" id="pf-favs"></section>
  `);
  const body = root.querySelector('#profile-body');
  const header = root.querySelector('#pf-header');
  const top5Panel = root.querySelector('#pf-top5');
  const favPanel = root.querySelector('#pf-favs');
  let me = null;
  let level = null;    // latest /api/profile
  let library = null;  // latest /api/library entries (for the Top 5)
  let favs = null;     // latest /api/me/fav-characters
  let editing = null;  // 'name' | 'bio' | null
  let adjustY = null;  // banner position while adjusting, or null when not adjusting
  let drag = null;     // {startY, startPos, overflow} while the banner is being dragged
  let busyCard = false;

  /* -------------------------------------------------------------- header */
  function drawHeader() {
    if (!me) return;
    const name = me.display_name || 'You';
    const avatar = me.avatar || null;
    const banner = me.banner || null;
    const since = memberSince(me.member_since);
    const featured = featuredBadges(me, level);
    const hasEarned = Boolean(level && (level.badges || []).some((b) => b.earned));
    const adjusting = adjustY !== null && Boolean(banner);
    let posY = 50;
    if (adjusting) posY = adjustY;
    else if (banner && typeof banner.position_y === 'number') posY = banner.position_y;

    // The profile's data hue comes from the banner anime (vermilion when there's none).
    setAccent(banner ? banner.color : null);
    header.classList.toggle('has-banner', Boolean(banner));

    setHTML(header, html`
      ${banner ? html`<div class="pf-banner ${adjusting ? 'adjusting' : ''}" id="pf-banner">
        <img class="pf-banner-img" src="${imgUrl(banner.image)}" alt="" draggable="false" style="object-position: 50% ${posY}%">
        <div class="pf-scrim"></div>
        ${adjusting ? html`<p class="pf-adjust-hint">Drag the picture up or down</p>` : ''}
      </div>` : ''}
      <div class="pf-inner">
        <button type="button" class="pf-avatar-btn" data-pick aria-label="Change avatar" title="Change avatar">
          ${avatarHtml(avatar, name, 'avatar-xl')}
          <span class="pf-edit" aria-hidden="true"></span>
          ${level ? html`<span class="pf-level-chip" title="Level ${level.level}">Lv ${level.level}</span>` : ''}
        </button>
        <div class="pf-text">
          ${editing === 'name'
            ? html`<input class="pf-name-input" id="pf-name-input" maxlength="40" value="${name}" aria-label="Display name">`
            : html`<h1 class="pf-h1"><button type="button" class="pf-name" data-edit="name" title="Click to rename">${name}<span class="pf-pencil" aria-hidden="true"></span></button></h1>`}
          ${level ? html`<p class="pf-title">${level.title} · Level ${level.level}</p>` : ''}
          ${editing === 'bio'
            ? html`<textarea class="pf-bio-input" id="pf-bio-input" maxlength="200" rows="2" placeholder="A line about you…" aria-label="Bio">${me.bio || ''}</textarea>`
            : html`<button type="button" class="pf-bio ${me.bio ? '' : 'empty'}" data-edit="bio">${me.bio || 'Add a short bio…'}</button>`}
          ${featured.length || hasEarned ? html`<div class="pf-showcase">
            ${featured.map((b) => html`<span class="pf-feature" title="${b.description || ''}">${b.name}</span>`)}
            <button type="button" class="pf-link" data-showcase>${featured.length ? 'Edit showcase' : 'Feature badges'}</button>
          </div>` : ''}
          <div class="pf-meta">
            ${since ? html`<span>${since}</span>` : ''}
            ${!avatar ? html`<button type="button" class="pf-pick-prompt" data-pick>Pick an avatar</button>` : ''}
          </div>
        </div>
        <div class="pf-actions">
          ${adjusting
            ? html`<label class="pf-slider">Position
                <input type="range" id="pf-pos" min="0" max="100" step="1" value="${Math.round(posY)}" aria-label="Banner position, top to bottom">
              </label>
              <button type="button" class="btn btn-ghost" data-adjust-cancel>Cancel</button>
              <button type="button" class="btn btn-primary" data-adjust-save>Save position</button>`
            : html`<button type="button" class="btn btn-primary" data-card ${busyCard ? 'disabled' : ''}>${busyCard ? 'Drawing…' : 'Download card'}</button>
              <button type="button" class="btn" data-banner>${banner ? 'Change banner' : 'Add banner'}</button>
              ${banner ? html`<button type="button" class="btn btn-ghost" data-adjust>Adjust</button>` : ''}`}
        </div>
      </div>`);

    if (editing) {
      const input = header.querySelector(editing === 'name' ? '#pf-name-input' : '#pf-bio-input');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  function drawTop5() {
    const count = top5Entries(me, library).length;
    const hasLibrary = Array.isArray(library) && library.length > 0;
    setHTML(top5Panel, html`
      <div class="panel-head"><h2>Top 5</h2>
        ${hasLibrary && me ? html`<button type="button" class="btn btn-sm" data-top5>${count ? 'Edit' : 'Pick your Top 5'}</button>` : ''}
      </div>
      ${Array.isArray(library) && !library.length
        ? html`<p class="muted">Add anime to your library, then pin your five favourites here.</p>`
        : top5Shelf(me, library)}`);
  }

  function drawFavs() {
    const count = favs && Array.isArray(favs.characters) ? favs.characters.length : 0;
    setHTML(favPanel, html`
      <div class="panel-head"><h2>Favourite characters</h2>${favs ? html`<span class="muted small">${count}</span>` : ''}</div>
      ${favWall(favs)}`);
  }

  async function saveField(field, rawValue) {
    const value = rawValue.trim();
    editing = null;
    if (field === 'display_name' && (value.length < 1 || value.length > 40)) {
      toast('Display name must be 1–40 characters', 'error');
      drawHeader();
      return;
    }
    if ((me[field] || '') === value) { drawHeader(); return; }
    try {
      me = await api.patchMe({ [field]: value });
      toast(field === 'bio' ? 'Bio saved' : `Hi, ${me.display_name}!`, 'success', 2200);
    } catch (err) {
      toast(err.message, 'error');
    }
    if (header.isConnected) drawHeader();
  }

  /** Called after an editor saved: keep the new "me" and repaint what depends on it. */
  function applyMe(updated) {
    if (!updated || !header.isConnected) return;
    me = updated;
    drawHeader();
    drawTop5();
  }

  /* -------------------------------------------------------------- banner position */
  function setBannerPos(value) {
    adjustY = Math.min(100, Math.max(0, value));
    const img = header.querySelector('.pf-banner-img');
    if (img) img.style.objectPosition = `50% ${adjustY}%`;
    const slider = header.querySelector('#pf-pos');
    if (slider) slider.value = String(Math.round(adjustY));
  }

  async function saveBannerPos() {
    if (!me || !me.banner || adjustY === null) return;
    const banner = { ...me.banner, position_y: Math.round(adjustY * 10) / 10 };
    adjustY = null;
    try {
      me = await api.patchMe({ banner });
      toast('Banner position saved', 'success', 2200);
    } catch (err) {
      toast(err.message, 'error');
    }
    if (header.isConnected) drawHeader();
  }

  header.addEventListener('pointerdown', (event) => {
    const bannerEl = event.target.closest('#pf-banner.adjusting');
    if (!bannerEl) return;
    const img = bannerEl.querySelector('.pf-banner-img');
    if (!img || !img.naturalWidth) return;
    // How many pixels of the picture are hidden (above + below). Dragging over that
    // distance moves object-position all the way from 0% to 100%.
    const shownHeight = bannerEl.clientWidth * (img.naturalHeight / img.naturalWidth);
    const overflow = Math.max(1, shownHeight - bannerEl.clientHeight);
    drag = { startY: event.clientY, startPos: adjustY, overflow };
    bannerEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    // Dragging down shows more of the top of the picture, so the position goes down.
    setBannerPos(drag.startPos - (dy / drag.overflow) * 100);
  });
  const endDrag = () => { drag = null; };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  header.addEventListener('input', (event) => {
    if (event.target.id === 'pf-pos') setBannerPos(Number(event.target.value));
  });

  /* -------------------------------------------------------------- card */
  async function downloadCard() {
    if (busyCard || !me) return;
    busyCard = true;
    drawHeader();
    try {
      const stats = await api.stats();
      const freshLevel = level || await api.profile();
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff5a36';
      await downloadProfileCard({ me, level: freshLevel, stats, top5: top5Entries(me, library), accent });
      toast('Profile card downloaded', 'success', 2200);
    } catch (err) {
      toast(err.message || "Couldn't make the card", 'error');
    }
    busyCard = false;
    if (header.isConnected && !headerBusy()) drawHeader();
  }

  /* -------------------------------------------------------------- clicks */
  header.addEventListener('click', async (event) => {
    const t = event.target;
    if (t.closest('[data-pick]')) {
      applyMe(await openAvatarPicker(me && me.avatar));
      return;
    }
    if (t.closest('[data-card]')) { downloadCard(); return; }
    if (t.closest('[data-banner]')) { applyMe(await openBannerPicker(me)); return; }
    if (t.closest('[data-adjust]')) {
      adjustY = me && me.banner && typeof me.banner.position_y === 'number' ? me.banner.position_y : 50;
      drawHeader();
      const slider = header.querySelector('#pf-pos');
      if (slider) slider.focus();
      return;
    }
    if (t.closest('[data-adjust-cancel]')) { adjustY = null; drawHeader(); return; }
    if (t.closest('[data-adjust-save]')) { saveBannerPos(); return; }
    if (t.closest('[data-showcase]')) {
      applyMe(await openShowcaseEditor(me, level && level.badges));
      return;
    }
    const edit = t.closest('[data-edit]');
    if (edit) {
      editing = edit.dataset.edit;
      drawHeader();
    }
  });
  top5Panel.addEventListener('click', async (event) => {
    if (event.target.closest('[data-top5]') && me && Array.isArray(library)) {
      applyMe(await openTop5Editor(me, library));
    }
  });
  header.addEventListener('keydown', (event) => {
    const t = event.target;
    if (adjustY !== null && event.key === 'Escape') {
      event.preventDefault();
      adjustY = null;
      drawHeader();
      return;
    }
    if (event.key === 'Enter' && (t.id === 'pf-name-input' || (t.id === 'pf-bio-input' && !event.shiftKey))) {
      event.preventDefault();
      t.dataset.done = '1'; // the later focusout must not save a second time
      saveField(t.id === 'pf-name-input' ? 'display_name' : 'bio', t.value);
      return;
    }
    if ((t.id === 'pf-name-input' || t.id === 'pf-bio-input') && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      editing = null;
      t.dataset.cancelled = '1';
      drawHeader();
    }
  });
  header.addEventListener('focusout', (event) => {
    const t = event.target;
    if (!t.dataset || t.dataset.cancelled || t.dataset.done) return;
    t.dataset.done = '1';
    if (t.id === 'pf-name-input') saveField('display_name', t.value);
    else if (t.id === 'pf-bio-input') saveField('bio', t.value);
  });

  /* -------------------------------------------------------------- loading */
  // While the user is typing or adjusting the banner, a background refresh must not redraw the header.
  function headerBusy() {
    return Boolean(editing) || adjustY !== null;
  }

  async function loadMe() {
    try {
      me = await api.me();
      if (header.isConnected && !headerBusy()) drawHeader();
      if (top5Panel.isConnected) drawTop5();
    } catch (err) {
      if (!header.isConnected) return;
      if (err.status === 404) { header.hidden = true; return; }
      setHTML(header, html`<div class="pf-inner"><p class="muted">Couldn't load your profile (${err.message}).</p></div>`);
    }
  }

  async function loadLibrary() {
    try {
      const data = await api.library();
      library = Array.isArray(data.entries) ? data.entries : [];
    } catch {
      library = [];
    }
    if (top5Panel.isConnected) drawTop5();
  }

  async function loadFavs() {
    try {
      favs = await api.meFavCharacters();
    } catch (err) {
      if (!favPanel.isConnected) return;
      setHTML(favPanel, html`<div class="panel-head"><h2>Favourite characters</h2></div><p class="muted">${err.message}</p>`);
      return;
    }
    if (favPanel.isConnected) drawFavs();
  }

  function draw(p) {
    level = p;
    if (me && !headerBusy()) drawHeader();
    const earned = (p.badges || []).filter((b) => b.earned).length;
    setHTML(body, html`
      <div class="profile-grid">
        ${levelCard(p)}
        <section class="panel">
          <div class="panel-head"><h2>Where your XP comes from</h2></div>
          ${breakdown(p.breakdown)}
        </section>
      </div>
      <section class="panel badges-panel">
        <div class="panel-head"><h2>Badges</h2><span class="muted small">${earned} of ${(p.badges || []).length} unlocked</span></div>
        ${badgeGrid(p.badges)}
      </section>
    `);
    const total = body.querySelector('[data-count]');
    if (total) countUp(total, Number(total.dataset.count));
  }

  async function load() {
    try {
      const p = await api.profile();
      if (body.isConnected) draw(p);
    } catch (err) {
      errorBox(body, err.status === 404 ? 'The level system is still being set up — try again in a moment.' : err.message, load);
    }
  }

  // Live update when XP changes elsewhere (e.g. after importing a backup in another tab of the app).
  const onProfile = (event) => { if (body.isConnected && event.detail) draw(event.detail); };
  const onMe = (event) => {
    if (!header.isConnected || !event.detail) return;
    me = event.detail;
    if (!headerBusy()) drawHeader();
    drawTop5();
  };
  window.addEventListener('anishelf:profile', onProfile);
  window.addEventListener('anishelf:me', onMe);
  drawTop5();
  drawFavs();
  loadMe();
  load();
  loadLibrary();
  loadFavs();
  return () => {
    window.removeEventListener('anishelf:profile', onProfile);
    window.removeEventListener('anishelf:me', onMe);
  };
}
