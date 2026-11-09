"""Join stray entries (movies, specials) to the series they belong to.

Seasons are grouped by following AniList's SEQUEL/PREQUEL links (see franchise.py). Some
entries aren't linked that way, e.g. "The Apothecary Diaries: The Late Lady's Treasure" (a movie)
or "The Quintessential Quintuplets Movie", so they used to show up as a separate anime.

Two ways to fix that, both stored in the settings table:
- automatic: an entry that is alone in its group joins another group when its title starts
  with that group's title ("Kusuriya no Hitorigoto: Bouhi no Hihou" -> "Kusuriya no Hitorigoto")
- manual: the user picks "Group with..." on the anime page (this always wins, and can also
  keep two things apart on purpose)

A merge is stored as {member_mal_id: target_mal_id}, where target is any entry of the group.
"""

from __future__ import annotations

import re

AUTO_KEY = "franchise_merges_auto"
MANUAL_KEY = "franchise_merges"
KEEP_SEPARATE = 0  # manual value meaning "don't group this one with anything"
MIN_PREFIX_LEN = 4  # very short titles ("86") only match exactly, never as a prefix

# Things that come AFTER the series name in a title. Order matters: subtitles first.
_SUBTITLE = re.compile(r"\s*[:：]\s+.*$|\s+[-–—]\s+.*$")  # "Name: Subtitle", "Name - Subtitle" (not "Re:ZERO")
_TAIL = re.compile(
    r"\s+(?:the\s+)?(?:movie|film|gekijouban)\b.*$"       # "... Movie", "... The Movie 2"
    r"|\s+(?:season|part|cour)\s*\d+.*$"                  # "... Season 2", "... Part 2"
    r"|\s+\d+(?:st|nd|rd|th)\s+season.*$"                 # "... 2nd Season"
    r"|\s+final\s+season.*$",                             # "... Final Season"
    re.I,
)


def base_title(title: str | None) -> str:
    """The plain series name, lowercased with punctuation removed.

    "The Apothecary Diaries: The Late Lady's Treasure" -> "the apothecary diaries"
    "Go-toubun no Hanayome Movie"                      -> "go toubun no hanayome"
    "Re:ZERO -Starting Life in Another World-"         -> "re zero starting life in another world"
    """
    if not title:
        return ""
    text = _SUBTITLE.sub("", title.strip())
    text = _TAIL.sub("", text)
    text = re.sub(r"[^0-9a-z]+", " ", text.lower())  # anything that isn't a letter/digit -> space
    return text.strip()


def titles_of(thing: dict) -> set[str]:
    """Base titles from both the romaji and the English title (empty ones dropped)."""
    found = {base_title(thing.get("title")), base_title(thing.get("title_english"))}
    found.discard("")
    return found


def match_score(single: set[str], group: set[str]) -> int:
    """How well a lone entry's titles match a group's titles: 0 = no match, higher = better.

    An exact match beats a prefix match ("spy x family code" starts with "spy x family").
    The length of the matched name breaks ties, so the most specific group wins.
    """
    best = 0
    for mine in single:
        for theirs in group:
            if mine == theirs:
                best = max(best, 1000 + len(theirs))
            elif len(theirs) >= MIN_PREFIX_LEN and mine.startswith(theirs + " "):
                best = max(best, len(theirs))
    return best


def auto_merges(entries: list[dict]) -> dict[int, int]:
    """Find lone entries that belong to a bigger group. `entries` are library entries with
    `meta` and `franchise` ({"id", "size", "title", "title_english"} or None).

    Returns {lone_mal_id: target_mal_id}.
    """
    # Group the library by franchise id, collecting every title we know for each group.
    groups: dict[int, dict] = {}
    for entry in entries:
        ref = entry.get("franchise") or {}
        group_id = ref.get("id") or entry["mal_id"]
        group = groups.setdefault(group_id, {"members": [], "titles": set()})
        group["members"].append(entry["mal_id"])
        group["titles"] |= titles_of(entry["meta"]) | titles_of(ref)

    merges: dict[int, int] = {}
    for group_id, group in groups.items():
        if len(group["members"]) != 1:
            continue  # only entries that are alone get moved
        lone_id = group["members"][0]
        lone_entry = next(e for e in entries if e["mal_id"] == lone_id)
        if (lone_entry.get("franchise") or {}).get("size", 1) > 1:
            continue  # AniList already gave it a real group (the rest just isn't in the library)
        mine = titles_of(lone_entry["meta"])
        best_score, best_target = 0, None
        for other_id, other in groups.items():
            if other_id == group_id:
                continue
            score = match_score(mine, other["titles"])
            if score > best_score:
                best_score, best_target = score, other["members"][0]
        if best_target is not None:
            merges[lone_id] = best_target
    return merges


def combined(auto: dict, manual: dict) -> dict[int, int]:
    """Manual choices win over automatic ones. A manual KEEP_SEPARATE removes a merge."""
    result = {int(k): int(v) for k, v in (auto or {}).items()}
    for key, value in (manual or {}).items():
        if int(value) == KEEP_SEPARATE:
            result.pop(int(key), None)
        else:
            result[int(key)] = int(value)
    # Never point at yourself, and never let a target be merged elsewhere too (no chains/loops).
    return {k: v for k, v in result.items() if k != v and v not in result}
