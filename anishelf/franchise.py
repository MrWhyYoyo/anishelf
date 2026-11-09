"""Group the separate MyAnimeList/AniList entries of one show (Season 1, 2, 3, sequel movies)
into a single series.

AniList links entries with SEQUEL / PREQUEL relations. We walk that chain in both directions,
but only through "main story" formats (TV, TV_SHORT, ONA, MOVIE) - spin-offs, OVAs, recaps and
alternative versions are deliberately left out so a series doesn't swallow its side material.
"""

from __future__ import annotations

import re

FOLLOW_RELATIONS = {"SEQUEL", "PREQUEL"}
STORY_FORMATS = {"TV", "TV_SHORT", "ONA", "MOVIE"}
EPISODIC_FORMATS = {"TV", "TV_SHORT", "ONA"}
MAX_NODES = 15  # hard stop: even very long franchises rarely have more main entries


def node_from_media(media: dict) -> dict | None:
    """AniList Media (with relations) -> compact node. None without a MyAnimeList id."""
    mal_id = media.get("idMal")
    if not isinstance(mal_id, int) or mal_id < 1:
        return None
    title = media.get("title") or {}
    start = media.get("startDate") or {}
    cover = media.get("coverImage") or {}
    neighbours = []
    for edge in ((media.get("relations") or {}).get("edges")) or []:
        node = edge.get("node") or {}
        if (
            edge.get("relationType") in FOLLOW_RELATIONS
            and node.get("type") == "ANIME"
            and node.get("format") in STORY_FORMATS
            and isinstance(node.get("idMal"), int)
        ):
            neighbours.append(node["idMal"])
    year, month, day = start.get("year"), start.get("month"), start.get("day")
    return {
        "mal_id": mal_id,
        "title": title.get("romaji") or title.get("english") or "Untitled",
        "title_english": title.get("english"),
        "format": media.get("format"),
        "episodes": media.get("episodes") if isinstance(media.get("episodes"), int) and media["episodes"] > 0 else None,
        "status": media.get("status"),
        "year": year,
        # sortable start date; unknown parts sort last within their year
        "start": f"{year or 9999:04d}-{month or 12:02d}-{day or 31:02d}",
        "image": cover.get("extraLarge") or cover.get("large"),
        "neighbours": neighbours,
    }


def walk(start_id: int, get_node, max_nodes: int = MAX_NODES) -> list[dict]:
    """Breadth-first walk over SEQUEL/PREQUEL links. `get_node(mal_id)` returns a node or None."""
    seen: set[int] = set()
    queue = [start_id]
    nodes: list[dict] = []
    while queue and len(nodes) < max_nodes:
        mal_id = queue.pop(0)
        if mal_id in seen:
            continue
        seen.add(mal_id)
        node = get_node(mal_id)
        if not node:
            continue
        if node["format"] not in STORY_FORMATS and mal_id != start_id:
            continue
        nodes.append(node)
        queue.extend(n for n in node["neighbours"] if n not in seen)
    return nodes


SEASON_NUMBER = re.compile(r"\bSeason\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+Season\b", re.I)
PART_NUMBER = re.compile(r"\b(?:Part|Cour)\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+(?:Part|Cour)\b", re.I)
FINAL_SEASON = re.compile(r"\bFinal\s+Season\b|\bThe\s+Final\b", re.I)


def season_label(title: str, previous_season: int) -> tuple[str, int]:
    """Name a season the way fans do, from its official title.

    "Attack on Titan Season 3 Part 2" -> "Season 3 Part 2", "... Final Season" -> "Final Season",
    "Sousou no Frieren 3rd Season" -> "Season 3". No hint in the title -> the next number.
    Returns (label, season number used for the next entry).
    """
    part = PART_NUMBER.search(title)
    part_text = f" Part {part.group(1) or part.group(2)}" if part else ""
    if FINAL_SEASON.search(title):
        return "Final Season" + part_text, previous_season + (0 if part else 1)
    number = SEASON_NUMBER.search(title)
    if number:
        n = int(number.group(1) or number.group(2))
        return f"Season {n}{part_text}", n
    if part:  # "Part 2" of the season before it
        return f"Season {max(previous_season, 1)}{part_text}", max(previous_season, 1)
    return f"Season {previous_season + 1}", previous_season + 1


def order(nodes: list[dict]) -> list[dict]:
    """Chronological order + labels ("Season 1", "Season 3 Part 2", "Final Season", "Movie")."""
    ordered = sorted(nodes, key=lambda n: (n["start"], n["mal_id"]))
    season = 0
    out = []
    for node in ordered:
        if node["format"] in EPISODIC_FORMATS:
            title = " / ".join(t for t in (node.get("title_english"), node.get("title")) if t)
            label, season = season_label(title, season)
        elif node["format"] == "MOVIE":
            label = "Movie"
        else:
            label = node["format"] or "Special"
        out.append({k: v for k, v in node.items() if k != "neighbours"} | {"label": label})
    return out
