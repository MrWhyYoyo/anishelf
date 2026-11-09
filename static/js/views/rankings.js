import { api } from '../api.js';
import { buildItems } from '../franchise.js';
import {
  html, setHTML, coverHtml, emptyState, errorBox, toast, pickMenu, displayTitle, TIERS, plural, replayAnimation,
} from '../ui.js';

const RANKABLE = new Set(['completed', 'watching', 'on_hold', 'dropped']);

export function render(root, params, query) {
  let tab = query.get('tab') === 'versus' ? 'versus' : 'tiers';
  let entries = [];
  let loaded = false;
  let pair = null;
  let voting = false;
  let pairToken = 0;

  setHTML(root, html`
    <header class="page-head">
      <h1>Rankings</h1>
      <p>Sort your shows into tiers, or let head-to-head battles build an Elo leaderboard.</p>
    </header>
    <div class="tabs" role="tablist" aria-label="Ranking mode" style="margin-bottom:22px">
      <button type="button" role="tab" data-tab="tiers">Tier list</button>
      <button type="button" role="tab" data-tab="versus">Versus</button>
    </div>
    <div id="r-body"></div>
  `);

  const body = root.querySelector('#r-body');

  function syncTabs() {
    root.querySelectorAll('[data-tab]').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function rankable() {
    return entries.filter((e) => RANKABLE.has(e.status));
  }

  function show() {
    syncTabs();
    if (!loaded) return;
    if (tab === 'tiers') drawTiers();
    else drawVersus();
  }

  async function load() {
    setHTML(body, html`<p class="inline-hint">Loading your shelf…</p>`);
    try {
      const data = await api.library();
      entries = data.entries || [];
      loaded = true;
      show();
    } catch (err) {
      errorBox(body, err.message, load);
    }
  }

  root.querySelector('.tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button || button.dataset.tab === tab) return;
    tab = button.dataset.tab;
    history.replaceState(null, '', tab === 'versus' ? '#/rankings?tab=versus' : '#/rankings');
    show();
  });

  /* ------------------------------------------------------------ tier list */
  // The tier list ranks whole series: every season of one anime shares one card and one tier.
  const TIER_ORDER = ['S', 'A', 'B', 'C', 'D'];

  function seriesList() {
    return buildItems(rankable(), true).map((item) => {
      // the cover of Season 1 looks best for a whole series; fall back to the latest season
      const first = item.members.find((m) => m.franchise && m.franchise.label === 'Season 1') || item.lead;
      // a series' tier is the best tier any of its seasons already has
      const tiers = item.members.map((m) => m.tier).filter(Boolean);
      const tier = TIER_ORDER.find((t) => tiers.includes(t)) || '';
      return { ...item, cover: first.meta.image, title: displayTitle(item.series || item.lead.meta), tier };
    });
  }

  function findSeries(key) {
    return seriesList().find((s) => s.key === key);
  }

  function tierItem(series) {
    const seasons = series.members.length;
    const extra = seasons > 1 ? ` (${plural(seasons, 'season')})` : '';
    return html`<div class="tier-item" draggable="true" tabindex="0" role="button" data-key="${series.key}"
      title="${series.title}${extra} — drag to a tier, or click to choose" aria-label="${series.title}${extra}, tier ${series.tier || 'unranked'}">
      ${coverHtml(series.cover, series.title)}
      <span class="tier-name">${series.title}</span>
      ${seasons > 1 ? html`<span class="tier-seasons">${seasons} seasons</span>` : ''}
    </div>`;
  }

  function unrankedText() {
    return `${plural(seriesList().filter((s) => !s.tier).length, 'series', 'series')} · drag one into a tier, or click it to choose`;
  }

  function drawTiers() {
    const list = seriesList();
    if (!list.length) {
      setHTML(body, emptyState({
        title: 'Nothing to rank yet',
        text: 'Shows you are watching, have completed, put on hold or dropped can be ranked here.',
        action: html`<a class="btn btn-primary" href="#/library">Open library</a>`,
      }));
      return;
    }
    const byTier = (t) => list.filter((s) => s.tier === t);
    setHTML(body, html`
      <div class="section-head"><h2>Waiting to be ranked</h2><span class="muted small">${unrankedText()}</span></div>
      <div class="tier-drop tier-pool" data-tier="" aria-label="Unranked">${byTier('').map(tierItem)}</div>
      <div class="tier-board">
        ${TIERS.map((t) => html`<div class="tier-row">
          <div class="tier-label tier-${t}">${t}</div>
          <div class="tier-drop" data-tier="${t}" aria-label="Tier ${t}">${byTier(t).map(tierItem)}</div>
        </div>`)}
      </div>
    `);
  }

  async function moveTier(key, tier) {
    const series = findSeries(key);
    if (!series) return;
    // seasons that still need changing (one season may already have this tier)
    const toChange = series.members.filter((m) => (m.tier || '') !== tier);
    if (!toChange.length && series.tier === tier) return;
    const item = body.querySelector(`.tier-item[data-key="${key}"]`);
    const zone = body.querySelector(`.tier-drop[data-tier="${tier}"]`);
    if (item && zone) {
      zone.appendChild(item);
      item.classList.add('saving');
      replayAnimation(item, 'drop-in');
    }
    try {
      for (const member of toChange) {  // one request per season, a series has at most a handful
        const { entry: updated } = await api.patch(member.mal_id, { tier: tier || null });
        entries = entries.map((e) => (e.mal_id === updated.mal_id ? updated : e));
      }
      if (item) item.classList.remove('saving');
      toast(tier ? `${series.title} → ${tier} tier` : `${series.title} unranked`, 'success', 1800);
      if (tab === 'tiers') {
        const countEl = body.querySelector('.section-head .muted');
        if (countEl) countEl.textContent = unrankedText();
      }
    } catch (err) {
      toast(err.message, 'error');
      if (tab === 'tiers') drawTiers();
    }
  }

  let dragId = null;
  body.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.tier-item');
    if (!item) return;
    dragId = item.dataset.key;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
  });
  body.addEventListener('dragend', (event) => {
    const item = event.target.closest('.tier-item');
    if (item) item.classList.remove('dragging');
    body.querySelectorAll('.tier-drop.over').forEach((z) => z.classList.remove('over'));
    dragId = null;
  });
  body.addEventListener('dragover', (event) => {
    const zone = event.target.closest('.tier-drop');
    if (!zone || dragId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    body.querySelectorAll('.tier-drop.over').forEach((z) => { if (z !== zone) z.classList.remove('over'); });
    zone.classList.add('over');
  });
  body.addEventListener('dragleave', (event) => {
    const zone = event.target.closest('.tier-drop');
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('over');
  });
  body.addEventListener('drop', (event) => {
    const zone = event.target.closest('.tier-drop');
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove('over');
    const key = event.dataTransfer.getData('text/plain') || dragId;
    if (key) moveTier(key, zone.dataset.tier);
  });

  async function chooseTier(item) {
    const series = findSeries(item.dataset.key);
    if (!series) return;
    const choice = await pickMenu(item, [
      ...TIERS.map((t) => ({ value: t, label: `Tier ${t}`, current: series.tier === t })),
      { value: '', label: 'Unranked', current: !series.tier },
      { value: 'open', label: 'Open anime page →' },
    ]);
    if (choice === undefined) return;
    if (choice === 'open') { window.location.hash = `#/anime/${series.lead.mal_id}`; return; }
    moveTier(series.key, choice);
  }

  /* ------------------------------------------------------------ versus */
  function drawVersus() {
    setHTML(body, html`
      <div id="vs-stage"><p class="inline-hint" style="text-align:center">Finding a matchup…</p></div>
      <section class="panel" style="margin-top:34px">
        <div class="panel-head"><h2>Leaderboard</h2><span class="muted small">Elo rating from your battles</span></div>
        <div id="leaderboard"></div>
      </section>
    `);
    drawLeaderboard();
    loadPair();
  }

  function vsCard(entry, side) {
    const title = displayTitle(entry.meta);
    return html`<button type="button" class="vs-card" data-side="${side}" aria-label="${title} wins">
      ${coverHtml(entry.meta.image, title)}
      <span class="vs-title">${title}</span>
      <span class="muted small">${entry.score ? `Your score: ${entry.score}/10` : 'Not scored'} · ${plural(entry.matches || 0, 'battle')}</span>
    </button>`;
  }

  async function loadPair() {
    const token = ++pairToken;
    const stage = body.querySelector('#vs-stage');
    if (!stage) return;
    try {
      const data = await api.versus();
      if (token !== pairToken || !stage.isConnected) return;
      pair = data.pair;
      if (!pair) {
        setHTML(stage, emptyState({
          title: 'Not enough contenders',
          text: data.reason || 'Finish or start watching at least two anime to battle them.',
          action: html`<a class="btn btn-primary" href="#/library">Open library</a>`,
        }));
        return;
      }
      setHTML(stage, html`
        <div class="versus">
          ${vsCard(pair[0], 0)}
          <div class="vs-badge" aria-hidden="true">VS</div>
          ${vsCard(pair[1], 1)}
        </div>
        <p class="vs-hint">Which one is better? Click it — or press <span class="kbd">←</span> / <span class="kbd">→</span>.</p>`);
      voting = false;
    } catch (err) {
      if (token !== pairToken) return;
      errorBox(stage, err.message, loadPair);
    }
  }

  async function vote(side) {
    if (voting || !pair || tab !== 'versus') return;
    voting = true;
    const winner = pair[side];
    const loser = pair[1 - side];
    const stage = body.querySelector('#vs-stage');
    const cards = stage ? stage.querySelectorAll('.vs-card') : [];
    cards.forEach((c) => { c.disabled = true; });
    try {
      const result = await api.vote(winner.mal_id, loser.mal_id);
      [result.winner, result.loser].forEach((updated) => {
        if (updated) entries = entries.map((e) => (e.mal_id === updated.mal_id ? updated : e));
      });
      if (cards[side]) cards[side].classList.add('win');
      if (cards[1 - side]) cards[1 - side].classList.add('lose');
      drawLeaderboard();
      setTimeout(() => { if (root.isConnected && tab === 'versus') loadPair(); }, 650);
    } catch (err) {
      toast(err.message, 'error');
      voting = false;
      cards.forEach((c) => { c.disabled = false; });
    }
  }

  function drawLeaderboard() {
    const el = body.querySelector('#leaderboard');
    if (!el) return;
    const ranked = entries.filter((e) => (e.matches || 0) > 0).sort((a, b) => b.elo - a.elo);
    if (!ranked.length) {
      setHTML(el, html`<p class="muted">Do a few battles and your personal leaderboard will appear here.</p>`);
      return;
    }
    setHTML(el, html`<table class="leaderboard">
      <thead><tr><th>#</th><th>Anime</th><th class="num">Elo</th><th class="num">Battles</th><th class="num">Score</th></tr></thead>
      <tbody>${ranked.map((e, i) => html`<tr>
        <td class="rank">${i + 1}</td>
        <td><a class="lb-title" href="#/anime/${e.mal_id}">${coverHtml(e.meta.image, displayTitle(e.meta))}<span>${displayTitle(e.meta)}</span></a></td>
        <td class="num">${Math.round(e.elo)}</td>
        <td class="num">${e.matches}</td>
        <td class="num">${e.score ?? '—'}</td>
      </tr>`)}</tbody>
    </table>`);
  }

  body.addEventListener('click', (event) => {
    const vsBtn = event.target.closest('.vs-card');
    if (vsBtn) { vote(Number(vsBtn.dataset.side)); return; }
    const item = event.target.closest('.tier-item');
    if (item) chooseTier(item);
  });
  body.addEventListener('keydown', (event) => {
    const item = event.target.closest('.tier-item');
    if (item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      chooseTier(item);
    }
  });

  const onKey = (event) => {
    if (tab !== 'versus' || event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target;
    if (t instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); vote(0); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); vote(1); }
  };
  document.addEventListener('keydown', onKey);

  syncTabs();
  load();

  return () => {
    document.removeEventListener('keydown', onKey);
    pairToken += 1;
  };
}
