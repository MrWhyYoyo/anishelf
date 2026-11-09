import { api } from '../api.js';
import {
  html, setHTML, animeCard, skeletonCards, emptyState, errorBox, toast, STATUS_LABELS, plural, confetti,
  coverHtml, displayTitle, epStrip, fmtDuration, fmtCountdown,
} from '../ui.js';
import { onePerFranchise } from '../franchise.js';
import { localTime, dayNameFor, secondsUntil } from './calendar.js';
import { askForDiary } from '../diary-note.js';
import { mountMangaCard } from '../manga-card.js';
import { mountUpNextCard } from '../upnext.js';
import { toastUndo } from '../ui.js';
import { remember, undoEpisodes } from '../undo.js'; // "Undo" on the +1 toast

/* Home answers one question: "What do I watch next?"
   The biggest block is the show you touched last, with its episode strip and a one-click +1.
   Smaller blocks under it: what airs this week, "on this day" memories and
   "continue the franchise" nudges. Each of those hides itself when it has nothing to say. */

function seasonLabel(entry) {
  return entry.franchise && entry.franchise.label ? entry.franchise.label : '';
}

/* ---------------------------------------------------------------- rewatch support
   Another feature adds `rewatching`, `rewatch_watched` and `rewatch_next_episode` to entries.
   Everything checks `entry.rewatching === true`, so Home works the same without it. */
function isRewatch(entry) {
  return entry.rewatching === true;
}

/** Watched episodes and the next one, for a normal watch or a rewatch. */
function progressOf(entry) {
  if (!isRewatch(entry)) {
    return { watched: entry.watched, count: entry.watched_count, next: entry.next_episode };
  }
  const list = Array.isArray(entry.rewatch_watched) ? entry.rewatch_watched : [];
  // rewatch_watched may be a list of episodes or just a number; handle both
  const count = Array.isArray(entry.rewatch_watched) ? list.length : (Number(entry.rewatch_watched) || 0);
  return { watched: list, count, next: entry.rewatch_next_episode ?? null };
}

function leadBlock(entry) {
  const m = entry.meta;
  const { watched, count, next } = progressOf(entry);
  const total = entry.total;
  const left = total ? Math.max(0, total - count) : null;
  const minutes = m.duration_min && left ? left * m.duration_min : null;
  const season = seasonLabel(entry);
  const rewatch = isRewatch(entry);
  return html`<div class="home-next">
    <a href="#/anime/${entry.mal_id}" aria-label="${displayTitle(m)}">${coverHtml(m.image, displayTitle(m))}</a>
    <div class="next-body">
      <h2><a href="#/anime/${entry.mal_id}">${displayTitle(m)}</a></h2>
      <p class="meta">${[rewatch ? 'Rewatching' : null, season, `${count} of ${total ?? '?'} episodes`, minutes ? `${fmtDuration(minutes)} left` : null].filter(Boolean).join(' · ')}</p>
      ${epStrip({ watched, watchedCount: count, total, next, max: 80 })}
      <div class="next-actions">
        ${next ? html`<button type="button" class="btn btn-primary" data-plus="${entry.mal_id}" data-ep="${next}" ${rewatch ? 'data-rewatch' : ''}>Mark episode ${next} watched</button>` : ''}
        <a class="btn" href="#/anime/${entry.mal_id}">Open</a>
      </div>
    </div>
  </div>`;
}

function queueRow(entry) {
  const m = entry.meta;
  const season = seasonLabel(entry);
  const { count, next } = progressOf(entry);
  return html`<a class="queue-row" href="#/anime/${entry.mal_id}">
    ${coverHtml(m.image, displayTitle(m))}
    <span class="q-text"><span class="q-title">${displayTitle(m)}</span>
      <span class="q-sub">${[isRewatch(entry) ? 'Rewatching' : null, season, next ? `Episode ${next} next` : 'Up to date'].filter(Boolean).join(' · ')}</span></span>
    <span class="q-num">${count}/${entry.total ?? '?'}</span>
  </a>`;
}

/* ---------------------------------------------------------------- small Home blocks */
function memoryRow(memory) {
  const m = memory.meta;
  return html`<a class="memory-row" href="#/anime/${memory.mal_id}">
    ${coverHtml(m.image, displayTitle(m))}
    <span class="memory-text">${memory.when} ${memory.action} <strong>${displayTitle(m)}</strong></span>
  </a>`;
}

function airingRow(item) {
  const m = item.meta;
  return html`<a class="queue-row" href="#/anime/${item.mal_id}">
    ${coverHtml(m.image, displayTitle(m))}
    <span class="q-text"><span class="q-title">${displayTitle(m)}</span>
      <span class="q-sub">Episode ${item.episode} · ${dayNameFor(item.airing_at)} ${localTime(item.airing_at)}</span></span>
    <span class="q-num" data-airs="${item.airing_at}">${fmtCountdown(secondsUntil(item.airing_at))}</span>
  </a>`;
}

function nudgeText(nudge) {
  const from = `${displayTitle(nudge.from)}${nudge.from.label && nudge.from.label !== 'Season 1' ? ` ${nudge.from.label}` : ''}`;
  const where = nudge.next.library_status === 'plan_to_watch' ? 'is on your shelf' : 'is out';
  return `You finished ${from}, and ${nudge.next.label} ${where}.`;
}

function nudgeRow(nudge) {
  const n = nudge.next;
  const planned = n.library_status === 'plan_to_watch';
  return html`<div class="nudge-row">
    <a href="#/anime/${n.mal_id}" aria-label="${displayTitle(n)}">${coverHtml(n.image, displayTitle(n))}</a>
    <span class="q-text">
      <span class="nudge-text">${nudgeText(nudge)}</span>
      <a class="q-sub" href="#/anime/${n.mal_id}">${[displayTitle(n), n.episodes ? plural(n.episodes, 'episode') : null, n.year].filter(Boolean).join(' · ')}</a>
    </span>
    ${planned
      ? html`<button type="button" class="btn btn-sm" data-nudge-start="${n.mal_id}">Start</button>`
      : html`<button type="button" class="btn btn-sm" data-nudge-add="${n.mal_id}">Add</button>`}
  </div>`;
}

/* ---------------------------------------------------------------- quests (another feature) */
/** Mount the daily quests card. Returns a promise of its cleanup (it listens to app events). */
async function mountQuests(section) {
  try {
    const mod = await import('../quests.js');
    if (section.isConnected && typeof mod.mountQuestsCard === 'function') return mod.mountQuestsCard(section);
  } catch {
    /* quests unavailable: leave the slot empty */
  }
  return null;
}

export function render(root) {
  setHTML(root, html`
    <header class="page-head">
      <h1>Home</h1>
      <p id="home-sub">What to watch next, and what's airing.</p>
    </header>

    <section id="home-quests"></section>
    <section id="home-manga"></section>
    <section id="home-upnext" hidden></section>

    <div class="home-top" id="cw">
      <section class="panel"><div class="panel-head"><h2>Continue watching</h2></div><div class="sk-line" style="height:180px"></div></section>
      <section class="panel"><div class="panel-head"><h2>Also in progress</h2></div><div class="sk-line" style="height:120px"></div></section>
    </div>

    <div class="home-extras">
      <section class="panel" id="home-airing" hidden>
        <div class="panel-head"><h2>Airing this week</h2><a class="muted small" href="#/calendar">Full calendar</a></div>
        <div class="queue-list" id="home-airing-list"></div>
      </section>
      <section class="panel" id="home-memories" hidden>
        <div class="panel-head"><h2>On this day</h2></div>
        <div class="memory-list" id="home-memories-list"></div>
      </section>
    </div>

    <section class="panel home-nudges" id="home-nudges" hidden>
      <div class="panel-head"><h2>Continue the franchise</h2></div>
      <div class="nudge-list" id="home-nudges-list"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>This season</h2><a href="#/search">Search anime</a></div>
      <div id="season" class="grid">${skeletonCards(12)}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Top airing</h2></div>
      <div id="top" class="grid">${skeletonCards(12)}</div>
    </section>
  `);

  const cw = root.querySelector('#cw');
  const seasonEl = root.querySelector('#season');
  const topEl = root.querySelector('#top');
  const sub = root.querySelector('#home-sub');
  const airingEl = root.querySelector('#home-airing');
  const memoriesEl = root.querySelector('#home-memories');
  const nudgesEl = root.querySelector('#home-nudges');
  let watching = [];
  let planned = [];
  let nudges = [];
  let countdownTimer = null;

  function drawContinue() {
    if (!watching.length) {
      // Nothing in progress: the answer becomes "start the next one on your list".
      if (!planned.length) {
        setHTML(cw, html`<section class="panel" style="grid-column:1/-1">
          <div class="panel-head"><h2>Continue watching</h2></div>
          ${emptyState({
            title: 'Nothing in progress',
            text: 'Mark a show as Watching and its next episode will wait for you here.',
            action: html`<a class="btn btn-primary" href="#/search">Find anime</a>`,
          })}
        </section>`);
        sub.textContent = 'Nothing in progress and nothing planned yet.';
        return;
      }
      const [first, ...others] = planned;
      const m = first.meta;
      setHTML(cw, html`
        <section class="panel">
          <div class="panel-head"><h2>Start next</h2><a class="muted small" href="#/library?status=plan_to_watch">Want to watch</a></div>
          <div class="home-next">
            <a href="#/anime/${first.mal_id}" aria-label="${displayTitle(m)}">${coverHtml(m.image, displayTitle(m))}</a>
            <div class="next-body">
              <h2><a href="#/anime/${first.mal_id}">${displayTitle(m)}</a></h2>
              <p class="meta">${[seasonLabel(first), first.total ? plural(first.total, 'episode') : null, m.duration_min ? `${m.duration_min} min each` : null].filter(Boolean).join(' · ')}</p>
              ${epStrip({ watched: first.watched, total: first.total, next: 1, max: 80 })}
              <div class="next-actions">
                <button type="button" class="btn btn-primary" data-start="${first.mal_id}">Start watching</button>
                <a class="btn" href="#/anime/${first.mal_id}">Open</a>
              </div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Also on your list</h2><span class="muted small">${others.length}</span></div>
          ${others.length ? html`<div class="queue-list">${others.slice(0, 5).map(queueRow)}</div>` : html`<p class="muted">Nothing else planned.</p>`}
        </section>`);
      sub.textContent = `Nothing in progress · ${plural(planned.length, 'show')} on your Want to watch list.`;
      return;
    }
    const [lead, ...rest] = watching;
    setHTML(cw, html`
      <section class="panel">
        <div class="panel-head"><h2>Continue watching</h2><a class="muted small" href="#/library?status=watching">All in progress</a></div>
        ${leadBlock(lead)}
      </section>
      ${rest.length
        ? html`<section class="panel">
            <div class="panel-head"><h2>Also in progress</h2><span class="muted small">${rest.length}</span></div>
            <div class="queue-list">${rest.slice(0, 5).map(queueRow)}</div>
          </section>`
        : html`<section class="panel">
            <div class="panel-head"><h2>Next on your list</h2><a class="muted small" href="#/library?status=plan_to_watch">${plural(planned.length, 'show')}</a></div>
            ${planned.length
              ? html`<div class="queue-list">${planned.slice(0, 5).map(queueRow)}</div>`
              : html`<p class="muted">Nothing planned. Add shows from Find anime.</p>`}
          </section>`}`);
    const leadNext = progressOf(lead).next;
    const nextText = leadNext ? `episode ${leadNext} of ${displayTitle(lead.meta)} is next` : `${displayTitle(lead.meta)} is up to date`;
    sub.textContent = `${plural(watching.length, 'show')} in progress · ${nextText}.`;
  }

  async function loadContinue() {
    try {
      const { entries = [] } = await api.library();
      if (!root.isConnected) return;
      // One per series: the season being watched (or the planned season touched last).
      // Rewatches count as "in progress" too (they keep status Completed).
      watching = onePerFranchise(entries.filter((e) => e.status === 'watching' || isRewatch(e)));
      planned = onePerFranchise(entries.filter((e) => e.status === 'plan_to_watch'));
      drawContinue();
    } catch (err) {
      errorBox(cw, err.message, loadContinue);
    }
  }

  // The extra blocks are nice-to-have: on any error they simply stay hidden.
  async function loadAiring() {
    try {
      const data = await api.calendar();
      if (!root.isConnected) return;
      // "this week" means the next 7 days, so later episodes are left out
      const weekEnd = Date.now() / 1000 + 7 * 86400;
      const upcoming = (data.upcoming || []).filter((item) => item.airing_at < weekEnd).slice(0, 3);
      if (!upcoming.length) return;
      setHTML(root.querySelector('#home-airing-list'), html`${upcoming.map(airingRow)}`);
      airingEl.hidden = false;
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        root.querySelectorAll('[data-airs]').forEach((el) => {
          el.textContent = fmtCountdown(secondsUntil(Number(el.dataset.airs)));
        });
      }, 30000);
    } catch {
      airingEl.hidden = true;
    }
  }

  async function loadMemories() {
    try {
      const { memories = [] } = await api.memories();
      if (!root.isConnected || !memories.length) return;
      setHTML(root.querySelector('#home-memories-list'), html`${memories.map(memoryRow)}`);
      memoriesEl.hidden = false;
    } catch {
      memoriesEl.hidden = true;
    }
  }

  function drawNudges() {
    nudgesEl.hidden = nudges.length === 0;
    setHTML(root.querySelector('#home-nudges-list'), html`${nudges.map(nudgeRow)}`);
  }

  async function loadNudges() {
    try {
      const data = await api.nudges();
      if (!root.isConnected) return;
      nudges = data.nudges || [];
      drawNudges();
    } catch {
      nudgesEl.hidden = true;
    }
  }

  async function loadDiscover() {
    setHTML(seasonEl, skeletonCards(12));
    setHTML(topEl, skeletonCards(12));
    try {
      const { season = [], top_airing: top = [] } = await api.discover();
      setHTML(seasonEl, season.length
        ? html`${season.map((m) => animeCard(m))}`
        : emptyState({ title: 'Nothing listed for this season yet' }));
      setHTML(topEl, top.length
        ? html`${top.map((m) => animeCard(m))}`
        : emptyState({ title: 'No airing shows found' }));
    } catch (err) {
      errorBox(seasonEl, err.message, loadDiscover);
      setHTML(topEl, '');
    }
  }

  nudgesEl.addEventListener('click', async (event) => {
    const start = event.target.closest('[data-nudge-start]');
    const add = event.target.closest('[data-nudge-add]');
    const button = start || add;
    if (!button) return;
    const id = Number(start ? start.dataset.nudgeStart : add.dataset.nudgeAdd);
    button.disabled = true;
    try {
      if (start) {
        await api.patch(id, { status: 'watching' });
        toast('Moved to Watching', 'success');
        loadContinue();
      } else {
        await api.add(id, 'plan_to_watch');
        toast('Added to Want to watch', 'success');
      }
      nudges = nudges.filter((n) => n.next.mal_id !== id);
      drawNudges();
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    }
  });

  cw.addEventListener('click', async (event) => {
    const start = event.target.closest('[data-start]');
    if (start) {
      start.disabled = true;
      try {
        await api.patch(Number(start.dataset.start), { status: 'watching' });
        toast('Moved to Watching', 'success');
        loadContinue();
      } catch (err) {
        toast(err.message, 'error');
        if (start.isConnected) start.disabled = false;
      }
      return;
    }
    const button = event.target.closest('[data-plus]');
    if (!button) return;
    event.preventDefault();
    const id = Number(button.dataset.plus);
    const ep = Number(button.dataset.ep);
    button.disabled = true;
    try {
      // A rewatch marks one episode on the rewatch track; a first watch marks everything up to it.
      const rewatching = button.hasAttribute('data-rewatch');
      const body = rewatching
        ? { action: 'toggle', episode: ep, target: 'rewatch' }
        : { action: 'up_to', episode: ep };
      const undoState = remember(watching.find((e) => e.mal_id === id)); // the card's entry before +1
      const result = await api.updateEpisodes(id, body);
      const { entry, status_changed: changed } = result;
      // A finished rewatch ends rewatch mode on the server, which a simple reverse can't undo
      if (undoState && !result.rewatch_finished) toastUndo(`Episode ${ep} watched`, () => undoEpisodes(undoState));
      else toast(`Episode ${ep} watched`, 'success');
      const title = displayTitle(entry.meta);
      if (result.rewatch_finished) {
        toast('Rewatch finished', 'success');
        askForDiary({ malId: id, animeTitle: title, rewatch: entry.rewatch_count });
      } else if (changed === 'completed') {
        askForDiary({ malId: id, animeTitle: title });
      }
      if (changed) {
        if (changed === 'completed') confetti(button);
        toast(changed === 'completed' ? 'Finished. Moved to Done' : `Moved to ${STATUS_LABELS[changed] || changed}`, 'success');
      }
      watching = entry.status === 'watching' || entry.rewatching === true
        ? watching.map((e) => (e.mal_id === id ? entry : e))
        : watching.filter((e) => e.mal_id !== id);
      drawContinue();
      if (changed === 'completed') loadNudges(); // finishing a season may unlock a nudge
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    }
  });

  const questsCleanup = mountQuests(root.querySelector('#home-quests'));
  const mangaCleanup = mountMangaCard(root.querySelector('#home-manga')); // hides itself when nothing is being read
  const upNextCleanup = mountUpNextCard(root.querySelector('#home-upnext')); // top 3 of the Up Next queue
  loadContinue();
  loadAiring();
  loadMemories();
  loadNudges();
  loadDiscover();

  return () => {
    clearInterval(countdownTimer);
    questsCleanup.then((stop) => { if (typeof stop === 'function') stop(); });
    mangaCleanup();
    upNextCleanup();
  };
}
