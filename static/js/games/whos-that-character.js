// Who's That Character? A portrait from one of your shows: pick the right name (or, in some
// rounds, the right anime) from 4 options. Faster answers score more.
import { html, setHTML, imgUrl, setAccent } from '../ui.js';
import { api } from '../api.js';
import { playSound } from '../sound.js';
import {
  shuffle, onePerSeries, seriesKey, seriesTitle, loadImage, finishRun, startScreen,
} from './common.js';

const ROUNDS = 10;
const MAX_SERIES = 8; // hard cap: at most 8 character requests per game
const FETCH_GAP_MS = 250; // small pause between requests, to be gentle with the API
const ROUND_MS = 10000; // 10 seconds to answer
const MAX_POINTS = 1000; // 10 rounds x 1000 = the 10000 maximum the server allows
const MIN_POINTS = 100; // a right answer at the very last moment still earns this
const ANIME_ROUND_CHANCE = 0.3; // about 3 rounds in 10 ask for the anime instead of the name
const USABLE_ROLES = ['MAIN', 'SUPPORTING']; // background characters are too obscure

export const whosThatCharacter = {
  id: 'whos-that-character',
  title: "Who's That Character?",
  blurb: 'A character from one of your shows. Pick their name (or their anime) before the clock runs out.',
  unit: 'pts',
  minEntries: 1,
  mount,
};

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Collect characters from up to MAX_SERIES random shows on the shelf, one request at a time.
 * `cache` (a Map) remembers answers for this visit, so "Play again" doesn't ask twice.
 * Returns a list of { id, name, image, entry } where entry is the library entry they come from.
 */
async function gatherCharacters(entries, cache, isAlive, onProgress) {
  const picks = shuffle(onePerSeries(entries)).slice(0, MAX_SERIES);
  const seen = new Set(); // character ids, so a character in two shows only appears once
  const characters = [];

  for (let i = 0; i < picks.length; i += 1) {
    if (!isAlive()) return characters;
    const entry = picks[i];
    onProgress(i + 1, picks.length);

    let list = cache.get(entry.mal_id);
    if (!list) {
      try {
        const data = await api.characters(entry.mal_id);
        list = Array.isArray(data.characters) ? data.characters : [];
      } catch {
        list = []; // one show failing (offline, API hiccup) just means fewer characters
      }
      cache.set(entry.mal_id, list);
      if (i < picks.length - 1) await wait(FETCH_GAP_MS);
    }

    for (const c of list) {
      const usable = c && c.name && c.image && USABLE_ROLES.includes(c.role) && !seen.has(c.id);
      if (!usable) continue;
      seen.add(c.id);
      characters.push({ id: c.id, name: c.name, image: c.image, entry });
    }
  }
  return characters;
}

/** Points for a right answer: MAX_POINTS straight away, sliding down to MIN_POINTS at the buzzer. */
function pointsFor(elapsedMs) {
  const fraction = Math.min(1, elapsedMs / ROUND_MS);
  return Math.round(MAX_POINTS - fraction * (MAX_POINTS - MIN_POINTS));
}

/** Build one question. Returns { character, mode, options: [text], answerIndex }. */
function makeQuestion(character, characters, shelfSeries) {
  // An "anime" round needs 4 different shows to choose from.
  const canAskAnime = shelfSeries.length >= 4;
  const mode = canAskAnime && Math.random() < ANIME_ROUND_CHANCE ? 'anime' : 'name';

  let answer;
  let wrong;
  if (mode === 'anime') {
    answer = seriesTitle(character.entry);
    const key = seriesKey(character.entry);
    wrong = shuffle(shelfSeries.filter((e) => seriesKey(e) !== key)).map(seriesTitle);
  } else {
    answer = character.name;
    wrong = shuffle(characters.filter((c) => c.name !== answer)).map((c) => c.name);
  }
  // Keep 3 wrong options with distinct text (two characters can share a name).
  const distinctWrong = [];
  for (const text of wrong) {
    if (text !== answer && !distinctWrong.includes(text)) distinctWrong.push(text);
    if (distinctWrong.length === 3) break;
  }
  const options = shuffle([answer, ...distinctWrong]);
  return { character, mode, options, answerIndex: options.indexOf(answer) };
}

function mount(el, { entries }) {
  let alive = true;
  let timer = null; // the round clock (setInterval) or the pause before the next round (setTimeout)
  const cache = new Map();
  const stop = () => { clearInterval(timer); clearTimeout(timer); timer = null; };
  const isAlive = () => alive && el.isConnected;

  function showEmpty(count) {
    setHTML(el, html`<div class="game-start">
      <h2>Not enough characters yet</h2>
      <p class="muted">This game needs at least 4 main or supporting characters with pictures from your shows,
        and it found ${count}. Add a few more anime to your shelf, or try again if you were offline.</p>
      <div class="game-result-actions">
        <button type="button" class="btn btn-primary" data-retry>Try again</button>
        <a class="btn" href="#/search">Find anime</a>
      </div>
    </div>`);
    el.querySelector('[data-retry]').addEventListener('click', start, { once: true });
  }

  async function start() {
    stop();
    setHTML(el, html`<div class="game-start">
      <h2>Gathering characters…</h2>
      <p class="muted num" data-progress>Looking through your shelf</p>
    </div>`);
    const progressEl = el.querySelector('[data-progress]');
    const characters = await gatherCharacters(entries, cache, isAlive, (done, total) => {
      if (progressEl.isConnected) progressEl.textContent = `Show ${done} of ${total}`;
    });
    if (!isAlive()) return;
    if (characters.length < 4) {
      showEmpty(characters.length);
      return;
    }

    const shelfSeries = onePerSeries(entries);
    const questions = shuffle(characters)
      .slice(0, ROUNDS)
      .map((c) => makeQuestion(c, characters, shelfSeries));
    let round = 0;
    let total = 0;
    let correct = 0;
    let played = 0; // rounds actually shown (a portrait that fails to load is skipped)

    async function playRound() {
      stop();
      if (!isAlive()) return;
      if (round >= questions.length) {
        setAccent(null);
        finishRun(el, whosThatCharacter, {
          score: total,
          headline: `${correct} of ${played} right`,
          detail: 'Up to 1000 points a round: the faster you answer, the more you get.',
          again: start,
        });
        return;
      }
      const q = questions[round];
      // Preload the portrait first, so the clock only starts once the picture is visible.
      try {
        await loadImage(q.character.image);
      } catch {
        round += 1;
        playRound();
        return;
      }
      if (!isAlive()) return;
      // The accent follows the show this character is from (it colours the timer bar only).
      const anilist = q.character.entry.meta.anilist;
      setAccent(anilist ? anilist.color : null);

      const question = q.mode === 'anime' ? 'Which anime are they from?' : 'Who is this?';
      setHTML(el, html`<div class="wtc-layout">
        <div class="wtc-picture">
          <img class="wtc-portrait" src="${imgUrl(q.character.image)}" alt="Character portrait" draggable="false">
          <div class="cr-meter" aria-hidden="true"><span></span></div>
        </div>
        <div class="cr-side">
          <p class="faint small num">Round ${round + 1} of ${questions.length} · ${total} pts</p>
          <h2>${question}</h2>
          ${q.mode === 'anime' ? html`<p class="muted">${q.character.name}</p>` : ''}
          <div class="cr-options">
            ${q.options.map((text, i) => html`<button type="button" class="btn cr-option" data-i="${i}">
              <span class="kbd">${i + 1}</span><span class="cr-option-text">${text}</span></button>`)}
          </div>
          <p class="cr-feedback small" aria-live="polite"></p>
        </div>
      </div>`);

      const meter = el.querySelector('.cr-meter span');
      const startedAt = performance.now();
      let answered = false;

      // The clock: update the bar ~10 times a second and end the round at ROUND_MS.
      timer = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        meter.style.width = `${Math.max(0, 100 - (elapsed / ROUND_MS) * 100)}%`;
        if (elapsed >= ROUND_MS) choose(-1); // -1 means "time ran out"
      }, 100);

      function choose(i) {
        if (answered) return;
        answered = true;
        stop();
        const right = i === q.answerIndex;
        const points = right ? pointsFor(performance.now() - startedAt) : 0;
        total += points;
        played += 1;
        if (right) correct += 1;
        playSound(right ? 'tick' : 'error');

        el.querySelectorAll('.cr-option').forEach((b, j) => {
          b.disabled = true;
          if (j === q.answerIndex) b.classList.add('is-right');
          else if (j === i) b.classList.add('is-wrong');
        });
        const answerText = q.options[q.answerIndex];
        let feedback = `+${points} points`;
        if (!right && i === -1) feedback = `Time's up: ${answerText}`;
        else if (!right) feedback = `It was ${answerText}`;
        // In a name round, also say which show they're from: a small bit of trivia either way.
        if (q.mode === 'name') feedback += ` · ${seriesTitle(q.character.entry)}`;
        el.querySelector('.cr-feedback').textContent = feedback;
        round += 1;
        timer = setTimeout(playRound, right ? 1200 : 2000);
      }

      el.querySelectorAll('.cr-option').forEach((b) => b.addEventListener('click', () => choose(Number(b.dataset.i))));
      el.onkeydown = (ev) => {
        const n = Number(ev.key);
        if (n >= 1 && n <= q.options.length) choose(n - 1);
      };
      el.querySelector('.cr-option').focus();
    }

    playRound();
  }

  startScreen(el, {
    title: "Who's That Character?",
    rules: [
      `${ROUNDS} characters from up to ${MAX_SERIES} shows on your shelf.`,
      'Pick their name, or in some rounds the anime they are from.',
      'Up to 1000 points a round, fewer the longer you take (10 seconds each). Keys 1 to 4 answer.',
    ],
    onStart: start,
  });

  return () => { alive = false; stop(); el.onkeydown = null; };
}
