# AniShelf

A personal anime tracker with a dark, image-rich interface: banners, cover art, per-episode
tracking, a watchlist, tier lists, head-to-head rankings, stats and a "what should I watch
tonight?" picker.

Everything is **free**: anime data comes from [Jikan](https://jikan.moe) (MyAnimeList) and
[AniList](https://anilist.co), both public APIs that need **no account and no API key**.

## Start it

- **Windows:** double-click `run.bat`
- **Mac:** run `chmod +x run.command` once, then double-click `run.command`

The first start creates a virtual environment and installs Flask + requests. AniShelf then opens
in its own app window (Edge/Chrome "app mode"). Closing the console window stops it.

Manual start: `python run.py` (options: `--port 5178`, `--no-window`).

## Features

- **Home**: continue watching (with a one-click +1 episode), this season, top airing
- **Search** any anime and add it with a status: Want to watch, Watching, Done, Paused, Dropped
- **Detail page**: banner, cover, genres, studios, score, trailer, airing countdown, and
  the page tints itself in the anime's own cover colour
- **Episode tracker**: click episodes, shift-click for a range, or type `1-12, 15`.
  Status and dates update automatically (first episode → Watching, last → Done)
- **Journal**: notes, favourite character, favourite moment, start/finish dates, rewatches
- **Cast**: every main/supporting character with their voice actors, switchable between
  Sub (Japanese) and Dub (English)
- **Level-up system**: earn XP for episodes (10), finishing a show (50), scores, journal entries,
  versus battles, tier placements and rewatches. Climb from *Fresh Viewer* to *Ascended*, unlock
  16 badges, and get a level-up celebration. XP is calculated from your library, so it can't
  get out of sync (un-marking an episode takes its XP back)
- **Rankings**: drag-and-drop tier list (S–D) and "Versus" battles that build an Elo leaderboard
- **Stats**: hours watched, streaks, a 365-day activity heatmap, monthly chart, top genres, score spread
- **Profile**: display name, bio and a character avatar (pick from popular characters, characters
  from your shows, or search any character)
- **Where to watch**: Crunchyroll/Netflix/etc. links and per-episode "▶ Watch on Crunchyroll".
  Links open in your normal browser (where you're logged in); when you come back AniShelf asks
  "Finished episode N?". Streaming sites can't be embedded (DRM + they block it), so this is the
  closest legit thing
- **Episode titles + thumbnails** in a list view (Jikan, or AniList's streaming data as fallback)
- **Tonight's pick**: spin your Plan to Watch list, or "Surprise me" with a popular show you
  haven't added yet (genre + length filters)
- **Mini games**: seven small games (three from your own shelf, four inspired by shows); a new personal best gives a little XP
- **New in 1.2**
  - **Clearer statuses**: Want to watch, Watching, Done, Paused, Dropped. You pick what *you* are
    doing; badges show what the *show* is doing: "Waiting for Season 3 · Oct 2027",
    "Season 2 is out", "Caught up · next ep Tuesday", "Still airing", "No new season announced"
    (from cached season data, rechecked at start-up with a hard cap of 10 AniList calls)
  - **Season inbox**: a bell in the top bar collects sequel news for shows you've finished
  - **Smart Library filters** ("New season out", "Waiting for more") and a "Last watched" sort
  - **Undo** on toasts, **automatic daily backups** (last 7, in `data/backups/auto`),
    **Ctrl+K quick jump**, **bulk edit**, **collections**, the Library **remembers where you were**
  - **Seasonal chart** (`#/season`), **Up next** queue (`#/queue`), **taste profile** on Stats
- **New in 1.15**
  - **Manga**: search and track manga (Reading, Completed, Plan to Read...), chapter progress, official "Where to read" links, anime adaptations, "Continue reading" on Home, plus stats and XP
  - **9 themes**, including a light one (Paper)
  - **Floating companions**: small animated things drifting around the app (Flower field, Peanuts, Spirit lights, Ink sparkles, Sakura, Slime pals, Tiny UFOs), set up in Settings
  - **A new logo**: the Sakura bookmark
  - **Season grouping**: stray movies join their series automatically, and every anime page has a "Group with..." fix
- **New in 1.1**
  - **Profile**: a banner from your shows, a Top 5 shelf, a favourite-characters wall, a badge showcase and a downloadable profile card
  - **Daily quests** and new badges (some of them secret)
  - **Anime Wrapped**: your year in review
  - **Watch diary**: a one-line reaction when you finish a show
  - **Rewatch tracking** and **score predictions**
  - **Home**: "On this day" memories, "continue the franchise" nudges, and an **airing calendar** in your local time
  - **Tonight's pick** by mood
  - **Themes** and optional **sound effects** (Settings)
- **Seasonal chart** (Season in the sidebar): this season's anime as a cover grid with format, sort and
  "hide what I have" filters, one-click add, and up to 8 seasons back / 1 ahead
- **Up next**: put your Want to watch list in order (drag rows or use the arrow buttons); Home shows the top 3
- **Your taste** on the Stats page: favourite genres, studios, decade and season, your scores vs MyAnimeList,
  hidden gems and hot takes
- **Backup**: export/import everything as one JSON file (Settings)
- **Collections**: your own lists ("Comfort shows", "Watch with friends"...). Add a show from its page,
  filter the Library by collection, and rename/recolour/delete them under "Manage collections"
- **Bulk edit**: press *Select* in the Library, click cards (shift-click for a range) and change the
  status or tier, add them to a collection, mark everything watched or remove them in one go
- **Remembers where you were**: going back from an anime page restores the Library's tab, sort,
  filter, collection and scroll position (also Search results and the Manga shelf)
- **Automatic daily backups**: on start (and once a day while it runs) AniShelf saves the same
  JSON file to `data/backups/auto/anishelf-YYYY-MM-DD.json` and keeps the newest 7. Other files in
  `data/backups/` are never touched. Settings shows the last one and has a "Back up now" button
- **Undo**: marking episodes, +1 on Home, changing status, score or tier, and removing a show all
  show a toast with an **Undo** button for a few seconds (a removed show comes back with everything)
- **Ctrl+K quick jump**: type part of a title (English or Japanese) to jump to any show on your
  shelf or to a page; Shift+Enter marks the next episode

## How it works

```
run.py            starts the local server (127.0.0.1 only) and opens the window
anishelf/
  logic.py        pure rules: episode ranges, auto status, Elo, validation
  db.py           SQLite: library, watch history, API cache
  clients.py      HTTP + rate limiting + the Jikan client
  anilist.py      AniList client (banners, colours, countdowns, cast + full fallback)
  progression.py  XP, levels, titles and badges
  images.py       downloads each image once and caches it on disk
  service.py      app logic that ties it together (stats, versus, random, caching)
  server.py       Flask JSON API (see docs/API.md)
static/           the interface (HTML/CSS/JavaScript, no build step)
tests/            pytest suite (fake APIs, never touches the internet)
```

### API safety (no spamming, no bills)

- No API keys exist anywhere in this project, and no paid service is used.
- Every request goes through a rate limiter: Jikan ≤ 50/min, AniList ≤ 25/min (both well under
  their published limits). There is also a hard cap per session (600 each, 3000 image downloads).
- 4 s connect / 15 s read timeouts, at most one retry.
- Responses are cached in SQLite (search 1 day, details 2 days or 12 h for airing shows,
  seasonal lists 6 h), and images are stored permanently, so normal use makes very few calls.
- If Jikan is down, AniList provides the same data (same MyAnimeList ids) automatically.
  Only episode *titles* need Jikan; without it the grid just shows numbers.

### Your data

Everything is stored in `data/` (ignored by git): `anishelf.db` plus cached images.
To share one library between your PC and Mac, point both at a synced folder:

```bash
# Windows (PowerShell):  $env:ANISHELF_DATA = "$env:OneDrive\AniShelf"; python run.py
# Mac:                   ANISHELF_DATA=~/Library/Mobile\ Documents/com~apple~CloudDocs/AniShelf python3 run.py
```

Only run one computer at a time against a synced folder. Exporting a backup now and then never hurts.

Marking more than 25 episodes at once (e.g. adding a show you finished years ago) counts as
record keeping, so it doesn't show up as today's activity in the heatmap or streaks.

## Tests

```bash
.venv/Scripts/python -m pytest -q      # Windows
.venv/bin/python -m pytest -q          # Mac
```
