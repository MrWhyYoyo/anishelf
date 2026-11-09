// Anime Wrapped: a year in review (#/wrapped and #/wrapped/<year>).
// All numbers come from GET /api/wrapped?year=YYYY; this file only lays them out.
import { api } from '../api.js';
import {
  html, setHTML, emptyState, errorBox, fmtNumber, plural, countUp, coverHtml, displayTitle, setAccent,
} from '../ui.js';

function kpi(value, label, sub, lead = false, digits = 0) {
  return html`<div class="kpi ${lead ? 'kpi-lead' : ''}"><div class="kpi-label">${label}</div>
    <div class="kpi-value num" data-count="${value}" data-digits="${digits}">${fmtNumber(value, digits)}</div>
    ${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

/** Twelve bars, one per month. The busiest month gets its label in full white. */
function monthChart(months, busiest) {
  const width = 640;
  const height = 200;
  const pad = { top: 22, bottom: 26, left: 8, right: 8 };
  const max = Math.max(1, ...months.map((m) => m.episodes));
  const usable = height - pad.top - pad.bottom;
  const slot = (width - pad.left - pad.right) / months.length;
  const barW = Math.min(30, slot * 0.6);

  const bars = months.map((m, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2;
    const h = (m.episodes / max) * usable;
    const y = pad.top + usable - h;
    const isBusiest = busiest && busiest.month === m.month;
    return html`<g>
      ${m.episodes > 0 ? html`<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${m.label}: ${plural(m.episodes, 'episode')}</title></rect>` : ''}
      ${isBusiest ? html`<text class="wr-bar-value" x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${m.episodes}</text>` : ''}
      <text class="tick ${isBusiest ? 'wr-tick-strong' : ''}" x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${m.label}</text>
    </g>`;
  });
  return html`<div class="bar-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Episodes watched per month">
    <line class="baseline" x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + usable}" y2="${pad.top + usable}"></line>
    ${bars}
  </svg></div>`;
}

/** A cover with a title under it, linking to the anime page. */
function showTile(show, note) {
  if (!show) return html`<p class="wr-missing">—</p>`;
  const title = displayTitle(show);
  return html`<a class="wr-show" href="#/anime/${show.mal_id}">
    ${coverHtml(show.image, title, 'wr-cover')}
    <span class="wr-show-text"><span class="wr-show-title">${title}</span><span class="faint small">${note}</span></span>
  </a>`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

function yearTabs(years, current) {
  return html`<div class="tabs wr-years" role="tablist" aria-label="Year">${years.map((y) => html`<button type="button"
    role="tab" class="${y === current ? 'active' : ''}" aria-selected="${y === current ? 'true' : 'false'}" data-year="${y}">${y}</button>`)}</div>`;
}

export function render(root, params = {}) {
  setAccent(null); // the default data hue; Wrapped isn't about one anime
  setHTML(root, html`
    <header class="page-head"><h1 id="wr-title">Anime Wrapped</h1><p id="wr-sub">Your year in anime.</p></header>
    <div id="wr-body"><p class="inline-hint">Wrapping up your year…</p></div>
  `);
  const body = root.querySelector('#wr-body');

  async function load() {
    try {
      const w = await api.wrapped(params.year);
      if (!body.isConnected) return;
      root.querySelector('#wr-title').textContent = `Your ${w.year} in anime`;
      root.querySelector('#wr-sub').textContent = 'Everything you watched this year, wrapped up.';

      if (!w.has_data) {
        setHTML(body, html`${yearTabs(w.years, w.year)}${emptyState({
          title: `Nothing logged in ${w.year}`,
          text: 'Mark episodes as watched and your year in review fills itself in.',
          action: html`<a class="btn btn-primary" href="#/library">Open your library</a>`,
        })}`);
      } else {
        const busiest = w.busiest_month;
        const top = w.top_shows || [];
        setHTML(body, html`
          ${yearTabs(w.years, w.year)}
          <section class="panel wr-line" aria-label="Your year in one line">
            <h2>Your year in one line</h2>
            <p>${w.summary}</p>
          </section>
          <section class="kpis wr-kpis" aria-label="Totals">
            ${kpi(w.episodes, 'Episodes', `across ${plural(w.shows_watched, 'show')}`, true)}
            ${kpi(w.hours, 'Hours watched', `${fmtNumber(w.days_active)} active days`, false, 1)}
            ${kpi(w.completed, 'Shows completed', w.completed ? 'finished this year' : 'none finished yet')}
            ${kpi(w.longest_streak, 'Longest streak', 'days in a row')}
            ${kpi(busiest ? busiest.episodes : 0, 'Busiest month', busiest ? busiest.name : '—')}
          </section>
          <div class="stats-grid">
            <section class="panel stats-main">
              <div class="panel-head"><h2>Episodes per month</h2>
                <span class="muted small">${busiest ? `Busiest: ${busiest.name}` : ''}</span></div>
              ${monthChart(w.months || [], busiest)}
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Most watched</h2></div>
              ${showTile(w.most_watched, w.most_watched ? plural(w.most_watched.episodes, 'episode') : '')}
              ${top.length > 1 ? html`<ol class="wr-top">${top.slice(1).map((s, i) => html`<li>
                <span class="wr-rank num">${i + 2}</span>
                <a href="#/anime/${s.mal_id}">${displayTitle(s)}</a>
                <span class="faint num">${s.episodes}</span></li>`)}</ol>` : ''}
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Top genre</h2></div>
              ${w.top_genre ? html`<p class="wr-big">${w.top_genre.name}</p>
                <p class="faint small">${plural(w.top_genre.episodes, 'episode')} in this genre</p>`
                : html`<p class="wr-missing">—</p>`}
            </section>
            <section class="panel">
              <div class="panel-head"><h2>First finished</h2></div>
              ${showTile(w.first_finished, w.first_finished ? fmtDate(w.first_finished.finished_on) : '')}
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Last finished</h2></div>
              ${showTile(w.last_finished, w.last_finished ? fmtDate(w.last_finished.finished_on) : '')}
            </section>
          </div>
        `);
        body.querySelectorAll('[data-count]').forEach((el) => {
          countUp(el, Number(el.dataset.count), Number(el.dataset.digits) || 0);
        });
      }

      // Year switcher: changing the hash re-renders this view for that year.
      body.querySelectorAll('[data-year]').forEach((button) => {
        button.addEventListener('click', () => { window.location.hash = `#/wrapped/${button.dataset.year}`; });
      });
    } catch (err) {
      errorBox(body, err.message, load);
    }
  }

  load();
}
