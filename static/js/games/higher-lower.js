// Higher or Lower: two shows from your shelf, one question. Keep the streak alive.
import { html, setHTML, coverHtml, displayTitle, fmtNumber } from '../ui.js';
import { shuffle, finishRun, startScreen } from './common.js';

// Each question knows how to read its number and which side wins.
const QUESTIONS = [
  { ask: 'Which has the higher MAL score?', value: (m) => m.mal_score, show: (v) => fmtNumber(v, 2), higherWins: true },
  { ask: 'Which has more episodes?', value: (m) => m.episodes, show: (v) => `${fmtNumber(v)} eps`, higherWins: true },
  { ask: 'Which came out first?', value: (m) => m.year, show: (v) => String(v), higherWins: false },
  { ask: 'Which has longer episodes?', value: (m) => m.duration_min, show: (v) => `${fmtNumber(v)} min`, higherWins: true },
  { ask: 'Which is more popular on MAL?', value: (m) => m.popularity, show: (v) => `#${fmtNumber(v)}`, higherWins: false },
];

export const higherLower = {
  id: 'higher-lower',
  title: 'Higher or Lower',
  blurb: 'Two shows from your shelf. Which scored higher, ran longer or came out first? One miss ends the streak.',
  unit: 'streak',
  minEntries: 4,
  mount,
};

/** Find two different shows whose numbers differ for this question. */
function makeRound(entries) {
  for (let tries = 0; tries < 60; tries += 1) {
    const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    const usable = entries.filter((e) => typeof q.value(e.meta) === 'number');
    if (usable.length < 2) continue;
    const [a, b] = shuffle(usable);
    const va = q.value(a.meta);
    const vb = q.value(b.meta);
    if (va === vb) continue;
    const winner = (va > vb) === q.higherWins ? a : b;
    return { q, pair: [a, b], winner };
  }
  return null;
}

function mount(el, { entries }) {
  let timer = null;

  function start() {
    let streak = 0;

    function next() {
      const round = makeRound(entries);
      if (!round) {
        setHTML(el, html`<p class="muted">Not enough shows with scores and episode counts to compare.</p>`);
        return;
      }
      const { q, pair, winner } = round;
      setHTML(el, html`<div class="hl">
        <p class="faint small num">Streak ${streak}</p>
        <h2>${q.ask}</h2>
        <div class="hl-pair">
          ${pair.map((e, i) => html`<button type="button" class="hl-pick" data-i="${i}">
            ${coverHtml(e.meta.image, displayTitle(e.meta))}
            <span class="hl-title">${displayTitle(e.meta)}</span>
            <span class="hl-value num" aria-live="polite"></span>
          </button>`)}
        </div>
        <p class="faint small">Left and right arrow keys work too.</p>
      </div>`);

      let done = false;
      function pick(i) {
        if (done) return;
        done = true;
        const right = pair[i] === winner;
        el.querySelectorAll('.hl-pick').forEach((btn, j) => {
          btn.disabled = true;
          btn.querySelector('.hl-value').textContent = q.show(q.value(pair[j].meta));
          btn.classList.add(pair[j] === winner ? 'is-right' : 'is-loser');
          if (j === i && !right) btn.classList.add('is-wrong');
        });
        if (right) {
          streak += 1;
          timer = setTimeout(next, 1000);
        } else {
          timer = setTimeout(() => finishRun(el, higherLower, {
            score: streak,
            headline: streak ? `Streak of ${streak}` : 'Missed the first one',
            again: start,
          }), 1500);
        }
      }
      el.querySelectorAll('.hl-pick').forEach((b) => b.addEventListener('click', () => pick(Number(b.dataset.i))));
      el.onkeydown = (ev) => {
        if (ev.key === 'ArrowLeft') pick(0);
        if (ev.key === 'ArrowRight') pick(1);
      };
      el.querySelector('.hl-pick').focus();
    }
    next();
  }

  startScreen(el, {
    title: 'Higher or Lower',
    rules: [
      'You get two shows from your library and one question about them.',
      'Pick the one that wins. Keep going until you get one wrong.',
      'Numbers come from MyAnimeList.',
    ],
    onStart: start,
  });

  return () => { clearTimeout(timer); el.onkeydown = null; };
}
