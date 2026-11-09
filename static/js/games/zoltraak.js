// Zoltraak: demons drift down toward your barrier, each carrying a word. Type the word to blast it.
// Three demons through the barrier and the run ends. Score is demons defeated.
import { html, setHTML } from '../ui.js';
import { finishRun, startScreen } from './common.js';

const AREA_H = 380;
const LIVES = 3;
// Short words first, long ones as the run goes on.
const WORDS = {
  short: ['mana', 'staff', 'spell', 'flame', 'frost', 'ward', 'rune', 'grave', 'demon', 'elf', 'mimic', 'tome', 'oath', 'ash', 'hymn', 'relic'],
  medium: ['barrier', 'grimoire', 'familiar', 'lantern', 'phantom', 'sorcery', 'vanguard', 'blizzard', 'requiem', 'zoltraak', 'mirage', 'warlock'],
  long: ['incantation', 'flower field', 'apprentice', 'necromancer', 'thousand years', 'suppression', 'illusionist', 'first class mage'],
};

export const zoltraak = {
  id: 'zoltraak',
  title: 'Zoltraak',
  blurb: 'Demons drift toward your barrier, each carrying a word. Type it to blast them before they break through.',
  unit: 'demons',
  theme: { label: 'Frieren', match: /frieren|sousou no/i },
  mount,
};

function pickWord(level, active) {
  const pools = level < 6 ? ['short'] : level < 16 ? ['short', 'medium'] : ['medium', 'long'];
  const pool = WORDS[pools[Math.floor(Math.random() * pools.length)]];
  const taken = new Set(active.map((d) => d.word[0]));
  // Avoid two demons starting with the same letter, so typing always has one clear target.
  const options = pool.filter((w) => !taken.has(w[0]));
  const list = options.length ? options : pool;
  return list[Math.floor(Math.random() * list.length)];
}

function mount(el) {
  let raf = 0;
  let endTimer = null;

  function start() {
    setHTML(el, html`<div class="zt">
      <div class="zt-head"><p class="num"><span data-score>0</span> defeated</p><p class="num" data-lives></p></div>
      <div class="zt-area" style="height:${AREA_H}px"><div class="zt-barrier"></div></div>
      <input class="zt-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Type the demon's word">
    </div>`);
    const area = el.querySelector('.zt-area');
    const input = el.querySelector('.zt-input');
    const scoreEl = el.querySelector('[data-score]');
    const livesEl = el.querySelector('[data-lives]');
    const demons = [];
    let score = 0;
    let lives = LIVES;
    let spawnIn = 0.6;
    let over = false;

    const drawLives = () => setHTML(livesEl, html`Barrier <span class="zt-lives" aria-label="${lives} of ${LIVES} left">${
      Array.from({ length: LIVES }, (_, i) => html`<span class="${i < lives ? '' : 'lost'}"></span>`)}</span>`);
    drawLives();

    function spawn() {
      const word = pickWord(score, demons);
      const node = document.createElement('div');
      node.className = 'zt-demon';
      node.innerHTML = '<span class="zt-typed"></span><span class="zt-rest"></span>';
      node.querySelector('.zt-rest').textContent = word;
      area.appendChild(node);
      const maxX = Math.max(10, area.clientWidth - node.offsetWidth - 10);
      const d = { word, node, x: 10 + Math.random() * (maxX - 10), y: -30, speed: 28 + Math.min(70, score * 2.2) + Math.random() * 12 };
      node.style.left = `${d.x}px`;
      demons.push(d);
    }

    /** Light up the typed part of whichever demon the input is aimed at. */
    function paintTargets(text) {
      for (const d of demons) {
        const hit = text && d.word.startsWith(text);
        d.node.querySelector('.zt-typed').textContent = hit ? text : '';
        d.node.querySelector('.zt-rest').textContent = hit ? d.word.slice(text.length) : d.word;
        d.node.classList.toggle('is-target', Boolean(hit));
      }
    }

    function blast(d) {
      const beam = document.createElement('div');
      beam.className = 'zt-beam';
      const cx = d.x + d.node.offsetWidth / 2;
      beam.style.left = `${cx}px`;
      beam.style.top = `${d.y + 14}px`;
      beam.style.height = `${AREA_H - d.y - 14}px`;
      area.appendChild(beam);
      setTimeout(() => beam.remove(), 220);
      d.node.remove();
      demons.splice(demons.indexOf(d), 1);
      score += 1;
      scoreEl.textContent = String(score);
    }

    input.addEventListener('input', () => {
      const text = input.value.toLowerCase();
      const done = demons.find((d) => d.word === text);
      if (done) { blast(done); input.value = ''; paintTargets(''); return; }
      if (text && !demons.some((d) => d.word.startsWith(text))) {
        input.classList.add('is-miss'); // a typo: shake the box and start the word again
        setTimeout(() => input.classList.remove('is-miss'), 200);
        input.value = '';
        paintTargets('');
        return;
      }
      paintTargets(text);
    });

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      spawnIn -= dt;
      if (spawnIn <= 0) {
        spawn();
        spawnIn = Math.max(0.75, 2.3 - score * 0.05);
      }
      const barrierY = AREA_H - 40;
      for (const d of demons.slice()) {
        d.y += d.speed * dt;
        d.node.style.transform = `translateY(${d.y}px)`;
        if (d.y > barrierY) {
          d.node.remove();
          demons.splice(demons.indexOf(d), 1);
          lives -= 1;
          drawLives();
          area.classList.add('is-hit');
          setTimeout(() => area.classList.remove('is-hit'), 250);
          const typed = input.value.toLowerCase();
          if (typed && !demons.some((x) => x.word.startsWith(typed))) { input.value = ''; paintTargets(''); }
          if (lives <= 0) over = true;
        }
      }
      if (over) {
        input.disabled = true;
        endTimer = setTimeout(() => finishRun(el, zoltraak, {
          score, headline: `${score} demons defeated`, detail: 'The barrier broke.', again: start,
        }), 600);
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    input.focus();
    area.addEventListener('pointerdown', (ev) => { ev.preventDefault(); input.focus(); });
  }

  startScreen(el, {
    title: 'Zoltraak',
    rules: [
      'Demons fall toward your barrier, each with a word on it.',
      'Type a word to blast that demon. A typo clears what you typed.',
      'They get faster and the words get longer. Three through the barrier and it breaks.',
    ],
    onStart: start,
  });

  return () => { cancelAnimationFrame(raf); clearTimeout(endTimer); };
}
