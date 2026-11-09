"""Watching helpers for Home and the airing calendar (AniShelf 1.1).

Four small features live here so the shared service.py stays short:
  1. memories  - "A year ago today you finished ..." (from the watch log and start/finish dates)
  2. calendar  - upcoming episodes of my airing shows, grouped into the next 7 local days
  3. nudges    - "You finished Season 2, and Season 3 is on your shelf"
  4. moods     - "Chill", "Hype", ... mapped to genre sets for Tonight's pick

Most functions here are "pure": they take plain data in and give plain data back, without
touching the database or the network. That makes them easy to test with made-up data.
The functions at the bottom of each section (memories(), calendar(), nudges()) are the thin
glue that reads the real library through the AniShelf service.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone

from . import franchise
from .clients import DAY, HOUR, ApiError
from .logic import ValidationError

log = logging.getLogger(__name__)


# ====================================================================== 1. memories
MEMORY_LIMIT = 3            # at most this many memories on Home
MONTHS_FALLBACK = (1, 3, 6)  # if nothing happened on this day in earlier years, look this many months back
KIND_RANK = {"finished": 0, "started": 1, "watched": 2}  # finishing a show is the best memory


def local_date(iso_text: str) -> date | None:
    """Watch log times are stored in UTC; turn one into a date on this computer's clock."""
    try:
        return datetime.fromisoformat(iso_text).astimezone().date()
    except (TypeError, ValueError):
        return None


def months_back(today: date, months: int) -> date | None:
    """The same day of the month, `months` months earlier. None if that day doesn't exist
    (for example 31 March -> 31 February), so we never invent a memory for a wrong day."""
    month = today.month - months
    year = today.year
    while month < 1:  # stepping back past January wraps into the previous year
        month += 12
        year -= 1
    try:
        return today.replace(year=year, month=month)
    except ValueError:
        return None


def collect_events(watch_log: list[dict], entries: list[dict]) -> dict:
    """Build {date: {mal_id: {"kind", "episodes"}}} - what happened to each show on each day.

    - every watch log row adds one episode to that show on that (local) day
    - started_on / finished_on dates from the library are "started" and "finished" events
    If several things happened to one show on one day, the best kind wins (finished > started > watched).
    """
    days: dict = {}

    def remember(day: date, mal_id: int, kind: str, episodes: int = 0) -> None:
        shows = days.setdefault(day, {})
        event = shows.get(mal_id)
        if event is None:
            shows[mal_id] = {"kind": kind, "episodes": episodes}
            return
        event["episodes"] += episodes
        if KIND_RANK[kind] < KIND_RANK[event["kind"]]:
            event["kind"] = kind

    for row in watch_log:
        day = local_date(row.get("watched_at"))
        if day:
            remember(day, row["mal_id"], "watched", 1)

    for entry in entries:
        for field, kind in (("started_on", "started"), ("finished_on", "finished")):
            value = entry.get(field)
            if not value:
                continue
            try:
                day = date.fromisoformat(value)
            except ValueError:
                continue
            remember(day, entry["mal_id"], kind)
    return days


def when_text(years: int = 0, months: int = 0) -> str:
    """'A year ago today', '2 years ago today', '3 months ago today'."""
    if years:
        return "A year ago today" if years == 1 else f"{years} years ago today"
    return "A month ago today" if months == 1 else f"{months} months ago today"


def action_text(kind: str, episodes: int) -> str:
    """The verb part of the sentence. The title is added after it (by the page)."""
    if kind == "finished":
        return "you finished"
    if kind == "started":
        return "you started"
    word = "episode" if episodes == 1 else "episodes"
    return f"you watched {episodes} {word} of"


def pick_memories(events: dict, entries_by_id: dict, today: date, limit: int = MEMORY_LIMIT) -> list[dict]:
    """Choose the memories to show today.

    First choice: this calendar day in earlier years (most recent year first).
    Only if there are none: exactly 1, 3 or 6 months ago.
    One memory per show, at most `limit`.
    """
    # (day, years ago, months ago) for every day worth looking at, best first
    candidates = []
    for day in sorted(events, reverse=True):
        if day < today and day.month == today.month and day.day == today.day:
            candidates.append((day, today.year - day.year, 0))
    if not candidates:
        for months in MONTHS_FALLBACK:
            day = months_back(today, months)
            if day and day in events:
                candidates.append((day, 0, months))

    memories = []
    used_ids = set()
    for day, years, months in candidates:
        shows = events[day]
        # inside one day: finished first, then started, then most episodes watched
        ordered = sorted(shows.items(), key=lambda item: (KIND_RANK[item[1]["kind"]], -item[1]["episodes"], item[0]))
        for mal_id, event in ordered:
            entry = entries_by_id.get(mal_id)
            if entry is None or mal_id in used_ids:
                continue  # removed from the library, or already remembered once
            used_ids.add(mal_id)
            meta = entry["meta"]
            when = when_text(years, months)
            action = action_text(event["kind"], event["episodes"])
            memories.append({
                "mal_id": mal_id,
                "meta": {"mal_id": mal_id, "title": meta.get("title"), "title_english": meta.get("title_english"),
                         "image": meta.get("image")},
                "date": day.isoformat(),
                "kind": event["kind"],
                "episodes": event["episodes"],
                "years_ago": years,
                "months_ago": months,
                "when": when,
                "action": action,
                "text": f"{when} {action} {meta.get('title_english') or meta.get('title')}",
            })
            if len(memories) >= limit:
                return memories
    return memories


def memories(shelf, today: date | None = None) -> list[dict]:
    """GET /api/memories: reads the real watch log + library. No network."""
    today = today or date.today()
    entries = shelf.library()
    entries_by_id = {e["mal_id"]: e for e in entries}
    events = collect_events(shelf.db.watch_log(), entries)
    return pick_memories(events, entries_by_id, today)


# ====================================================================== 2. airing calendar
CALENDAR_DAYS = 7
CALENDAR_STATUSES = ("watching", "plan_to_watch")
MAX_TZ_OFFSET = 14 * 60  # real time zones are within +-14 hours of UTC


def is_airing(entry: dict) -> bool:
    """Airing now = the stored info says so, or AniList knows the next episode's date."""
    meta = entry.get("meta") or {}
    next_airing = (meta.get("anilist") or {}).get("next_airing")
    return bool(meta.get("airing") or next_airing)


def server_tz_offset() -> int:
    """This computer's offset in the same format as JavaScript's getTimezoneOffset():
    minutes to ADD to local time to get UTC (Finland in winter: -120)."""
    offset = datetime.now().astimezone().utcoffset() or timedelta(0)
    return -int(offset.total_seconds() // 60)


def parse_tz_offset(raw: str | None) -> int:
    """The ?tz_offset= query value from the browser. Missing -> the server's own zone."""
    if raw is None or raw == "":
        return server_tz_offset()
    try:
        value = int(raw)
    except ValueError:
        raise ValidationError("tz_offset must be a whole number of minutes") from None
    if abs(value) > MAX_TZ_OFFSET:
        raise ValidationError("tz_offset is out of range")
    return value


def to_local(unix_seconds: int, tz_offset: int) -> datetime:
    """Unix time -> wall-clock time in the browser's zone (as a naive datetime)."""
    utc = datetime.fromtimestamp(unix_seconds, timezone.utc).replace(tzinfo=None)
    return utc - timedelta(minutes=tz_offset)


def build_calendar(schedule: list[dict], entries_by_id: dict, now: float, tz_offset: int,
                   days: int = CALENDAR_DAYS) -> dict:
    """Group upcoming episodes into `days` local days, today first.

    schedule: [{"mal_id", "episode", "airing_at"}] from AniList (may include past episodes
    if it came from a slightly old cache - those are dropped here).
    """
    today = to_local(int(now), tz_offset).date()
    day_list = []
    for i in range(days):
        day = today + timedelta(days=i)
        day_list.append({"date": day.isoformat(), "items": []})

    upcoming = []
    for item in sorted(schedule, key=lambda s: (s["airing_at"], s["mal_id"])):
        entry = entries_by_id.get(item["mal_id"])
        if entry is None or item["airing_at"] < now:
            continue  # not one of my shows, or it already aired
        meta = entry["meta"]
        local = to_local(item["airing_at"], tz_offset)
        upcoming.append({
            "mal_id": item["mal_id"],
            "episode": item["episode"],
            "airing_at": item["airing_at"],
            "local_time": local.strftime("%H:%M"),
            "status": entry["status"],
            "total": entry.get("total"),
            "meta": {"mal_id": item["mal_id"], "title": meta.get("title"),
                     "title_english": meta.get("title_english"), "image": meta.get("image")},
        })
        index = (local.date() - today).days
        if 0 <= index < days:
            day_list[index]["items"].append(upcoming[-1])

    return {
        "days": day_list,
        "next": upcoming[0] if upcoming else None,
        "upcoming": upcoming[:3],  # for the small "Airing this week" strip on Home
        "shows": len({u["mal_id"] for u in upcoming}),
    }


def calendar(shelf, tz_offset: int, now: float | None = None) -> dict:
    """GET /api/calendar: ONE AniList request for all my airing shows, cached for an hour."""
    from .anilist import AIRING_BATCH_MAX  # the same cap the client uses

    now = time.time() if now is None else now
    entries = [e for e in shelf.library() if e["status"] in CALENDAR_STATUSES and is_airing(e)]
    entries_by_id = {e["mal_id"]: e for e in entries}
    ids = sorted(entries_by_id)[:AIRING_BATCH_MAX]
    error = None
    schedule = []
    if ids:
        # the key lists the ids, so adding or removing a show asks AniList again
        key = "airing:" + ",".join(str(i) for i in ids)
        try:
            schedule = shelf._cached(key, HOUR, lambda: shelf.anilist.airing_schedule(ids))
        except ApiError as exc:
            log.warning("Airing calendar failed: %s", exc)
            error = "Couldn't reach AniList for the airing times. Try again in a minute."
    result = build_calendar(schedule or [], entries_by_id, now, tz_offset)
    result["tracked"] = len(ids)
    result["error"] = error
    return result


# ====================================================================== 3. franchise nudges
NUDGE_LIMIT = 6
MAX_UNCACHED_LOOKUPS = 5  # hard cap on AniList calls per /api/nudges request
NUDGE_STATUSES = (None, "plan_to_watch")  # suggest seasons that are not started yet


class LookupBudget:
    """Counts how many uncached AniList lookups we may still make in this request."""

    def __init__(self, allowed: int):
        self.left = allowed

    def take(self) -> bool:
        if self.left <= 0:
            return False
        self.left -= 1
        return True


def cached_node_getter(shelf, budget: LookupBudget):
    """A get_node(mal_id) for franchise.walk() that prefers the cache.

    Cached relation nodes are free. A missing one is fetched only while the budget lasts;
    after that it counts as unknown (None), which simply ends the walk in that direction.
    """
    def get_node(mal_id: int):
        key = f"relations:{mal_id}"
        hit = shelf.db.cache_get(key, None)
        if hit is not None:
            return hit[0]
        if not budget.take():
            return None
        try:
            # same key and lifetime as AniShelf.seasons(), so both share the cache
            return shelf._cached(key, 7 * DAY, lambda: shelf.anilist.relations_node(mal_id))
        except ApiError:
            return None

    return get_node


def find_nudges(completed: list[dict], statuses: dict, ordered_for, limit: int = NUDGE_LIMIT) -> list[dict]:
    """For each completed show, look at the NEXT main-story entry of its series.

    completed:   completed library entries, most recently finished first
    statuses:    {mal_id: library status} for the whole library
    ordered_for: function(mal_id) -> franchise.order(...) list, or [] if unknown
    A nudge is made when that next entry is on Plan to Watch or not in the library at all.
    """
    nudges = []
    suggested = set()
    for entry in completed:
        seasons = ordered_for(entry["mal_id"])
        ids = [s["mal_id"] for s in seasons]
        if entry["mal_id"] not in ids:
            continue
        position = ids.index(entry["mal_id"])
        if position + 1 >= len(seasons):
            continue  # this was the newest entry of the series
        following = seasons[position + 1]
        if following.get("status") == "NOT_YET_RELEASED":
            continue  # can't watch it yet
        status = statuses.get(following["mal_id"])
        if status not in NUDGE_STATUSES or following["mal_id"] in suggested:
            continue
        suggested.add(following["mal_id"])
        current_label = seasons[position]["label"]
        meta = entry["meta"]
        nudges.append({
            "from": {"mal_id": entry["mal_id"], "title": meta.get("title"), "title_english": meta.get("title_english"),
                     "image": meta.get("image"), "label": current_label},
            "next": {"mal_id": following["mal_id"], "title": following.get("title"),
                     "title_english": following.get("title_english"), "image": following.get("image"),
                     "label": following["label"], "format": following.get("format"),
                     "episodes": following.get("episodes"), "year": following.get("year"),
                     "library_status": status},
        })
        if len(nudges) >= limit:
            break
    return nudges


def nudges(shelf, max_lookups: int = MAX_UNCACHED_LOOKUPS) -> list[dict]:
    """GET /api/nudges: "continue the franchise" suggestions, mostly from cached data."""
    entries = shelf.library()
    statuses = {e["mal_id"]: e["status"] for e in entries}
    completed = [e for e in entries if e["status"] == "completed"]
    # most recently finished first (shows without a date go last)
    completed.sort(key=lambda e: (e.get("finished_on") or "", e.get("updated_at") or ""), reverse=True)

    budget = LookupBudget(max_lookups)
    get_node = cached_node_getter(shelf, budget)
    known: dict = {}  # mal_id -> ordered seasons, so one series is walked only once

    def ordered_for(mal_id: int) -> list[dict]:
        if mal_id not in known:
            seasons = franchise.order(franchise.walk(mal_id, get_node))
            for season in seasons:
                known[season["mal_id"]] = seasons
            known.setdefault(mal_id, seasons)
        return known[mal_id]

    return find_nudges(completed, statuses, ordered_for)


# ====================================================================== 4. moods
# Genre names as Jikan (MyAnimeList genres + themes) and AniList write them.
MOODS = {
    "chill": ["Slice of Life", "Iyashikei", "Comedy", "CGDCT", "Gourmet"],
    "hype": ["Action", "Sports", "Mecha", "Martial Arts", "Super Power"],
    "sad": ["Drama", "Tragedy"],
    "brain": ["Mystery", "Psychological", "Thriller", "Suspense", "Sci-Fi"],
    "laugh": ["Comedy", "Gag Humor", "Parody"],
}


def mood_genres(mood: str | None) -> list[str] | None:
    """The genre list for a mood. None means "any mood" (no filtering)."""
    if not mood or mood.lower() == "any":
        return None
    genres = MOODS.get(mood.lower())
    if genres is None:
        raise ValidationError("Unknown mood")
    return genres


def matches_mood(genres: list[str] | None, wanted: list[str] | None) -> bool:
    """True if the show has at least ONE of the mood's genres (or there is no mood)."""
    if wanted is None:
        return True
    for genre in genres or []:
        if genre in wanted:
            return True
    return False


def discover_genre_for_mood(mood: str | None, rng, allowed: list[str]) -> str | None:
    """'Surprise me' can only ask AniList for one genre: pick one of the mood's genres at random."""
    wanted = mood_genres(mood)
    if wanted is None:
        return None
    usable = [g for g in wanted if g in allowed]
    return rng.choice(usable) if usable else None
