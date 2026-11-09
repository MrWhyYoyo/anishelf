import { api } from '../api.js';
import {
  html, setHTML, raw, coverHtml, animeCard, skeletonCards, errorBox, toast, confirmDialog, setAccent,
  imgUrl, safeUrl, icon, displayTitle, seasonText, fmtCountdown, fmtDuration, plural,
  STATUS_ORDER, STATUS_LABELS, STATUS_HINTS, TIERS, SCORE_WORDS, confetti, replayAnimation, prefersReducedMotion,
  openInBrowser, setPendingWatch, sortStreaming, altTitle, epStrip,
} from '../ui.js';
import { askForDiary, moodMark, openDiaryEditor } from '../diary-note.js';
import { openGroupPicker } from '../group-picker.js';
import { MANGA_STATUS_LABELS } from '../manga-common.js';
import { mountCollections } from '../collections-ui.js'; // custom collections panel
import { showStateBadge } from '../show-state.js';
import { toastUndo } from '../ui.js';
import { remember, undoEpisodes, undoFields, undoRemove } from '../undo.js'; // "Undo" on toasts

const PAGE_SIZE = 100;     // episode buttons per page for very long shows
const PAGING_FROM = 200;   // only paginate when there are more than this many episodes
const LIST_PAGE_SIZE = 50; // list view rows per page
const CAST_PREVIEW = 9;    // cast cards before "Show all" (three rows at desktop width)
const MIN_UNKNOWN = 12;    // grid size when the total is unknown
const RING_R = 52;         // progress ring radius inside a 120x120 viewBox (stroke 10 → fits with room for the glow)

export function render(root, { id }) {
  const state = {
    meta: null,
    entry: null,
    episodeInfo: new Map(),   // number -> {title, filler, recap, aired}
    lastClicked: null,
    page: null,
    extra: 0,                 // extra buttons added with "+ more" when total is unknown
    queue: Promise.resolve(),
    cast: null,               // characters with sub/dub voice actors (null = not loaded)
    castLang: readCastLang(),
    epView: readEpView(),     // 'grid' | 'list'
    seasons: null,            // other seasons of the same series (null = not loaded)
    franchise: null,
    prevProgress: null,       // ring animates from here to the new value
    popEps: new Set(),        // episodes that just changed (bounce on next draw)
    diary: null,              // my diary notes for this anime (null = not loaded)
  };
  let countdownTimer = null;
  let parallaxFrame = 0;
  let notesTimer = null;
  let savedTimer = null;
  let els = {};

  setHTML(root, html`<div class="detail-view">
    <div class="hero shimmer"></div>
    <div class="detail-inner">
      <div class="detail-head">
        <div class="cover detail-cover shimmer"></div>
        <div class="detail-titles"><div class="sk-line shimmer" style="height:34px;width:60%"></div><div class="sk-line short shimmer"></div></div>
      </div>
    </div>
  </div>`);

  load();

  /* ---------------------------------------------------------------- streaming links */
  // Any [data-open-url] button on this page opens in the user's logged-in default browser.
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-url]');
    if (!button) return;
    event.preventDefault();
    openInBrowser(button.dataset.openUrl, button.dataset.site);
  });

  async function watchEpisode(num) {
    const info = state.episodeInfo.get(num);
    if (!info || !info.watch_url) return;
    const opened = await openInBrowser(info.watch_url, info.watch_site || 'the episode');
    if (opened && state.entry && !trackerEntry().watched.includes(num)) {
      setPendingWatch({ mal_id: id, episode: num, title: displayTitle(state.meta) });
    }
  }

  // The "Finished episode N?" prompt (in main.js) may mark an episode while this page is open.
  const onEpisodesUpdated = (event) => {
    const detail = event.detail || {};
    if (detail.mal_id !== id || !detail.entry || !root.isConnected || !els.tracker) return;
    const before = new Set(state.entry ? trackerEntry().watched : []);
    state.entry = detail.entry;
    trackerEntry().watched.forEach((n) => { if (!before.has(n)) state.popEps.add(n); });
    drawActions();
    drawTracker();
    if (state.seasons) drawSeasons();
    syncJournalValues();
  };
  window.addEventListener('anishelf:episodes-updated', onEpisodesUpdated);

  // A diary note saved anywhere (e.g. the "Finished!" prompt from main.js) refreshes this page's diary.
  const onChanged = (event) => {
    const path = (event.detail && event.detail.path) || '';
    if (path.startsWith('/api/diary') && root.isConnected && state.entry) loadDiary();
  };
  window.addEventListener('anishelf:changed', onChanged);

  /** The episode set the tracker shows: the rewatch while rewatching, else the first watch. */
  function trackerEntry() {
    const e = state.entry;
    if (!e || !e.rewatching) return e;
    const rewatched = e.rewatch_watched || [];
    return {
      ...e,
      watched: rewatched,
      watched_count: e.rewatch_watched_count || 0,
      next_episode: e.rewatch_next_episode,
      progress: e.rewatch_progress,
      watched_text: rangesText(rewatched),
    };
  }

  /** [1,2,3,5] -> "1-3, 5" (same as the server's compress_ranges). */
  function rangesText(numbers) {
    const nums = [...new Set(numbers)].sort((a, b) => a - b);
    const parts = [];
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j += 1;
      parts.push(i === j ? String(nums[i]) : `${nums[i]}-${nums[j]}`);
      i = j + 1;
    }
    return parts.join(', ');
  }

  /* ---------------------------------------------------------------- loading */
  async function load() {
    let data;
    try {
      data = await api.anime(id);
    } catch (err) {
      if (!root.isConnected) return;
      errorBox(root, err.status === 404 ? "Couldn't find that anime." : err.message, err.status === 404 ? null : load);
      return;
    }
    if (!root.isConnected) return;
    state.meta = data.meta;
    state.entry = data.entry || null;
    setAccent(state.meta.anilist && state.meta.anilist.color);
    document.title = `${displayTitle(state.meta)} · AniShelf`;
    window.dispatchEvent(new CustomEvent('anishelf:context', { detail: { title: displayTitle(state.meta) } }));
    drawShell();
    loadEpisodes();
    loadDiary();
    loadRecommendations();
    loadCast();
    loadSeasons();
    loadSource();
  }

  /* ---------------------------------------------------------------- source manga */
  // "Read the manga": the manga this anime is adapted from, with its status on the manga shelf.
  async function loadSource() {
    try {
      const { source } = await api.animeSource(id);
      const panel = root.querySelector('#d-source');
      if (!source || !panel) return;
      panel.hidden = false;
      setHTML(panel, html`<a class="source-link" href="#/manga/${source.anilist_id}">
        ${coverHtml(source.image, displayTitle(source), 'source-cover')}
        <span class="source-text">
          <span class="faint small">Based on the manga</span>
          <strong>${displayTitle(source)}</strong>
          <span class="muted small">${source.library_status ? `On your manga shelf: ${MANGA_STATUS_LABELS[source.library_status]}` : 'Not on your manga shelf yet'}</span>
        </span>
        <span class="btn btn-sm">${source.library_status ? 'Open' : 'Read the manga'}</span>
      </a>`);
    } catch {
      /* no source manga, or offline: the panel just stays hidden */
    }
  }

  /* ---------------------------------------------------------------- seasons (one series) */
  async function loadSeasons() {
    try {
      const data = await api.seasons(id);
      if (!root.isConnected) return;
      state.seasons = Array.isArray(data.seasons) ? data.seasons : [];
      state.franchise = data;
      drawSeasons();
    } catch (err) {
      // 404 (not available yet) or a failed lookup: the switcher simply stays hidden.
      if (err.status !== 404) console.warn('Seasons unavailable:', err.message);
      if (root.isConnected && els.seasons) els.seasons.hidden = true;
    }
  }

  // "Group with..." (both the solo line and the grouped header have a [data-group] button).
  async function changeGrouping() {
    const result = await openGroupPicker(state.entry, { grouped: (state.seasons || []).length > 1 });
    if (!result || !root.isConnected) return;
    state.seasons = Array.isArray(result.seasons) ? result.seasons : [];
    state.franchise = result;
    state.seasonsCentered = false;
    drawSeasons();
  }

  function drawSeasons() {
    const list = state.seasons || [];
    if (!els.seasons) return;
    if (list.length < 2) {
      // On its own: only offer grouping when it's on the shelf (it needs a library entry).
      if (!state.entry) { els.seasons.hidden = true; return; }
      els.seasons.hidden = false;
      setHTML(els.seasons, html`<div class="seasons-solo">
        <span class="muted small">Not grouped with any other seasons.</span>
        <button type="button" class="btn btn-sm" data-group>Group with another anime…</button>
      </div>`);
      return;
    }

    // Use the live entry for the season on screen so the numbers follow episode clicks.
    const seasons = list.map((s) => {
      if (s.mal_id !== id) return s;
      const e = state.entry;
      return {
        ...s,
        is_current: true,
        library_status: e ? e.status : null,
        watched_count: e ? e.watched_count : 0,
        total: e && e.total ? e.total : s.total,
      };
    });
    const watched = seasons.reduce((sum, s) => sum + (s.watched_count || 0), 0);
    const allKnown = seasons.every((s) => typeof (s.total ?? s.episodes) === 'number');
    const total = seasons.reduce((sum, s) => sum + ((s.total ?? s.episodes) || 0), 0);
    const seriesName = displayTitle(state.franchise || {});

    els.seasons.hidden = false;
    setHTML(els.seasons, html`
      <div class="seasons-head">
        <h2>${seriesName && seriesName !== 'Untitled' ? seriesName : 'Seasons'}</h2>
        <span class="muted small">Series progress: <strong>${watched} / ${total}${allKnown ? '' : '+'}</strong> episodes across ${plural(seasons.length, 'season')}</span>
        ${state.entry ? html`<button type="button" class="btn btn-sm btn-ghost" data-group>Change grouping</button>` : ''}
      </div>
      <div class="season-row" role="list">
        ${seasons.map((s, i) => {
          const sTotal = s.total ?? s.episodes;
          const isCurrent = s.mal_id === id;
          const bits = [s.year, s.library_status ? STATUS_LABELS[s.library_status] : 'Not on your shelf'].filter(Boolean).join(' · ');
          // The current season shows its exact episodes; the others fill from the start by count.
          // While rewatching, the current season's strip shows the rewatch instead.
          const shown = isCurrent ? trackerEntry() : null;
          const rewatchNo = shown && shown.rewatching ? shown.rewatch_number : null;
          const strip = sTotal
            ? epStrip({
              watched: shown ? shown.watched : [],
              watchedCount: shown ? shown.watched_count : (s.watched_count || 0),
              total: sTotal,
              next: shown ? shown.next_episode : null,
              max: 64,
              label: rewatchNo ? `Rewatch #${rewatchNo}: ${shown.watched_count} of ${sTotal} episodes` : '',
            })
            : html`<span class="faint small">Episode count not announced</span>`;
          return html`<a role="listitem" class="season-chip ${isCurrent ? 'current' : ''}" href="#/anime/${s.mal_id}"
            title="${displayTitle(s)}" ${isCurrent ? html`aria-current="page"` : ''}>
            ${coverHtml(s.image, displayTitle(s), 'season-cover')}
            <span class="season-text">
              <strong><span class="season-label">${s.label || displayTitle(s)}</span></strong>
              <small>${bits || s.format || ''}</small>
            </span>
            <span class="season-strip">${strip}</span>
            <span class="season-count">${rewatchNo ? html`<span class="rewatch-mark">Rewatch #${rewatchNo}</span> ${shown.watched_count}` : (s.watched_count || 0)} / ${sTotal ?? '—'}</span>
          </a>`;
        })}
      </div>`);
    // Centre the current season in the row (first draw only) without moving the page.
    const row = els.seasons.querySelector('.season-row');
    const current = els.seasons.querySelector('.season-chip.current');
    if (row && current && !state.seasonsCentered) {
      row.scrollLeft = Math.max(0, current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2);
      state.seasonsCentered = true;
    } else if (row && typeof state.seasonsScroll === 'number') {
      row.scrollLeft = state.seasonsScroll;
    }
    if (row) row.addEventListener('scroll', () => { state.seasonsScroll = row.scrollLeft; }, { passive: true });
  }

  /** Skeleton while the (slow, first-time) seasons lookup runs — only when we already know there are several. */
  function drawSeasonsSkeleton() {
    const franchise = state.entry && state.entry.franchise;
    if (!els.seasons || !franchise || !(franchise.size > 1)) return;
    els.seasons.hidden = false;
    setHTML(els.seasons, html`<div class="seasons-head"><h2>${displayTitle(franchise)}</h2><span class="muted small">Loading seasons…</span></div>
      <div class="season-row">${Array.from({ length: Math.min(franchise.size, 6) }, () => html`<div class="season-chip skeleton"><div class="cover season-cover shimmer"></div><span class="season-text"><span class="sk-line shimmer"></span><span class="sk-line short shimmer"></span></span></div>`)}</div>`);
  }

  /* ---------------------------------------------------------------- cast (sub / dub) */
  function readEpView() {
    try { return localStorage.getItem('anishelf.epView') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  }

  function readCastLang() {
    try { return localStorage.getItem('anishelf.castLang') === 'dub' ? 'dub' : 'sub'; } catch { return 'sub'; }
  }

  async function loadCast() {
    if (!els.cast) return;
    try {
      const { characters = [] } = await api.characters(id);
      if (!root.isConnected || !els.cast) return;
      state.cast = characters;
      drawCast(false);
    } catch (err) {
      if (!root.isConnected || !els.cast) return;
      if (err.status === 404) { els.cast.hidden = true; return; }
      setHTML(els.castBody, html`<div class="cast-empty"><p class="muted">Couldn't load the cast (${err.message}).</p>
        <button type="button" class="btn btn-sm" data-cast-retry>Try again</button></div>`);
    }
  }

  function roleLabel(role) {
    return { MAIN: 'Main', SUPPORTING: 'Supporting', BACKGROUND: 'Background' }[role] || '';
  }

  function castCard(ch, lang, index) {
    const actors = (lang === 'dub' ? ch.dub : ch.sub) || [];
    const va = actors[0];
    const others = actors.slice(1).map((a) => a.name).filter(Boolean);
    const role = roleLabel(ch.role);
    return html`<article class="cast-card" style="--i:${Math.min(index, 18)}">
      <div class="cast-half cast-char">
        ${coverHtml(ch.image, ch.name, 'cast-portrait')}
        <div class="cast-text">
          <strong title="${ch.name}">${ch.name}</strong>
          ${role ? html`<span class="role role-${String(ch.role).toLowerCase()}">${role}</span>` : ''}
        </div>
        <button type="button" class="fav-heart" data-fav="${ch.name}" aria-pressed="false" hidden
          title="Favourite character" aria-label="Favourite ${ch.name}">${heartSvg()}</button>
      </div>
      <div class="cast-half cast-va">
        ${va ? html`<div class="cast-text">
            <strong title="${va.name}">${va.name}</strong>
            <span class="faint" ${others.length ? html`title="Also: ${others.join(', ')}"` : ''}>${va.language || (lang === 'dub' ? 'English' : 'Japanese')}${others.length ? ` · +${others.length}` : ''}</span>
          </div>
          ${coverHtml(va.image, va.name, 'cast-portrait')}`
        : html`<div class="cast-text cast-none">${lang === 'dub' ? 'No English dub cast listed' : 'No Japanese cast listed'}</div>`}
      </div>
    </article>`;
  }

  function drawCast(animateSwap) {
    const list = state.cast || [];
    if (!list.length) {
      setHTML(els.castBody, html`<div class="cast-empty"><span aria-hidden="true"></span><p class="muted">No cast information for this anime yet.</p></div>`);
      els.castToggle.hidden = true;
      return;
    }
    els.castToggle.hidden = false;
    const lang = state.castLang;
    els.castToggle.querySelectorAll('[data-lang]').forEach((b) => {
      const active = b.dataset.lang === lang;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    // Main cast first; the long tail of supporting roles waits behind "Show all".
    const shown = state.castExpanded ? list : list.slice(0, CAST_PREVIEW);
    const draw = () => { setHTML(els.castBody, html`<div class="cast-grid">${shown.map((ch, i) => castCard(ch, lang, i))}</div>
      ${list.length > CAST_PREVIEW ? html`<button type="button" class="btn btn-sm cast-more" data-cast-more>${state.castExpanded ? 'Show fewer' : `Show all ${list.length} characters`}</button>` : ''}`);
      refreshHearts(); // hearts depend on the library entry, which may load before or after the cast
    };
    if (!animateSwap) { draw(); return; }
    els.castBody.classList.add('fading');
    setTimeout(() => {
      if (!root.isConnected) return;
      draw();
      els.castBody.querySelectorAll('.cast-card').forEach((c) => c.style.setProperty('--i', '0'));
      els.castBody.classList.remove('fading');
    }, 160);
  }

  /* ---------------------------------------------------------------- favourite hearts
     The favourites live in the journal's "Favourite character" text, as names joined with ", "
     (the Profile splits them the same way). A heart just adds or removes a name in that text,
     so typing in the journal and clicking hearts always agree. */
  const MAX_FAVS_PER_SHOW = 3; // same limit as the Profile wall (MAX_NAMES_PER_ENTRY in Python)

  function heartSvg() {
    return html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2.1 0 3.6 1.1 5 2.9 1.4-1.8 2.9-2.9 5-2.9 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>`;
  }

  // "Levi / Erwin & Hange" -> ['Levi', 'Erwin', 'Hange'] (mirrors _split_names in profile_extras.py)
  function splitFavNames(text) {
    return String(text || '').split(/[,/&;]| and /).map((part) => part.trim()).filter(Boolean);
  }

  function nameWords(name) {
    return String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  // Which cast member a typed name means, using the same rules as match_character in logic.py:
  // the same words in any order first, then "every typed word is in the name" ("Spike" -> Spike Spiegel).
  function castMatch(typed, cast) {
    const wanted = nameWords(typed);
    if (!wanted.length) return null;
    const same = cast.find((ch) => nameWords(ch.name).sort().join(' ') === [...wanted].sort().join(' '));
    if (same) return same;
    return cast.find((ch) => {
      const words = nameWords(ch.name);
      return words.length && wanted.every((w) => words.includes(w));
    }) || null;
  }

  // For each typed name: the cast name it points to (or null when it matches nobody).
  function favPairs() {
    const cast = state.cast || [];
    return splitFavNames(state.entry?.fav_character).map((typed) => ({ typed, name: castMatch(typed, cast)?.name || null }));
  }

  // Show hearts only for shows on your shelf (the favourite is saved on the library entry).
  function refreshHearts() {
    if (!els.castBody) return;
    const faved = new Set(favPairs().map((p) => p.name).filter(Boolean));
    els.castBody.querySelectorAll('[data-fav]').forEach((btn) => {
      btn.hidden = !state.entry;
      const on = faved.has(btn.dataset.fav);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? 'Remove from favourite characters' : 'Add to favourite characters';
    });
  }

  async function toggleFavourite(btn) {
    if (!state.entry) return;
    const name = btn.dataset.fav;
    const pairs = favPairs();
    const isOn = pairs.some((p) => p.name === name);
    let names;
    if (isOn) {
      names = pairs.filter((p) => p.name !== name).map((p) => p.typed);
    } else {
      if (pairs.length >= MAX_FAVS_PER_SHOW) {
        toast(`You can pick up to ${MAX_FAVS_PER_SHOW} favourites per show. Un-heart one first.`, 'info', 3200);
        return;
      }
      names = [...pairs.map((p) => p.typed), name];
    }
    btn.disabled = true;
    try {
      await patch({ fav_character: names.join(', ') });
      syncJournalValues();
      refreshHearts();
      if (!isOn) {
        btn.classList.add('pop');
        setTimeout(() => btn.classList.remove('pop'), 400);
      }
      toast(isOn ? `${name} removed from favourites` : `${name} added to your favourite characters ♥`, 'success', 2200);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function onCastClick(event) {
    const heart = event.target.closest('[data-fav]');
    if (heart) { toggleFavourite(heart); return; }
    if (event.target.closest('[data-cast-retry]')) { loadCast(); return; }
    if (event.target.closest('[data-cast-more]')) {
      state.castExpanded = !state.castExpanded;
      drawCast(false);
      return;
    }
    const button = event.target.closest('[data-lang]');
    if (!button || button.dataset.lang === state.castLang) return;
    state.castLang = button.dataset.lang;
    try { localStorage.setItem('anishelf.castLang', state.castLang); } catch { /* storage unavailable */ }
    drawCast(true);
  }

  async function loadEpisodes() {
    try {
      const { episodes = [] } = await api.episodeList(id);
      if (!root.isConnected) return;
      state.episodeInfo = new Map(episodes.map((ep) => [ep.number, ep]));
      if (state.entry) drawTracker();
    } catch (err) {
      console.warn('Episode titles unavailable:', err.message);
    }
  }

  async function loadRecommendations() {
    try {
      const { results = [] } = await api.recommendations(id);
      if (!root.isConnected || !els.recs) return;
      if (!results.length) {
        setHTML(els.recs, html`<p class="muted">No recommendations yet.</p>`);
        return;
      }
      setHTML(els.recs, html`${results.map((r) => animeCard(
        { mal_id: r.mal_id, title: r.title, title_english: r.title_english || null, image: r.image },
        { subtitle: r.votes ? plural(r.votes, 'vote') : '' },
      ))}`);
    } catch (err) {
      if (els.recs) setHTML(els.recs, html`<p class="muted">Couldn't load recommendations (${err.message})</p>`);
    }
  }

  /* ---------------------------------------------------------------- layout */
  function drawShell() {
    const m = state.meta;
    const al = m.anilist || {};
    const cover = al.cover_xl || m.image;
    const banner = al.banner;
    const chips = [
      m.type,
      seasonText(m),
      m.episodes ? plural(m.episodes, 'episode') : null,
      m.duration_min ? `${m.duration_min} min/ep` : null,
      m.airing_status,
    ].filter(Boolean);
    const score = typeof m.mal_score === 'number' ? m.mal_score.toFixed(2) : null;
    const streaming = sortStreaming(m.streaming);

    setHTML(root, html`<div class="detail-view">
      <div class="hero">
        ${banner && imgUrl(banner)
          ? html`<img class="hero-img fx-img" src="${imgUrl(banner)}" alt="">`
          : (cover && imgUrl(cover) ? html`<img class="hero-img blurred fx-img" src="${imgUrl(cover)}" alt="">` : '')}
        <div class="hero-shade"></div>
      </div>
      <div class="detail-inner">
        <div class="detail-head">
          ${coverHtml(cover, displayTitle(m), 'detail-cover')}
          <div class="detail-titles">
            <h1>${displayTitle(m)}</h1>
            ${altTitle(m) ? html`<p class="alt-title">${altTitle(m)}</p>` : ''}
            ${m.title_japanese ? html`<p class="jp-title" lang="ja">${m.title_japanese}</p>` : ''}
            <div class="chips">
              ${chips.map((c) => html`<span class="chip">${c}</span>`)}
              ${score ? html`<span class="chip chip-score">MAL ${score}</span>` : ''}
              ${(m.genres || []).map((g) => html`<span class="chip chip-genre">${g}</span>`)}
            </div>
            ${streaming.length ? html`<div class="watch-row" aria-label="Where to watch">
              <span class="watch-label">Where to watch</span>
              ${streaming.map((s) => html`<button type="button" class="watch-pill ${/crunchyroll/i.test(s.site) ? 'crunchyroll' : ''}"
                data-open-url="${s.url}" data-site="${s.site}" title="Open ${s.site} in your browser">${icon('play')}${s.site}</button>`)}
            </div>` : ''}
            <div id="d-countdown" class="countdown" hidden></div>
            <div id="d-actions" class="detail-actions"></div>
          </div>
        </div>

        <section id="d-seasons" class="seasons" aria-label="Seasons" hidden></section>

        <div class="detail-grid">
          <div class="detail-main">
            <section id="d-tracker" class="panel" aria-label="Episode tracker"></section>
            <section id="d-journal" class="panel" aria-label="My journal"></section>
            <section id="d-diary" class="panel" aria-label="Watch diary" hidden></section>
            <section id="d-collections" class="panel" aria-label="Collections" hidden></section>
            <section id="d-source" class="panel source-panel" aria-label="Source manga" hidden></section>
          </div>
          <aside class="detail-side">${aboutPanel(m)}</aside>
        </div>

        <section id="d-cast" class="panel cast-panel" aria-label="Cast">
          <div class="panel-head">
            <h2>Cast</h2>
            <div class="segmented" id="d-cast-toggle" role="group" aria-label="Voice language">
              <button type="button" data-lang="sub">Sub · Japanese</button>
              <button type="button" data-lang="dub">Dub · English</button>
            </div>
          </div>
          <div id="d-cast-body" class="cast-body"><div class="cast-grid">${Array.from({ length: 4 }, () => html`<div class="cast-card skeleton shimmer"></div>`)}</div></div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Because you liked this</h2></div>
          <div id="d-recs" class="row-scroll">${skeletonCards(6)}</div>
        </section>
      </div>
    </div>`);

    els = {
      actions: root.querySelector('#d-actions'),
      tracker: root.querySelector('#d-tracker'),
      journal: root.querySelector('#d-journal'),
      diary: root.querySelector('#d-diary'),
      recs: root.querySelector('#d-recs'),
      countdown: root.querySelector('#d-countdown'),
      seasons: root.querySelector('#d-seasons'),
      cast: root.querySelector('#d-cast'),
      castBody: root.querySelector('#d-cast-body'),
      castToggle: root.querySelector('#d-cast-toggle'),
    };
    els.cast.addEventListener('click', onCastClick);
    els.seasons.addEventListener('click', (event) => {
      if (event.target.closest('[data-group]')) { event.preventDefault(); changeGrouping(); }
    });
    if (state.cast) drawCast(false);
    if (state.seasons) drawSeasons();
    else drawSeasonsSkeleton();

    els.actions.addEventListener('click', onActionsClick);
    els.actions.addEventListener('change', onActionsChange);
    els.tracker.addEventListener('click', onTrackerClick);
    els.tracker.addEventListener('submit', onTrackerSubmit);
    els.journal.addEventListener('change', onJournalChange);
    els.journal.addEventListener('input', onJournalInput);
    els.diary.addEventListener('click', onDiaryClick);

    const toggle = root.querySelector('#syn-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const syn = root.querySelector('#synopsis');
        const clamped = syn.classList.toggle('clamp');
        toggle.textContent = clamped ? 'Read more' : 'Show less';
        toggle.setAttribute('aria-expanded', clamped ? 'false' : 'true');
      });
    }

    drawActions();
    drawTracker();
    drawJournal();
    drawDiary();
    startCountdown();
    // Collections panel (collections-ui.js): hidden while the show isn't in the library
    mountCollections(root.querySelector('#d-collections'), id, () => Boolean(state.entry));
  }

  /* ---------------------------------------------------------------- banner parallax */
  function onScroll() {
    if (parallaxFrame) return;
    parallaxFrame = requestAnimationFrame(() => {
      parallaxFrame = 0;
      const img = root.querySelector('.hero-img');
      if (!img) return;
      const offset = Math.min(window.scrollY, 600) * 0.35;
      img.style.translate = `0 ${offset.toFixed(1)}px`;
    });
  }
  if (!prefersReducedMotion()) window.addEventListener('scroll', onScroll, { passive: true });

  function aboutPanel(m) {
    const synopsis = (m.synopsis || '').trim();
    const paragraphs = synopsis ? synopsis.split(/\n\s*\n|\r\n\s*\r\n/).map((p) => p.trim()).filter(Boolean) : [];
    const long = synopsis.length > 420;
    const rows = [
      ['Status', m.airing_status],
      ['Season', seasonText(m)],
      ['Episodes', m.episodes ? String(m.episodes) : (m.airing ? 'Still airing' : null)],
      ['Duration', m.duration_min ? `${m.duration_min} min per episode` : null],
      ['Studios', (m.studios || []).join(', ')],
      ['Rating', m.rating],
      ['MAL rank', m.rank ? `#${m.rank.toLocaleString()}` : null],
      ['Popularity', m.popularity ? `#${m.popularity.toLocaleString()}` : null],
    ].filter(([, value]) => value);
    const malUrl = safeUrl(m.url);
    const trailer = m.trailer_youtube_id
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(m.trailer_youtube_id)}`
      : '';

    return html`<section class="panel about">
      <h2 style="margin-bottom:12px">About</h2>
      ${paragraphs.length
        ? html`<div id="synopsis" class="synopsis ${long ? 'clamp' : ''}">${paragraphs.map((p) => html`<p>${p}</p>`)}</div>
          ${long ? html`<button type="button" class="link-btn" id="syn-toggle" aria-expanded="false" style="margin-top:8px">Read more</button>` : ''}`
        : html`<p class="muted">No synopsis available.</p>`}
      ${rows.length ? html`<dl class="info-list">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : ''}
      <div class="link-row">
        ${trailer ? html`<button type="button" class="btn btn-sm" data-open-url="${trailer}" data-site="YouTube">${icon('play')} Trailer</button>` : ''}
        ${malUrl ? html`<button type="button" class="btn btn-sm" data-open-url="${malUrl}" data-site="MyAnimeList">${icon('external')} MyAnimeList</button>` : ''}
      </div>
    </section>`;
  }

  /* ---------------------------------------------------------------- countdown */
  function startCountdown() {
    clearInterval(countdownTimer);
    const next = state.meta.anilist && state.meta.anilist.next_airing;
    if (!next || !next.airing_at || !els.countdown) return;
    const tick = () => {
      const seconds = next.airing_at - Date.now() / 1000;
      setHTML(els.countdown, seconds > 0
        ? html`<span class="pulse"></span> Episode ${next.episode} airs in ${fmtCountdown(seconds)}`
        : html`<span class="pulse"></span> Episode ${next.episode} should be out now!`);
      els.countdown.hidden = false;
    };
    tick();
    countdownTimer = setInterval(tick, 30000);
  }

  /* ---------------------------------------------------------------- actions */
  function drawActions() {
    const e = state.entry;
    if (!e) {
      setHTML(els.actions, html`<div class="add-box">
        <select id="add-status" aria-label="Status to add with">
          ${STATUS_ORDER.map((s) => html`<option value="${s}" ${s === 'plan_to_watch' ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`)}
        </select>
        <button type="button" class="btn btn-primary btn-lg" data-act="add">${icon('plus')} Add to library</button>
      </div>`);
      return;
    }
    const score = e.score;
    setHTML(els.actions, html`
      <div class="action-row">
        <div class="action-fields">
        <label class="field-inline"><span class="sr-only">Status</span>
          <select id="a-status" class="status-select status-${e.status}">
            ${STATUS_ORDER.map((s) => html`<option value="${s}" title="${STATUS_HINTS[s]}" ${s === e.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`)}
          </select>
        </label>
        <label class="field-inline"><span class="sr-only">Tier</span>
          <select id="a-tier" title="Tier list placement">
            <option value="" ${!e.tier ? 'selected' : ''}>No tier</option>
            ${TIERS.map((t) => html`<option value="${t}" ${t === e.tier ? 'selected' : ''}>Tier ${t}</option>`)}
          </select>
        </label>
        </div>
        <div class="action-icons">
        <button type="button" class="icon-btn ${e.favorite ? 'on' : ''}" data-act="fav" aria-pressed="${e.favorite ? 'true' : 'false'}"
          title="${e.favorite ? 'Remove from favourites' : 'Add to favourites'}">${icon('heart')}</button>
        <button type="button" class="icon-btn" data-act="refresh" title="Refresh info from MyAnimeList/AniList">${icon('refresh')}</button>
        <button type="button" class="icon-btn danger" data-act="remove" title="Remove from library">${icon('trash')}</button>
        </div>
      </div>
      ${showStateLine(e)}
      <div class="score-picker" role="group" aria-label="Your score">
        <div class="score-head"><span class="label">Your score</span><span class="score-word">${score ? `${score}/10 · ${SCORE_WORDS[score]}` : 'Not scored'}</span></div>
        <span class="score-buttons">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`<button type="button" data-score="${n}"
          class="${score && n <= score ? 'filled' : ''} ${n === score ? 'selected' : ''}"
          aria-pressed="${n === score ? 'true' : 'false'}" title="${n} — ${SCORE_WORDS[n]}${n === score ? ' (click to clear)' : ''}">${n}</button>`)}</span>
      </div>
      ${predictionHtml(e)}`);
  }

  /* ---------------------------------------------------------------- show state (1.2) */
  // "Waiting for Season 3 · Oct 2027" or "Season 2 is out" under the status, with a link to that season.
  function showStateLine(e) {
    const badge = showStateBadge(e.show_state);
    if (!badge) return '';
    const next = e.show_state.next;
    const link = next && next.mal_id && e.show_state.kind !== 'ended'
      ? html` <a class="small" href="#/anime/${next.mal_id}">${e.show_state.kind === 'new_season' ? 'Open it' : 'See it'}</a>`
      : '';
    return html`<div class="detail-show-state">${badge}${link}</div>`;
  }

  /* ---------------------------------------------------------------- score prediction */
  function predictionHtml(e) {
    const predicted = e.predicted_score;
    // Both scores known: compare them
    if (predicted && e.score) {
      const diff = e.score - predicted;
      const sign = diff > 0 ? `+${diff}` : String(diff);
      return html`<p class="prediction-result">You predicted ${predicted}, you gave ${e.score}
        <span class="prediction-diff">(${diff === 0 ? 'spot on' : sign})</span></p>`;
    }
    if (e.can_predict) {
      return html`<div class="prediction-picker" role="group" aria-label="Predicted score">
        <span class="label">${predicted ? `Predicted ${predicted}/10` : 'Predict your score'}</span>
        <span class="prediction-buttons">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`<button type="button"
          data-predict="${n}" class="${n === predicted ? 'selected' : ''}" aria-pressed="${n === predicted ? 'true' : 'false'}"
          title="I think I'll give it ${n}${n === predicted ? ' (click to clear)' : ''}">${n}</button>`)}</span>
      </div>`;
    }
    if (predicted) {
      return html`<p class="prediction-result">You predicted ${predicted}. Score it when you're done to see how close you were.</p>`;
    }
    return '';
  }

  async function patch(fields) {
    const { entry } = await api.patch(id, fields);
    state.entry = entry;
    return entry;
  }

  async function onActionsClick(event) {
    const scoreBtn = event.target.closest('[data-score]');
    const actBtn = event.target.closest('[data-act]');
    const predictBtn = event.target.closest('[data-predict]');

    if (predictBtn) {
      const n = Number(predictBtn.dataset.predict);
      const next = state.entry.predicted_score === n ? null : n;
      try {
        await patch({ predicted_score: next });
        drawActions();
        toast(next ? `Prediction saved: ${next}/10` : 'Prediction cleared', 'success', 2200);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    if (scoreBtn) {
      const n = Number(scoreBtn.dataset.score);
      const next = state.entry.score === n ? null : n;
      const before = remember(state.entry); // for the Undo button
      try {
        await patch({ score: next });
        drawActions();
        replayAnimation(els.actions.querySelector('.score-picker button.selected'), 'pop');
        toastUndo(next ? `Scored ${next}/10 · ${SCORE_WORDS[next]}` : 'Score cleared', () => undoFields(before, ['score']));
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (!actBtn) return;
    const act = actBtn.dataset.act;

    if (act === 'add') {
      const status = root.querySelector('#add-status').value;
      actBtn.disabled = true;
      try {
        const { entry } = await api.add(id, status);
        state.entry = entry;
        toast(`Added to ${STATUS_LABELS[entry.status]}`, 'success');
        drawActions();
        drawTracker();
        drawJournal();
        loadDiary();
        if (state.seasons) drawSeasons();
      } catch (err) {
        toast(err.message, 'error');
        if (actBtn.isConnected) actBtn.disabled = false;
      }
    } else if (act === 'fav') {
      try {
        await patch({ favorite: !state.entry.favorite });
        drawActions();
        replayAnimation(els.actions.querySelector('[data-act="fav"]'), 'beat');
        toast(state.entry.favorite ? 'Added to favourites' : 'Removed from favourites', 'success', 2200);
      } catch (err) { toast(err.message, 'error'); }
    } else if (act === 'refresh') {
      actBtn.disabled = true;
      actBtn.classList.add('spinning');
      try {
        await api.refresh(id);
        toast('Info refreshed', 'success');
        if (!root.isConnected) return;
        const { meta, entry } = await api.anime(id);
        if (!root.isConnected) return;
        state.meta = meta;
        state.entry = entry || null;
        setAccent(meta.anilist && meta.anilist.color);
        drawShell();
        loadRecommendations();
      } catch (err) {
        toast(err.message, 'error');
        if (actBtn.isConnected) { actBtn.disabled = false; actBtn.classList.remove('spinning'); }
      }
    } else if (act === 'remove') {
      const ok = await confirmDialog(
        `Remove "${displayTitle(state.meta)}" from your library? Your episodes, score and notes for it will be deleted.`,
        { title: 'Remove from library?', okText: 'Remove', danger: true },
      );
      if (!ok) return;
      try {
        // the server answers with a full snapshot of the removed show, which Undo sends back
        const { snapshot } = await api.remove(id);
        state.entry = null;
        if (snapshot) toastUndo('Removed from library', () => undoRemove(id, snapshot));
        else toast('Removed from library', 'success');
        state.diary = null; // diary notes are kept (see #/diary) but the panel needs the show on the shelf
        drawActions();
        drawTracker();
        drawJournal();
        drawDiary();
        if (state.seasons) drawSeasons();
      } catch (err) { toast(err.message, 'error'); }
    }
  }

  async function onActionsChange(event) {
    const target = event.target;
    if (target.id === 'a-status') {
      const wasCompleted = state.entry.status === 'completed';
      const before = remember(state.entry); // for the Undo button
      try {
        await patch({ status: target.value });
        toastUndo(`Moved to ${STATUS_LABELS[state.entry.status]}`, () => undoFields(before, ['status']));
        // Setting Completed by hand gets the same diary prompt as finishing the last episode
        if (state.entry.status === 'completed' && !wasCompleted) offerDiary();
      } catch (err) { toast(err.message, 'error'); }
      drawActions();
      drawTracker();
      syncJournalValues();
      if (state.seasons) drawSeasons();
    } else if (target.id === 'a-tier') {
      const before = remember(state.entry); // for the Undo button
      try {
        await patch({ tier: target.value || null });
        toastUndo(state.entry.tier ? `Placed in tier ${state.entry.tier}` : 'Tier cleared', () => undoFields(before, ['tier']));
      } catch (err) {
        toast(err.message, 'error');
        drawActions();
      }
    }
  }

  /* ---------------------------------------------------------------- episodes */
  function gridSize(e) {
    const watchedMax = e.watched.length ? Math.max(...e.watched) : 0;
    if (e.total) return Math.max(e.total, watchedMax);
    return Math.max(e.aired || 0, watchedMax, e.next_episode || 0, MIN_UNKNOWN) + state.extra;
  }

  function episodeTooltip(n, info, upcoming) {
    const parts = [`Episode ${n}`];
    if (info && info.title) parts.push(info.title);
    if (info && info.filler) parts.push('Filler');
    if (info && info.recap) parts.push('Recap');
    if (upcoming) parts.push('Not aired yet');
    return parts.join(' · ');
  }

  function drawTracker() {
    // While rewatching, every number below (count, ring, next episode) is about the rewatch
    const e = trackerEntry();
    // Not on the shelf: no tracker card; "About" takes the full row instead of leaving a hole beside it.
    const grid = els.tracker.closest('.detail-grid');
    if (grid) grid.classList.toggle('solo', !e);
    els.tracker.hidden = !e;
    if (!e) {
      setHTML(els.tracker, '');
      return;
    }

    const watched = new Set(e.watched);
    const n = gridSize(e);
    const total = e.total;
    const airedLimit = state.meta.airing && e.aired ? e.aired : null;
    const listView = state.epView === 'list';
    const pageSize = listView ? LIST_PAGE_SIZE : PAGE_SIZE;
    const paged = n > (listView ? LIST_PAGE_SIZE : PAGING_FROM);
    const pages = paged ? Math.ceil(n / pageSize) : 1;
    if (state.page === null || state.page >= pages) {
      state.page = paged ? Math.min(pages - 1, Math.floor(((e.next_episode || 1) - 1) / pageSize)) : 0;
    }
    const start = paged ? state.page * pageSize + 1 : 1;
    const end = paged ? Math.min(n, start + pageSize - 1) : n;

    const pct = typeof e.progress === 'number' ? Math.min(1, Math.max(0, e.progress)) : null;
    const circumference = 2 * Math.PI * RING_R;
    const offset = circumference * (1 - (pct ?? 0));
    // Draw the ring at the previous value first, then let CSS transition it to the new one.
    const startOffset = circumference * (1 - (state.prevProgress ?? 0));
    state.prevProgress = pct ?? 0;
    const pops = state.popEps;
    state.popEps = new Set();
    const remaining = total ? Math.max(0, total - e.watched_count) : null;
    const minutes = state.meta.duration_min;
    const nextOk = e.next_episode && (!total || e.next_episode <= total) && (!airedLimit || e.next_episode <= airedLimit);
    const unknownTotal = !state.meta.episodes;
    const nextInfo = nextOk ? state.episodeInfo.get(e.next_episode) : null;
    const nextWatch = nextInfo && nextInfo.watch_url && safeUrl(nextInfo.watch_url) ? nextInfo : null;

    let hasFiller = false;
    let hasRecap = false;
    const buttons = [];
    const rows = [];
    for (let num = start; num <= end; num += 1) {
      const info = state.episodeInfo.get(num);
      if (info && info.filler) hasFiller = true;
      if (info && info.recap) hasRecap = true;
      const isWatched = watched.has(num);
      const upcoming = Boolean(airedLimit && num > airedLimit && !isWatched);
      if (listView) {
        rows.push(episodeRow(num, info, isWatched, upcoming, pops.has(num), num - start));
        continue;
      }
      const canWatch = Boolean(info && info.watch_url && safeUrl(info.watch_url));
      buttons.push(html`<span class="ep-cell">${canWatch && !upcoming
        ? html`<button type="button" class="ep-play" data-watch-ep="${num}" title="Watch episode ${num} on ${info.watch_site || 'streaming site'}" aria-label="Watch episode ${num}">${icon('play')}</button>`
        : ''}<button type="button" data-ep="${num}"
        class="ep ${isWatched ? 'watched' : ''} ${pops.has(num) ? (isWatched ? 'pop' : 'unpop') : ''} ${num === e.next_episode ? 'next' : ''} ${info && info.filler ? 'filler' : ''} ${info && info.recap ? 'recap' : ''} ${upcoming ? 'upcoming' : ''}"
        aria-pressed="${isWatched ? 'true' : 'false'}" title="${episodeTooltip(num, info, upcoming)}" ${upcoming ? raw('disabled') : ''}>${num}</button></span>`);
    }

    setHTML(els.tracker, html`
      <div class="panel-head"><h2>${e.rewatching ? `Rewatch #${e.rewatch_number}` : 'Episodes'}</h2>
        <div class="tracker-head-right">
          <span class="faint small">Tip: shift-click to mark a whole range</span>
          <div class="segmented" role="group" aria-label="Episode view">
            <button type="button" data-view="grid" class="${listView ? '' : 'active'}" aria-pressed="${listView ? 'false' : 'true'}">Grid</button>
            <button type="button" data-view="list" class="${listView ? 'active' : ''}" aria-pressed="${listView ? 'true' : 'false'}">List</button>
          </div>
        </div>
      </div>
      ${unknownTotal ? html`<div class="total-override">
        <span>${e.total_override ? `Total set to ${e.total_override} episodes.` : 'Total episodes unknown (still airing?).'}</span>
        <input type="number" id="total-input" min="1" max="5000" placeholder="Total" value="${e.total_override ?? ''}" aria-label="Total episodes">
        <button type="button" class="btn btn-sm" data-act="set-total">Set total</button>
        ${e.total_override ? html`<button type="button" class="btn btn-sm btn-ghost" data-act="clear-total">Clear</button>` : ''}
      </div>` : ''}
      <div class="tracker-top">
        <div class="ring ${pct === 1 ? 'ring-full' : ''}" aria-hidden="true">
          <svg viewBox="0 0 120 120">
            <circle class="ring-bg" cx="60" cy="60" r="${RING_R}"/>
            <circle class="ring-fg" cx="60" cy="60" r="${RING_R}" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${startOffset.toFixed(2)}"/>
          </svg>
          <div class="ring-label">
            <span class="ring-value">${pct !== null ? `${Math.round(pct * 100)}%` : e.watched_count}</span>
            <span class="ring-caption">${pct !== null ? 'done' : 'watched'}</span>
          </div>
        </div>
        <div class="tracker-info">
          <div class="big">${e.watched_count} / ${total ?? '?'} episodes</div>
          <div class="muted small">
            ${e.watched_count === 0 ? (e.rewatching ? 'Rewatch not started yet.' : 'Not started yet.') : (e.watched_text ? `${e.rewatching ? 'Rewatched' : 'Watched'}: ${e.watched_text}` : '')}
          </div>
          ${e.rewatching ? html`<div class="faint small">First watch kept: ${state.entry.watched_count} / ${total ?? '?'}${state.entry.finished_on ? `, finished ${state.entry.finished_on}` : ''}</div>` : ''}
          ${remaining !== null && minutes && remaining > 0 ? html`<div class="faint small">About ${fmtDuration(remaining * minutes)} left · ${plural(remaining, 'episode')} to go</div>` : ''}
          ${remaining === 0 && !e.rewatching ? html`<div class="small" style="color:#6ee7b7;font-weight:650">All caught up</div>` : ''}
          <div class="tracker-buttons">
            ${nextOk ? html`<button type="button" class="btn btn-sm btn-accent" data-act="next">${icon('check')} Mark Ep ${e.next_episode}</button>` : ''}
            ${total ? html`<button type="button" class="btn btn-sm" data-act="all" ${e.watched_count >= total ? raw('disabled') : ''}>Mark all</button>` : ''}
            ${e.watched_count > 0 ? html`<button type="button" class="btn btn-sm btn-ghost" data-act="clear">Clear</button>` : ''}
            ${!total ? html`<button type="button" class="btn btn-sm btn-ghost" data-act="more">${icon('plus')} More episodes</button>` : ''}
            ${e.status === 'completed' && !e.rewatching ? html`<button type="button" class="btn btn-sm" data-act="rewatch-start">Start rewatch${e.rewatch_count ? ` #${e.rewatch_count + 1}` : ''}</button>` : ''}
            ${e.rewatching ? html`<button type="button" class="btn btn-sm" data-act="rewatch-finish">Finish rewatch</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="rewatch-cancel">Stop rewatch</button>` : ''}
          </div>
        </div>
        ${nextWatch ? html`<button type="button" class="watch-cta" data-watch-ep="${e.next_episode}">
          <span class="watch-cta-icon" aria-hidden="true">${icon('play')}</span>
          <span class="watch-cta-text"><small>Up next</small>Watch Ep ${e.next_episode} on ${nextWatch.watch_site || 'Crunchyroll'}</span>
        </button>` : ''}
      </div>
      ${paged ? html`<div class="ep-pages" role="group" aria-label="Episode pages">${Array.from({ length: pages }, (_, p) => html`<button type="button" data-page="${p}" class="${p === state.page ? 'active' : ''}">${p * pageSize + 1}–${Math.min(n, (p + 1) * pageSize)}</button>`)}</div>` : ''}
      ${listView ? html`<div class="ep-list">${rows}</div>` : html`<div class="ep-grid">${buttons}</div>`}
      <div class="ep-legend">
        <span><i style="background:var(--accent)"></i>${e.rewatching ? 'Rewatched' : 'Watched'}</span>
        ${hasFiller ? html`<span><i style="background:#fb923c"></i>Filler</span>` : ''}
        ${hasRecap ? html`<span><i style="background:#94a3b8"></i>Recap</span>` : ''}
        ${airedLimit ? html`<span><i style="background:rgba(255,255,255,.25)"></i>Not aired yet</span>` : ''}
      </div>
      <form class="range-form" autocomplete="off">
        <input type="text" name="ranges" placeholder="Episodes e.g. 1-12, 15" aria-label="Episode ranges">
        <button type="submit" class="btn btn-sm" value="add">Mark watched</button>
        <button type="submit" class="btn btn-sm btn-ghost" value="remove">Unmark</button>
      </form>`);

    const ringFg = els.tracker.querySelector('.ring-fg');
    if (ringFg && Math.abs(startOffset - offset) > 0.01) {
      getComputedStyle(ringFg).strokeDashoffset; // commit the start value so the change transitions
      ringFg.style.strokeDashoffset = offset.toFixed(2);
    }
  }

  function fmtAired(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function episodeRow(num, info, isWatched, upcoming, popped, index) {
    const title = info && info.title ? info.title : '';
    const thumb = info && info.thumbnail ? imgUrl(info.thumbnail) : '';
    const aired = info ? fmtAired(info.aired) : '';
    const watchUrl = info && info.watch_url ? safeUrl(info.watch_url) : '';
    return html`<div class="ep-row ${isWatched ? 'is-watched' : ''} ${upcoming ? 'is-upcoming' : ''}" style="--i:${Math.min(index, 20)}">
      <div class="ep-thumb">
        ${thumb ? html`<img class="fx-img" src="${thumb}" alt="" loading="lazy" decoding="async">` : html`<span>EP ${num}</span>`}
        ${isWatched ? html`<span class="ep-thumb-check" aria-hidden="true">${icon('check')}</span>` : ''}
      </div>
      <div class="ep-info">
        <span class="ep-no">Episode ${num}</span>
        <span class="ep-name ${title ? '' : 'untitled'}" title="${title}">${title || `Episode ${num}`}</span>
        <div class="ep-tags">
          ${info && info.filler ? html`<span class="ep-tag filler">Filler</span>` : ''}
          ${info && info.recap ? html`<span class="ep-tag recap">Recap</span>` : ''}
          ${aired ? html`<span>${upcoming ? 'Airs' : 'Aired'} ${aired}</span>` : (upcoming ? html`<span>Not aired yet</span>` : '')}
        </div>
      </div>
      <div class="ep-row-actions">
        ${watchUrl ? html`<button type="button" class="btn btn-sm btn-watch" data-watch-ep="${num}" title="Watch on ${info.watch_site || 'streaming site'}">${icon('play')} Watch</button>` : ''}
        <button type="button" data-ep="${num}" class="ep-toggle ${isWatched ? 'watched' : ''} ${popped && isWatched ? 'pop' : ''}"
          aria-pressed="${isWatched ? 'true' : 'false'}" aria-label="Episode ${num} watched" ${upcoming ? raw('disabled') : ''}>
          <span class="when-on">${icon('check')} Watched</span><span class="when-off">Mark watched</span>
        </button>
      </div>
    </div>`;
  }

  function episodeAction(body) {
    state.queue = state.queue.then(async () => {
      try {
        const before = new Set(state.entry ? trackerEntry().watched : []);
        const undoState = remember(state.entry); // for the Undo button
        const { entry, status_changed: changed, rewatch_finished: rewatchDone } = await api.updateEpisodes(id, body);
        if (!root.isConnected) return;
        if (rewatchDone) {
          // The last rewatch episode ends rewatch mode on the server; the tracker goes back to the first watch
          state.entry = entry;
          drawTracker();
          drawActions();
          syncJournalValues();
          if (state.seasons) drawSeasons();
          confetti(els.tracker.querySelector('.ring'));
          toast(`Rewatch #${rewatchDone} complete`, 'success');
          offerDiary(rewatchDone);
          return;
        }
        // Episodes whose state flipped get a little bounce (capped so huge ranges stay cheap).
        state.entry = entry;
        const after = new Set(trackerEntry().watched);
        let popped = 0;
        for (const n of new Set([...before, ...after])) {
          if (before.has(n) !== after.has(n) && popped < 150) { state.popEps.add(n); popped += 1; }
        }
        drawTracker();
        if (state.seasons) drawSeasons();
        // An "Undo" toast for every mark/unmark. Undo sends back the whole old episode list.
        const marked = [...after].filter((n) => !before.has(n));
        const unmarked = [...before].filter((n) => !after.has(n));
        if (undoState && (marked.length || unmarked.length)) {
          let message = `${marked.length + unmarked.length} episodes updated`;
          if (marked.length === 1 && !unmarked.length) message = `Episode ${marked[0]} watched`;
          else if (unmarked.length === 1 && !marked.length) message = `Episode ${unmarked[0]} unmarked`;
          else if (!unmarked.length) message = `${marked.length} episodes marked`;
          else if (!marked.length) message = `${unmarked.length} episodes unmarked`;
          toastUndo(message, () => undoEpisodes(undoState));
        }
        if (changed) {
          drawActions();
          syncJournalValues();
          if (changed === 'completed') confetti(els.tracker.querySelector('.ring'));
          toast(changed === 'completed' ? `Moved to Done. Great run!` : `Moved to ${STATUS_LABELS[changed] || changed}`, 'success');
          if (changed === 'completed') offerDiary();
        }
      } catch (err) {
        toast(err.message, 'error');
        if (root.isConnected) drawTracker();
      }
    });
    return state.queue;
  }

  async function onTrackerClick(event) {
    const epBtn = event.target.closest('[data-ep]');
    if (epBtn) {
      const num = Number(epBtn.dataset.ep);
      const isWatched = epBtn.classList.contains('watched');
      if (event.shiftKey && state.lastClicked && state.lastClicked !== num) {
        const a = Math.min(state.lastClicked, num);
        const b = Math.max(state.lastClicked, num);
        state.lastClicked = num;
        episodeAction({ action: isWatched ? 'remove_range' : 'add_range', text: `${a}-${b}` });
      } else {
        state.lastClicked = num;
        epBtn.classList.toggle('watched'); // optimistic; the redraw confirms it with a bounce
        episodeAction({ action: 'toggle', episode: num });
      }
      return;
    }

    const viewBtn = event.target.closest('[data-view]');
    if (viewBtn) {
      if (viewBtn.dataset.view === state.epView) return;
      state.epView = viewBtn.dataset.view === 'list' ? 'list' : 'grid';
      try { localStorage.setItem('anishelf.epView', state.epView); } catch { /* storage unavailable */ }
      state.page = null;
      drawTracker();
      return;
    }

    const watchBtn = event.target.closest('[data-watch-ep]');
    if (watchBtn) {
      watchEpisode(Number(watchBtn.dataset.watchEp));
      return;
    }

    const pageBtn = event.target.closest('[data-page]');
    if (pageBtn) {
      state.page = Number(pageBtn.dataset.page);
      drawTracker();
      return;
    }

    const actBtn = event.target.closest('[data-act]');
    if (!actBtn) return;
    const act = actBtn.dataset.act;
    const e = trackerEntry();
    if (act.startsWith('rewatch-')) {
      rewatchAction(act.slice('rewatch-'.length), actBtn);
    } else if (act === 'next' && e.next_episode) {
      episodeAction({ action: 'toggle', episode: e.next_episode });
    } else if (act === 'all') {
      episodeAction({ action: 'all' });
    } else if (act === 'clear') {
      const message = e.rewatching ? 'Unmark every episode of this rewatch? Your first watch stays.' : 'Unmark every episode of this anime?';
      const ok = await confirmDialog(message, { title: 'Clear episodes?', okText: 'Clear all', danger: true });
      if (ok) episodeAction({ action: 'clear' });
    } else if (act === 'more') {
      state.extra += 12;
      drawTracker();
    } else if (act === 'set-total' || act === 'clear-total') {
      let value = null;
      if (act === 'set-total') {
        const input = els.tracker.querySelector('#total-input');
        value = Number.parseInt(input.value, 10);
        if (!Number.isInteger(value) || value < 1 || value > 5000) {
          toast('Total must be a whole number from 1 to 5000', 'error');
          return;
        }
      }
      try {
        await patch({ total_override: value });
        toast(value ? `Total set to ${value} episodes` : 'Total cleared', 'success', 2200);
        drawTracker();
      } catch (err) { toast(err.message, 'error'); }
    }
  }

  function onTrackerSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const input = form.querySelector('[name="ranges"]');
    const text = input.value.trim();
    if (!text) {
      toast('Type some episodes, e.g. 1-12, 15', 'error');
      input.focus();
      return;
    }
    const mode = event.submitter && event.submitter.value === 'remove' ? 'remove_range' : 'add_range';
    episodeAction({ action: mode, text }).then(() => {
      const fresh = els.tracker && els.tracker.querySelector('[name="ranges"]');
      if (fresh) fresh.value = '';
    });
  }

  /* ---------------------------------------------------------------- rewatch */
  async function rewatchAction(action, button) {
    if (action === 'cancel') {
      const ok = await confirmDialog("Stop this rewatch without counting it? Episodes you've rewatched stay in your stats.",
        { title: 'Stop rewatch?', okText: 'Stop rewatch' });
      if (!ok) return;
    }
    const number = state.entry.rewatching ? state.entry.rewatch_number : null;
    button.disabled = true;
    try {
      const { entry } = await api.rewatch(id, action);
      if (!root.isConnected) return;
      state.entry = entry;
      state.page = null;
      drawTracker();
      syncJournalValues();
      if (state.seasons) drawSeasons();
      if (action === 'start') toast(`Rewatch #${entry.rewatch_number} started`, 'success', 2200);
      else if (action === 'cancel') toast('Rewatch stopped', 'success', 2200);
      else {
        toast(`Rewatch #${number} complete`, 'success');
        offerDiary(number);
      }
    } catch (err) {
      toast(err.message, 'error');
      if (button.isConnected) button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- watch diary */
  function offerDiary(rewatchNumber = null) {
    askForDiary({ malId: id, animeTitle: displayTitle(state.meta), rewatch: rewatchNumber });
    // The saved note arrives through the 'anishelf:changed' listener above
  }

  async function loadDiary() {
    if (!state.entry) return;
    try {
      const data = await api.diary({ mal_id: id });
      if (!root.isConnected) return;
      state.diary = data.entries || [];
      drawDiary();
    } catch (err) {
      if (err.status === 404) return; // endpoint missing: keep the panel hidden
      console.warn('Diary unavailable:', err.message);
    }
  }

  function fmtNoteDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function drawDiary() {
    if (!els.diary) return;
    if (!state.entry || state.diary === null) {
      els.diary.hidden = true;
      return;
    }
    els.diary.hidden = false;
    const notes = state.diary;
    setHTML(els.diary, html`
      <div class="panel-head"><h2>Watch diary</h2>
        <button type="button" class="btn btn-sm" data-diary-add>${icon('plus')} Add a line</button>
      </div>
      ${notes.length
        ? html`<ul class="detail-diary">${notes.map((n) => html`<li>
            <div class="diary-line">${moodMark(n.mood)}<span class="faint small">${fmtNoteDate(n.created_at)}</span></div>
            ${n.text ? html`<p>${n.text}</p>` : ''}
            <div class="diary-actions">
              <button type="button" class="link-btn" data-diary-edit="${n.id}">Edit</button>
              <button type="button" class="link-btn" data-diary-delete="${n.id}">Delete</button>
            </div>
          </li>`)}</ul>
          <a class="small muted" href="#/diary">See your whole diary</a>`
        : html`<p class="muted">No diary notes for this show yet. One line and a mood is enough.</p>`}`);
  }

  async function onDiaryClick(event) {
    if (event.target.closest('[data-diary-add]')) {
      await openDiaryEditor({ malId: id, animeTitle: displayTitle(state.meta) });
      return; // the list reloads through the 'anishelf:changed' listener
    }
    const editBtn = event.target.closest('[data-diary-edit]');
    if (editBtn) {
      const note = (state.diary || []).find((n) => n.id === Number(editBtn.dataset.diaryEdit));
      if (note) await openDiaryEditor({ malId: id, animeTitle: displayTitle(state.meta), note });
      return;
    }
    const deleteBtn = event.target.closest('[data-diary-delete]');
    if (deleteBtn) {
      const ok = await confirmDialog('Delete this diary note?', { title: 'Delete note?', okText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api.deleteDiary(Number(deleteBtn.dataset.diaryDelete));
        toast('Note deleted', 'success', 2200);
      } catch (err) { toast(err.message, 'error'); }
    }
  }

  /* ---------------------------------------------------------------- journal */
  function drawJournal() {
    const e = state.entry;
    if (!e) {
      els.journal.hidden = true;
      setHTML(els.journal, '');
      refreshHearts();
      return;
    }
    els.journal.hidden = false;
    setHTML(els.journal, html`
      <div class="panel-head"><h2>My journal</h2><span class="save-ind" id="save-ind" aria-live="polite"></span></div>
      <div class="journal-grid">
        <label class="field span-2"><span>Notes</span>
          <textarea data-field="notes" rows="5" maxlength="20000" placeholder="What did you think? Theories, feelings, hot takes…">${e.notes || ''}</textarea>
        </label>
        <label class="field"><span>Favourite character</span>
          <input type="text" data-field="fav_character" maxlength="300" value="${e.fav_character || ''}" placeholder="e.g. Fern">
        </label>
        <label class="field"><span>Favourite moment</span>
          <input type="text" data-field="fav_moment" maxlength="300" value="${e.fav_moment || ''}" placeholder="That one scene…">
        </label>
        <label class="field"><span>Started</span>
          <input type="date" data-field="started_on" value="${e.started_on || ''}">
        </label>
        <label class="field"><span>Finished</span>
          <input type="date" data-field="finished_on" value="${e.finished_on || ''}">
        </label>
        <label class="field"><span>Times rewatched</span>
          <input type="number" data-field="rewatch_count" min="0" max="999" value="${e.rewatch_count ?? 0}">
        </label>
      </div>`);
    refreshHearts();
  }

  function syncJournalValues() {
    if (!els.journal || !state.entry) return;
    els.journal.querySelectorAll('[data-field]').forEach((el) => {
      if (el === document.activeElement) return;
      const value = state.entry[el.dataset.field];
      el.value = value === null || value === undefined ? '' : String(value);
    });
  }

  function showSaved(kind) {
    const ind = els.journal && els.journal.querySelector('#save-ind');
    if (!ind) return;
    clearTimeout(savedTimer);
    ind.className = `save-ind show ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''}`;
    ind.textContent = kind === 'ok' ? 'Saved' : kind === 'err' ? 'Not saved' : 'Saving…';
    if (kind === 'ok') savedTimer = setTimeout(() => ind.classList.remove('show'), 1800);
  }

  async function saveField(el) {
    if (!state.entry || !el.isConnected) return;
    const field = el.dataset.field;
    let value = el.value;
    if (field === 'rewatch_count') {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0 || n > 999) {
        toast('Rewatch count must be a whole number from 0 to 999', 'error');
        el.value = String(state.entry.rewatch_count ?? 0);
        return;
      }
      value = n;
    } else if (field === 'started_on' || field === 'finished_on') {
      value = value || null;
    }
    const current = state.entry[field];
    if ((current ?? '') === (value ?? '')) return;

    showSaved('saving');
    try {
      await patch({ [field]: value });
      showSaved('ok');
      if (field === 'fav_character') refreshHearts();
    } catch (err) {
      showSaved('err');
      toast(err.message, 'error');
    }
  }

  function onJournalChange(event) {
    const el = event.target.closest('[data-field]');
    if (!el) return;
    if (el.dataset.field === 'notes') clearTimeout(notesTimer);
    saveField(el);
  }

  function onJournalInput(event) {
    const el = event.target.closest('[data-field="notes"]');
    if (!el) return;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => saveField(el), 1200);
  }

  /* ---------------------------------------------------------------- cleanup */
  return () => {
    window.removeEventListener('anishelf:episodes-updated', onEpisodesUpdated);
    window.removeEventListener('anishelf:changed', onChanged);
    window.removeEventListener('scroll', onScroll);
    if (parallaxFrame) cancelAnimationFrame(parallaxFrame);
    clearInterval(countdownTimer);
    clearTimeout(savedTimer);
    if (notesTimer) {
      clearTimeout(notesTimer);
      const notes = els.journal && els.journal.querySelector('[data-field="notes"]');
      // Flush unsaved notes when leaving the page (fire and forget).
      if (notes && state.entry && notes.value !== (state.entry.notes || '')) {
        api.patch(id, { notes: notes.value }).catch((err) => toast(`Notes not saved: ${err.message}`, 'error'));
      }
    }
  };
}
