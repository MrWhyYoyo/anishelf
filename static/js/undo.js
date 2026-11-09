// Undo helpers for the "Undo" button on toasts (toastUndo in ui.js).
//
// The idea: just before a change, remember() copies the few fields we might need. If you click
// Undo, we send the server the *reverse* change, using the same API calls the pages already use.
// For "Remove from library" the server sends back a full snapshot, and restore puts it all back
// (see anishelf/undo.py).
import { api } from './api.js';

/** A small copy of an entry, taken BEFORE a change. */
export function remember(entry) {
  if (!entry) return null;
  return {
    mal_id: entry.mal_id,
    status: entry.status,
    score: entry.score ?? null,
    tier: entry.tier ?? null,
    started_on: entry.started_on ?? null,
    finished_on: entry.finished_on ?? null,
    rewatching: Boolean(entry.rewatching),
    // [...list] makes a copy, so later changes to the entry can't change what we remembered
    watched: [...(entry.watched || [])],
    rewatch_watched: [...(entry.rewatch_watched || [])],
  };
}

/** Redraw the page you're on, so it shows the undone state. */
function redraw() {
  window.dispatchEvent(new CustomEvent('anishelf:rerender'));
}

/**
 * Put the episodes back the way they were. The episode route has a "set" action that replaces
 * the whole list, so that is the exact reverse of any mark/unmark/range.
 * Marking episodes can also change the status and dates (e.g. the last episode -> Completed),
 * so those are put back too.
 */
export async function undoEpisodes(before) {
  const target = before.rewatching ? 'rewatch' : 'watch';
  const episodes = target === 'rewatch' ? before.rewatch_watched : before.watched;
  const { entry } = await api.updateEpisodes(before.mal_id, { action: 'set', episodes, target });
  if (target === 'watch') {
    const fix = {};
    for (const key of ['status', 'started_on', 'finished_on']) {
      if (entry[key] !== before[key]) fix[key] = before[key];
    }
    // Sending the dates with the status stops the server from filling in "today" for them.
    if (fix.status) Object.assign(fix, { started_on: before.started_on, finished_on: before.finished_on });
    if (Object.keys(fix).length) await api.patch(before.mal_id, fix);
  }
  redraw();
}

/**
 * Put some simple fields back (score, tier, status...). `keys` says which ones.
 * A status change can fill in start/finish dates, so undoing a status also restores the dates.
 */
export async function undoFields(before, keys) {
  const fields = {};
  for (const key of keys) fields[key] = before[key];
  if (keys.includes('status')) Object.assign(fields, { started_on: before.started_on, finished_on: before.finished_on });
  await api.patch(before.mal_id, fields);
  redraw();
}

/** Bring back a removed anime from the snapshot that DELETE returned. */
export async function undoRemove(malId, snapshot) {
  if (!snapshot) throw new Error('Nothing to restore');
  await api.restore(malId, snapshot);
  redraw();
}
