// Show-state badges (AniShelf 1.2): what the SHOW is doing, next to what YOU picked.
// The backend works these out (anishelf/show_state.py) and puts them on every library entry
// as entry.show_state = { kind, ... } or null. This file only turns them into words.
import { html } from './ui.js';

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

/** "Tuesday", "tomorrow", "today" for a unix time in seconds (or '' when unknown). */
function dayText(unixSeconds) {
  if (!unixSeconds) return '';
  const when = new Date(unixSeconds * 1000);
  const today = new Date();
  const days = Math.round((new Date(when).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return WEEKDAY.format(when);
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Words for a show state, or null when there's nothing to say.
 * Returns { text, tone, title } — tone picks the colour: 'new' (act on it), 'wait', 'quiet'.
 */
export function showStateInfo(state) {
  if (!state || !state.kind) return null;
  const next = state.next || {};
  switch (state.kind) {
    case 'new_season':
      return { text: `${next.label || 'New season'} is out`, tone: 'new',
        title: state.airing ? 'The next season is airing now' : 'The next season has finished airing — ready to binge' };
    case 'announced':
      return { text: `Waiting for ${next.label || 'next season'}${next.when ? ` · ${next.when}` : ''}`, tone: 'wait',
        title: 'A new season is announced. AniShelf checks for updates on start-up.' };
    case 'airing':
      return { text: 'Still airing', tone: 'wait', title: 'You marked it Done, but new episodes are still coming out' };
    case 'ended':
      return { text: 'No new season announced', tone: 'quiet', title: 'The show has finished and no sequel is announced (yet)' };
    case 'caught_up': {
      const day = dayText(state.airing_at);
      return { text: `Caught up${day ? ` · next ep ${day}` : ''}`, tone: 'wait',
        title: state.next_episode ? `Episode ${state.next_episode} airs ${day || 'soon'}` : "You've watched every episode that's out" };
    }
    case 'upcoming': {
      const day = dayText(state.airing_at);
      return { text: day ? `Starts ${day}` : 'Not out yet', tone: 'wait', title: "This hasn't started airing yet" };
    }
    default:
      return null;
  }
}

/** A small pill. Empty string when there's nothing to show, so it can sit in any template. */
export function showStateBadge(state, extraClass = '') {
  const info = showStateInfo(state);
  if (!info) return '';
  return html`<span class="show-state tone-${info.tone} ${extraClass}" title="${info.title}">${info.text}</span>`;
}

/** For a grouped series: the badge of whichever season has one (the backend gives at most one). */
export function groupShowState(members) {
  const withState = (members || []).find((m) => m.show_state);
  return withState ? withState.show_state : null;
}
