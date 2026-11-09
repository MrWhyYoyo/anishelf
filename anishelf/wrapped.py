"""Anime Wrapped: your year in review, built from the watch log and the library.

Everything is calculated on request (nothing stored), the same way the stats page works.
Dates use the computer's local time, so an episode at 00:30 on 1 January counts for the new year.
"""

from __future__ import annotations

from collections import Counter
from datetime import date

from .logic import ValidationError
from .progression import local_time
from .service import DEFAULT_EPISODE_MINUTES, streaks

MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
MIN_YEAR, MAX_YEAR = 1990, 2100


def parse_year(raw) -> int | None:
    """'2026' -> 2026. Empty -> None (meaning "pick a sensible default")."""
    if raw in (None, ""):
        return None
    text = str(raw)
    if not text.isdigit() or not MIN_YEAR <= int(text) <= MAX_YEAR:
        raise ValidationError(f"year must be a number between {MIN_YEAR} and {MAX_YEAR}")
    return int(text)


def _show(entry: dict, **extra) -> dict:
    """The small bit of an entry the page needs to show a title and cover."""
    meta = entry["meta"]
    return {"mal_id": entry["mal_id"], "title": meta.get("title"), "title_english": meta.get("title_english"),
            "image": meta.get("image"), **extra}


def _plural(n: int, word: str) -> str:
    return f"{n:,} {word}" if n == 1 else f"{n:,} {word}s"


def summary_line(episodes: int, hours: float, completed: int, most_watched: dict | None, top_genre: str | None) -> str:
    """One friendly sentence about the year."""
    if episodes == 0 and completed == 0:
        return "A quiet year on the shelf. Plenty of room for next year."
    # Build the sentence from the pieces that exist, then join them like a person would.
    parts = [f"watched {_plural(episodes, 'episode')} ({hours:g} hours)"]
    if completed:
        parts.append(f"finished {_plural(completed, 'show')}")
    if most_watched:
        parts.append(f"kept coming back to {most_watched['title_english'] or most_watched['title']}")
    if len(parts) == 1:
        sentence = f"You {parts[0]}."
    else:
        sentence = "You " + ", ".join(parts[:-1]) + " and " + parts[-1] + "."
    if top_genre:
        sentence += f" Your genre of the year: {top_genre}."
    return sentence


def build_wrapped(entries: list[dict], log: list[dict], year: int | None = None,
                  today: date | None = None) -> dict:
    """`entries` are service Entry dicts, `log` rows come from db.watch_log()."""
    today = today or date.today()
    by_id = {e["mal_id"]: e for e in entries}

    # 1. Turn the log into local dates once, and find every year that has something in it.
    dated = []  # (local date, mal_id)
    years = set()
    for item in log:
        when = local_time(item["watched_at"])
        if when is None:
            continue
        dated.append((when.date(), item["mal_id"]))
        years.add(when.year)
    for e in entries:
        if e["status"] == "completed" and e["finished_on"]:
            years.add(int(e["finished_on"][:4]))

    # Default: this year if it has data, otherwise the most recent year that does.
    if year is None:
        if today.year in years or not years:
            year = today.year
        else:
            year = max(years)

    # 2. Count this year's episodes per show, per month and per day.
    per_show = Counter()
    per_month = Counter()
    days = set()
    for day, mal_id in dated:
        if day.year != year:
            continue
        per_show[mal_id] += 1
        per_month[day.month] += 1
        days.add(day)

    episodes = sum(per_show.values())
    minutes = 0
    genres = Counter()  # weighted by episodes, so a 24-episode show counts more than a movie
    for mal_id, count in per_show.items():
        entry = by_id.get(mal_id)
        if entry is None:
            minutes += count * DEFAULT_EPISODE_MINUTES
            continue
        minutes += count * (entry["meta"].get("duration_min") or DEFAULT_EPISODE_MINUTES)
        for genre in entry["meta"].get("genres") or []:
            genres[genre] += count
    hours = round(minutes / 60, 1)

    # 3. The highlights.
    most_watched = None
    top_shows = []
    for mal_id, count in per_show.most_common():
        if mal_id in by_id and len(top_shows) < 5:
            top_shows.append(_show(by_id[mal_id], episodes=count))
    if top_shows:
        most_watched = top_shows[0]

    months = [{"month": m, "label": MONTH_NAMES[m - 1][:3], "episodes": per_month[m]} for m in range(1, 13)]
    busiest = None
    if episodes:
        best = max(months, key=lambda m: m["episodes"])  # max keeps the earliest month on a tie
        busiest = {"month": best["month"], "name": MONTH_NAMES[best["month"] - 1], "episodes": best["episodes"]}

    top_genre = None
    if genres:
        name, count = genres.most_common(1)[0]
        top_genre = {"name": name, "episodes": count}

    finished = [e for e in entries
                if e["status"] == "completed" and (e["finished_on"] or "").startswith(f"{year}-")]
    finished.sort(key=lambda e: (e["finished_on"], e["updated_at"]))
    first_finished = _show(finished[0], finished_on=finished[0]["finished_on"]) if finished else None
    last_finished = _show(finished[-1], finished_on=finished[-1]["finished_on"]) if finished else None

    return {
        "year": year,
        "years": sorted(years | {today.year}, reverse=True),
        "has_data": bool(episodes or finished),
        "episodes": episodes,
        "minutes": minutes,
        "hours": hours,
        "shows_watched": len(per_show),
        "days_active": len(days),
        "most_watched": most_watched,
        "top_shows": top_shows,
        "months": months,
        "busiest_month": busiest,
        "longest_streak": streaks(days, today)["longest"],
        "top_genre": top_genre,
        "completed": len(finished),
        "first_finished": first_finished,
        "last_finished": last_finished,
        "summary": summary_line(episodes, hours, len(finished), most_watched, top_genre["name"] if top_genre else None),
    }


def wrapped_for(shelf, raw_year=None) -> dict:
    """Entry point for the /api/wrapped route."""
    return build_wrapped(shelf.library(), shelf.db.watch_log(), parse_year(raw_year))
