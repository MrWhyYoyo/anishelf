"""Taste profile: what your library says about what you like. (GET /api/taste)

Everything comes from data already stored with each library entry (meta + your score +
episodes watched), so this makes NO network requests.

How a show counts ("weight"):
    weight = episode factor x score factor
    episode factor = log2(1 + episodes watched)  -> 12 eps ~ 3.7, 24 ~ 4.6, 100 ~ 6.7
        (a log, so one 500-episode show can't drown out twenty 12-episode ones)
    score factor   = your score / 7               -> a 7 counts as 1.0, a 10 as 1.43, a 3 as 0.43
        (unscored shows count as 1.0, like an average score)
A Completed show with no episodes ticked counts as all its episodes watched.
Plan to watch shows and shows with 0 episodes watched and no score are left out:
you haven't watched them, so they say nothing about your taste yet.
"""

from __future__ import annotations

import collections
import math

NEUTRAL_SCORE = 7          # the score that counts as "1.0"
GEM_GAP = 1.5              # your score at least this far ABOVE MyAnimeList's -> hidden gem
HOT_TAKE_GAP = 1.5         # at least this far BELOW -> hot take
TOP_GENRES = 8
TOP_STUDIOS = 5
TOP_PICKS = 3              # hidden gems / hot takes shown
SEASON_ORDER = ["winter", "spring", "summer", "fall"]


# ---------------------------------------------------------------- weights
def weight(entry: dict) -> float:
    """How much one library entry says about your taste (0 = nothing)."""
    if entry.get("status") == "plan_to_watch":
        return 0.0
    episodes = entry.get("watched_count") or 0
    if episodes == 0 and entry.get("status") == "completed":
        episodes = entry.get("total") or 1  # marked Completed without ticking episodes: you saw them all
    score = entry.get("score")
    if episodes == 0 and not score:
        return 0.0
    # A scored show you watched 0 episodes of (e.g. a rating from memory) still counts as one episode.
    episode_factor = math.log2(1 + max(episodes, 1))
    score_factor = (score / NEUTRAL_SCORE) if score else 1.0
    return episode_factor * score_factor


def _ranked(totals: dict, shows: dict, scores: dict, limit: int) -> list[dict]:
    """Turn {name: weight} into a sorted list with a 0-1 "share" of the biggest one, for bars."""
    ordered = sorted(totals.items(), key=lambda item: (-item[1], item[0]))[:limit]
    biggest = ordered[0][1] if ordered else 1
    out = []
    for name, total in ordered:
        rated = scores.get(name) or []
        out.append({
            "name": name,
            "weight": round(total, 1),
            "share": round(total / biggest, 3) if biggest else 0,
            "shows": shows[name],
            "avg_score": round(sum(rated) / len(rated), 1) if rated else None,
        })
    return out


class _Tally:
    """Adds up weight, show count and your scores per name (one per genre, studio, season...)."""

    def __init__(self):
        self.weight = collections.defaultdict(float)  # missing names start at 0.0
        self.shows = collections.Counter()
        self.scores = collections.defaultdict(list)

    def add(self, name, entry_weight: float, score) -> None:
        if not name:
            return
        self.weight[name] += entry_weight
        self.shows[name] += 1
        if score:
            self.scores[name].append(score)

    def ranked(self, limit: int) -> list[dict]:
        return _ranked(self.weight, self.shows, self.scores, limit)

    def favourite(self) -> dict | None:
        top = self.ranked(1)
        return top[0] if top else None


# ---------------------------------------------------------------- gems and hot takes
def _versus_mal(entry: dict) -> dict | None:
    """Your score next to MyAnimeList's, or None when one of them is missing."""
    meta = entry.get("meta") or {}
    mine, theirs = entry.get("score"), meta.get("mal_score")
    if not mine or not isinstance(theirs, (int, float)) or theirs <= 0:
        return None
    return {
        "mal_id": entry["mal_id"],
        "title": meta.get("title"),
        "title_english": meta.get("title_english"),
        "image": meta.get("image"),
        "score": mine,
        "mal_score": round(float(theirs), 2),
        "diff": round(mine - float(theirs), 2),
    }


# ---------------------------------------------------------------- the profile
def profile(entries: list[dict]) -> dict:
    """Build the taste profile from library entries (shelf.library())."""
    genres, studios, seasons, decades, formats = _Tally(), _Tally(), _Tally(), _Tally(), _Tally()
    counted = 0
    compared = []

    for entry in entries:
        w = weight(entry)
        if w <= 0:
            continue
        counted += 1
        meta = entry.get("meta") or {}
        score = entry.get("score")
        for genre in meta.get("genres") or []:
            genres.add(genre, w, score)
        for studio in meta.get("studios") or []:
            studios.add(studio, w, score)
        if meta.get("season") in SEASON_ORDER:
            seasons.add(meta["season"], w, score)
        year = meta.get("year")
        if isinstance(year, int) and year > 1900:
            decades.add(f"{year // 10 * 10}s", w, score)  # 2017 -> "2010s"
        formats.add(meta.get("type") or "Unknown", w, score)
        pair = _versus_mal(entry)
        if pair:
            compared.append(pair)

    # Average score: yours vs MyAnimeList's, over the shows that have both.
    you_vs_mal = None
    if compared:
        mine = sum(p["score"] for p in compared) / len(compared)
        theirs = sum(p["mal_score"] for p in compared) / len(compared)
        you_vs_mal = {"count": len(compared), "your_avg": round(mine, 2), "mal_avg": round(theirs, 2),
                      "diff": round(mine - theirs, 2)}

    gems = sorted((p for p in compared if p["diff"] >= GEM_GAP), key=lambda p: (-p["diff"], p["mal_id"]))
    hot_takes = sorted((p for p in compared if p["diff"] <= -HOT_TAKE_GAP), key=lambda p: (p["diff"], p["mal_id"]))

    # Format split counts shows (not weight): "60% TV, 25% Movie..." is what people expect to read.
    format_total = sum(formats.shows.values())
    format_split = [{"name": name, "count": count, "share": round(count / format_total, 3)}
                    for name, count in formats.shows.most_common()]

    result = {
        "shows_counted": counted,
        "top_genres": genres.ranked(TOP_GENRES),
        "top_studios": studios.ranked(TOP_STUDIOS),
        "seasons": seasons.ranked(len(SEASON_ORDER)),
        "decades": decades.ranked(10),
        "favourite_season": seasons.favourite(),
        "favourite_decade": decades.favourite(),
        "you_vs_mal": you_vs_mal,
        "hidden_gems": gems[:TOP_PICKS],
        "hot_takes": hot_takes[:TOP_PICKS],
        "format_split": format_split,
    }
    result["summary"] = summary(result)
    return result


def summary(p: dict) -> str:
    """One readable sentence built from the profile ("" when there's nothing to say yet)."""
    if not p["shows_counted"]:
        return ""
    parts = []
    names = [g["name"] for g in p["top_genres"][:2]]
    if names:
        parts.append(f"You lean towards {' and '.join(names)}")
    if p["favourite_decade"]:
        parts.append(f"mostly from the {p['favourite_decade']['name']}")
    sentence = ", ".join(parts)
    versus = p["you_vs_mal"]
    if versus and versus["count"] >= 3:
        gap = versus["diff"]
        if abs(gap) < 0.25:
            tail = "and you score about the same as MyAnimeList"
        elif gap > 0:
            tail = f"and you score {gap:.1f} above MyAnimeList on average"
        else:
            tail = f"and you score {abs(gap):.1f} below MyAnimeList on average"
        sentence = f"{sentence}, {tail}" if sentence else tail.removeprefix("and ").capitalize()
    return f"{sentence}." if sentence else ""


def taste_for(shelf) -> dict:
    """GET /api/taste."""
    return profile(shelf.library())
