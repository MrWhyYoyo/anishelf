// Taste profile: a section on the Stats page built from GET /api/taste (no outside API calls).
// stats.js calls mountTaste(container) once its own panels are drawn.
import { api } from './api.js';
import { html, setHTML, coverHtml, displayTitle, fmtNumber, plural, capitalize } from './ui.js';

/** Horizontal bars, same look as the Stats page's genre bars. `share` is 0-1 of the biggest. */
function weightBars(items, emptyText) {
  if (!items || !items.length) return html`<p class="muted">${emptyText}</p>`;
  return html`<div class="hbars">${items.map((item, i) => html`<div class="hbar ${i === 0 ? 'lead' : ''}">
    <div class="hb-top"><span class="hb-label" title="${item.name}">${capitalize(item.name)}</span>
      <span class="hb-val num">${plural(item.shows, 'show')}${item.avg_score !== null ? html` · <span title="Your average score">${fmtNumber(item.avg_score, 1)}</span>` : ''}</span></div>
    <div class="hb-track"><div class="hb-fill" style="width:${(item.share * 100).toFixed(1)}%"></div></div>
  </div>`)}</div>`;
}

/** One stacked bar for the format split, plus a legend with percentages. */
function formatSplit(items) {
  if (!items || !items.length) return html`<p class="muted">Nothing watched yet.</p>`;
  return html`<div class="taste-split" role="img" aria-label="${items.map((f) => `${f.name} ${Math.round(f.share * 100)}%`).join(', ')}">
      ${items.map((f, i) => html`<span class="seg-${Math.min(i, 4)}" style="width:${(f.share * 100).toFixed(1)}%"></span>`)}
    </div>
    <ul class="taste-legend">${items.map((f, i) => html`<li><span class="taste-swatch seg-${Math.min(i, 4)}"></span>${f.name}
      <span class="num muted">${Math.round(f.share * 100)}% · ${f.count}</span></li>`)}</ul>`;
}

/** Hidden gems / hot takes: your score next to MyAnimeList's. */
function pickList(items, emptyText) {
  if (!items || !items.length) return html`<p class="muted">${emptyText}</p>`;
  return html`<div class="queue-list">${items.map((p) => html`<a class="queue-row" href="#/anime/${p.mal_id}">
    ${coverHtml(p.image, displayTitle(p))}
    <span class="q-text"><span class="q-title">${displayTitle(p)}</span>
      <span class="q-sub">You ${p.score} · MyAnimeList ${fmtNumber(p.mal_score, 2)}</span></span>
    <span class="q-num">${p.diff > 0 ? '+' : ''}${fmtNumber(p.diff, 1)}</span>
  </a>`)}</div>`;
}

function kpi(value, label, sub) {
  return html`<div class="kpi"><div class="kpi-label">${label}</div>
    <div class="kpi-value num ${value === '—' ? 'missing' : ''}">${value}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function draw(t) {
  if (!t.shows_counted) {
    return html`<div class="panel-head"><h2>Your taste</h2></div>
      <p class="muted">Watch or score a few shows and your taste profile appears here.</p>`;
  }
  const vs = t.you_vs_mal;
  const diffText = vs ? `${vs.diff > 0 ? '+' : ''}${fmtNumber(vs.diff, 2)} vs MyAnimeList (${fmtNumber(vs.mal_avg, 2)})` : 'score some shows to compare';
  return html`
    <div class="panel-head"><h2>Your taste</h2><span class="muted small">From ${plural(t.shows_counted, 'show')}, weighted by your score and episodes watched</span></div>
    ${t.summary ? html`<p class="taste-summary">${t.summary}</p>` : ''}
    <div class="kpis taste-kpis">
      ${kpi(vs ? fmtNumber(vs.your_avg, 2) : '—', 'Your average', diffText)}
      ${kpi(t.favourite_decade ? t.favourite_decade.name : '—', 'Favourite decade', t.favourite_decade ? plural(t.favourite_decade.shows, 'show') : '')}
      ${kpi(t.favourite_season ? capitalize(t.favourite_season.name) : '—', 'Favourite season', t.favourite_season ? plural(t.favourite_season.shows, 'show') : '')}
    </div>
    <div class="taste-grid">
      <div><h3>Genres</h3>${weightBars(t.top_genres, 'No genres yet.')}</div>
      <div><h3>Studios</h3>${weightBars(t.top_studios, 'No studios yet.')}</div>
      <div><h3>Format</h3>${formatSplit(t.format_split)}<h3 class="taste-sub-h">Seasons</h3>${weightBars(t.seasons, 'No season data.')}</div>
      <div><h3>Hidden gems</h3><p class="faint small taste-note">You scored these far above MyAnimeList.</p>${pickList(t.hidden_gems, 'None yet.')}</div>
      <div><h3>Hot takes</h3><p class="faint small taste-note">You scored these far below MyAnimeList.</p>${pickList(t.hot_takes, 'None yet.')}</div>
    </div>`;
}

/** Append the taste section to `container` and fill it. Failing quietly keeps Stats usable. */
export function mountTaste(container) {
  if (!container) return;
  const section = document.createElement('section');
  section.className = 'panel taste-panel';
  section.setAttribute('aria-label', 'Your taste');
  setHTML(section, html`<div class="panel-head"><h2>Your taste</h2></div><p class="inline-hint">Working out your taste…</p>`);
  container.appendChild(section);
  api.taste()
    .then((t) => { if (section.isConnected) setHTML(section, draw(t)); })
    .catch(() => section.remove());
}
