// Daily quests card: three small goals for today, with progress bars in the data hue.
// Usage (e.g. on Home): mountQuestsCard(document.querySelector('#quests-slot'))
// The card refreshes itself after any change in the app (an episode, a score, a game),
// and stops listening once it is removed from the page.
import { api } from './api.js';
import { html, setHTML, plural } from './ui.js';

function questRow(q) {
  const pct = q.goal ? Math.min(100, (q.progress / q.goal) * 100) : 0;
  return html`<li class="quest ${q.done ? 'done' : ''}">
    <div class="quest-top">
      <span class="quest-text">${q.text}</span>
      <span class="quest-xp num">${q.done ? 'Done' : `+${q.xp} XP`}</span>
    </div>
    <div class="quest-bar" role="progressbar" aria-label="${q.text}" aria-valuemin="0"
      aria-valuemax="${q.goal}" aria-valuenow="${q.progress}"><span style="width:${pct.toFixed(1)}%"></span></div>
    <span class="quest-count faint small num">${q.progress} / ${q.goal}</span>
  </li>`;
}

export function mountQuestsCard(container) {
  if (!container) return () => {};
  setHTML(container, html`<section class="panel quests-card" aria-label="Daily quests">
    <div class="panel-head"><h2>Daily quests</h2><span class="muted small" data-quests-sub>Today</span></div>
    <ul class="quest-list" data-quests-list><li class="faint small">Loading today's quests…</li></ul>
  </section>`);
  const list = container.querySelector('[data-quests-list]');
  const sub = container.querySelector('[data-quests-sub]');
  let busy = false;

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const data = await api.quests();
      if (!list.isConnected) return;
      const quests = data.quests || [];
      const doneCount = quests.filter((q) => q.done).length;
      sub.textContent = `${doneCount} of ${quests.length} done · ${plural(data.xp_today || 0, 'XP', 'XP')} today`;
      setHTML(list, html`${quests.map(questRow)}`);
    } catch (err) {
      if (list.isConnected) setHTML(list, html`<li class="faint small">${err.message}</li>`);
    } finally {
      busy = false;
    }
  }

  // Re-check after any change; quests complete automatically when their goal is reached.
  function onChanged() {
    if (!container.isConnected || !list.isConnected) {
      window.removeEventListener('anishelf:changed', onChanged);
      return;
    }
    load();
  }
  window.addEventListener('anishelf:changed', onChanged);
  load();

  // Callers may use this to stop the auto-refresh early.
  return () => window.removeEventListener('anishelf:changed', onChanged);
}
