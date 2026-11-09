"""Extra data for the profile page: banner choices and the favourite characters wall.

Both look at the library and may need data from AniList. To stay polite to the free API
(and to make sure a bug can never fire hundreds of requests), every function here has a
hard cap on how many NEW lookups it does per call. Anything already cached is free, so
the page fills in a bit more each time it is opened.
"""

from __future__ import annotations

import logging
import re

from .clients import ApiError
from .logic import AVATAR_HOSTS, match_character

log = logging.getLogger(__name__)

HOUR = 3600
MAX_BANNER_FETCHES = 6       # new AniList lookups per call to banner_choices()
MAX_CHARACTER_LOOKUPS = 12   # new cast lookups per call to fav_characters()
MAX_NAMES_PER_ENTRY = 3      # "Levi, Erwin, Hange" -> try at most 3 names


def _anilist_extras(shelf, row: dict, budget: dict) -> dict | None:
    """Banner + colour for one library row, or None when we don't know yet.

    Looks in three places, cheapest first:
    1. the library snapshot (filled when the anime was added or its page was opened),
    2. the cache of an earlier AniList lookup,
    3. AniList itself, but only while budget["left"] > 0.
    """
    mal_id = row["mal_id"]
    snapshot = row["meta"].get("anilist")
    if isinstance(snapshot, dict) and "banner" in snapshot:
        return snapshot

    hit = shelf.db.cache_get(f"anilist:{mal_id}", None)  # None = accept any age
    if hit:
        return hit[0] or {}

    if budget["left"] <= 0:
        return None  # out of budget: try again next time the picker opens
    budget["left"] -= 1
    try:
        # _cached stores the answer, so this anime never needs a request again
        return shelf._cached(f"anilist:{mal_id}", 6 * HOUR, lambda: shelf.anilist.extras(mal_id)) or {}
    except ApiError as exc:
        log.warning("Banner lookup for %s failed: %s", mal_id, exc)
        return None


def banner_choices(shelf, max_fetches: int = MAX_BANNER_FETCHES) -> dict:
    """Every library anime that has an AniList banner.

    Returns {"choices": [{"mal_id", "title", "title_english", "image", "color"}], "unchecked": n}
    where "unchecked" counts the anime we couldn't look up yet (open the picker again for more).
    """
    budget = {"left": max_fetches}
    choices = []
    unchecked = 0
    for row in shelf.db.all():
        extras = _anilist_extras(shelf, row, budget)
        if extras is None:
            unchecked += 1
            continue
        banner = extras.get("banner")
        # only offer pictures that the profile validation (and the /img proxy) will accept
        if not isinstance(banner, str) or not banner.startswith(AVATAR_HOSTS):
            continue
        meta = row["meta"]
        choices.append({
            "mal_id": row["mal_id"],
            "title": meta.get("title"),
            "title_english": meta.get("title_english"),
            "image": banner,
            "color": extras.get("color"),
        })
    return {"choices": choices, "unchecked": unchecked}


def _split_names(text: str) -> list[str]:
    """'Levi / Erwin & Hange' -> ['Levi', 'Erwin', 'Hange'] (at most MAX_NAMES_PER_ENTRY)."""
    parts = [part.strip() for part in re.split(r"[,/&;]| and ", text)]
    names = [part for part in parts if part]
    return names[:MAX_NAMES_PER_ENTRY]


def _portrait(character: dict | None) -> str | None:
    """The character's picture, unless it is AniList's grey 'no picture' placeholder."""
    if not character:
        return None
    image = character.get("image")
    if not isinstance(image, str) or "default.jpg" in image:
        return None
    return image


def _matches(typed: str, cast: list | None) -> list[tuple[str, dict | None]]:
    """Turn the typed favourite text into (name, cast member) pairs, one per Profile card.

    "Spike Spiegel" -> one card. "Levi, Erwin" (the hearts on the Cast cards save it like this)
    -> one card per name that matches someone in the cast. If nothing matches (or the cast
    isn't loaded yet) we still show one card with what was typed, drawn with initials."""
    if cast:
        whole = match_character(typed, cast)
        if whole is not None:
            return [(typed, whole)]
        pairs, seen = [], set()
        for name in _split_names(typed):
            match = match_character(name, cast)
            if match and match.get("name") not in seen:   # two spellings of one character -> one card
                seen.add(match.get("name"))
                pairs.append((name, match))
        if pairs:
            return pairs
    return [(typed, None)]


def fav_characters(shelf, max_lookups: int = MAX_CHARACTER_LOOKUPS) -> dict:
    """One card per favourite character (up to 3 per show), with a portrait when we can match it.

    Returns {"characters": [{"mal_id", "title", "title_english", "cover", "character",
    "matched_name", "image"}], "pending": n} where "pending" counts entries whose cast
    wasn't looked up yet because the per-call cap was reached.
    """
    lookups = 0
    pending = 0
    cards = []
    for row in shelf.db.all():
        typed = str(row.get("fav_character") or "").strip()
        if not typed:
            continue
        mal_id = row["mal_id"]

        # Find the cast: from the cache if possible, otherwise ask AniList (capped).
        cast = None
        hit = shelf.db.cache_get(f"characters:{mal_id}", None)
        if hit:
            cast = hit[0]
        elif lookups < max_lookups:
            lookups += 1
            try:
                cast = shelf.characters(mal_id)
            except ApiError as exc:
                log.warning("Cast lookup for %s failed: %s", mal_id, exc)
        else:
            pending += 1

        meta = row["meta"]
        for name, match in _matches(typed, cast):
            cards.append({
                "mal_id": mal_id,
                "title": meta.get("title"),
                "title_english": meta.get("title_english"),
                "cover": meta.get("image"),
                "character": name,
                "matched_name": match["name"] if match else None,
                "image": _portrait(match),
            })
    return {"characters": cards, "pending": pending}
