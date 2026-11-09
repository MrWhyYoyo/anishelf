// Operation Strix: crack a 4-symbol code. After each guess you learn how many symbols are in
// the right place and how many are in the code but somewhere else. One mind-read hint per game.
import { html, setHTML, raw } from '../ui.js';
import { shuffle, finishRun, startScreen } from './common.js';

const LENGTH = 4;
const MAX_GUESSES = 10;
// Six shapes drawn in SVG (no colour needed to tell them apart).
const SYMBOLS = [
  { name: 'circle', svg: '<circle cx="12" cy="12" r="7"/>' },
  { name: 'square', svg: '<rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/>' },
  { name: 'triangle', svg: '<path d="M12 4.5 20 19H4z"/>' },
  { name: 'diamond', svg: '<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/>' },
  { name: 'star', svg: '<path d="m12 3.5 2.6 5.6 6 .6-4.5 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6L3.4 9.7l6-.6z"/>' },
  { name: 'cross', svg: '<path d="M9 4h6v5h5v6h-5v5H9v-5H4V9h5z"/>' },
];

export const operationStrix = {
  id: 'operation-strix',
  title: 'Operation Strix',
  blurb: 'Crack the 4-symbol code in as few guesses as you can. You get one mind-read hint.',
  unit: 'guesses',
  theme: { label: 'SPY x FAMILY', match: /spy\s?x\s?family/i },
  mount,
};

const glyph = (i) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${SYMBOLS[i].svg}</svg>`);

/**
 * Score one guess against the code.
 * exact   = right symbol in the right place
 * present = in the code, wrong place (each symbol in the code counts only once)
 */
export function grade(code, guess) {
  let exact = 0;
  const codeLeft = [];
  const guessLeft = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === guess[i]) exact += 1;
    else { codeLeft.push(code[i]); guessLeft.push(guess[i]); }
  }
  let present = 0;
  for (const g of guessLeft) {
    const at = codeLeft.indexOf(g);
    if (at !== -1) { present += 1; codeLeft.splice(at, 1); }
  }
  return { exact, present };
}

function mount(el) {
  let endTimer = null;

  function start() {
    // No repeats: pick 4 different symbols in a random order.
    const code = shuffle([0, 1, 2, 3, 4, 5]).slice(0, LENGTH);
    const history = [];
    let current = [];
    let hintUsed = false;
    let revealed = null; // { pos, sym } after the hint
    let over = false;

    setHTML(el, html`<div class="strix">
      <div class="strix-board" data-board></div>
      <div class="strix-controls">
        <div class="strix-current" data-current aria-live="polite"></div>
        <div class="strix-palette">
          ${SYMBOLS.map((s, i) => html`<button type="button" class="strix-key" data-sym="${i}" aria-label="${s.name}">
            ${glyph(i)}<span class="kbd">${i + 1}</span></button>`)}
        </div>
        <div class="strix-actions">
          <button type="button" class="btn btn-ghost" data-undo>Undo</button>
          <button type="button" class="btn" data-hint>Read a mind (+1 guess)</button>
          <button type="button" class="btn btn-primary" data-submit disabled>Guess</button>
        </div>
        <p class="faint small">Filled dot: right symbol, right place. Ring: in the code, wrong place. Keys 1 to 6, Backspace, Enter.</p>
      </div>
    </div>`);
    const boardEl = el.querySelector('[data-board]');
    const currentEl = el.querySelector('[data-current]');
    const submitBtn = el.querySelector('[data-submit]');
    const hintBtn = el.querySelector('[data-hint]');

    const pips = ({ exact, present }) => html`<span class="strix-pips" aria-label="${exact} exact, ${present} misplaced">
      ${Array.from({ length: LENGTH }, (_, i) => html`<span class="pip ${i < exact ? 'pip-exact' : i < exact + present ? 'pip-present' : ''}"></span>`)}
    </span>`;

    function draw() {
      const rows = [];
      for (let r = 0; r < MAX_GUESSES; r += 1) {
        const h = history[r];
        rows.push(html`<div class="strix-row ${h ? '' : 'is-empty'}">
          <span class="faint small num">${r + 1}</span>
          <span class="strix-slots">${Array.from({ length: LENGTH }, (_, i) => html`<span class="strix-slot">${h ? glyph(h.guess[i]) : ''}</span>`)}</span>
          ${h ? pips(h.result) : html`<span class="strix-pips"></span>`}
        </div>`);
      }
      setHTML(boardEl, html`${rows}`);
      setHTML(currentEl, html`${Array.from({ length: LENGTH }, (_, i) => html`<span class="strix-slot ${revealed && revealed.pos === i ? 'is-hint' : ''}">
        ${current[i] !== undefined ? glyph(current[i]) : revealed && revealed.pos === i ? html`<span class="strix-hint-mark">${glyph(revealed.sym)}</span>` : ''}</span>`)}`);
      submitBtn.disabled = current.length !== LENGTH || over;
      hintBtn.disabled = hintUsed || over || history.length >= MAX_GUESSES - 1; // always leave one real guess
    }

    const used = () => history.length + (hintUsed ? 1 : 0);

    function submit() {
      if (current.length !== LENGTH || over) return;
      const result = grade(code, current);
      history.push({ guess: current, result });
      current = [];
      // used() counts the hint too, so reading a mind really does cost one of the 10 guesses.
      if (result.exact === LENGTH || used() >= MAX_GUESSES) {
        over = true;
        el.onkeydown = null; // the result screen's buttons get Enter back
        draw();
        const won = result.exact === LENGTH;
        endTimer = setTimeout(() => {
          if (won) {
            finishRun(el, operationStrix, {
              score: used(), headline: 'Code cracked', detail: hintUsed ? 'Includes 1 for the hint. Lower is better.' : 'Lower is better.', again: start,
            });
          } else {
            setHTML(el, html`<div class="game-result">
              <h2>Mission failed</h2>
              <p class="strix-slots strix-answer">${code.map((c) => html`<span class="strix-slot">${glyph(c)}</span>`)}</p>
              <p class="muted">That was the code. No score is saved for a failed mission.</p>
              <div class="game-result-actions"><button type="button" class="btn btn-primary" data-again>Try again</button><a class="btn" href="#/games">All games</a></div>
            </div>`);
            el.querySelector('[data-again]').addEventListener('click', start);
          }
        }, 900);
        return;
      }
      draw();
    }

    function add(sym) {
      if (over || current.length >= LENGTH) return;
      current = [...current, sym];
      draw();
    }

    el.querySelector('.strix-palette').addEventListener('click', (ev) => {
      const key = ev.target.closest('[data-sym]');
      if (key) add(Number(key.dataset.sym));
    });
    el.querySelector('[data-undo]').addEventListener('click', () => { current = current.slice(0, -1); draw(); });
    submitBtn.addEventListener('click', submit);
    hintBtn.addEventListener('click', () => {
      if (hintUsed) return;
      hintUsed = true;
      const pos = Math.floor(Math.random() * LENGTH);
      revealed = { pos, sym: code[pos] };
      draw();
    });
    el.onkeydown = (ev) => {
      if (over) return;
      const n = Number(ev.key);
      if (n >= 1 && n <= SYMBOLS.length) add(n - 1);
      else if (ev.key === 'Backspace') { current = current.slice(0, -1); draw(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    };
    el.tabIndex = -1;
    el.focus();
    draw();
  }

  startScreen(el, {
    title: 'Operation Strix',
    rules: [
      'The code is 4 different symbols out of 6.',
      `You have ${MAX_GUESSES} guesses. Each one tells you how many are exactly right and how many are in the wrong place.`,
      'Once per game you can read a mind: it shows one symbol of the code, but costs a guess.',
      'Fewest guesses wins.',
    ],
    onStart: start,
  });

  return () => { clearTimeout(endTimer); el.onkeydown = null; };
}
