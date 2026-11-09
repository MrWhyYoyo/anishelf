// AniShelf entry point: hash router + global behaviour.
import { api } from './api.js';
import { boot } from './boot.js';
import {
  setAccent, closeMenu, setHTML, emptyState, errorBox, html, toast, confetti, replayAnimation, fmtNumber, imgUrl,
  getPendingWatch, clearPendingWatch, setTitleLanguage,
} from './ui.js';
import * as profile from './views/profile.js';
import { initialOf } from './avatar.js';
import * as home from './views/home.js';
import * as search from './views/search.js';
import * as library from './views/library.js';
import * as detail from './views/detail.js';
import * as rankings from './views/rankings.js';
import * as stats from './views/stats.js';
import * as wrapped from './views/wrapped.js';
import * as random from './views/random.js';
import * as calendar from './views/calendar.js';
import * as settings from './views/settings.js';
import * as games from './views/games.js';
import * as diary from './views/diary.js';
import * as mangaShelf from './views/manga.js';
import * as mangaDetail from './views/manga-detail.js';
import * as seasonChart from './views/season.js';
import * as upNext from './views/queue.js';
import { askForDiary } from './diary-note.js';
import { playSound } from './sound.js';
import { startFeel } from './feel.js'; startFeel(); // clicks answer back: ripple, spinner, ✓, loading line (1.2.1)
import { startInbox } from './inbox.js'; startInbox(); // the season-news bell in the top bar (1.2)
import { startBuddy } from './buddy.js'; startBuddy(); // the little buddy along the bottom edge (Settings > Buddy)
import { initPalette } from './palette.js'; initPalette(); // Ctrl+K quick jump (palette.js)

const routes = [
  { pattern: /^$/, view: home, nav: 'home', title: 'Home' },
  { pattern: /^search$/, view: search, nav: 'search', title: 'Search' },
  { pattern: /^season$/, view: seasonChart, nav: 'season', title: 'Seasonal chart' },
  { pattern: /^queue$/, view: upNext, nav: 'queue', title: 'Up next' },
  { pattern: /^library$/, view: library, nav: 'library', title: 'Library' },
  { pattern: /^anime\/(\d+)$/, view: detail, nav: null, title: 'Anime', params: (m) => ({ id: Number(m[1]) }) },
  { pattern: /^rankings$/, view: rankings, nav: 'rankings', title: 'Rankings' },
  { pattern: /^stats$/, view: stats, nav: 'stats', title: 'Stats' },
  { pattern: /^wrapped$/, view: wrapped, nav: 'wrapped', title: 'Anime Wrapped' },
  { pattern: /^wrapped\/(\d{4})$/, view: wrapped, nav: 'wrapped', title: 'Anime Wrapped', params: (m) => ({ year: Number(m[1]) }) },
  { pattern: /^random$/, view: random, nav: 'random', title: "Tonight's pick" },
  { pattern: /^calendar$/, view: calendar, nav: 'calendar', title: 'Airing calendar' },
  { pattern: /^settings$/, view: settings, nav: 'settings', title: 'Settings' },
  { pattern: /^profile$/, view: profile, nav: 'profile', title: 'Profile' },
  { pattern: /^games$/, view: games, nav: 'games', title: 'Mini games' },
  { pattern: /^diary$/, view: diary, nav: 'diary', title: 'Watch diary' },
  { pattern: /^games\/([a-z-]+)$/, view: games, nav: null, title: 'Mini games', params: (m) => ({ game: m[1] }) },
  { pattern: /^manga$/, view: mangaShelf, nav: 'manga', title: 'Manga' },
  { pattern: /^manga\/(\d+)$/, view: mangaDetail, nav: null, title: 'Manga', params: (m) => ({ id: Number(m[1]) }) },
];

let cleanup = null;

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [path = '', queryString = ''] = hash.split('?');
  return { path: path.replace(/\/+$/, ''), query: new URLSearchParams(queryString) };
}

function runCleanup() {
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (err) { console.error('View cleanup failed', err); }
  }
  cleanup = null;
}

function render() {
  runCleanup();
  closeMenu();
  setAccent(null);

  const { path, query } = parseHash();
  let route = null;
  let match = null;
  for (const candidate of routes) {
    match = path.match(candidate.pattern);
    if (match) { route = candidate; break; }
  }

  const main = document.getElementById('view');
  // Each render gets a fresh container; async work from an old view writes into a detached node.
  const root = document.createElement('div');
  root.className = 'view';
  main.replaceChildren(root);
  window.scrollTo({ top: 0 });

  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = Boolean(route && link.dataset.nav === route.nav);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  moveNavIndicators();

  if (!route) {
    document.title = 'Not found · AniShelf';
    setHTML(root, emptyState({
      title: 'This page wandered off',
      text: "There's nothing here. Let's head back home.",
      action: html`<a class="btn btn-primary" href="#/">Go home</a>`,
    }));
    return;
  }

  document.title = route.nav === 'home' ? 'AniShelf' : `${route.title} · AniShelf`;
  setContext(route.nav ? route.title : '', !route.nav);
  try {
    const result = route.view.render(root, route.params ? route.params(match) : {}, query);
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error(err);
    errorBox(root, 'Something went wrong showing this page.', render);
  }
}

/* ---------------------------------------------------------------- sliding nav indicator */
function moveNavIndicators() {
  document.querySelectorAll('.sidebar .nav').forEach((nav) => {
    let indicator = nav.querySelector('.nav-indicator');
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'nav-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.style.transition = 'none'; // first placement: no slide from the corner
      nav.prepend(indicator);
      requestAnimationFrame(() => requestAnimationFrame(() => { indicator.style.transition = ''; }));
    }
    const active = nav.querySelector('a.active');
    if (!active) {
      indicator.classList.remove('show');
      return;
    }
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    indicator.classList.add('show');
  });
}

/* ---------------------------------------------------------------- top bar */
const contextEl = document.getElementById('topbar-context');

/** The top bar names where you are; object pages get a back link plus the object's name. */
function setContext(title, withBack) {
  setHTML(contextEl, withBack
    ? html`<button type="button" class="back-link" data-back aria-label="Back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button><span class="context-title">${title}</span>`
    : html`<span class="context-title">${title}</span>`);
}
contextEl.addEventListener('click', (event) => {
  if (!event.target.closest('[data-back]')) return;
  if (window.history.length > 1) window.history.back();
  else window.location.hash = '#/library';
});
// Object pages (anime detail) tell the shell their name once it has loaded.
window.addEventListener('anishelf:context', (event) => setContext((event.detail && event.detail.title) || '', true));

const topbarSearch = document.getElementById('topbar-search');
const topbarQ = document.getElementById('topbar-q');
topbarSearch.addEventListener('submit', (event) => {
  event.preventDefault();
  const q = topbarQ.value.trim();
  window.location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
  topbarQ.value = '';
  topbarQ.blur();
});

// Phone: the sidebar becomes a full-screen menu sheet.
const menuBtn = document.getElementById('menu-btn');
function setMenu(open) {
  document.body.classList.toggle('nav-open', open);
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
menuBtn.addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
window.addEventListener('hashchange', () => setMenu(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });

window.addEventListener('hashchange', render);
window.addEventListener('resize', moveNavIndicators);

/* ---------------------------------------------------------------- shortcuts */
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const typing = target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  if (typing) return;
  if (event.key === '/') {
    event.preventDefault();
    const input = parseHash().path === 'search' ? document.getElementById('q') : document.getElementById('topbar-q');
    if (input) input.focus();
  }
});

/* ---------------------------------------------------------------- server health */
const offlineBanner = document.getElementById('offline');

async function checkHealth() {
  try {
    await api.health();
    offlineBanner.hidden = true;
    return true;
  } catch (err) {
    // An HTTP error still means the server answered; only a network failure means it's down.
    offlineBanner.hidden = Boolean(err && err.status);
    return Boolean(err && err.status);
  }
}

window.addEventListener('anishelf:offline', () => { offlineBanner.hidden = false; });
document.getElementById('offline-retry').addEventListener('click', async () => {
  if (await checkHealth()) render();
});

/* ---------------------------------------------------------------- level / XP */
const STORE_KEY = 'anishelf.progress';
const widget = document.getElementById('level-widget');
const badgeEl = document.getElementById('level-badge');
let profileTimer = null;

function readProgress() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return value && typeof value.level === 'number' ? value : null;
  } catch {
    return null;
  }
}

function writeProgress(value) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function renderWidget(p) {
  const pct = Math.min(1, Math.max(0, Number(p.progress) || 0));
  const toNext = typeof p.next_level_xp === 'number' ? Math.max(0, p.next_level_xp - p.xp) : null;
  document.getElementById('lvl-num').textContent = String(p.level);
  document.getElementById('lvl-title').textContent = p.title || '';
  document.getElementById('lvl-bar').style.width = `${(pct * 100).toFixed(1)}%`;
  document.getElementById('lvl-xp').textContent = toNext !== null
    ? `${fmtNumber(toNext)} XP to level ${p.level + 1}`
    : `${fmtNumber(p.xp)} XP · max level`;
  badgeEl.style.setProperty('--p', pct.toFixed(3));
  widget.title = `Level ${p.level} · ${p.title}${toNext !== null ? ` · ${fmtNumber(toNext)} XP to level ${p.level + 1}` : ''}`;
  widget.setAttribute('aria-label', `Your profile: ${widget.title}`);
  widget.hidden = false;
  moveNavIndicators();
}

function celebrate(p) {
  const earned = (p.badges || []).filter((b) => b.earned).map((b) => b.id);
  const stored = readProgress();
  writeProgress({ level: p.level, badges: earned });
  if (!stored) return; // first load: just remember where we are

  if (p.level > stored.level) {
    toast(`LEVEL UP! Level ${p.level} — ${p.title}`, 'success', 5500);
    playSound('chime'); // silent unless sounds are on in Settings
    confetti(badgeEl);
    replayAnimation(badgeEl, 'level-pulse');
    window.dispatchEvent(new CustomEvent('anishelf:celebrate', { detail: { kind: 'level', level: p.level } })); // the buddy dances
  }
  const before = new Set(Array.isArray(stored.badges) ? stored.badges : []);
  (p.badges || [])
    .filter((b) => b.earned && !before.has(b.id))
    .slice(0, 3)
    .forEach((b) => {
      toast(`Badge unlocked: ${b.name} ${b.icon || ''}`.trim(), 'success', 4500);
      playSound('chime');
      window.dispatchEvent(new CustomEvent('anishelf:celebrate', { detail: { kind: 'badge', id: b.id } }));
    });
}

/* ---------------------------------------------------------------- avatar in the sidebar */
const sideAvatar = document.getElementById('side-avatar');

function renderSideAvatar(me) {
  const name = (me && me.display_name) || '';
  const src = me && me.avatar ? imgUrl(me.avatar.image) : '';
  sideAvatar.dataset.initial = initialOf(name);
  setHTML(sideAvatar, src ? html`<img class="fx-img" src="${src}" alt="" decoding="async" draggable="false">` : '');
  if (me && me.display_name) widget.dataset.name = me.display_name;
}

async function refreshMe() {
  try {
    const me = await api.me();
    renderSideAvatar(me);
    // The server's title language wins over the cached one; repaint if it differs.
    if (me && me.title_language && setTitleLanguage(me.title_language)) render();
    window.dispatchEvent(new CustomEvent('anishelf:me', { detail: me }));
  } catch {
    renderSideAvatar(null); // endpoint missing or offline: keep the initial placeholder
  }
}

async function refreshProfile() {
  try {
    const p = await api.profile();
    renderWidget(p);
    celebrate(p);
    window.dispatchEvent(new CustomEvent('anishelf:profile', { detail: p }));
  } catch (err) {
    if (err && err.status === 404) widget.hidden = true; // endpoint not available yet
  }
}

// Every successful change refreshes XP (debounced so bursts of clicks cost one request).
window.addEventListener('anishelf:changed', (event) => {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(refreshProfile, 800);
  // Profile edits (name / avatar) update the sidebar straight away.
  if (event.detail && event.detail.path === '/api/me') refreshMe();
  // Marking episodes (the +1 button, episode cells, ranges) gets a tiny tick when sounds are on.
  if (event.detail && String(event.detail.path || '').includes('/episodes')) playSound('tick');
});

/* ---------------------------------------------------------------- "Finished episode N?" */
const PROMPT_MIN_AWAY_MS = 3 * 60 * 1000; // don't ask if they came back after only a moment
let promptEl = null;
let promptBusy = false;

function closePrompt() {
  if (!promptEl) return;
  const el = promptEl;
  promptEl = null;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 260);
}

async function maybeAskAboutEpisode() {
  if (promptEl || promptBusy || document.visibilityState !== 'visible') return;
  const pending = getPendingWatch();
  if (!pending || Date.now() - pending.at < PROMPT_MIN_AWAY_MS) return;
  promptBusy = true;
  try {
    const { entry } = await api.anime(pending.mal_id);
    // While rewatching, the episode is checked against the rewatch set instead
    const done = entry && entry.rewatching ? entry.rewatch_watched : (entry ? entry.watched : []);
    if (!entry || done.includes(pending.episode)) { clearPendingWatch(); return; }
    showPrompt(pending);
  } catch {
    /* offline or removed: try again on the next focus */
  } finally {
    promptBusy = false;
  }
}

function showPrompt(pending) {
  const host = document.getElementById('toasts');
  promptEl = document.createElement('div');
  promptEl.className = 'prompt-card';
  promptEl.setAttribute('role', 'dialog');
  promptEl.setAttribute('aria-label', 'Did you finish the episode?');
  setHTML(promptEl, html`<p>Finished Episode ${pending.episode}?<small>${pending.title || ''}</small></p>
    <div class="prompt-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-later>Not yet</button>
      <button type="button" class="btn btn-sm btn-primary" data-mark>Mark watched</button>
    </div>`);
  host.appendChild(promptEl);
  requestAnimationFrame(() => { if (promptEl) promptEl.classList.add('show'); });

  promptEl.addEventListener('click', async (event) => {
    if (event.target.closest('[data-later]')) {
      clearPendingWatch();
      closePrompt();
      return;
    }
    const mark = event.target.closest('[data-mark]');
    if (!mark) return;
    mark.disabled = true;
    try {
      const { entry, status_changed: changed, rewatch_finished: rewatchDone } = await api.updateEpisodes(pending.mal_id, { action: 'toggle', episode: pending.episode });
      clearPendingWatch();
      closePrompt();
      toast(`Episode ${pending.episode} watched`, 'success');
      if (changed === 'completed') { toast('Finished! Moved to Done', 'success'); confetti(null); }
      // A finished show (or rewatch) gets the watch diary prompt
      if (changed === 'completed' || rewatchDone) askForDiary({ malId: pending.mal_id, animeTitle: pending.title, rewatch: rewatchDone });
      window.dispatchEvent(new CustomEvent('anishelf:episodes-updated', { detail: { mal_id: pending.mal_id, entry } }));
    } catch (err) {
      toast(err.message, 'error');
      mark.disabled = false;
    }
  });
}

// Views ask for a full repaint (e.g. after switching title language) or a fresh start (reset).
window.addEventListener('anishelf:rerender', () => render());
window.addEventListener('anishelf:reset', () => {
  closePrompt();
  refreshProfile();
  refreshMe();
});

window.addEventListener('focus', maybeAskAboutEpisode);
document.addEventListener('visibilitychange', maybeAskAboutEpisode);

// Show the loading screen while the main data and caches warm up, then draw the first page.
// refreshProfile/refreshMe reuse what boot() already fetched (api.js remembers it briefly).
boot().finally(() => {
  render();
  checkHealth();
  refreshProfile();
  refreshMe();
});
