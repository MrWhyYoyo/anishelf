# AniShelf API contract

Backend: Flask on `http://127.0.0.1:5178`. All JSON. Errors always come back as
`{"error": "human readable message"}` with a 4xx/5xx status — show the message in a toast.

**Images:** never load external image URLs directly. Always use
`/img?u=<encodeURIComponent(url)>` — the backend downloads once, caches on disk and
serves same-origin. Only `cdn.myanimelist.net` and `s4.anilist.co` URLs are allowed.

## Shared objects

### `Meta` (anime info from Jikan/AniList)
```json
{
  "mal_id": 52991,
  "title": "Sousou no Frieren",
  "title_english": "Frieren: Beyond Journey's End",   // may be null
  "title_japanese": "葬送のフリーレン",                 // may be null
  "image": "https://cdn.myanimelist.net/images/anime/.../large.webp", // may be null
  "type": "TV",                     // TV, Movie, OVA, ONA, Special... may be null
  "episodes": 28,                   // null when unknown (still airing)
  "duration_min": 24,               // minutes per episode, may be null
  "airing_status": "Finished Airing", // or "Currently Airing", "Not yet aired", null
  "airing": false,
  "year": 2023, "season": "fall",   // may be null
  "genres": ["Adventure", "Drama", "Fantasy", "Shounen"],
  "studios": ["Madhouse"],
  "synopsis": "text...",            // may be null
  "mal_score": 9.3, "rank": 1, "popularity": 150,   // may be null
  "rating": "PG-13 - Teens 13 or older",            // may be null
  "url": "https://myanimelist.net/anime/52991/...",
  "trailer_youtube_id": "qgQWxUv4QoY",               // may be null
  "anilist": {                      // null in search/discover lists; filled on detail
    "banner": "https://s4.anilist.co/file/.../banner.jpg",  // may be null
    "color": "#e4a15d",            // dominant cover colour, may be null
    "cover_xl": "https://s4.anilist.co/...",                 // may be null
    "next_airing": {"episode": 9, "airing_at": 1767225600}   // unix seconds, or null
  }
}
```

### `Entry` (an anime in my library)
```json
{
  "mal_id": 52991,
  "meta": { ...Meta... },
  "status": "watching",            // watching | completed | plan_to_watch | on_hold | dropped
  "score": 9,                      // 1-10 or null
  "tier": "S",                     // S | A | B | C | D | null
  "elo": 1532.4, "matches": 6,     // head-to-head rating
  "watched": [1,2,3,4,5,7],        // sorted episode numbers
  "watched_count": 6,
  "watched_text": "1-5, 7",
  "total": 28,                     // total_override ?? meta.episodes ?? null
  "total_override": null,          // user-set total for shows with unknown length
  "aired": null,                   // for airing shows: episodes aired so far (from AniList), else null
  "progress": 0.214,               // watched_count/total, null when total unknown
  "next_episode": 6,               // lowest unwatched episode, null when finished
  "notes": "", "fav_character": "", "fav_moment": "",
  "started_on": "2026-10-01", "finished_on": null,   // ISO dates or null
  "rewatch_count": 0,
  "favorite": false,
  "added_at": "2026-11-04T10:00:00+00:00", "updated_at": "...",
  // rewatch (history.py): the first watch above is never changed by a rewatch
  "rewatching": false,             // true while a rewatch of a completed show is running
  "rewatch_number": null,          // rewatch_count + 1 while rewatching ("Rewatch #N"), else null
  "rewatch_watched": [],           // rewatch episode set (empty when not rewatching)
  "rewatch_watched_count": 0,
  "rewatch_next_episode": null,    // lowest episode not rewatched yet; null when not rewatching
  "rewatch_progress": null,        // rewatch_watched_count/total, null when not rewatching or total unknown
  // score prediction
  "predicted_score": null,         // 1-10 or null
  "can_predict": false             // true for plan_to_watch/watching with 0-2 episodes watched
}
```
Status labels for the UI: Watching, Completed, Plan to Watch, On Hold, Dropped.

## Endpoints

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/health` | | `{"ok": true, "version": "1.0.0"}` |
| `GET /api/warmup` | | `{"running", "done", "step", "finished", "total", "seconds"}`: progress of the start-up cache warm-up (anishelf/warmup.py), shown on the loading screen |
| `GET /api/search?q=frieren` | q ≥ 2 chars | `{"results": [Meta + "library_status": status or null]}` (max 20) |
| `GET /api/discover` | | `{"season": [Meta+library_status], "top_airing": [Meta+library_status]}` |
| `GET /api/anime/<mal_id>` | | `{"meta": Meta (with anilist), "entry": Entry or null}` |
| `GET /api/anime/<mal_id>/episodes` | | `{"episodes": [{"number":1,"title":"...","filler":false,"recap":false,"aired":"2023-09-29"}], "truncated": false}` (may be empty list) |
| `GET /api/anime/<mal_id>/recommendations` | | `{"results": [{"mal_id":1,"title":"...","image":"url","votes":12}]}` (max 12) |
| `GET /api/anime/<mal_id>/characters` | | `{"characters": [{"id","name","image","role": "MAIN"/"SUPPORTING"/"BACKGROUND","sub": [VoiceActor],"dub": [VoiceActor]}]}` (max 25, main first; VoiceActor = `{"id","name","image","language"}`) |
| `GET /api/profile` | | `{"level","title","xp","level_xp","next_level_xp","progress","next_title": {"level","title"} or null,"breakdown": [{"label","xp"}],"badges": [{"id","icon","name","description","earned","progress","goal","secret"}]}` — see "Progression" below |
| `GET /api/anime/<mal_id>/seasons` | | `{"franchise_id","title","title_english","seasons": [{"mal_id","title","title_english","format","episodes","year","image","label","is_current","library_status","watched_count","total"}]}` — main story only (SEQUEL/PREQUEL through TV/ONA/MOVIE), chronological. Library entries carry `"franchise": {"id","title","title_english","size","label"}` or null |
| `GET/PATCH /api/me` | `display_name`, `bio`, `avatar`, `title_language` ("english"/"romaji"), `banner`, `top5`, `showcase` (see "Profile 1.1" below) | profile + `member_since` |
| `GET /api/me/banners` | | `{"choices": [{"mal_id","title","title_english","image","color"}], "unchecked": n}` — library anime with an AniList banner. Looks up at most 6 new anime per call; `unchecked` counts the rest (call again for more) |
| `GET /api/me/fav-characters` | | `{"characters": [{"mal_id","title","title_english","cover","character","matched_name","image"}], "pending": n}` — one per favourite (a `fav_character` like "A, B" from the Cast hearts gives a card per matched name, up to 3; unmatched text gives one card); `image` is the matched AniList portrait or null. At most 12 new cast lookups per call (cached 7 days); `pending` counts the rest |
| `POST /api/reset` | `{"confirm": "RESET"}` | `{"ok": true}` — deletes library, watch history, profile and mini-game scores; keeps the anime info/image cache |
| `GET /api/games` | | `{"scores": {game_id: {"best","plays","last","last_played","lower_is_better"}}}` for every game id |
| `POST /api/games/<game_id>/score` | `{"score": 820}` | `{"game","best","plays","last","last_played","best_at","new_best","lower_is_better","xp_awarded"}` — 400 for an unknown game or a bad score |
| `GET /api/quests` | | today's daily quests, see "Progression" below |
| `GET /api/wrapped?year=YYYY` | `year` optional (1990-2100, else 400) | year in review, see "Anime Wrapped" below |
| `GET /api/library` | `?status=watching` optional | `{"entries": [Entry]}` sorted by `updated_at` desc |
| `POST /api/library` | `{"mal_id": 1, "status": "plan_to_watch"}` (status optional, default plan_to_watch) | `{"entry": Entry}` — adding an existing one just changes its status |
| `PATCH /api/library/<mal_id>` | any of `status, score, tier, notes, fav_character, fav_moment, started_on, finished_on, rewatch_count, favorite, total_override` | `{"entry": Entry}` |
| `DELETE /api/library/<mal_id>` | | `{"ok": true, "snapshot": {...}}` — the snapshot is a one-anime backup (`app`, `format`, `entries: [row]`, `watch_log`, `diary`) kept by the browser for Undo (`anishelf/undo.py`) |
| `POST /api/library/<mal_id>/restore` | the `snapshot` DELETE returned | `{"entry": Entry}` — undo a remove; runs through the backup import's checks. 400 if the snapshot is damaged, holds another anime, or the anime is already back in the library |
| `PUT /api/library/<mal_id>/episodes` | see below | `{"entry": Entry, "status_changed": "completed" or null}` |
| `POST /api/library/<mal_id>/refresh` | | `{"entry": Entry}` (re-downloads metadata) |
| `POST /api/library/<mal_id>/rewatch` | `{"action": "start" \| "finish" \| "cancel"}` | `{"entry": Entry}` — start needs status `completed`; finish adds 1 to `rewatch_count`; cancel stops without counting. Moving the show out of Completed (PATCH status) also cancels a running rewatch |
| `GET /api/diary` | `?mood=cozy&mal_id=1` (both optional) | `{"entries": [Note], "moods": ["hyped","moved","cozy","mind-blown","meh"], "mood_counts": {mood: n}, "total": n}` — newest first (max 2000). Note = `{"id","mal_id","text","mood","created_at","title","title_english","image","in_library"}` |
| `POST /api/diary` | `{"mal_id": 1, "text": "one line", "mood": "hyped"}` | `{"note": Note}` — anime must be in the library; text ≤ 280 chars (trimmed); mood from the list or null; at least one of text/mood |
| `PATCH /api/diary/<id>` | any of `text`, `mood` | `{"note": Note}` (404 if missing) |
| `DELETE /api/diary/<id>` | | `{"ok": true}` (404 if missing) |
| `GET /api/versus` | | `{"pair": [Entry, Entry]}` or `{"pair": null, "reason": "..."}` |
| `POST /api/versus` | `{"winner": mal_id, "loser": mal_id}` | `{"winner": Entry, "loser": Entry}` |
| `GET /api/random` | `?genre=Action&max_episodes=13&statuses=plan_to_watch,on_hold&mood=chill` (all optional; statuses default `plan_to_watch`; `mood` see "Moods" below) | `{"pick": Entry or null, "candidates": [Entry]}` |
| `GET /api/memories` | | `{"memories": [Memory]}` (max 3, may be empty: then Home hides the card). See "Watching" below |
| `GET /api/calendar` | `?tz_offset=-120` (browser's `getTimezoneOffset()`; optional, default = server's zone) | see "Watching" below; 400 for a bad tz_offset |
| `GET /api/nudges` | | `{"nudges": [Nudge]}` (max 6). See "Watching" below |
| `GET /api/stats` | | see below |
| `GET /api/export` | | JSON file download (backup) |
| `POST /api/import` | the export JSON | `{"imported": 12}` |
| `GET /api/backups/auto` | | `{"enabled": true, "folder": "...", "keep": 7, "count": 3, "last": {"date": "2026-11-09", "file": "anishelf-2026-11-09.json", "saved_at": iso} or null}` — automatic daily backups (`anishelf/autobackup.py`) |
| `POST /api/backups/auto` | | same as GET, after writing today's backup now ("Back up now"; replaces today's file) |

### Episode actions (`PUT /api/library/<id>/episodes`)
```json
{"action": "toggle", "episode": 5}
{"action": "up_to", "episode": 12}          // mark 1..12 watched
{"action": "add_range", "text": "1-12, 15"}
{"action": "remove_range", "text": "3-4"}
{"action": "set", "episodes": [1,2,3]}
{"action": "all"}                            // needs a known total
{"action": "clear"}
```
Optional `"target": "watch" | "rewatch"` on any action. Without it, the action changes the
rewatch set while `rewatching` is true and the first watch otherwise, so older callers keep working
(a `+1` on a rewatching show should send `rewatch_next_episode`). A rewatch action never changes the
status or dates. The response also has `"rewatch_finished"`: the rewatch number when that action
finished the rewatch (all episodes marked: `rewatch_count` +1, rewatch set cleared, `rewatching`
false), else null. Watch-log lines carry `"rewatch": 0` (first watch) or N, so stats activity,
monthly and streaks count rewatched episodes. Diary notes, rewatch state and `predicted_score` are in
the backup (`"diary"` key and Entry fields) and are cleared by `POST /api/reset`.
`PATCH /api/library/<id>` also accepts `predicted_score` (1-10 or null); setting a number is only
allowed while `can_predict` is true (400 otherwise); clearing is always allowed.
`status_changed` is non-null when the app automatically moved the anime
(e.g. to `completed` after the last episode, or plan_to_watch → `watching`) — show a toast.

### Watching: memories, airing calendar, nudges, moods (code in `anishelf/watching.py`)

**`Memory`** (`GET /api/memories`): built from `watch_log` plus each entry's `started_on` / `finished_on`.
First choice is this calendar day in earlier years (most recent first); only if there are none,
exactly 1, 3 or 6 months ago (skipped when that day doesn't exist, e.g. 31 Feb). One per show,
finished > started > watched. No network calls.
```json
{"mal_id": 1, "meta": {"mal_id", "title", "title_english", "image"}, "date": "2025-11-06",
 "kind": "finished",            // finished | started | watched
 "episodes": 0,                 // episodes logged that day
 "years_ago": 1, "months_ago": 0,
 "when": "A year ago today", "action": "you finished",   // or "you watched 3 episodes of"
 "text": "A year ago today you finished Attack on Titan Season 3"}
```

**Calendar** (`GET /api/calendar`): Watching + Plan to Watch entries that are airing (`meta.airing` or
`meta.anilist.next_airing`). ONE AniList request (`airingSchedule` via `idMal_in`, at most 50 ids),
cached for 1 hour (key `airing:<ids>`; a stale copy is used if AniList is down).
```json
{"days": [{"date": "2026-11-06", "items": [CalItem]}],   // exactly 7 local days, today first
 "next": CalItem or null,         // the next episode, even if it is after the 7 days
 "upcoming": [CalItem],           // first 3 (Home's "Airing this week" strip)
 "shows": 2, "tracked": 3,        // shows with upcoming episodes / airing shows asked about
 "error": null}                   // a message when AniList failed and nothing was cached
```
`CalItem` = `{"mal_id", "episode", "airing_at" (unix seconds), "local_time": "22:00", "status", "total", "meta": {"mal_id","title","title_english","image"}}`.
The UI formats times itself from `airing_at`, so they are always in the browser's zone.

**`Nudge`** (`GET /api/nudges`): for each Completed entry (most recently finished first), the next
main-story entry of its series (from `franchise.order`) when that one is Plan to Watch or not in the
library, and not `NOT_YET_RELEASED`. Uses cached `relations:<id>` nodes; at most 5 uncached AniList
lookups per request, after which unknown series are skipped.
```json
{"from": {"mal_id", "title", "title_english", "image", "label": "Season 2"},
 "next": {"mal_id", "title", "title_english", "image", "label": "Season 3", "format": "TV",
          "episodes": 12, "year": 2026, "library_status": "plan_to_watch" or null}}
```

**Moods** (`GET /api/random?mood=`): a show matches when it has ANY of the mood's genres
(Jikan genres include themes). `any` or empty = no filter; an unknown mood is a 400.
With `source=discover` and no `genre`, one of the mood's genres (that AniList knows) is picked at random.

| mood | genres |
|---|---|
| `chill` | Slice of Life, Iyashikei, Comedy, CGDCT, Gourmet |
| `hype` | Action, Sports, Mecha, Martial Arts, Super Power |
| `sad` | Drama, Tragedy |
| `brain` | Mystery, Psychological, Thriller, Suspense, Sci-Fi |
| `laugh` | Comedy, Gag Humor, Parody |

### Mini games
High scores are stored in the `settings` table (key `game_scores`), so `POST /api/reset` clears them.
`best`, `last` and `last_played` are `null` and `plays` is 0 until a game has been played.
`score` must be a whole number (a bool is rejected) from 0 up to the game's maximum, otherwise 400.
`new_best` is true when the score beat the stored best (or there was none), using `lower_is_better`.

| Game id | Score counts | Lower is better | Max |
|---|---|---|---|
| `cover-reveal` | points | no | 10000 |
| `higher-lower` | streak | no | 1000 |
| `return-by-death` | deaths | yes | 1000 |
| `odm-swing` | metres | no | 100000 |
| `operation-strix` | guesses | yes | 20 |
| `zoltraak` | demons defeated | no | 10000 |
| `whos-that-character` | points ("pts") | no | 10000 |

`best_at` is when the current best was set (used by the "personal best" daily quest). A new best gives
`xp_awarded` = 15 XP, at most 60 XP per local day in total (stored per date in the `game_xp` setting);
otherwise `xp_awarded` is 0.

### Progression: daily quests, bonus XP and badges (code in `anishelf/progression.py`, `quests.py`)
`GET /api/quests`:
```json
{
  "date": "2026-11-06",                       // the server's local date
  "quests": [{"id": "watch_2", "text": "Watch 2 episodes today", "progress": 1, "goal": 2, "done": false, "xp": 20}],
  "xp_today": 0,                              // quest XP earned today
  "xp_total": 140                             // all quest XP ever (the "Daily quests" breakdown line)
}
```
- 3 quests a day, drawn from a pool with a random generator seeded by the date (stable all day).
  Pool ids: `watch_2`, `watch_5`, `two_shows`, `revisit` (a show untouched for 7+ days), `rate_or_tier`,
  `game_best`, `finish_show`, `plan_add`.
- Progress comes from today's watch log, library `updated_at`/`added_at`/`finished_on` and mini-game
  `best_at`. A quest completes automatically when progress reaches the goal; its XP is then stored in
  the `quest_xp` setting (`{"2026-11-06": {"watch_2": 20}}`) and stays even if episodes are unwatched.
  `GET /api/profile` also checks today's quests, so XP appears without opening the card.
- The profile `breakdown` gains two lines: `"Daily quests"` and `"Mini games"`.
- Badges have a `secret` flag. A secret badge that is not earned yet is sent as name `"Secret badge"`,
  description `"Keep watching..."`; once earned it shows its real name. New badges: `night_owl` (secret,
  an episode logged 02:00-05:00 local), `marathon` (10 episodes in one day), `loyal` (every main-story
  entry of a 5+ entry franchise completed, using the library's season grouping), `speedrunner` (a 12+
  episode show finished within 3 days of its first logged episode), `comeback` (secret, a show resumed
  after a 30+ day break), `perfect_ten` (score an anime 10).
- Backups: `GET /api/export` adds `"progression": {"quest_xp": ..., "game_xp": ...}`; import restores it.

### Anime Wrapped (`GET /api/wrapped?year=2026`, code in `anishelf/wrapped.py`)
Without `year`: this year if it has data, otherwise the latest year that does.
```json
{
  "year": 2026, "years": [2026, 2025],        // years with data (this year always included), newest first
  "has_data": true,
  "episodes": 142, "minutes": 3408, "hours": 56.8, "shows_watched": 11, "days_active": 60,
  "most_watched": {"mal_id": 1, "title": "...", "title_english": "...", "image": "...", "episodes": 28},
  "top_shows": [/* up to 5, same shape as most_watched */],
  "months": [{"month": 1, "label": "Jan", "episodes": 12}],      // always 12
  "busiest_month": {"month": 3, "name": "March", "episodes": 30}, // null without episodes
  "longest_streak": 6,                                           // days in a row inside that year
  "top_genre": {"name": "Fantasy", "episodes": 40},              // weighted by episodes; or null
  "completed": 9,
  "first_finished": {"mal_id", "title", "title_english", "image", "finished_on"},  // or null
  "last_finished": {...},
  "summary": "You watched 142 episodes (56.8 hours), finished 9 shows and kept coming back to Frieren. Your genre of the year: Fantasy."
}
```

### Stats (`GET /api/stats`)
```json
{
  "total_entries": 40,
  "status_counts": {"watching": 3, "completed": 20, "plan_to_watch": 12, "on_hold": 2, "dropped": 3},
  "episodes_watched": 812,
  "minutes_watched": 19488, "hours_watched": 324.8, "days_watched": 13.5,
  "mean_score": 7.9,                       // null if nothing scored
  "score_distribution": {"1":0, "2":0, ..., "10":3},
  "top_genres": [{"name": "Action", "count": 14}],     // up to 10
  "top_studios": [{"name": "MAPPA", "count": 4}],      // up to 5
  "activity": [{"date": "2026-11-03", "count": 4}],   // last 365 days, only days with count>0
  "monthly": [{"month": "2025-12", "episodes": 30}],   // last 12 months, oldest first, includes zeros
  "streak": {"current": 3, "longest": 12},             // consecutive days with ≥1 episode
  "favorites": 5,
  "completed_this_year": 7,
  "predictions": {"count": 4, "avg_abs_error": 1.25, "avg_diff": 0.5, "exact": 1}
  // entries with both predicted_score and score; avg_diff > 0 = liked shows more than predicted;
  // avg_abs_error/avg_diff are null when count is 0
  "manga": {"chapters_read": 45, "completed": 1, "reading": 2,   // AniShelf 1.15, see "Manga" below
            "volumes_read": 3, "total_entries": 6, "chapters_last_30_days": 12}
}
```

### Profile 1.1 (`PATCH /api/me` fields)
All are optional; a PATCH only changes the fields it sends. Bad values give a 400 and change nothing.

| Field | Shape | Rules |
|---|---|---|
| `banner` | `{"mal_id": 3, "image": "https://s4.anilist.co/...", "position_y": 30, "color": "#ff8800"}` or `null` | `image` must be an `s4.anilist.co` URL (≤500 chars), `mal_id` a positive int, `position_y` a number 0-100 (default 50, used as CSS `object-position: 50% <y>%`), `color` `#rrggbb` or null. `null` removes the banner |
| `top5` | `[52991, 5114]` | up to 5 unique positive ints, best first; each must be in the library when saved. Ids that later leave the library are skipped when drawing |
| `showcase` | `["first-steps", "marathon"]` | up to 3 unique badge id strings (1-60 chars). Not checked against the badge list; unknown or unearned ids are skipped when drawing |

`GET /api/me` always returns `banner` (null), `top5` ([]) and `showcase` ([]) even for old profiles. They are part of `profile` in the backup export.

## Manga (AniShelf 1.15, code in `anishelf/manga.py`)
Manga are keyed by their **AniList media id** (`anilist_id`); many manga have no MAL id, so
`id_mal` is stored when AniList has one (else null). Data comes from AniList only (free, no key),
cached in `api_cache` (`manga:<id>` 12 h while publishing / 3 days when finished,
`manga:search:<q>` 1 day, `anime_source:<mal_id>` 7 days). Statuses:
`reading`, `completed`, `plan_to_read`, `on_hold`, `dropped`.

### `MangaMeta`
```json
{
  "anilist_id": 118586, "id_mal": 126287,          // id_mal may be null
  "title": "Sousou no Frieren", "title_english": "Frieren: Beyond Journey's End", "title_japanese": "...",
  "image": "https://s4.anilist.co/...", "color": "#e4ae5d",   // cover colour -> setAccent()
  "format": "Manga",                               // Manga | One-shot | Light novel
  "publishing_status": "Publishing",               // Finished | Publishing | Not yet published | Cancelled | On hiatus
  "finished": false,
  "chapters": null, "volumes": null,               // only set once the manga has FINISHED
  "year": 2020, "genres": ["Adventure"], "anilist_score": 8.7, "url": "https://anilist.co/manga/118586",
  // only on GET /api/manga/<id> (not in search results):
  "banner": "https://s4.anilist.co/...", "synopsis": "text",
  "authors": [{"id": 122202, "name": "Kanehito Yamada", "role": "Story"}],   // Story/Art staff only
  "reading": [{"site": "VIZ", "url": "https://www.viz.com/..."}],           // official readers only (host allow-list)
  "adaptations": [{"mal_id": 52991, "anilist_id": 154587, "title": "...", "title_english": "...",
                   "image": "...", "format": "TV", "year": 2023, "relation": "ADAPTATION"}]
}
```

### `MangaEntry`
```json
{
  "anilist_id": 118586, "id_mal": 126287, "meta": { MangaMeta },
  "status": "reading", "chapters_read": 45, "volumes_read": 0,
  "total_chapters": null, "total_volumes": null,   // = meta.chapters / meta.volumes
  "progress": null,                                // 0-1, null while the total is unknown
  "score": 9, "notes": "", "started_on": "2026-11-07", "finished_on": null,
  "added_at": "...", "updated_at": "..."
}
```

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/manga/search?q=` | | `{"results": [MangaMeta + "library_status"]}` (≥2 chars, max 20, adult filtered) |
| `GET /api/manga?status=` | | `{"entries": [MangaEntry]}` newest `updated_at` first; bad status → 400 |
| `POST /api/manga` | `{"anilist_id": 118586, "status": "plan_to_read"}` | `{"entry"}`; adding again changes the status; unknown id → 404 |
| `GET /api/manga/<id>` | | `{"meta", "entry" or null, "adaptations": [... + "library_status"]}` (anime status by MAL id) |
| `PATCH /api/manga/<id>` | any of `status`, `score` (1-10/null), `notes`, `started_on`, `finished_on` (YYYY-MM-DD/null), `volumes_read` (0-1000, ≤ total) | `{"entry"}`; unknown fields → 400, not on shelf → 404 |
| `PUT /api/manga/<id>/progress` | `{"action": "increment"}` or `{"action": "set", "chapter": 45}` | `{"entry", "status_changed": "reading" \| "completed" \| null}` |
| `PUT /api/manga/<id>/progress` | `{"action": "volumes", "volumes": 5}` | `{"entry", "status_changed", "chapters_from_volumes": {"volume": 5, "chapter": 42 \| null, "source": "mangadex" \| "estimate" \| "anilist" \| null, "estimated": bool, "kept_higher": bool}}` — see *Volumes → chapters* |
| `GET /api/manga/<id>/volumes` | | `{"anilist_id", "source": "mangadex" \| "estimate" \| null, "volumes": [{"volume": 5, "last_chapter": 42, "source": ...}], "total_volumes", "total_chapters"}`; unknown id → 404 |
| `DELETE /api/manga/<id>` | | `{"ok": true}` (also deletes its reading log) |
| `GET /api/anime/<mal_id>/source` | | `{"source": MangaMeta (light) + "library_status"}` or `{"source": null}` — the manga an anime adapts |

Progress rules (same idea as episodes): the first chapter moves Plan to Read / On Hold to
Reading and fills `started_on`; reaching the last chapter of a *finished* manga sets Completed and
`finished_on`; ongoing manga never auto-complete; Dropped is left alone. You can't go past a known
total. Each newly read chapter is logged in `manga_log (anilist_id, chapter, read_at)`, except jumps
of more than 25 chapters (catching up records); going back removes the log rows above the new chapter.

### Volumes → chapters (code in `anishelf/mangadex.py` + `manga.py`)
AniList doesn't say which chapters are in which volume, so the server asks **MangaDex** (free public
API, no key, metadata only: no chapter pages, images or reading links). It searches
`GET /manga?title=<romaji, then English>&limit=10`, picks the result whose `links.al` is our AniList id
(or, for results with no AniList link, `links.mal` = our MAL id), then reads `GET /manga/{id}/aggregate`
(no language filter, it covers more volumes). At most **3 requests per lookup**, ≥ 0.3 s apart,
10 s timeout, User-Agent `AniShelf personal tracker`. Cached as `mangadex:volumes:<anilist_id>`
for 7 days (a "not found" for 1 day; a MangaDex error isn't cached).

- A volume's end = its last whole chapter (`10.5` → 10), or the chapter before the next volume starts.
  The `"none"` volume (not collected yet) and volumes whose end can't be seen (the next volume is
  missing and it isn't the newest) are left out, because MangaDex lacks chapters of some licensed manga.
- The last volume of a finished manga always ends at AniList's final chapter (`source: "anilist"`).
- No MangaDex map but the manga is finished with known totals: `round(volumes × chapters / volumes_total)`,
  `source: "estimate"`. Otherwise `chapter: null` and only `volumes_read` is saved.
- `volumes`: whole number 0-1000 and ≤ the known volume total (else 400, checked before any request).
- **Never lowers chapters**: `chapters_read = max(current, end of volume N)` (`kept_higher: true` when you
  were already further). Same auto-status (Reading on start, Completed at the end; the last volume of a
  finished manga completes it), dates and reading log as `set`.
- The other way round: `increment` / `set` raise `volumes_read` when the chapter count passes a volume
  end in the *cached* map (no network on a +1), and to the volume total at the final chapter. Never lowered.

XP: the profile `breakdown` gains a `"Manga"` line = 2 XP per chapter read + 40 per completed manga.
Backups: the export has `"manga": {"entries": [...], "log": [...]}` (older backups without it still
import; a damaged manga entry fails the import with a 400). `POST /api/reset` also clears manga.

## Seasonal chart, Up next, taste profile

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/season` | `?season=fall&year=2026` (both optional = this season; 8 seasons back to 1 ahead, else 400) | `{"season","year","label": "Fall 2026","is_current","current": {"season","year"},"prev"/"next": {"season","year"} or null (null at the browse limit),"items": [Meta + "library_status","start_date" ("2026-10-03", unknown month/day = 99, or null),"popularity_rank","members"],"count","in_library","truncated","source": "anilist" \| "discover","error"}` |
| `GET /api/queue` | `?limit=3` optional (max 50) | `{"entries": [Entry + "queue_position"], "total": n}`: Plan to Watch entries in your Up next order |
| `PUT /api/queue` | `{"order": [mal_id, ...]}` | same as GET. The list must hold every queued id exactly once (ints, no duplicates), else 400 and nothing changes |
| `GET /api/taste` | | taste profile, see below |

**Seasonal chart** (`anishelf/seasonal.py`): AniList `Page.media(season, seasonYear, sort: POPULARITY_DESC)`,
50 per page, **at most 2 requests per season** (100 shows; `truncated` true when more exist). Cached as
`season:<year>:<season>`: 6 h for the current/next season, 7 days for older ones. Adult shows and shows
without a MAL id are skipped. If AniList fails with nothing cached, the current season falls back to
`/api/discover`'s cached season list (`source: "discover"`). Format/sort/"hide in library" filters run in
the browser, so they make no requests. Airing day comes from `anilist.next_airing.airing_at`.

**Up next** (`anishelf/upnext.py`): stored in `library.queue_pos` (added by an idempotent `ALTER TABLE`).
A show that becomes Plan to Watch (add or PATCH) goes to the bottom; leaving Plan to Watch clears its
place, so coming back means the bottom again. Auto status changes and imports are tidied on the next
queue read. `queue_pos` is in each exported entry and restored on import; reset clears it with the library.

**Taste** (`anishelf/taste.py`, no network): each watched entry counts with
`weight = log2(1 + episodes watched) × score / 7` (unscored = ×1; Completed with no episodes ticked =
all episodes; Plan to Watch and untouched shows count 0).
```json
{"shows_counted": 12,
 "top_genres": [{"name": "Fantasy", "weight": 18.2, "share": 1.0, "shows": 4, "avg_score": 8.5}],  // max 8
 "top_studios": [...], "seasons": [...], "decades": [{"name": "2010s", ...}],                       // same shape
 "favourite_season": {...} or null, "favourite_decade": {...} or null,
 "you_vs_mal": {"count": 9, "your_avg": 8.1, "mal_avg": 7.8, "diff": 0.3} or null,
 "hidden_gems": [{"mal_id","title","title_english","image","score","mal_score","diff"}],  // diff >= +1.5, max 3
 "hot_takes": [...],                                                                     // diff <= -1.5, max 3
 "format_split": [{"name": "TV", "count": 8, "share": 0.667}],
 "summary": "You lean towards Fantasy and Drama, mostly from the 2010s, ..."}
```

## Collections + bulk edit (code in `anishelf/user_collections.py`, `anishelf/bulk.py`)
Tables: `collections (id, name, color, created_at)` and `collection_items (collection_id, mal_id, added_at)`,
primary key `(collection_id, mal_id)`, so a show can be in several collections. Created with
`CREATE TABLE IF NOT EXISTS` on every start (safe to repeat).

`Collection` = `{"id", "name", "color": "#rrggbb" or null, "created_at", "count", "mal_ids": [...]}`
(`mal_ids` only lists anime that are still in the library, oldest added first).

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/collections` | | `{"collections": [Collection]}` sorted A-Z |
| `POST /api/collections` | `{"name": "Comfort shows", "color": null}` | `{"collection"}`; name 1-40 chars (spaces squashed), unique ignoring case; at most 100 collections; else 400 |
| `PATCH /api/collections/<id>` | any of `name`, `color` | `{"collection"}`; unknown fields → 400, unknown id → 404 |
| `DELETE /api/collections/<id>` | | `{"ok": true}` (the anime stay in the library); unknown id → 404 |
| `POST /api/collections/<id>/anime` | `{"mal_id": 1}` or `{"mal_ids": [1, 2]}` (≤ 500) | `{"collection"}`; ids not in the library are ignored, adding twice is harmless |
| `DELETE /api/collections/<id>/anime/<mal_id>` | | `{"collection"}` |
| `POST /api/library/bulk` | `{"ids": [1, 2], "action": "...", "value": ...}` | `{"action", "changed": [ids], "skipped": [ids], "missing": [ids]}` |

Bulk actions (`ids`: 1-500 positive whole numbers, else 400; everything runs in ONE transaction, so a
failure changes nothing):

| action | value | effect |
|---|---|---|
| `status` | a status key | same date rules as PATCH (Watching fills `started_on`, Completed both dates); leaving Completed cancels a running rewatch; already-that-status → `skipped` |
| `tier` | `S`..`D` or null | sets/clears the tier |
| `collection` | collection id | adds every show to that collection (400 if the collection doesn't exist) |
| `watch_all` | — | marks 1..total watched (auto status + dates like `{"action": "all"}`); unknown total or already done → `skipped`. Watch-log lines are only written for ≤ 25 new episodes per show (catch-up rule) |
| `remove` | — | deletes the shows, their watch log and their collection memberships |

`missing` = ids that aren't in the library. The Library sends all seasons of a grouped series card.
Removing a show (here or `DELETE /api/library/<id>`) also takes it out of every collection.
Backups: the export has `"collections": [{"name", "color", "created_at", "mal_ids"}]`. Import matches
collections by name (ignoring case), and for the imported anime the backup decides which collections
they're in; older backups without the key still import, damaged collections are skipped.
`POST /api/reset` deletes all collections.

### Remember where you were (frontend only, `static/js/view-memory.js`)
Library, Search and Manga save their state in `sessionStorage` (`anishelf.viewMemory.<page>`) when you
leave. It is restored only when you come straight back from an anime/manga page: Library = status tab,
sort, title filter, collection and scroll (`?status=`/`?sort=` in the URL still win); Search = scroll for
the same query; Manga = status tab, sort and scroll. The view mode (List/Covers) was already kept in
`localStorage`. `#/library?collection=<id>` opens the Library filtered on a collection.
