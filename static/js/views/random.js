import { api } from '../api.js';
import {
  html, setHTML, coverHtml, emptyState, errorBox, toast, displayTitle, plural, icon, STATUS_LABELS,
} from '../ui.js';

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Same list the backend accepts for source=discover (replaced by the server's list once it answers).
let DISCOVER_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery',
  'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];

// Moods map to genre sets on the server (see MOODS in anishelf/watching.py and docs/API.md).
// The hint only explains the choice; the server decides which shows match.
const MOODS = [
  { id: 'any', label: 'Any', hint: 'No mood filter' },
  { id: 'chill', label: 'Chill', hint: 'Slice of Life, Iyashikei, Comedy' },
  { id: 'hype', label: 'Hype', hint: 'Action, Sports, Mecha' },
  { id: 'sad', label: 'Sad', hint: 'Drama' },
  { id: 'brain', label: 'Brain', hint: 'Mystery, Psychological, Thriller, Sci-Fi' },
  { id: 'laugh', label: 'Laugh', hint: 'Comedy, Gag Humor, Parody' },
];

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Library entries have .meta; discover results are Meta objects themselves. */
const metaOf = (item) => (item && item.meta ? item.meta : item);

function frame(item, cls) {
  const m = metaOf(item);
  return html`<div class="slot-frame ${cls}">
    ${coverHtml(m.image, displayTitle(m))}
    <div class="slot-title">${displayTitle(m)}</div>
  </div>`;
}

export function render(root) {
  setHTML(root, html`
    <header class="page-head">
      <h1>What should I watch tonight?</h1>
      <p id="rf-sub">Can't decide? Let fate pick something for you.</p>
    </header>
    <div class="random-layout">
      <form class="panel random-filters" id="rf">
        <div class="segmented segmented-full" role="group" aria-label="Pick from">
          <button type="button" data-source="mine">From my list</button>
          <button type="button" data-source="discover">Surprise me</button>
        </div>
        <div class="field"><span id="rf-mood-label">Mood</span>
          <div class="mood-picker" role="radiogroup" aria-labelledby="rf-mood-label">
            ${MOODS.map((m) => html`<button type="button" role="radio" data-mood="${m.id}" title="${m.hint}">${m.label}</button>`)}
          </div>
        </div>
        <label class="field"><span>Genre</span>
          <select name="genre" id="rf-genre"><option value="">Any genre</option></select>
        </label>
        <label class="field"><span>Length</span>
          <select name="max_episodes">
            <option value="">Any length</option>
            <option value="1">Movie / one-shot</option>
            <option value="13">Up to 13 episodes</option>
            <option value="26">Up to 26 episodes</option>
            <option value="52">Up to 52 episodes</option>
          </select>
        </label>
        <label class="check" id="rf-onhold"><input type="checkbox" name="on_hold"> Include Paused shows</label>
        <button type="submit" class="btn btn-primary btn-lg" id="rf-spin">Spin</button>
        <p class="faint small" id="rf-count"></p>
      </form>
      <div class="slot-stage" id="stage" aria-live="polite">
        <div class="slot-idle"><h2>Loading your list</h2><p class="muted">One moment.</p></div>
      </div>
    </div>
  `);

  const form = root.querySelector('#rf');
  const stage = root.querySelector('#stage');
  const spinBtn = root.querySelector('#rf-spin');
  const genreSelect = root.querySelector('#rf-genre');
  const countEl = root.querySelector('#rf-count');
  const onHoldEl = root.querySelector('#rf-onhold');
  const subEl = root.querySelector('#rf-sub');

  let source = 'discover';
  let mood = 'any';
  let entries = [];
  let libraryGenres = [];
  let token = 0;
  let timer = null;
  let pick = null;          // library Entry (mine) or Meta (discover)
  let pickStatus = null;    // discover: library status after adding

  function planned(includeOnHold) {
    return entries.filter((e) => e.status === 'plan_to_watch' || (includeOnHold && e.status === 'on_hold'));
  }

  function fillGenres(list) {
    const previous = genreSelect.value;
    setHTML(genreSelect, html`<option value="">Any genre</option>${list.map((g) => html`<option value="${g}">${g}</option>`)}`);
    genreSelect.value = list.includes(previous) ? previous : '';
  }

  function applySource() {
    root.querySelectorAll('[data-source]').forEach((b) => {
      const active = b.dataset.source === source;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    onHoldEl.hidden = source === 'discover';
    if (source === 'discover') {
      fillGenres(DISCOVER_GENRES);
      subEl.textContent = 'Discover a popular anime you haven’t added yet.';
      countEl.textContent = 'Picks from popular anime that are not on your shelf.';
    } else {
      fillGenres(libraryGenres);
      subEl.textContent = 'Let fate pick something from your Want to watch list.';
      const n = planned(false).length;
      countEl.textContent = n
        ? `${plural(n, 'show')} on your Want to watch list.`
        : 'Your Want to watch list is empty. Try "Surprise me" instead.';
    }
    drawIdle();
  }

  /** Before the first spin, the stage shows what's in the draw instead of a blank box. */
  function drawIdle() {
    if (pick || !stage.querySelector('.slot-idle, .slot-frame.idle')) return;
    const pool = source === 'mine' ? planned(Boolean(form.querySelector('[name="on_hold"]').checked)) : [];
    setHTML(stage, html`<div class="slot-idle">
      <h2>${source === 'mine' ? `In the draw: ${plural(pool.length, 'show')}` : 'A popular anime you have not added'}</h2>
      <p class="muted">${source === 'mine'
        ? (pool.length ? 'Set a genre or length, then spin.' : 'Your Want to watch list is empty.')
        : 'Pick a genre or length, then spin.'}</p>
      ${pool.length ? html`<div class="idle-covers">${pool.slice(0, 8).map((e) => coverHtml(e.meta.image, displayTitle(e.meta)))}</div>` : ''}
    </div>`);
  }

  async function loadLibrary() {
    try {
      const data = await api.library();
      if (!root.isConnected) return;
      entries = data.entries || [];
      const pool = entries.filter((e) => e.status === 'plan_to_watch' || e.status === 'on_hold');
      libraryGenres = [...new Set(pool.flatMap((e) => (e.meta && e.meta.genres) || []))].sort((a, b) => a.localeCompare(b));
      source = planned(false).length ? 'mine' : 'discover';
      applySource();
    } catch (err) {
      countEl.textContent = `Couldn't load your library: ${err.message}`;
      applySource();
    }
  }

  function resultActions() {
    if (source === 'mine') {
      return html`<button type="button" class="btn btn-primary" data-act="start-mine">${icon('play')} Start watching</button>
        <a class="btn" href="#/anime/${pick.mal_id}">Open page</a>
        <button type="button" class="btn btn-ghost" data-act="again">Spin again</button>`;
    }
    if (pickStatus) {
      return html`<span class="chip">In your list · ${STATUS_LABELS[pickStatus] || pickStatus}</span>
        <a class="btn btn-primary" href="#/anime/${pick.mal_id}">Open page</a>
        <button type="button" class="btn btn-ghost" data-act="again">Spin again</button>`;
    }
    return html`<button type="button" class="btn btn-primary" data-act="add" data-status="plan_to_watch">${icon('plus')} Add to Want to watch</button>
      <button type="button" class="btn" data-act="add" data-status="watching">${icon('play')} Start watching</button>
      <a class="btn" href="#/anime/${pick.mal_id}">Open page</a>
      <button type="button" class="btn btn-ghost" data-act="again">Spin again</button>`;
  }

  function showResult() {
    const m = metaOf(pick);
    const total = pick.meta ? pick.total : m.episodes;
    const bits = [m.type, m.year, total ? plural(total, 'episode') : null, m.duration_min ? `${m.duration_min} min/ep` : null]
      .filter(Boolean).join(' · ');
    const extra = source === 'mine' && pick.status !== 'plan_to_watch' ? ` · ${STATUS_LABELS[pick.status]}` : '';
    setHTML(stage, html`<div class="slot-frame landed">
      ${coverHtml(m.image, displayTitle(m))}
      <div class="slot-title">${displayTitle(m)}</div>
      <div class="slot-meta">${bits}${extra}${source === 'discover' && typeof m.mal_score === 'number' ? ` · MAL ${m.mal_score.toFixed(2)}` : ''}</div>
      ${(m.genres || []).length ? html`<div class="chips" style="justify-content:center">${m.genres.slice(0, 5).map((g) => html`<span class="chip chip-genre">${g}</span>`)}</div>` : ''}
      <div class="slot-actions" id="slot-actions">${resultActions()}</div>
    </div>`);
  }

  function showNothing() {
    if (source === 'mine') {
      setHTML(stage, emptyState({
        title: 'Nothing matches',
        text: planned(true).length
          ? 'No shows on your list fit those filters. Try a different genre or length.'
          : 'Your Want to watch list is empty.',
        action: html`<button type="button" class="btn btn-primary" data-act="go-discover">Surprise me with something new instead</button>`,
      }));
    } else {
      setHTML(stage, emptyState({
        title: 'Nothing new found',
        text: "Couldn't find a popular anime you haven't added for those filters. Try another genre or length.",
      }));
    }
  }

  async function spin() {
    const mine = ++token;
    clearTimeout(timer);
    pick = null;
    pickStatus = null;
    const data = new FormData(form);
    const params = source === 'discover'
      ? { source: 'discover', genre: data.get('genre') || '', max_episodes: data.get('max_episodes') || '' }
      : {
        genre: data.get('genre') || '',
        max_episodes: data.get('max_episodes') || '',
        statuses: data.get('on_hold') ? 'plan_to_watch,on_hold' : 'plan_to_watch',
      };
    // "Any" means no mood filter, so the parameter is left out completely.
    if (mood !== 'any') params.mood = mood;
    spinBtn.disabled = true;
    try {
      const result = await api.random(params);
      if (mine !== token || !root.isConnected) return;
      if (source === 'discover' && Array.isArray(result.genres) && result.genres.length) {
        DISCOVER_GENRES = result.genres.slice();
        const selected = genreSelect.value;
        fillGenres(DISCOVER_GENRES);
        genreSelect.value = selected;
      }
      const candidates = (result.candidates || []).filter(Boolean);
      pick = result.pick;
      if (!pick) {
        showNothing();
        spinBtn.disabled = false;
        return;
      }
      if (reduceMotion() || candidates.length < 2) {
        showResult();
        spinBtn.disabled = false;
        return;
      }

      // A reel of covers that slows down (ease-out) and lands on the pick.
      const others = candidates.filter((c) => c.mal_id !== pick.mal_id);
      let reel = shuffle(others.length ? others : candidates);
      while (reel.length < 14) reel = reel.concat(shuffle(others.length ? others : candidates));
      reel = reel.slice(0, 14);
      reel.push(pick);
      let i = 0;
      const step = () => {
        if (mine !== token || !root.isConnected) return;
        if (i >= reel.length - 1) {
          showResult();
          spinBtn.disabled = false;
          return;
        }
        setHTML(stage, frame(reel[i], 'spinning'));
        i += 1;
        timer = setTimeout(step, 55 + (i / reel.length) ** 2.2 * 330);
      };
      step();
    } catch (err) {
      if (mine !== token) return;
      errorBox(stage, err.message, spin);
      spinBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    spin();
  });

  form.addEventListener('change', (event) => {
    if (event.target.name === 'on_hold') drawIdle();
  });

  function applyMood() {
    root.querySelectorAll('[data-mood]').forEach((b) => {
      const active = b.dataset.mood === mood;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  form.addEventListener('click', (event) => {
    const moodButton = event.target.closest('[data-mood]');
    if (moodButton) {
      mood = moodButton.dataset.mood;
      applyMood();
      return;
    }
    const button = event.target.closest('[data-source]');
    if (!button || button.dataset.source === source) return;
    source = button.dataset.source;
    applySource();
  });

  stage.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'again') { spin(); return; }
    if (act === 'go-discover') {
      source = 'discover';
      applySource();
      spin();
      return;
    }
    if (!pick) return;
    const m = metaOf(pick);

    if (act === 'start-mine') {
      button.disabled = true;
      try {
        await api.patch(pick.mal_id, { status: 'watching' });
        toast(`Enjoy ${displayTitle(m)}!`, 'success');
        window.location.hash = `#/anime/${pick.mal_id}`;
      } catch (err) {
        toast(err.message, 'error');
        if (button.isConnected) button.disabled = false;
      }
      return;
    }

    if (act === 'add') {
      const status = button.dataset.status === 'watching' ? 'watching' : 'plan_to_watch';
      stage.querySelectorAll('[data-act="add"]').forEach((b) => { b.disabled = true; });
      try {
        const { entry } = await api.add(pick.mal_id, status);
        pickStatus = (entry && entry.status) || status;
        toast(status === 'watching' ? `Enjoy ${displayTitle(m)}!` : `Added ${displayTitle(m)} to Want to watch`, 'success');
        if (entry) entries = entries.filter((e) => e.mal_id !== entry.mal_id).concat(entry);
        const actions = stage.querySelector('#slot-actions');
        if (actions) setHTML(actions, resultActions());
      } catch (err) {
        toast(err.message, 'error');
        stage.querySelectorAll('[data-act="add"]').forEach((b) => { b.disabled = false; });
      }
    }
  });

  applyMood();
  applySource();
  loadLibrary();

  return () => {
    token += 1;
    clearTimeout(timer);
  };
}
