// The loading screen shown when the app opens.
//
// While it is up, two things happen at the same time:
//  1. The browser asks for the main data (library, profile, quests, calendar...). api.js keeps
//     those answers for a minute, so the pages you open next appear instantly.
//  2. The server finishes its own warm-up (anishelf/warmup.py): AniList lookups for the
//     calendar, nudges, banners and character portraits.
// The first covers are also downloaded, so Home doesn't pop in picture by picture.
//
// It never blocks for long: if something is slow (no internet), it gives up after MAX_WAIT_MS
// and the app opens anyway; the slow request just finishes in the background.
import { api } from './api.js';
import { imgUrl } from './ui.js';

const SHOW_AFTER_MS = 250;   // a fast start skips the screen entirely (no flash)
const MAX_WAIT_MS = 6000;    // never hold the app longer than this
const COVERS_TO_PRELOAD = 24;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Download one image into the browser cache. Resolves either way (a broken cover is fine). */
function preloadImage(url) {
  return new Promise((resolve) => {
    const src = imgUrl(url);
    if (!src) { resolve(); return; }
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = src;
  });
}

async function preloadCovers() {
  const { entries = [] } = await api.library();
  // The library comes newest-first, so these are the covers Home and Library show first.
  const urls = entries.slice(0, COVERS_TO_PRELOAD).map((e) => e.meta && e.meta.image).filter(Boolean);
  await Promise.race([Promise.all(urls.map(preloadImage)), sleep(3000)]);
}

export async function boot() {
  const splash = document.getElementById('splash');
  const bar = document.getElementById('splash-bar');
  const stepEl = document.getElementById('splash-step');
  if (!splash) return;

  const showTimer = setTimeout(() => { splash.hidden = false; }, SHOW_AFTER_MS);

  // Each task: [what the screen says, the work]. Errors are ignored: the page will retry.
  const tasks = [
    ['Opening your library', preloadCovers],
    ['Loading your profile', () => Promise.all([api.profile(), api.me()])],
    ["Checking today's quests", api.quests],
    ['Checking the airing schedule', api.calendar],
    ['Finding what to watch next', () => Promise.all([api.nudges(), api.memories()])],
  ];
  let finished = 0;
  let server = { finished: 0, total: 0, done: true, step: null };

  const paint = (label) => {
    const total = tasks.length + server.total;
    const done = finished + server.finished;
    bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    if (label) stepEl.textContent = label;
  };

  const browserWork = Promise.all(tasks.map(([label, work]) => Promise.resolve()
    .then(work)
    .catch(() => {})
    .then(() => { finished += 1; paint(label); })));

  // Follow the server's warm-up so the bar shows the whole picture.
  const serverWork = (async () => {
    for (let i = 0; i < 40; i += 1) { // hard cap: 40 checks
      try {
        server = await api.warmup();
      } catch {
        return; // older server or offline: just don't wait for it
      }
      paint(server.step);
      if (server.done || !server.running) return;
      await sleep(250);
    }
  })();

  await Promise.race([Promise.all([browserWork, serverWork]), sleep(MAX_WAIT_MS)]);
  clearTimeout(showTimer);
  if (splash.hidden) { splash.remove(); return; } // it never needed to show

  paint('Ready');
  splash.classList.add('is-leaving');
  await sleep(220);
  splash.remove();
}
