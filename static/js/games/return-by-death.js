// Return by Death: cross a field of hidden traps. Each death sends you back to the start,
// but you keep every tile you learned. Fewest deaths wins.
import { html, setHTML } from '../ui.js';
import { randInt, clamp, finishRun, startScreen } from './common.js';

const COLS = 7;
const ROWS = 10;
const LOOP_SECONDS = 25;

export const returnByDeath = {
  id: 'return-by-death',
  title: 'Return by Death',
  blurb: 'Cross a field of hidden traps. Every death sends you back to the start, but you remember what killed you.',
  unit: 'deaths',
  theme: { label: 'Re:ZERO', match: /re:?\s?zero/i },
  mount,
};

/** A random walk up the board: each row's safe tile is next to the one below it. */
function makePath() {
  const path = [randInt(2, COLS - 3)];
  for (let r = 1; r < ROWS; r += 1) path.push(clamp(path[r - 1] + randInt(-1, 1), 0, COLS - 1));
  return path;
}

function mount(el) {
  let tick = null;
  let pause = null;

  function start() {
    const path = makePath();
    const known = new Map(); // "r,c" -> 'safe' | 'trap'
    let deaths = 0;
    let pos = { r: -1, c: Math.floor(COLS / 2) }; // r = -1 is the start ledge
    let timeLeft = LOOP_SECONDS;
    let busy = false;

    setHTML(el, html`<div class="rbd">
      <div class="rbd-head">
        <p class="num"><span data-deaths>0</span> deaths · loop <span data-loop>1</span></p>
        <div class="rbd-time" aria-label="Time left this loop"><span data-time></span></div>
      </div>
      <div class="rbd-board" role="grid" aria-label="Trap field"></div>
      <p class="faint small">Click a highlighted tile, or use the arrow keys: left, up, right. You have ${LOOP_SECONDS} seconds per loop.</p>
      <div class="rbd-flash" aria-hidden="true"></div>
    </div>`);
    const board = el.querySelector('.rbd-board');
    const timeBar = el.querySelector('[data-time]');
    const flash = el.querySelector('.rbd-flash');

    // You can step up or diagonally up, but never back onto a trap you already found.
    const reachable = (r, c) => r === pos.r + 1 && Math.abs(c - pos.c) <= 1 && known.get(`${r},${c}`) !== 'trap';

    function draw() {
      const cells = [];
      for (let r = ROWS - 1; r >= -1; r -= 1) { // top of the screen is the goal row
        for (let c = 0; c < COLS; c += 1) {
          if (r === -1) {
            cells.push(html`<div class="rbd-cell rbd-ledge ${pos.r === -1 && pos.c === c ? 'is-here' : ''}"></div>`);
            continue;
          }
          const state = known.get(`${r},${c}`) || '';
          const here = pos.r === r && pos.c === c;
          const can = reachable(r, c) && !busy;
          cells.push(html`<button type="button" class="rbd-cell ${state ? `is-${state}` : ''} ${here ? 'is-here' : ''} ${can ? 'is-reachable' : ''}"
            data-r="${r}" data-c="${c}" ${can ? '' : 'disabled'} aria-label="Row ${r + 1}, column ${c + 1}${state ? `, ${state}` : ''}"></button>`);
        }
      }
      setHTML(board, html`${cells}`);
      board.style.setProperty('--cols', COLS);
    }

    function die(cause) {
      deaths += 1;
      busy = true;
      el.querySelector('[data-deaths]').textContent = String(deaths);
      flash.textContent = cause;
      flash.classList.add('show');
      draw();
      pause = setTimeout(() => {
        flash.classList.remove('show');
        pos = { r: -1, c: Math.floor(COLS / 2) };
        timeLeft = LOOP_SECONDS;
        busy = false;
        el.querySelector('[data-loop]').textContent = String(deaths + 1);
        draw();
      }, 900);
    }

    function step(r, c) {
      if (busy || !reachable(r, c) || c < 0 || c >= COLS) return;
      pos = { r, c };
      if (path[r] !== c) {
        known.set(`${r},${c}`, 'trap');
        die('Returned by death');
        return;
      }
      known.set(`${r},${c}`, 'safe');
      if (r === ROWS - 1) {
        clearInterval(tick);
        busy = true;
        draw();
        pause = setTimeout(() => finishRun(el, returnByDeath, {
          score: deaths,
          headline: deaths === 0 ? 'Not a single death' : `Made it after ${deaths + 1} loops`,
          detail: 'Lower is better.',
          again: start,
        }), 600);
        return;
      }
      draw();
    }

    board.addEventListener('click', (ev) => {
      const cell = ev.target.closest('button.rbd-cell');
      if (cell) step(Number(cell.dataset.r), Number(cell.dataset.c));
      el.focus(); // the clicked button was just redrawn away; keep arrow keys working
    });
    el.onkeydown = (ev) => {
      const moves = { ArrowLeft: -1, a: -1, ArrowUp: 0, w: 0, ArrowRight: 1, d: 1 };
      if (!(ev.key in moves)) return;
      ev.preventDefault();
      step(pos.r + 1, pos.c + moves[ev.key]);
    };

    clearInterval(tick);
    tick = setInterval(() => {
      if (busy) return;
      timeLeft -= 0.1;
      timeBar.style.width = `${Math.max(0, timeLeft / LOOP_SECONDS) * 100}%`;
      if (timeLeft <= 0) die('Out of time');
    }, 100);

    draw();
    el.tabIndex = -1;
    el.focus();
  }

  startScreen(el, {
    title: 'Return by Death',
    rules: [
      'Get from the bottom ledge to the top row. Only one tile per row is safe.',
      'You can step up, or up and one to the side.',
      'Step on a trap and you go back to the start, but the tiles you found stay marked.',
      `Each loop has ${LOOP_SECONDS} seconds. Fewest deaths wins.`,
    ],
    onStart: start,
  });

  return () => { clearInterval(tick); clearTimeout(pause); el.onkeydown = null; };
}
