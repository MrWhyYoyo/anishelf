// Shared UI helpers: safe HTML templating, cards, toasts, modals, menus, accent colour.

/* ------------------------------------------------------------------ safe HTML */
// Everything interpolated into html`` is escaped unless it is itself html`` / raw().

export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[ch]));
}

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function raw(value) {
  return new SafeHtml(String(value));
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

export function setHTML(element, content) {
  if (!element) return;
  element.innerHTML = content instanceof SafeHtml ? content.value : escapeHtml(content ?? '');
  applyStagger(element);
}

/* ------------------------------------------------------------------ motion */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Give cards inside grids/rows an index (--i) so CSS can stagger their entrance. */
function applyStagger(element) {
  const containers = [];
  if (element.matches && element.matches('.grid, .row-scroll')) containers.push(element);
  element.querySelectorAll('.grid, .row-scroll').forEach((c) => containers.push(c));
  containers.forEach((container) => {
    let i = 0;
    for (const child of container.children) {
      if (child.classList.contains('card')) {
        child.style.setProperty('--i', String(Math.min(i, 18)));
        i += 1;
      }
    }
  });
}

/** Restart a one-shot CSS animation class on an element. */
export function replayAnimation(element, className) {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth; // force reflow so the animation restarts
  element.classList.add(className);
  element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
}

/** Animate a number from 0 to its final value (text is already correct if motion is off). */
export function countUp(element, target, digits = 0, duration = 600) {
  if (!element || !Number.isFinite(target) || prefersReducedMotion()) return;
  const format = (v) => v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  const startTime = performance.now();
  const step = (now) => {
    if (!element.isConnected) return;
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - (1 - t) ** 3;
    const value = digits ? target * eased : Math.round(target * eased);
    element.textContent = format(t === 1 ? target : value);
    if (t < 1) requestAnimationFrame(step);
  };
  element.textContent = format(0);
  requestAnimationFrame(step);
  // Safety net: rAF pauses in hidden windows, so always land on the real value.
  setTimeout(() => { if (element.isConnected) element.textContent = format(target); }, duration + 150);
}


/** Small confetti burst from an element (or the screen centre). Cleans itself up. */
export function confetti(origin) {
  if (prefersReducedMotion()) return;
  const rect = origin && origin.isConnected ? origin.getBoundingClientRect() : null;
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 3;
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  // A small, quiet burst: 14 flat squares in the data hue and white, no spin, under 450ms.
  const pieces = 14;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff5a36';
  let remaining = pieces;
  for (let i = 0; i < pieces; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    piece.style.left = `${x}px`;
    piece.style.top = `${y}px`;
    piece.style.background = i % 2 ? '#ffffff' : accent;
    layer.appendChild(piece);
    const angle = (i / pieces) * Math.PI * 2;
    const distance = 36 + Math.random() * 28;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const animation = piece.animate([
      { transform: 'translate(-50%, -50%)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`, opacity: 0 },
    ], { duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' });
    animation.onfinish = () => {
      remaining -= 1;
      if (remaining === 0) layer.remove();
    };
  }
  // Safety net in case some animations never finish (e.g. tab hidden).
  setTimeout(() => layer.remove(), 1500);
}

/** Turn an html`` fragment into a real element (first element child). */
export function toElement(content) {
  const template = document.createElement('template');
  template.innerHTML = content instanceof SafeHtml ? content.value : escapeHtml(content ?? '');
  return template.content.firstElementChild;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ------------------------------------------------------------------ constants */
// AniShelf 1.2: clearer names. The saved values (the keys) stay the same, so old backups,
// stats and quests keep working; only the words you see changed. The badges from
// show-state.js add what the SHOW is doing ("Waiting for Season 3", "New season out").
export const STATUS_ORDER = ['plan_to_watch', 'watching', 'completed', 'on_hold', 'dropped'];
export const STATUS_LABELS = {
  watching: 'Watching',
  completed: 'Done',
  plan_to_watch: 'Want to watch',
  on_hold: 'Paused',
  dropped: 'Dropped',
};
export const STATUS_HINTS = {
  plan_to_watch: "On your list, not started yet",
  watching: 'In progress',
  completed: "You've seen everything that's out. The app tells you when more comes",
  on_hold: 'Taking a break, coming back later',
  dropped: 'Stopped, not coming back',
};
export const TIERS = ['S', 'A', 'B', 'C', 'D'];
export const SCORE_WORDS = {
  1: 'Appalling', 2: 'Horrible', 3: 'Very bad', 4: 'Bad', 5: 'Average',
  6: 'Fine', 7: 'Good', 8: 'Very good', 9: 'Great', 10: 'Masterpiece',
};

/* ------------------------------------------------------------------ icons */
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  heart: '<path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7.1 4.5c2 0 3.5 1.1 4.9 2.9 1.4-1.8 2.9-2.9 4.9-2.9 3.5 0 5.7 3.5 4.4 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.2"/><circle cx="15.5" cy="15.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};

export function icon(name) {
  return raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`);
}

/* ------------------------------------------------------------------ urls & text */
const IMAGE_HOSTS = ['cdn.myanimelist.net', 's4.anilist.co', 'img1.ak.crunchyroll.com'];

/** Proxy an external image through the backend cache. Returns '' for unusable URLs. */
export function imgUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    if (!IMAGE_HOSTS.includes(parsed.hostname)) return '';
  } catch {
    return '';
  }
  return `/img?u=${encodeURIComponent(url)}`;
}

/** Only allow http(s) links into href attributes. */
export function safeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

/* Title language ('english' | 'romaji'). Cached locally so the first paint already uses it;
   /api/me is the source of truth and main.js updates it at startup. */
let titleLanguage = (() => {
  try { return localStorage.getItem('anishelf.titleLang') === 'romaji' ? 'romaji' : 'english'; } catch { return 'english'; }
})();

export function getTitleLanguage() {
  return titleLanguage;
}

/** Returns true when the language actually changed. */
export function setTitleLanguage(lang) {
  const next = lang === 'romaji' ? 'romaji' : 'english';
  if (next === titleLanguage) return false;
  titleLanguage = next;
  try { localStorage.setItem('anishelf.titleLang', next); } catch { /* storage unavailable */ }
  return true;
}

/** The title to show for any object with title / title_english, in the user's chosen language. */
export function displayTitle(obj) {
  if (!obj) return 'Untitled';
  if (titleLanguage === 'english' && obj.title_english) return obj.title_english;
  return obj.title || obj.title_english || 'Untitled';
}

/** The "other" title (for subtitles), or '' when there isn't a different one. */
export function altTitle(obj) {
  if (!obj) return '';
  const main = displayTitle(obj);
  const other = main === obj.title_english ? obj.title : obj.title_english;
  return other && other !== main ? other : '';
}

function initialsOf(title) {
  const words = String(title || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : (pluralWord || `${word}s`)}`;
}

export function fmtNumber(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

export function capitalize(text) {
  return text ? String(text).charAt(0).toUpperCase() + String(text).slice(1) : '';
}

export function seasonText(meta) {
  if (!meta) return '';
  if (meta.season && meta.year) return `${capitalize(meta.season)} ${meta.year}`;
  return meta.year ? String(meta.year) : '';
}

/* ------------------------------------------------------------------ images */
// Any <img class="fx-img"> that fails to load is removed so the placeholder shows.
document.addEventListener('error', (event) => {
  const target = event.target;
  if (target instanceof HTMLImageElement && target.classList.contains('fx-img')) {
    target.remove();
  }
}, true);

/**
 * A 2:3 cover with initials placeholder. `inner` (html``) is placed on top (badges, progress).
 */
export function coverHtml(url, title, extraClass = '', inner = '') {
  const src = imgUrl(url);
  return html`<div class="cover ${extraClass}" data-initials="${initialsOf(title)}">${src
    ? html`<img class="fx-img" src="${src}" alt="" loading="lazy" decoding="async" draggable="false">`
    : ''}${inner}</div>`;
}

/* ------------------------------------------------------------------ cards */
function cardSubtitle(meta, entry) {
  if (entry) {
    const total = entry.total ?? '?';
    if (entry.status === 'watching' && entry.next_episode) {
      return `Ep ${entry.next_episode} next · ${entry.watched_count}/${total}`;
    }
    if (entry.watched_count > 0 && entry.status !== 'completed') {
      return `${entry.watched_count}/${total} episodes`;
    }
  }
  const parts = [meta.type, meta.year, meta.episodes ? plural(meta.episodes, 'ep') : null].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Cover card used across the app.
 * opts: { entry, status, subtitle, actions (html``), showProgress }
 */
export function animeCard(meta, opts = {}) {
  const entry = opts.entry || null;
  const status = entry ? entry.status : (opts.status ?? meta.library_status ?? null);
  const showProgress = opts.showProgress ?? Boolean(entry);
  const progress = entry && typeof entry.progress === 'number' ? Math.min(1, Math.max(0, entry.progress)) : null;
  const favorite = Boolean(entry && entry.favorite);
  const subtitle = opts.subtitle ?? cardSubtitle(meta, entry);

  const inner = html`
    ${status && STATUS_LABELS[status] ? html`<span class="badge status-${status}">${STATUS_LABELS[status]}</span>` : ''}
    ${entry && entry.score ? html`<span class="score-pill">${entry.score}<small>/10</small></span>` : ''}
    ${favorite ? html`<span class="fav-mark" title="Favourite">${icon('heart')}</span>` : ''}
    ${opts.badge ? html`<span class="seasons-pill">${opts.badge}</span>` : ''}
    ${showProgress && progress !== null && progress > 0
      ? html`<div class="cover-progress ${favorite ? 'with-fav' : ''}"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>`
      : ''}`;

  return html`<article class="card" data-id="${meta.mal_id}">
    <a class="card-link" href="#/anime/${meta.mal_id}" title="${displayTitle(meta)}">
      ${coverHtml(meta.image, displayTitle(meta), '', inner)}
      <div class="card-title">${displayTitle(meta)}</div>
      ${subtitle ? html`<div class="card-sub">${subtitle}</div>` : ''}
      ${opts.below || ''}
    </a>
    ${opts.actions ? html`<div class="card-actions">${opts.actions}</div>` : ''}
  </article>`;
}

/**
 * The episode strip (AniShelf's signature): one small cell per episode, watched cells in the
 * data hue, the next episode outlined. `watched` may be a list of episode numbers or just a count
 * (then the first N cells fill). Long or unknown runs fall back to a thin bar at the true ratio.
 */
export function epStrip({ watched = [], watchedCount = null, total = null, next = null, max = 60, label = '' } = {}) {
  const set = Array.isArray(watched) ? new Set(watched) : new Set();
  const count = watchedCount ?? set.size;
  if (!total || total < 1) return html``;
  const aria = label || `${count} of ${total} episodes watched`;
  if (total > max) {
    const pct = Math.min(100, (count / total) * 100);
    return html`<div class="ep-strip-bar" role="img" aria-label="${aria}"><span style="width:${pct.toFixed(1)}%"></span></div>`;
  }
  const useSet = Array.isArray(watched) && watched.length > 0;
  const cells = [];
  for (let n = 1; n <= total; n += 1) {
    const isWatched = useSet ? set.has(n) : n <= count;
    cells.push(isWatched ? 'w' : (n === next ? 'n' : ''));
  }
  return html`<div class="ep-strip ${total > 36 ? 'dense' : ''}" role="img" aria-label="${aria}">${cells.map((c) => (c ? raw(`<i class="${c}"></i>`) : raw('<i></i>')))}</div>`;
}

export function skeletonCards(count = 8) {
  const one = html`<div class="card skeleton" aria-hidden="true"><div class="cover shimmer"></div><div class="sk-line shimmer"></div><div class="sk-line short shimmer"></div></div>`;
  return html`${Array.from({ length: count }, () => one)}`;
}

/* ------------------------------------------------------------------ states */
export function emptyState({ emoji = '', title, text = '', action = '' }) {
  return html`<div class="empty-state">
    ${title ? html`<h3>${title}</h3>` : ''}
    ${text ? html`<p>${text}</p>` : ''}
    ${action}
  </div>`;
}

export function errorBox(container, message, retry) {
  if (!container) return;
  setHTML(container, html`<div class="error-state" role="alert">
    <p>${message || 'Something went wrong.'}</p>
    ${retry ? html`<button type="button" class="btn" data-retry>Try again</button>` : ''}
  </div>`);
  const button = container.querySelector('[data-retry]');
  if (button && retry) button.addEventListener('click', () => retry(), { once: true });
}

/* ------------------------------------------------------------------ toast */
export function toast(message, type = 'info', timeout = 3400) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  const all = host.querySelectorAll('.toast');
  for (let i = 0; i < all.length - 4; i += 1) all[i].remove(); // never removes a prompt card
  requestAnimationFrame(() => el.classList.add('show'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  };
  setTimeout(close, type === 'error' ? Math.max(timeout, 5000) : timeout);
  el.addEventListener('click', close);
}

/* ------------------------------------------------------------------ undo toast
   A success toast with an "Undo" button that stays for ~6 seconds (styles in css/qol.css).
   onUndo is an async function that puts the old state back; while it runs the button is
   disabled, so a double click can't undo twice. Only the newest undo toast is kept: an older
   one could restore a state that a newer change has already replaced. */
let closeLastUndo = null;

export function toastUndo(message, onUndo, timeout = 6000) {
  const host = document.getElementById('toasts');
  if (!host) return;
  if (closeLastUndo) closeLastUndo();
  const el = document.createElement('div');
  el.className = 'toast toast-success toast-undo';
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toast-undo-btn';
  button.textContent = 'Undo';
  el.append(text, button);
  host.appendChild(el);
  const all = host.querySelectorAll('.toast');
  for (let i = 0; i < all.length - 4; i += 1) all[i].remove();
  requestAnimationFrame(() => el.classList.add('show'));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (closeLastUndo === close) closeLastUndo = null;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  };
  closeLastUndo = close;
  // Hovering or focusing the toast pauses the countdown, so there is time to reach the button.
  let timer = setTimeout(close, timeout);
  const pause = () => clearTimeout(timer);
  const resume = () => { clearTimeout(timer); if (!closed) timer = setTimeout(close, 2500); };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  button.addEventListener('focus', pause);
  button.addEventListener('blur', resume);

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await onUndo();
      close();
      toast('Undone', 'info', 1800);
    } catch (err) {
      close();
      toast(`Couldn't undo: ${err.message}`, 'error');
    }
  });
  el.addEventListener('click', (event) => { if (event.target !== button) close(); });
}

/* ------------------------------------------------------------------ modal */
export function openModal({ title, body = '', actions = [{ label: 'Close', value: null }] }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    setHTML(overlay, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h3 id="modal-title">${title}</h3>
      <div class="modal-body">${typeof body === 'string' ? html`<p>${body}</p>` : body}</div>
      <div class="modal-actions">${actions.map((a, i) => html`<button type="button" class="btn ${a.className || ''}" data-i="${i}">${a.label}</button>`)}</div>
    </div>`);

    const previousFocus = document.activeElement;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onHash);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) previousFocus.focus();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === 'Tab') {
        const buttons = $$('button', overlay);
        if (!buttons.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onHash = () => finish(null);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) { finish(null); return; }
      const button = event.target.closest('button[data-i]');
      if (button) finish(actions[Number(button.dataset.i)].value);
    });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const buttons = $$('.modal-actions button', overlay);
    (buttons[buttons.length - 1] || overlay).focus();
  });
}

export async function confirmDialog(message, { title = 'Are you sure?', okText = 'Confirm', danger = false } = {}) {
  const value = await openModal({
    title,
    body: message,
    actions: [
      { label: 'Cancel', value: false, className: 'btn-ghost' },
      { label: okText, value: true, className: danger ? 'btn-danger' : 'btn-primary' },
    ],
  });
  return value === true;
}

/* ------------------------------------------------------------------ popover menu */
let activeMenu = null;

export function closeMenu() {
  if (activeMenu) activeMenu(undefined);
}

/**
 * Small dropdown anchored to an element.
 * options: [{ value, label, current?, statusClass? }]. Resolves to the chosen value or undefined.
 */
export function pickMenu(anchor, options) {
  closeMenu();
  return new Promise((resolve) => {
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    setHTML(menu, html`${options.map((o, i) => html`<button type="button" role="menuitem" class="menu-item ${o.current ? 'current' : ''} ${o.hint ? 'has-hint' : ''}" data-i="${i}">${o.statusClass ? html`<span class="dot ${o.statusClass}"></span>` : ''}${o.hint ? html`<span class="menu-text"><span>${o.label}</span><small>${o.hint}</small></span>` : o.label}</button>`)}`);
    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - width - 10);
    left = Math.max(10, left);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const items = $$('.menu-item', menu);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      activeMenu = null;
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      menu.remove();
      if (value === undefined && anchor.isConnected) anchor.focus({ preventScroll: true });
      resolve(value);
    };
    const onOutside = (event) => {
      if (!menu.contains(event.target)) finish(undefined);
    };
    const onKey = (event) => {
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(undefined); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
      else if (event.key === 'Tab') { finish(undefined); }
    };
    const onScroll = (event) => {
      if (event && event.target && menu.contains(event.target)) return;
      finish(undefined);
    };

    menu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-i]');
      if (button) finish(options[Number(button.dataset.i)].value);
    });
    setTimeout(() => {
      if (done) return;
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
    }, 0);
    document.addEventListener('keydown', onKey, true);
    activeMenu = finish;
    const current = items.find((el) => el.classList.contains('current')) || items[0];
    if (current) current.focus({ preventScroll: true });
  });
}

export function statusMenu(anchor, current = null) {
  return pickMenu(anchor, STATUS_ORDER.map((s) => ({
    value: s,
    label: STATUS_LABELS[s],
    hint: STATUS_HINTS[s],
    current: s === current,
    statusClass: `status-${s}`,
  })));
}

/* ------------------------------------------------------------------ streaming links */
// Streaming sites need the user's logged-in default browser, so the backend opens them.
export async function openInBrowser(url, siteName) {
  const safe = safeUrl(url);
  if (!safe) {
    toast("That link doesn't look valid.", 'error');
    return false;
  }
  const { api } = await import('./api.js');
  try {
    await api.openUrl(safe);
    toast(`Opening ${siteName || 'link'} in your browser…`, 'info', 2600);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

const PENDING_KEY = 'anishelf.pendingWatch';
export const PENDING_MAX_AGE = 6 * 60 * 60 * 1000;

/** Remember the episode the user just went to watch (only one at a time). */
export function setPendingWatch(value) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ...value, at: Date.now() })); } catch { /* storage unavailable */ }
}

export function getPendingWatch() {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (!value || typeof value.mal_id !== 'number' || typeof value.episode !== 'number') return null;
    if (Date.now() - value.at > PENDING_MAX_AGE) { clearPendingWatch(); return null; }
    return value;
  } catch {
    return null;
  }
}

export function clearPendingWatch() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* storage unavailable */ }
}

/** Streaming sites with Crunchyroll first. */
export function sortStreaming(list) {
  const items = Array.isArray(list) ? list.filter((s) => s && s.site && safeUrl(s.url)) : [];
  return items.sort((a, b) => Number(/crunchyroll/i.test(b.site)) - Number(/crunchyroll/i.test(a.site)));
}

/* ------------------------------------------------------------------ accent colour */
const DEFAULT_ACCENT = '#ff5a36'; // torii vermilion; detail pages use the anime's own cover colour

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function mixWithWhite([r, g, b], amount) {
  return [r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount];
}

function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Sets --accent (fills), --accent-text (readable on the dark background)
 * and --accent-contrast (text drawn on top of the accent). Pass null to reset.
 */
export function setAccent(color) {
  const hex = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ACCENT;
  let fill = hexToRgb(hex);
  let guard = 0;
  // Very dark colours vanish on the near-black background: lift them a little.
  while (relativeLuminance(fill) < 0.07 && guard < 12) { fill = mixWithWhite(fill, 0.15); guard += 1; }

  let text = fill;
  guard = 0;
  // Accent used as text must reach ~4.5:1 against the background.
  while (relativeLuminance(text) < 0.3 && guard < 20) { text = mixWithWhite(text, 0.12); guard += 1; }

  // White text reads well on darker fills; bright fills (yellow, cyan...) get near-black text.
  const contrast = relativeLuminance(fill) > 0.22 ? '#0b0d14' : '#ffffff';

  const root = document.documentElement.style;
  root.setProperty('--accent', toHex(fill));
  root.setProperty('--accent-rgb', fill.map((c) => Math.round(c)).join(', '));
  root.setProperty('--accent-text', toHex(text));
  root.setProperty('--accent-contrast', contrast);
}
