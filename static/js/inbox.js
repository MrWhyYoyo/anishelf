// The season inbox (AniShelf 1.2): a bell in the top bar with news about sequels to shows
// you've finished. The server works the news out (anishelf/inbox.py); this file draws the
// bell, the red dot for unread news, and the little panel that opens under it.
import { api } from './api.js';
import { html, setHTML, coverHtml, displayTitle } from './ui.js';

let data = { items: [], unread: 0 };
let open = false;
let refreshTimer = null;

const $ = (id) => document.getElementById(id);

function drawDot() {
  const dot = $('inbox-dot');
  const label = $('inbox-label');
  if (!dot) return;
  dot.hidden = !data.unread;
  label.textContent = data.unread ? `Season news, ${data.unread} new` : 'Season news';
}

function itemHtml(item) {
  const next = item.next || {};
  const show = displayTitle(item.from);
  const headline = item.kind === 'new_season'
    ? `${next.label || 'A new season'} is out${item.airing ? ' and airing now' : ''}`
    : `${next.label || 'A new season'} announced${next.when ? ` for ${next.when}` : ''}`;
  return html`<a class="inbox-item ${item.unread ? 'unread' : ''}" href="#/anime/${next.mal_id}">
    ${coverHtml(next.image || item.from.image, show, 'inbox-cover')}
    <span class="inbox-text">
      <span class="inbox-show">${show}</span>
      <span class="inbox-head">${headline}</span>
    </span>
    ${item.unread ? html`<span class="inbox-new" aria-label="new"></span>` : ''}
  </a>`;
}

function drawPanel() {
  const panel = $('inbox-panel');
  if (!panel) return;
  const items = data.items || [];
  setHTML(panel, html`
    <div class="inbox-headline"><strong>Season news</strong><span class="faint small">${items.length ? `${items.length} ${items.length === 1 ? 'show' : 'shows'}` : ''}</span></div>
    ${items.length
      ? html`<div class="inbox-list">${items.map(itemHtml)}</div>`
      : html`<p class="muted small inbox-empty">No sequel news yet. When a show you've finished gets a new season, it shows up here.</p>`}
    <a class="inbox-all small" href="#/library?status=new_season">See shows with a new season in your Library</a>`);
}

async function refresh() {
  try {
    data = await api.inbox();
  } catch {
    return; // offline: keep what we had, the bell just doesn't update
  }
  drawDot();
  if (open) drawPanel();
}

function setOpen(next) {
  open = next;
  const panel = $('inbox-panel');
  const button = $('inbox-btn');
  panel.hidden = !open;
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    drawPanel();
    // Opening the bell counts as "seen": the dot goes away, the items stay marked for this look.
    if (data.unread) {
      api.inboxSeen().then((fresh) => { data = { ...fresh, items: data.items }; drawDot(); }).catch(() => {});
    }
  } else if (data.items.some((i) => i.unread)) {
    data.items = data.items.map((i) => ({ ...i, unread: false })); // next time it opens, they're read
  }
}

export function startInbox() {
  const button = $('inbox-btn');
  const box = $('inbox');
  if (!button || !box) return;
  button.addEventListener('click', () => setOpen(!open));
  // Close on a click outside, on Escape, and when you follow a link inside.
  document.addEventListener('pointerdown', (event) => { if (open && !box.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') { setOpen(false); button.focus(); }
  });
  $('inbox-panel').addEventListener('click', (event) => { if (event.target.closest('a')) setOpen(false); });
  // Status changes can add or remove news (e.g. you start the new season): refresh, but not
  // on every single click — wait until things calm down for a moment.
  window.addEventListener('anishelf:changed', (event) => {
    if (event.detail && event.detail.path === '/api/inbox/seen') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 1500);
  });
  refresh();
  // The start-up warm-up may find new seasons a little after the app opens: look again once.
  setTimeout(refresh, 20000);
}
