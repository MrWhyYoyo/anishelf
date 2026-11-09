"""Seasonal chart: every anime of one season (Winter/Spring/Summer/Fall) as a cover grid.

Data comes from AniList (free, no key) through the normal rate-limited client.
API safety:
  * at most MAX_PAGES requests per season (50 shows each), so one page view can't spam AniList
  * every page is cached in api_cache (6 h for the current/next season, 7 days for older ones)
  * you can only browse a few seasons back or ahead (MAX_BACK / MAX_AHEAD)
If AniList is down and nothing is cached, the current season falls back to the list
shelf.discover() already fetches (Jikan's "this season", 24 shows).
"""

from __future__ import annotations

import logging
from datetime import date

from .anilist import current_season, normalize_anilist
from .clients import DAY, HOUR, ApiError
from .logic import ValidationError

log = logging.getLogger(__name__)

SEASONS = ["winter", "spring", "summer", "fall"]  # calendar order
MAX_PAGES = 2       # hard cap: 2 AniList requests (100 shows) per season
PER_PAGE = 50       # AniList's largest page size
MAX_BACK = 8        # you can go 8 seasons (2 years) back...
MAX_AHEAD = 1       # ...and 1 season ahead (next season's announced shows)


# ---------------------------------------------------------------- season arithmetic
def season_index(season: str, year: int) -> int:
    """Turn (season, year) into one number so seasons can be compared and stepped.

    Fall 2026 -> 2026 * 4 + 3. One season later is just +1, which also handles the year change.
    """
    return year * 4 + SEASONS.index(season)


def from_index(index: int) -> dict:
    """The opposite of season_index: 8107 -> {"season": "fall", "year": 2026}."""
    year, position = divmod(index, 4)  # divmod gives (whole part, remainder) in one go
    return {"season": SEASONS[position], "year": year}


def label(season: str, year: int) -> str:
    return f"{season.capitalize()} {year}"


def this_season(today: date | None = None) -> dict:
    season, year = current_season(today)  # AniList's helper says e.g. ("FALL", 2026)
    return {"season": season.lower(), "year": year}


def pick_season(season: str | None, year: str | int | None, today: date | None = None) -> dict:
    """Check the ?season=&year= query. Missing values mean "this season". Raises ValidationError."""
    now = this_season(today)
    if not season and not year:
        return now
    season = (season or "").strip().lower()
    if season not in SEASONS:
        raise ValidationError("season must be winter, spring, summer or fall")
    try:
        year = int(year)
    except (TypeError, ValueError):
        raise ValidationError("year must be a number") from None
    offset = season_index(season, year) - season_index(now["season"], now["year"])
    if offset < -MAX_BACK or offset > MAX_AHEAD:
        raise ValidationError(f"You can browse up to {MAX_BACK} seasons back and {MAX_AHEAD} ahead")
    return {"season": season, "year": year}


# ---------------------------------------------------------------- turning AniList data into cards
def chart_item(media: dict, rank: int) -> dict | None:
    """Raw AniList media -> Meta plus the few extra fields the chart needs. None without a MAL id."""
    meta = normalize_anilist(media)
    if meta is None:
        return None  # the app keys everything by MyAnimeList id, so shows without one can't be added
    start = media.get("startDate") or {}
    if start.get("year"):
        # "2026-10-03"; unknown month/day become 99 so they sort after the known dates
        meta["start_date"] = f"{start['year']:04d}-{start.get('month') or 99:02d}-{start.get('day') or 99:02d}"
    else:
        meta["start_date"] = None
    meta["popularity_rank"] = rank  # AniList sent the list most-popular-first; remember that order
    meta["members"] = media.get("popularity")  # how many AniList users have it on a list
    return meta


def fetch_season(anilist, season: str, year: int) -> dict:
    """Ask AniList for up to MAX_PAGES pages. Only this function makes requests."""
    items, seen = [], set()
    truncated = False
    for page in range(1, MAX_PAGES + 1):  # a for loop with a fixed range can never run away
        answer = anilist.season_page(season, year, page, PER_PAGE)
        for media in answer.get("media") or []:
            if media.get("isAdult"):
                continue
            item = chart_item(media, len(items) + 1)
            if item and item["mal_id"] not in seen:
                seen.add(item["mal_id"])
                items.append(item)
        if not answer.get("has_next"):
            break
    else:
        truncated = True  # the loop used every allowed page and AniList still had more
    return {"items": items, "truncated": truncated}


# ---------------------------------------------------------------- the endpoint
def season_chart(shelf, season: str | None = None, year=None, today: date | None = None) -> dict:
    """GET /api/season: one season's chart with library statuses filled in."""
    chosen = pick_season(season, year, today)
    now = this_season(today)
    index = season_index(chosen["season"], chosen["year"])
    now_index = season_index(now["season"], now["year"])
    # Old seasons barely change; the current and next season gain shows and airing times.
    ttl = 6 * HOUR if index >= now_index else 7 * DAY
    key = f"season:{chosen['year']}:{chosen['season']}"

    source, error = "anilist", None
    try:
        data = shelf._cached(key, ttl, lambda: fetch_season(shelf.anilist, chosen["season"], chosen["year"]))
    except ApiError as exc:
        log.warning("Seasonal chart failed for %s: %s", key, exc)
        error = str(exc)
        data = {"items": [], "truncated": False}
        if index == now_index:
            # Reuse what Home already fetched (shelf.discover is cached for 6 h).
            try:
                fallback = shelf.discover()["season"]
                # these lists have no start date or chart rank, so fill those in the same shape
                data = {"items": [{**m, "start_date": None, "popularity_rank": i + 1, "members": None}
                                  for i, m in enumerate(fallback)], "truncated": True}
                source = "discover"
            except ApiError:
                pass

    items = shelf._with_status(data["items"])  # adds "library_status" (None when not on the shelf)
    previous = index - 1 if index - 1 >= now_index - MAX_BACK else None
    following = index + 1 if index + 1 <= now_index + MAX_AHEAD else None
    return {
        "season": chosen["season"],
        "year": chosen["year"],
        "label": label(chosen["season"], chosen["year"]),
        "is_current": index == now_index,
        "current": now,
        "prev": from_index(previous) if previous is not None else None,
        "next": from_index(following) if following is not None else None,
        "items": items,
        "count": len(items),
        "in_library": sum(1 for item in items if item["library_status"]),
        "truncated": data.get("truncated", False),
        "source": source,
        "error": error if not items else None,
    }
