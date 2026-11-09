import { api } from '../api.js';
import { mountTaste } from '../taste.js';
import {
  html, setHTML, emptyState, errorBox, fmtNumber, STATUS_ORDER, STATUS_LABELS, plural, countUp,
} from '../ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function level(count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

function heatmap(activity) {
  const counts = new Map((activity || []).map((a) => [a.date, a.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = localIso(today);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday

  const cells = [];
  const months = [];
  let col = 0;
  let first = true;
  let lastMonth = -1;
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const row = (d.getDay() + 6) % 7;
    if (row === 0 && !first) col += 1;
    first = false;
    if (row === 0 && d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      months.push({ col, label: MONTHS[d.getMonth()] });
    }
    const iso = localIso(d);
    const count = counts.get(iso) || 0;
    cells.push({ iso, count, row, col });
  }

  const dayLabels = [['Mon', 0], ['Wed', 2], ['Fri', 4]];
  return html`<div class="heatmap-wrap"><div class="heatmap" role="img" aria-label="Episodes watched per day over the last year">
    ${months.map((m) => html`<span class="hm-month" style="grid-column:${m.col + 1}">${m.label}</span>`)}
    ${dayLabels.map(([label, row]) => html`<span class="hm-day" style="top:${16 + 3 + row * 15}px">${label}</span>`)}
    ${cells.map((c) => html`<span class="hm-cell l${level(c.count)} ${c.iso === todayIso ? 'today' : ''}"
      style="grid-row:${c.row + 2};grid-column:${c.col + 1};animation-delay:${c.col * 8}ms"
      title="${c.count ? plural(c.count, 'episode') : 'No episodes'} on ${c.iso}"></span>`)}
  </div></div>
  <div class="hm-legend">Less <span class="hm-cell"></span><span class="hm-cell l1"></span><span class="hm-cell l2"></span><span class="hm-cell l3"></span><span class="hm-cell l4"></span> More</div>`;
}

function monthlyChart(monthly) {
  const data = monthly || [];
  if (!data.length) return html`<p class="muted">No data yet.</p>`;
  // The SVG scales to its card; a narrower drawing on phones keeps the 12px ticks readable.
  const width = window.matchMedia('(max-width: 640px)').matches ? 340 : 640;
  const height = window.matchMedia('(max-width: 640px)').matches ? 200 : 196;
  const pad = { top: 10, bottom: 26, left: 34, right: 4 };
  const maxValue = Math.max(0, ...data.map((m) => m.episodes || 0));
  const step = niceStep(maxValue);
  const top = Math.max(step, Math.ceil((maxValue + 0.0001) / step) * step); // top tick above the maximum
  const ticks = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  const usable = height - pad.top - pad.bottom;
  const slot = (width - pad.left - pad.right) / data.length;
  const barW = Math.min(28, slot * 0.56);
  const yOf = (v) => pad.top + usable - (v / top) * usable;
  const last = data.length - 1;

  const grid = ticks.map((t) => html`<g>
    <line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${pad.left}" x2="${width - pad.right}" y1="${yOf(t).toFixed(1)}" y2="${yOf(t).toFixed(1)}"></line>
    <text class="tick" x="${pad.left - 8}" y="${(yOf(t) + 4).toFixed(1)}" text-anchor="end">${t}</text>
  </g>`);
  const bars = data.map((m, i) => {
    const [y, mo] = String(m.month).split('-').map(Number);
    const label = MONTHS[(mo || 1) - 1] || m.month;
    const value = m.episodes || 0;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const h = (value / top) * usable;
    return html`<g>
      ${value > 0 ? html`<rect class="bar" x="${x.toFixed(1)}" y="${yOf(value).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${label} ${y}: ${plural(value, 'episode')}</title></rect>` : ''}
      ${i % 2 === last % 2 ? html`<text class="tick" x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${label}</text>` : ''}
    </g>`;
  });

  return html`<div class="bar-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Episodes watched per month">${grid}${bars}</svg></div>`;
}

/** Round, even steps (1, 2, 5, 10 …) giving about four intervals. */
function niceStep(max) {
  const raw = Math.max(1, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw) || mag * 10;
  return Math.max(1, Math.round(step));
}

function hbars(items) {
  if (!items || !items.length) return html`<p class="muted">Nothing here yet.</p>`;
  const max = Math.max(1, ...items.map((g) => g.count));
  return html`<div class="hbars">${items.map((g, i) => html`<div class="hbar ${i === 0 ? 'lead' : ''}">
    <div class="hb-top"><span class="hb-label" title="${g.name}">${g.name}</span><span class="hb-val num">${g.count}</span></div>
    <div class="hb-track"><div class="hb-fill" style="width:${((g.count / max) * 100).toFixed(1)}%"></div></div>
  </div>`)}</div>`;
}

function scoreBars(dist) {
  const values = Array.from({ length: 10 }, (_, i) => Number((dist || {})[String(i + 1)] || 0));
  const max = Math.max(1, ...values);
  const none = !values.some((v) => v > 0);
  return html`<div class="vbars">${values.map((v, i) => html`<div class="vbar" title="${plural(v, 'anime', 'anime')} scored ${i + 1}">
    <span class="vb-val num">${v}</span>
    <div class="vb-fill" style="height:${v ? Math.max(4, (v / max) * 110) : 0}px"></div>
    <span class="vb-label num">${i + 1}</span>
  </div>`)}</div>${none ? html`<p class="faint small kv-note">Nothing scored yet. Score anime from 1 to 10 on their pages.</p>` : ''}`;
}

function statusBreakdown(counts) {
  return html`<table class="kv-table"><tbody>${STATUS_ORDER.map((s) => html`<tr>
    <td><span class="dot status-${s}"></span>${STATUS_LABELS[s]}</td><td class="num">${(counts || {})[s] || 0}</td>
  </tr>`)}</tbody></table>`;
}

function kpi(value, label, sub, target = null, digits = 0, lead = false) {
  const counting = typeof target === 'number' && Number.isFinite(target);
  return html`<div class="kpi ${lead ? 'kpi-lead' : ''}"><div class="kpi-label">${label}</div>
    <div class="kpi-value num ${value === '—' ? 'missing' : ''}" ${counting ? html`data-count="${target}" data-digits="${digits}"` : ''}>${value}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

export function render(root) {
  setHTML(root, html`
    <header class="page-head"><h1>Stats</h1><p id="stats-sub">Everything you've watched, added up.</p></header>
    <div id="stats-body"><p class="inline-hint">Crunching the numbers…</p></div>
  `);
  const body = root.querySelector('#stats-body');

  async function load() {
    try {
      const s = await api.stats();
      if (!body.isConnected) return;
      if (!s.total_entries) {
        setHTML(body, emptyState({
          title: 'No stats yet',
          text: 'Add some anime and mark the episodes you have watched — your stats will come alive here.',
          action: html`<a class="btn btn-primary" href="#/search">Find anime</a>`,
        }));
        return;
      }
      const counts = s.status_counts || {};
      const streak = s.streak || { current: 0, longest: 0 };
      const sub = root.querySelector('#stats-sub');
      if (sub) {
        sub.textContent = `${fmtNumber(s.episodes_watched)} episodes across ${plural(s.total_entries, 'anime', 'anime')} · `
          + `current streak ${plural(streak.current || 0, 'day')} (longest ${plural(streak.longest || 0, 'day')})`;
      }
      const mean = typeof s.mean_score === 'number' ? s.mean_score : null;
      setHTML(body, html`
        <section class="kpis" aria-label="Totals">
          ${kpi(fmtNumber(s.hours_watched, 1), 'Hours watched', `${fmtNumber(s.days_watched, 1)} days`, Number(s.hours_watched) || 0, 1, true)}
          ${kpi(fmtNumber(s.episodes_watched), 'Episodes', `on ${plural(s.total_entries, 'show')}`, Number(s.episodes_watched) || 0)}
          ${kpi(fmtNumber(counts.completed || 0), 'Done', `${fmtNumber(s.completed_this_year || 0)} this year`, counts.completed || 0)}
          ${kpi(mean !== null ? fmtNumber(mean, 2) : '—', 'Mean score', mean !== null ? 'out of 10' : 'nothing scored yet', mean, 2)}
          ${kpi(fmtNumber(streak.current || 0), 'Day streak', `longest ${fmtNumber(streak.longest || 0)}`, streak.current || 0)}
        </section>
        <div class="stats-grid">
          <section class="panel stats-main">
            <div class="panel-head"><h2>Episodes per month</h2><span class="muted small">Last 12 months</span></div>
            ${monthlyChart(s.monthly)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Your shelf</h2><span class="muted small">${plural(s.total_entries, 'show')}</span></div>
            ${statusBreakdown(counts)}
            <p class="faint small kv-note">${fmtNumber(s.favorites || 0)} marked as favourite</p>
          </section>
          <section class="panel span-all">
            <div class="panel-head"><h2>Activity</h2><span class="muted small">Episodes per day, last 12 months</span></div>
            ${heatmap(s.activity)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Top genres</h2></div>
            ${hbars(s.top_genres)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Your scores</h2></div>
            ${scoreBars(s.score_distribution)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Studios</h2></div>
            ${hbars(s.top_studios)}
          </section>
        </div>
      `);
      // Show the most recent weeks first when the heatmap is wider than the panel.
      const wrap = body.querySelector('.heatmap-wrap');
      if (wrap) wrap.scrollLeft = wrap.scrollWidth;
      mountTaste(body); // taste profile section (static/js/taste.js)
      body.querySelectorAll('[data-count]').forEach((el) => {
        countUp(el, Number(el.dataset.count), Number(el.dataset.digits) || 0);
      });
    } catch (err) {
      errorBox(body, err.message, load);
    }
  }

  load();
}
