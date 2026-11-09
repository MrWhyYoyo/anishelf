// Airing calendar: the next 7 days of episodes for my Watching and Want to watch shows.
// The server groups episodes by day using this browser's time zone (api.calendar sends it),
// and every time shown here is formatted by the browser, so it is always local time.
import { api } from '../api.js';
import {
  html, setHTML, coverHtml, emptyState, errorBox, displayTitle, fmtCountdown, STATUS_LABELS,
} from '../ui.js';

/** "22:00" in the browser's own clock format. */
export function localTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Today", "Tomorrow", or "Monday 10 Nov". */
export function dayName(isoDate, index) {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  const day = new Date(`${isoDate}T12:00:00`); // noon: safe from DST edges
  return day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

/** "Today", "Tomorrow" or a weekday for a unix time, using the browser's calendar. */
export function dayNameFor(unixSeconds) {
  const when = new Date(unixSeconds * 1000);
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Math.round absorbs the 1-hour difference on daylight-saving days
  const daysAway = Math.round((startOf(when) - startOf(new Date())) / 86400000);
  const iso = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  return dayName(iso, daysAway);
}

/** Seconds until an episode airs (never negative). */
export function secondsUntil(unixSeconds) {
  return Math.max(0, unixSeconds - Date.now() / 1000);
}

function episodeRow(item, isNext) {
  const m = item.meta;
  const status = item.status === 'plan_to_watch' ? STATUS_LABELS.plan_to_watch : '';
  return html`<a class="cal-item ${isNext ? 'is-next' : ''}" href="#/anime/${item.mal_id}">
    ${coverHtml(m.image, displayTitle(m))}
    <span class="cal-text">
      <span class="cal-title">${displayTitle(m)}</span>
      <span class="cal-sub"><span class="cal-ep">Episode ${item.episode}</span> · ${localTime(item.airing_at)}${status ? ` · ${status}` : ''}</span>
    </span>
  </a>`;
}

function dayColumn(day, index, nextKey) {
  return html`<section class="cal-day ${index === 0 ? 'is-today' : ''}">
    <h2 class="cal-day-name">${dayName(day.date, index)}</h2>
    ${day.items.length
      ? html`<div class="cal-list">${day.items.map((item) => episodeRow(item, `${item.mal_id}:${item.episode}` === nextKey))}</div>`
      : html`<p class="cal-empty">No episodes</p>`}
  </section>`;
}

export function render(root) {
  setHTML(root, html`
    <header class="page-head">
      <h1>Airing calendar</h1>
      <p id="cal-sub">New episodes of your Watching and Want to watch shows, in your local time.</p>
    </header>
    <section class="panel cal-next" id="cal-next" aria-live="polite"><div class="sk-line" style="height:64px"></div></section>
    <div class="cal-week" id="cal-week"><div class="sk-line" style="height:240px"></div></div>
  `);

  const nextEl = root.querySelector('#cal-next');
  const weekEl = root.querySelector('#cal-week');
  const sub = root.querySelector('#cal-sub');
  let timer = null;

  function drawCountdown(next) {
    const countEl = nextEl.querySelector('[data-countdown]');
    if (!countEl || !next) return;
    const left = secondsUntil(next.airing_at);
    countEl.textContent = left > 0 ? `in ${fmtCountdown(left)}` : 'airing now';
  }

  function drawNext(next) {
    if (!next) {
      setHTML(nextEl, html`<p class="muted">No upcoming episodes found for your shows.</p>`);
      return;
    }
    const m = next.meta;
    setHTML(nextEl, html`<a class="cal-next-link" href="#/anime/${next.mal_id}">
      ${coverHtml(m.image, displayTitle(m))}
      <span class="cal-text">
        <span class="cal-label">Next episode</span>
        <span class="cal-next-title">${displayTitle(m)} · Episode ${next.episode}</span>
        <span class="cal-sub">${dayNameFor(next.airing_at)} at ${localTime(next.airing_at)}</span>
      </span>
      <span class="cal-count" data-countdown></span>
    </a>`);
    drawCountdown(next);
    clearInterval(timer);
    // The countdown only needs minute precision, so a 30-second tick is plenty.
    timer = setInterval(() => {
      if (!root.isConnected) { clearInterval(timer); return; }
      drawCountdown(next);
    }, 30000);
  }

  async function load() {
    try {
      const data = await api.calendar();
      if (!root.isConnected) return;
      const days = data.days || [];
      const next = data.next || null;
      const nextKey = next ? `${next.mal_id}:${next.episode}` : '';
      drawNext(next);
      if (!data.tracked) {
        setHTML(weekEl, emptyState({
          title: 'None of your shows are airing',
          text: 'Shows you are watching or planning to watch that are currently airing will appear here.',
          action: html`<a class="btn btn-primary" href="#/search">Find anime</a>`,
        }));
        sub.textContent = 'Nothing airing on your shelf right now.';
        return;
      }
      setHTML(weekEl, html`${days.map((day, i) => dayColumn(day, i, nextKey))}`);
      const count = days.reduce((sum, day) => sum + day.items.length, 0);
      sub.textContent = data.error
        ? data.error
        : `${count} ${count === 1 ? 'episode' : 'episodes'} this week from ${data.tracked} airing ${data.tracked === 1 ? 'show' : 'shows'}, in your local time.`;
    } catch (err) {
      errorBox(weekEl, err.message, load);
      setHTML(nextEl, '');
    }
  }

  load();
  return () => clearInterval(timer);
}
