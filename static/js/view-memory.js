// "Remember where you were": a list page (Library, Search, Manga) saves its filters and scroll
// position when you leave, and gets them back when you return from a detail page.
//
// Why sessionStorage? It survives moving between pages (and a reload) but is forgotten when the
// app window closes, so a new session always starts on a clean Library. Every access is wrapped
// in try/catch because storage can be switched off (private windows, strict settings).

const PREFIX = 'anishelf.viewMemory.';
const DETAIL_PAGE = /^#\/(anime|manga)\/\d+/; // the pages you "go into" from a list

// Track the page we came from. This module is imported by the views, which load before
// main.js adds its own hashchange listener, so this one always runs first.
let currentHash = window.location.hash;
let previousHash = '';
window.addEventListener('hashchange', () => {
  previousHash = currentHash;
  currentHash = window.location.hash;
});

/** True when the page that was open just before this one was an anime or manga page. */
export function cameFromDetail() {
  return DETAIL_PAGE.test(previousHash);
}

/** Save a small object for a page (e.g. {status, sort, filter, scrollY}). */
export function saveViewState(name, state) {
  try {
    sessionStorage.setItem(PREFIX + name, JSON.stringify(state));
  } catch { /* storage unavailable: the page just starts fresh next time */ }
}

/** The saved object for a page, or null. */
export function readViewState(name) {
  try {
    const value = JSON.parse(sessionStorage.getItem(PREFIX + name) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Scroll back to a saved position once the content is on screen. Call it right after the
 * grid is drawn. setTimeout (not requestAnimationFrame) so it also runs when the window is in
 * the background, where browsers pause animation frames.
 */
export function restoreScroll(y) {
  if (!Number.isFinite(y) || y <= 0) return;
  setTimeout(() => window.scrollTo({ top: y }), 0);
}
