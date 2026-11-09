// Mini games: the hub (#/games) and one game (#/games/<id>).
import { api } from '../api.js';
import { html, setHTML, coverHtml, errorBox, emptyState, setAccent } from '../ui.js';
import { scoreText } from '../games/common.js';
import { coverReveal } from '../games/cover-reveal.js';
import { higherLower } from '../games/higher-lower.js';
import { returnByDeath } from '../games/return-by-death.js';
import { odmSwing } from '../games/odm-swing.js';
import { broomCourier } from '../games/broom-courier.js';
import { operationStrix } from '../games/operation-strix.js';
import { zoltraak } from '../games/zoltraak.js';
import { whosThatCharacter } from '../games/whos-that-character.js';
import { devilArena } from '../games/devil-arena.js';
import { coverCascade } from '../games/cover-cascade.js';

// The order here is the order on the hub: the big graphical games first.
const GAMES = [devilArena, broomCourier, odmSwing, coverCascade, coverReveal, whosThatCharacter, higherLower, returnByDeath, operationStrix, zoltraak];

/** The library entry a themed game borrows its picture and colour from (the first season). */
function themeEntry(game, entries) {
  if (!game.theme) return null;
  const matches = entries.filter((e) => game.theme.match.test(`${e.meta.title} ${e.meta.title_english || ''}`));
  matches.sort((a, b) => (a.meta.year || 9999) - (b.meta.year || 9999));
  return matches[0] || null;
}

function cardHtml(game, entries, scores, fallbackCover) {
  const themed = themeEntry(game, entries);
  const cover = themed ? themed.meta.image : fallbackCover;
  const record = scores[game.id] || {};
  const tag = game.theme ? `Inspired by ${game.theme.label}` : 'Made from your shelf';
  return html`<a class="game-card" href="#/games/${game.id}">
    ${coverHtml(cover, game.title, 'game-card-cover')}
    <div class="game-card-body">
      <h3>${game.title}</h3>
      <p class="faint small">${tag}</p>
      <p class="muted">${game.blurb}</p>
      <p class="game-card-best small">${record.plays
        ? html`Best <span class="num">${scoreText(game, record.best)}</span>`
        : 'Not played yet'}</p>
    </div>
  </a>`;
}

function renderHub(root) {
  setHTML(root, html`
    <header class="page-head">
      <h1>Mini games</h1>
      <p>Something to do between episodes. Four use your own shelf; the rest are inspired by shows you've watched.</p>
    </header>
    <div class="game-grid" id="game-grid"><p class="muted">Loading…</p></div>`);
  const grid = root.querySelector('#game-grid');

  Promise.all([api.library(), api.gameScores().catch(() => ({ scores: {} }))])
    .then(([lib, sc]) => {
      const entries = (lib.entries || []).filter((e) => e.meta);
      const covers = entries.filter((e) => e.meta.image);
      const pick = () => (covers.length ? covers[Math.floor(Math.random() * covers.length)].meta.image : null);
      setHTML(grid, html`${GAMES.map((g) => cardHtml(g, entries, sc.scores || {}, pick()))}`);
    })
    .catch(() => errorBox(grid, "Couldn't load the games.", () => renderHub(root)));
}

function renderGame(root, game) {
  setHTML(root, html`
    <header class="page-head">
      <h1>${game.title}</h1>
      <p>${game.blurb}</p>
    </header>
    <section class="panel game-stage" id="stage"><p class="muted">Loading…</p></section>`);
  window.dispatchEvent(new CustomEvent('anishelf:context', { detail: { title: game.title } }));
  const stage = root.querySelector('#stage');
  let cleanup = null;
  let gone = false;

  // `load` lives inside this closure so a retry still hands its cleanup to the router.
  const load = () => api.library()
    .then((lib) => {
      if (gone) return;
      const entries = (lib.entries || []).filter((e) => e.meta);
      const themed = themeEntry(game, entries);
      if (themed && themed.meta.anilist) setAccent(themed.meta.anilist.color);
      if (entries.length < (game.minEntries || 0)) {
        setHTML(stage, emptyState({
          title: 'Your shelf is a bit empty for this one',
          text: `This game needs at least ${game.minEntries} anime in your library.`,
          action: html`<a class="btn btn-primary" href="#/search">Find anime</a>`,
        }));
        return;
      }
      cleanup = game.mount(stage, { entries });
    })
    .catch(() => errorBox(stage, "Couldn't load your library.", load));
  load();

  return () => {
    gone = true;
    if (typeof cleanup === 'function') cleanup();
  };
}

export function render(root, params = {}) {
  if (!params.game) return renderHub(root);
  const game = GAMES.find((g) => g.id === params.game);
  if (!game) {
    setHTML(root, emptyState({
      title: "That game doesn't exist",
      action: html`<a class="btn btn-primary" href="#/games">All games</a>`,
    }));
    return null;
  }
  return renderGame(root, game);
}
