// Cover Reveal: a cover from your shelf starts as big blocks and sharpens. Name the show fast.
import { html, setHTML } from '../ui.js';
import { shuffle, onePerSeries, seriesTitle, loadImage, finishRun, startScreen } from './common.js';

const ROUNDS = 10;
const BLOCKS = [40, 28, 20, 14, 10, 7, 5, 3, 2, 1]; // block size in px, one step per tick
const TICK_MS = 900;
const W = 240;
const H = 340;

export const coverReveal = {
  id: 'cover-reveal',
  title: 'Cover Reveal',
  blurb: 'A cover from your shelf starts as blocks and slowly sharpens. Name the show before it does.',
  unit: 'pts',
  minEntries: 4,
  mount,
};

/** Draw `img` as a grid of `block`-sized squares: shrink it, then scale it up with smoothing off. */
function pixelate(ctx, small, img, block) {
  const sw = Math.max(1, Math.round(W / block));
  const sh = Math.max(1, Math.round(H / block));
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  sctx.drawImage(img, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, 0, 0, W, H);
}

function mount(el, { entries }) {
  let timer = null;
  let alive = true;
  const stop = () => { clearInterval(timer); timer = null; };

  function start() {
    const pool = onePerSeries(entries.filter((e) => e.meta.image));
    if (pool.length < 4) {
      setHTML(el, html`<p class="muted">You need at least 4 different shows with covers on your shelf.</p>`);
      return;
    }
    const rounds = shuffle(pool).slice(0, Math.min(ROUNDS, pool.length));
    let round = 0;
    let total = 0;
    let correct = 0;
    let played = 0; // rounds actually shown (a cover that fails to load is skipped)

    async function playRound() {
      stop();
      if (!alive) return;
      if (round >= rounds.length) {
        finishRun(el, coverReveal, {
          score: total,
          headline: `${correct} of ${played} right`,
          detail: 'Faster answers score more: 100 points on the first frame, 10 on the last.',
          again: start,
        });
        return;
      }
      const answer = rounds[round];
      const others = shuffle(pool.filter((e) => e !== answer)).slice(0, 3);
      const options = shuffle([answer, ...others]);

      setHTML(el, html`<div class="cr-layout">
        <div class="cr-picture">
          <canvas width="${W}" height="${H}" aria-label="Pixelated cover"></canvas>
          <div class="cr-meter" aria-hidden="true"><span></span></div>
        </div>
        <div class="cr-side">
          <p class="faint small num">Round ${round + 1} of ${rounds.length} · ${total} pts</p>
          <h2>Which show is this?</h2>
          <div class="cr-options">
            ${options.map((o, i) => html`<button type="button" class="btn cr-option" data-i="${i}">
              <span class="kbd">${i + 1}</span><span class="cr-option-text">${seriesTitle(o)}</span></button>`)}
          </div>
          <p class="cr-feedback small" aria-live="polite"></p>
        </div>
      </div>`);

      const canvas = el.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const small = document.createElement('canvas');
      const meter = el.querySelector('.cr-meter span');
      let img;
      try {
        img = await loadImage(answer.meta.image);
      } catch {
        round += 1; // broken cover: skip this round quietly
        playRound();
        return;
      }
      if (!alive || !canvas.isConnected) return;

      let step = 0;
      let answered = false;
      pixelate(ctx, small, img, BLOCKS[0]);
      meter.style.width = '100%';
      timer = setInterval(() => {
        if (step < BLOCKS.length - 1) {
          step += 1;
          pixelate(ctx, small, img, BLOCKS[step]);
          meter.style.width = `${100 - (step / (BLOCKS.length - 1)) * 100}%`;
        } else {
          stop();
        }
      }, TICK_MS);

      function choose(i) {
        if (answered) return;
        answered = true;
        stop();
        const picked = options[i];
        const right = picked === answer;
        const points = right ? Math.round(100 - (step / (BLOCKS.length - 1)) * 90) : 0;
        total += points;
        if (right) correct += 1;
        played += 1;
        pixelate(ctx, small, img, 1); // show the real cover
        el.querySelectorAll('.cr-option').forEach((b, j) => {
          b.disabled = true;
          if (options[j] === answer) b.classList.add('is-right');
          else if (j === i) b.classList.add('is-wrong');
        });
        el.querySelector('.cr-feedback').textContent = right ? `+${points} points` : `It was ${seriesTitle(answer)}`;
        round += 1;
        timer = setTimeout(playRound, right ? 1100 : 1800);
      }

      el.querySelectorAll('.cr-option').forEach((b) => b.addEventListener('click', () => choose(Number(b.dataset.i))));
      el.onkeydown = (ev) => {
        const n = Number(ev.key);
        if (n >= 1 && n <= options.length) choose(n - 1);
      };
      el.querySelector('.cr-option').focus();
    }

    playRound();
  }

  startScreen(el, {
    title: 'Cover Reveal',
    rules: [
      `${ROUNDS} covers from your shelf, one per show.`,
      'Each starts as big blocks and sharpens about once a second.',
      'Answer early for more points. Keys 1 to 4 pick an answer.',
    ],
    onStart: start,
  });

  return () => { alive = false; stop(); clearTimeout(timer); el.onkeydown = null; };
}
