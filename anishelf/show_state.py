"""What the SHOW is doing, worked out automatically (AniShelf 1.2).

The status you pick says what YOU are doing: Want to watch, Watching, Done, Paused, Dropped.
This module adds the other half, which you'd otherwise have to look up yourself:

    Done     + a sequel is announced     -> "announced"   ("Season 3 · Apr 2027")
    Done     + the sequel is already out -> "new_season"  ("Season 2 is out")
    Done     + no sequel known           -> "ended"       ("No new season announced")
    Done     + the show is still airing  -> "airing"      ("Still airing")
    Watching + you've seen every aired episode of an airing show -> "caught_up"
    Want to watch + it hasn't started airing yet               -> "upcoming"

It only reads data that is already in the local cache (the "relations:<id>" nodes that the
season grouping stores), so building the library stays fast and makes NO internet calls.
refresh() is the one part that may ask AniList, and it runs in the start-up warm-up with a
hard cap, so the "announced" badges stay up to date without hammering the API.
"""

from __future__ import annotations

import logging
import time

from . import franchise
from .clients import ApiError

log = logging.getLogger(__name__)

DAY = 24 * 3600
RELATIONS_TTL = 7 * DAY      # same lifetime AniShelf.seasons() uses for "relations:<id>"
MAX_REFRESH_LOOKUPS = 10     # hard cap on AniList calls per refresh() run

# Statuses that mean "I've started this season", so its badge wins over older seasons'.
ENGAGED = ("watching", "completed", "on_hold", "dropped")


def _date_text(node: dict) -> str | None:
    """'2027-04-31' style sortable dates -> 'Apr 2027' (or '2027', or None when unknown)."""
    start = str(node.get("start") or "")
    year, _, rest = start.partition("-")
    if not year or year == "9999":
        return None
    month = rest[:2]
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    # Unknown months were stored as 12 with day 31 (see franchise.node_from_media), so
    # only trust the month when the day is real too.
    if month.isdigit() and 1 <= int(month) <= 12 and not start.endswith("-12-31"):
        return f"{months[int(month) - 1]} {year}"
    return year


def _small(node: dict) -> dict:
    """Just the bits of a season node the page needs for a badge or a link."""
    return {"mal_id": node["mal_id"], "label": node.get("label"), "title": node.get("title"),
            "title_english": node.get("title_english"), "image": node.get("image"),
            "status": node.get("status"), "when": _date_text(node)}


def _done_state(entry: dict, seasons: list[dict], statuses: dict) -> dict | None:
    """Badge for a Done show: look at the NEXT season of its series."""
    ids = [s["mal_id"] for s in seasons]
    if entry["mal_id"] not in ids:
        return None
    position = ids.index(entry["mal_id"])
    later = seasons[position + 1:]
    # If you've already started a later season, that season carries the badge instead.
    if any(statuses.get(s["mal_id"]) in ENGAGED for s in later):
        return None
    # Skip cancelled entries: they will never come out.
    upcoming = [s for s in later if s.get("status") != "CANCELLED"]
    if not upcoming:
        if entry["meta"].get("airing"):
            return {"kind": "airing"}  # you marked it Done while it's still airing
        if (entry["meta"].get("airing_status") or "") == "Finished Airing":
            return {"kind": "ended"}
        return None
    nxt = upcoming[0]
    if nxt.get("status") == "NOT_YET_RELEASED":
        return {"kind": "announced", "next": _small(nxt)}
    return {"kind": "new_season", "next": _small(nxt), "airing": nxt.get("status") == "RELEASING"}


def _cached_nodes(shelf, ids) -> dict:
    """{mal_id: relations node} for every id that is already cached (one database query)."""
    keys = [f"relations:{i}" for i in ids]
    found = shelf.db.cache_get_many(keys)
    return {int(k.split(":")[1]): v for k, v in found.items() if isinstance(v, dict)}


def annotate(shelf, entries: list[dict], statuses: dict | None = None) -> None:
    """Add entry["show_state"] (a dict or None) to every library entry, in place.

    Uses only cached data. Walking a series needs the nodes of seasons you may not have in your
    library, so we first load every cached node we know about, then walk again for the ones
    the first round discovered (a series rarely needs more than 2-3 rounds)."""
    # statuses of the WHOLE library (entries may be just one status, or just one show)
    if statuses is None:
        statuses = {e["mal_id"]: e["status"] for e in entries}
    nodes = _cached_nodes(shelf, [e["mal_id"] for e in entries])
    for _ in range(4):  # follow neighbours a few steps out, each step one batched query
        missing = {n for node in nodes.values() for n in node.get("neighbours", []) if n not in nodes}
        if not missing:
            break
        nodes.update(_cached_nodes(shelf, missing))

    ordered: dict[int, list[dict]] = {}  # mal_id -> ordered seasons (each series walked once)

    def seasons_of(mal_id: int) -> list[dict]:
        if mal_id not in ordered:
            seasons = franchise.order(franchise.walk(mal_id, nodes.get))
            for season in seasons:
                ordered[season["mal_id"]] = seasons
            ordered.setdefault(mal_id, seasons)
        return ordered[mal_id]

    now = time.time()
    for entry in entries:
        entry["show_state"] = None
        status = entry["status"]
        meta = entry["meta"]
        try:
            if status == "completed":
                entry["show_state"] = _done_state(entry, seasons_of(entry["mal_id"]), statuses)
            elif status == "watching":
                aired = entry.get("aired")
                total = entry.get("total")
                behind_end = not total or entry["watched_count"] < total
                if meta.get("airing") and aired is not None and entry["watched_count"] >= aired and behind_end:
                    nxt = (meta.get("anilist") or {}).get("next_airing") or {}
                    entry["show_state"] = {"kind": "caught_up", "next_episode": nxt.get("episode"),
                                           "airing_at": nxt.get("airing_at")}
            elif status == "plan_to_watch" and meta.get("airing_status") == "Not yet aired":
                nxt = (meta.get("anilist") or {}).get("next_airing") or {}
                at = nxt.get("airing_at")
                entry["show_state"] = {"kind": "upcoming", "airing_at": at if at and at > now else None}
        except Exception as exc:  # a badge is a nice-to-have: never let it break the library
            log.warning("show_state for %s failed: %s", entry.get("mal_id"), exc)


def refresh(shelf, max_lookups: int = MAX_REFRESH_LOOKUPS) -> int:
    """Re-check AniList for new sequels of your Done shows (capped). Returns the calls made.

    Two kinds of cached node can go stale:
    - the newest Done season of a series: a NEW sequel shows up in its 'neighbours' list;
    - an announced (not yet released) sequel: its start date or status changes.
    Each is refreshed only when older than RELATIONS_TTL, and at most `max_lookups` per run."""
    entries = shelf.library()
    annotate(shelf, entries)
    wanted: list[int] = []
    for entry in entries:
        state = entry.get("show_state") or {}
        never_checked = shelf.db.cache_get(f"relations:{entry['mal_id']}", None) is None
        if entry["status"] == "completed" and (never_checked or state.get("kind") in ("ended", "announced")):
            wanted.append(entry["mal_id"])
            if state.get("kind") == "announced":
                wanted.append(state["next"]["mal_id"])

    calls = 0
    for mal_id in dict.fromkeys(wanted):  # dict.fromkeys = remove duplicates, keep the order
        key = f"relations:{mal_id}"
        hit = shelf.db.cache_get(key, RELATIONS_TTL)
        if hit and hit[1]:
            continue  # still fresh
        if calls >= max_lookups:
            break
        calls += 1
        try:
            shelf._cached(key, RELATIONS_TTL, lambda m=mal_id: shelf.anilist.relations_node(m), force=True)
        except ApiError as exc:
            log.info("Season check for %s failed: %s", mal_id, exc)
    return calls
