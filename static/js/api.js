// Thin wrapper around the AniShelf backend (see docs/API.md).
// Every call resolves to parsed JSON or throws an Error with a friendly message.

// Every request tells the page when it starts and ends (feel.js uses this for the loading line
// at the top and the spinner/tick on the button you clicked).
let requestSeq = 0;
function announce(type, detail) {
  try { window.dispatchEvent(new CustomEvent(type, { detail })); } catch { /* never break a request */ }
}

async function request(method, path, body, signal) {
  const id = ++requestSeq;
  announce('anishelf:request-start', { id, method, path });
  let ok = false;
  try {
    const data = await send(method, path, body, signal);
    ok = true;
    return data;
  } finally {
    announce('anishelf:request-end', { id, method, path, ok });
  }
}

async function send(method, path, body, signal) {
  const options = { method, headers: { Accept: 'application/json' }, signal };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    window.dispatchEvent(new CustomEvent('anishelf:offline'));
    throw new Error("Can't reach the AniShelf server. Is it still running?");
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message = data && typeof data.error === 'string' && data.error
      ? data.error
      : `Something went wrong (error ${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  // Any successful change (episodes, add, patch, vote, import...) can affect XP and badges.
  if (method !== 'GET' && path !== '/api/open') window.dispatchEvent(new CustomEvent('anishelf:changed', { detail: { method, path } }));
  return data ?? {};
}

/* ---------------------------------------------------------------- short memory cache
   The loading screen fetches the main data once; pages that ask for the same thing within a
   minute get that answer instantly instead of asking the server again. Any change (POST, PUT,
   PATCH, DELETE) empties the cache, so nothing stale is ever shown after you edit something. */
const MEMO_TTL_MS = 60 * 1000;
const MEMO_PATHS = new Set([
  '/api/library', '/api/profile', '/api/me', '/api/quests', '/api/memories', '/api/calendar', '/api/nudges',
  '/api/stats', '/api/discover', '/api/games', '/api/diary', '/api/me/banners', '/api/me/fav-characters', '/api/wrapped',
  '/api/manga', // manga shelf (AniShelf 1.15)
]);
const memo = new Map(); // full path -> { at, promise }
let memoGeneration = 0; // bumps on every clear, so an old in-flight answer can't sneak back in

window.addEventListener('anishelf:changed', () => { memo.clear(); memoGeneration += 1; });

function get(path, signal) {
  if (signal || !MEMO_PATHS.has(path.split('?')[0])) return request('GET', path, undefined, signal);
  const hit = memo.get(path);
  if (!hit || Date.now() - hit.at > MEMO_TTL_MS) {
    const generation = memoGeneration;
    const promise = request('GET', path).catch((err) => {
      if (memo.get(path)?.promise === promise) memo.delete(path); // never remember a failure
      throw err;
    });
    if (generation === memoGeneration) memo.set(path, { at: Date.now(), promise });
    return promise.then((data) => structuredClone(data));
  }
  // Each caller gets its own copy, so a page changing the object can't corrupt the cache.
  return hit.promise.then((data) => structuredClone(data));
}

const enc = encodeURIComponent;

export const api = {
  health: () => get('/api/health'),
  warmup: () => get('/api/warmup'),

  search: (q, signal) => get(`/api/search?q=${enc(q)}`, signal),
  discover: () => get('/api/discover'),

  anime: (id) => get(`/api/anime/${enc(id)}`),
  episodeList: (id) => get(`/api/anime/${enc(id)}/episodes`),
  recommendations: (id) => get(`/api/anime/${enc(id)}/recommendations`),
  characters: (id) => get(`/api/anime/${enc(id)}/characters`),
  profile: () => get('/api/profile'),
  openUrl: (url) => request('POST', '/api/open', { url }),
  reset: () => request('POST', '/api/reset', { confirm: 'RESET' }),
  seasons: (id) => get(`/api/anime/${enc(id)}/seasons`),
  me: () => get('/api/me'),
  patchMe: (fields) => request('PATCH', '/api/me', fields),
  meBanners: () => get('/api/me/banners'),
  meFavCharacters: () => get('/api/me/fav-characters'),
  avatars: (params = {}, signal) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    return get(`/api/avatars?${qs.toString()}`, signal);
  },

  library: (status) => get(status ? `/api/library?status=${enc(status)}` : '/api/library'),
  add: (malId, status = 'plan_to_watch') => request('POST', '/api/library', { mal_id: malId, status }),
  patch: (id, fields) => request('PATCH', `/api/library/${enc(id)}`, fields),
  remove: (id) => request('DELETE', `/api/library/${enc(id)}`), // -> {ok, snapshot} (snapshot is for restore)
  restore: (id, snapshot) => request('POST', `/api/library/${enc(id)}/restore`, snapshot), // undo a remove
  updateEpisodes: (id, body) => request('PUT', `/api/library/${enc(id)}/episodes`, body),
  refresh: (id) => request('POST', `/api/library/${enc(id)}/refresh`),
  setGroup: (id, withId) => request('POST', `/api/library/${enc(id)}/group`, { with: withId }),
  rewatch: (id, action) => request('POST', `/api/library/${enc(id)}/rewatch`, { action }), // start | finish | cancel

  diary: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.mood) qs.set('mood', params.mood);
    if (params.mal_id) qs.set('mal_id', String(params.mal_id));
    const query = qs.toString();
    return get(query ? `/api/diary?${query}` : '/api/diary');
  },
  addDiary: (note) => request('POST', '/api/diary', note),
  patchDiary: (noteId, fields) => request('PATCH', `/api/diary/${enc(noteId)}`, fields),
  deleteDiary: (noteId) => request('DELETE', `/api/diary/${enc(noteId)}`),

  versus: () => get('/api/versus'),
  vote: (winner, loser) => request('POST', '/api/versus', { winner, loser }),

  random: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    const query = qs.toString();
    return get(query ? `/api/random?${query}` : '/api/random');
  },

  stats: () => get('/api/stats'),
  memories: () => get('/api/memories'),
  calendar: () => get(`/api/calendar?tz_offset=${new Date().getTimezoneOffset()}`),
  nudges: () => get('/api/nudges'),
  gameScores: () => get('/api/games'),
  submitScore: (gameId, score) => request('POST', `/api/games/${enc(gameId)}/score`, { score }),
  quests: () => get('/api/quests'),
  wrapped: (year) => get(year ? `/api/wrapped?year=${enc(year)}` : '/api/wrapped'),
  importBackup: (data) => request('POST', '/api/import', data),
  autoBackup: () => request('GET', '/api/backups/auto'), // newest automatic daily backup (never memoised)
  autoBackupNow: () => request('POST', '/api/backups/auto'),

  // ---- manga (AniShelf 1.15); ids are AniList media ids
  mangaSearch: (q, signal) => get(`/api/manga/search?q=${enc(q)}`, signal),
  mangaLibrary: (status) => get(status ? `/api/manga?status=${enc(status)}` : '/api/manga'),
  manga: (id) => get(`/api/manga/${enc(id)}`),
  addManga: (anilistId, status = 'plan_to_read') => request('POST', '/api/manga', { anilist_id: anilistId, status }),
  patchManga: (id, fields) => request('PATCH', `/api/manga/${enc(id)}`, fields),
  mangaProgress: (id, body) => request('PUT', `/api/manga/${enc(id)}/progress`, body), // {action:'increment'} | {action:'set', chapter}
  removeManga: (id) => request('DELETE', `/api/manga/${enc(id)}`),
  mangaVolumes: (id) => get(`/api/manga/${enc(id)}/volumes`), // {volumes: [{volume, last_chapter, source}], source}
  // ^ mangaProgress also takes {action:'volumes', volumes: N} -> + chapters_from_volumes
  animeSource: (malId) => get(`/api/anime/${enc(malId)}/source`),
  inbox: () => get('/api/inbox'),                      // season news (1.2)
  inboxSeen: () => request('POST', '/api/inbox/seen'),
  // ---- seasonal chart, Up Next queue, taste profile
  season: (season, year) => get(season && year ? `/api/season?season=${enc(season)}&year=${enc(year)}` : '/api/season'),
  queue: (limit) => get(limit ? `/api/queue?limit=${enc(limit)}` : '/api/queue'),
  reorderQueue: (order) => request('PUT', '/api/queue', { order }), // order = every queued mal_id, first to watch first
  taste: () => get('/api/taste'),
  // ---- bulk edit + custom collections (anishelf/bulk.py, user_collections.py)
  bulk: (ids, action, value = null) => request('POST', '/api/library/bulk', { ids, action, value }), // -> {changed, skipped, missing}
  collections: () => request('GET', '/api/collections'), // not memoised: small, and the chips must be fresh
  createCollection: (name, color = null) => request('POST', '/api/collections', { name, color }),
  patchCollection: (id, fields) => request('PATCH', `/api/collections/${enc(id)}`, fields), // {name?, color?}
  deleteCollection: (id) => request('DELETE', `/api/collections/${enc(id)}`),
  addToCollection: (id, malIds) => request('POST', `/api/collections/${enc(id)}/anime`, { mal_ids: malIds }),
  removeFromCollection: (id, malId) => request('DELETE', `/api/collections/${enc(id)}/anime/${enc(malId)}`),
};
