"""XP, levels, titles and badges - all calculated from the library, nothing extra stored.

Because XP is derived from your data, it can never get out of sync: unwatching an
episode takes its XP back, importing a backup restores your level exactly.
"""

from __future__ import annotations

import math
from collections import Counter
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------- XP rules
XP_PER_EPISODE = 10
XP_PER_COMPLETED = 50
XP_PER_SCORE = 5
XP_PER_JOURNAL = 15        # anime with notes written
XP_PER_FAV_CHARACTER = 5
XP_PER_VERSUS = 3          # per head-to-head vote
XP_PER_TIER = 2
XP_PER_REWATCH = 30
GAME_BEST_XP = 15          # a new personal best in any mini game
GAME_XP_DAILY_CAP = 60     # ...but at most this much per day, so replaying can't farm levels
XP_PER_CHAPTER = 2         # manga (AniShelf 1.15): a chapter is shorter than an episode
XP_PER_MANGA_COMPLETED = 40

# Level L needs 50 * L * (L - 1) total XP: L2 = 100, L3 = 300, L5 = 1000, L10 = 4500, L20 = 19000
TITLES = [
    (1, "Fresh Viewer"),
    (3, "Weekend Binger"),
    (5, "Episode Hunter"),
    (8, "Seasoned Watcher"),
    (12, "Otaku"),
    (16, "Anime Connoisseur"),
    (20, "Sensei"),
    (25, "Living Legend"),
    (30, "Ascended"),
]


def xp_for_level(level: int) -> int:
    """Total XP needed to reach a level."""
    return 50 * level * (level - 1)


def level_for_xp(xp: int) -> int:
    """Inverse of xp_for_level: solve 50 L (L - 1) <= xp for the largest whole L."""
    if xp <= 0:
        return 1
    level = int((1 + math.sqrt(1 + 4 * xp / 50)) / 2)
    # guard against floating-point rounding at exact boundaries
    while xp_for_level(level + 1) <= xp:
        level += 1
    while level > 1 and xp_for_level(level) > xp:
        level -= 1
    return level


def title_for_level(level: int) -> str:
    return [t for lvl, t in TITLES if lvl <= level][-1]


def next_title(level: int) -> dict | None:
    for lvl, title in TITLES:
        if lvl > level:
            return {"level": lvl, "title": title}
    return None


# ---------------------------------------------------------------- badges
BADGES = [
    # id, icon, name, description, metric key, goal
    ("first_steps", "👣", "First Steps", "Watch your first episode", "episodes", 1),
    ("century", "💯", "Century", "Watch 100 episodes", "episodes", 100),
    ("marathoner", "🏃", "Marathoner", "Watch 1,000 episodes", "episodes", 1000),
    ("first_finish", "🏁", "First Finish", "Complete an anime", "completed", 1),
    ("collector", "📚", "Collector", "Complete 10 anime", "completed", 10),
    ("completionist", "🏆", "Completionist", "Complete 50 anime", "completed", 50),
    ("long_haul", "🚂", "Long Haul", "Complete a series with 50+ episodes", "long_series", 1),
    ("movie_night", "🍿", "Movie Night", "Complete 3 movies", "movies", 3),
    ("critic", "⭐", "Critic", "Score 10 anime", "scored", 10),
    ("ranker", "⚔️", "Ranker", "Vote in 25 head-to-head battles", "versus", 25),
    ("tier_master", "🗂️", "Tier Master", "Place 10 anime in your tier list", "tiers", 10),
    ("journalist", "✍️", "Journalist", "Write notes for 5 anime", "journals", 5),
    ("heart_collector", "💖", "Heart Collector", "Favourite 5 anime", "favorites", 5),
    ("explorer", "🧭", "Genre Explorer", "Watch anime from 10 different genres", "genres", 10),
    ("on_fire", "🔥", "On Fire", "Watch episodes 7 days in a row", "streak", 7),
    ("planner", "📝", "Planner", "Put 10 anime on your watch list", "planned", 10),
    # --- AniShelf 1.1: badges based on *when* you watch (from the watch log)
    ("night_owl", "🦉", "Night Owl", "Log an episode between 02:00 and 05:00", "night_owl", 1),
    ("marathon", "🎬", "Marathon", "Watch 10 episodes in one day", "best_day", 10),
    ("loyal", "🛡️", "Loyal", "Complete every main-story season of a franchise with 5+ seasons", "loyal", 1),
    ("speedrunner", "⚡", "Speedrunner", "Finish a 12+ episode show within 3 days of starting it", "speedruns", 1),
    ("comeback", "🔁", "Comeback", "Return to a show after a break of 30+ days", "comebacks", 1),
    ("perfect_ten", "🎯", "Perfect Ten", "Give an anime a 10 out of 10", "perfect_scores", 1),
]

# Secret badges stay hidden ("Secret badge" / "Keep watching...") until you earn them.
# A separate set (instead of a 7th tuple field) keeps the BADGES tuples the same shape as before.
SECRET_BADGES = {"night_owl", "comeback"}
SECRET_NAME = "Secret badge"
SECRET_DESCRIPTION = "Keep watching..."

NIGHT_OWL_HOURS = (2, 3, 4)   # 02:00 up to (not including) 05:00, local time
SPEEDRUN_MIN_EPISODES = 12
SPEEDRUN_MAX_DAYS = 3
COMEBACK_GAP_DAYS = 30
LOYAL_MIN_SEASONS = 5


def metrics(entries: list[dict], longest_streak: int) -> dict:
    """Count everything XP and badges are based on. `entries` are service Entry dicts."""
    genres = set()
    for e in entries:
        if e["status"] != "plan_to_watch" and e["watched_count"] > 0:
            genres.update(e["meta"].get("genres") or [])
    completed = [e for e in entries if e["status"] == "completed"]
    return {
        "episodes": sum(e["watched_count"] for e in entries),
        "completed": len(completed),
        "long_series": sum(1 for e in completed if (e["total"] or 0) >= 50),
        "movies": sum(1 for e in completed if e["meta"].get("type") == "Movie"),
        "scored": sum(1 for e in entries if e["score"]),
        "versus": sum(e["matches"] for e in entries) // 2,  # each battle counts for 2 anime
        "tiers": sum(1 for e in entries if e["tier"]),
        "journals": sum(1 for e in entries if (e["notes"] or "").strip()),
        "fav_characters": sum(1 for e in entries if (e["fav_character"] or "").strip()),
        "favorites": sum(1 for e in entries if e["favorite"]),
        "rewatches": sum(e["rewatch_count"] for e in entries),
        "genres": len(genres),
        "streak": longest_streak,
        "planned": sum(1 for e in entries if e["status"] == "plan_to_watch"),
        "perfect_scores": sum(1 for e in entries if e["score"] == 10),
    }


def local_time(watched_at: str) -> datetime | None:
    """A watch_log timestamp (stored in UTC) -> the same moment in this computer's local time."""
    try:
        return datetime.fromisoformat(watched_at).astimezone()
    except (TypeError, ValueError):
        return None


def activity_metrics(log: list[dict], entries: list[dict]) -> dict:
    """Badge numbers that depend on WHEN episodes were watched (the watch log), not just how many.

    `log` rows look like {"mal_id": 1, "episode": 3, "watched_at": "2026-11-04T18:00:00+00:00"}.
    """
    night_owl = 0
    per_day = Counter()      # local date -> episodes that day
    times_per_show = {}      # mal_id -> list of local datetimes
    for item in log:
        when = local_time(item["watched_at"])
        if when is None:
            continue
        if when.hour in NIGHT_OWL_HOURS:
            night_owl += 1
        per_day[when.date()] += 1
        times_per_show.setdefault(item["mal_id"], []).append(when)

    # Speedrunner: a completed show with 12+ episodes, all logged within 3 days of the first one.
    speedruns = 0
    for e in entries:
        if e["status"] != "completed" or (e["total"] or 0) < SPEEDRUN_MIN_EPISODES:
            continue
        times = times_per_show.get(e["mal_id"], [])
        if len(times) < SPEEDRUN_MIN_EPISODES:
            continue  # big bulk edits aren't logged, so we can't prove it was a speedrun
        if max(times) - min(times) <= timedelta(days=SPEEDRUN_MAX_DAYS):
            speedruns += 1

    # Comeback: two episodes of the same show logged 30+ days apart, with nothing in between.
    comebacks = 0
    for times in times_per_show.values():
        times.sort()
        for earlier, later in zip(times, times[1:]):
            if later - earlier >= timedelta(days=COMEBACK_GAP_DAYS):
                comebacks += 1
                break  # one comeback per show is enough

    # Loyal: every main-story entry of a 5+ entry franchise is completed. The franchise "size"
    # comes from the library's season grouping (franchise.py), so this is an approximation.
    completed_per_franchise = Counter()
    franchise_size = {}
    for e in entries:
        ref = e.get("franchise")
        if not ref:
            continue
        franchise_size[ref["id"]] = ref.get("size") or 1
        if e["status"] == "completed":
            completed_per_franchise[ref["id"]] += 1
    loyal = 0
    for franchise_id, size in franchise_size.items():
        if size >= LOYAL_MIN_SEASONS and completed_per_franchise[franchise_id] >= size:
            loyal += 1

    return {
        "night_owl": night_owl,
        "best_day": max(per_day.values()) if per_day else 0,
        "speedruns": speedruns,
        "comebacks": comebacks,
        "loyal": loyal,
    }


# ---------------------------------------------------------------- stored bonus XP
# Quest XP and mini-game XP are the only XP that is *stored* (in the settings table), because
# "you set a personal best on Tuesday" can't be recalculated from the library later.
def clean_quest_log(value) -> dict:
    """Validate {"2026-11-06": {"watch_2": 20, ...}} from a backup file; drop anything odd."""
    clean = {}
    if not isinstance(value, dict):
        return clean
    for day, quests in value.items():
        if not _is_iso_date(day) or not isinstance(quests, dict):
            continue
        good = {}
        for quest_id, xp in quests.items():
            if isinstance(quest_id, str) and isinstance(xp, int) and not isinstance(xp, bool) and 0 <= xp <= 500:
                good[quest_id[:40]] = xp
        if good:
            clean[day] = good
    return clean


def clean_game_xp_log(value, daily_cap: int = GAME_XP_DAILY_CAP) -> dict:
    """Validate {"2026-11-06": 45} from a backup file; each day is capped again for safety."""
    clean = {}
    if not isinstance(value, dict):
        return clean
    for day, xp in value.items():
        if _is_iso_date(day) and isinstance(xp, int) and not isinstance(xp, bool) and xp > 0:
            clean[day] = min(xp, daily_cap)
    return clean


def _is_iso_date(text) -> bool:
    try:
        date.fromisoformat(str(text))
        return True
    except ValueError:
        return False


def profile(m: dict) -> dict:
    breakdown = [
        ("Episodes watched", m["episodes"] * XP_PER_EPISODE),
        ("Anime completed", m["completed"] * XP_PER_COMPLETED),
        ("Anime scored", m["scored"] * XP_PER_SCORE),
        ("Journal entries", m["journals"] * XP_PER_JOURNAL),
        ("Favourite characters", m["fav_characters"] * XP_PER_FAV_CHARACTER),
        ("Versus battles", m["versus"] * XP_PER_VERSUS),
        ("Tier placements", m["tiers"] * XP_PER_TIER),
        ("Rewatches", m["rewatches"] * XP_PER_REWATCH),
        # stored bonus XP (0 when the caller didn't add these keys)
        ("Daily quests", m.get("quest_xp", 0)),
        ("Mini games", m.get("game_xp", 0)),
        # manga chapters + finished manga (0 when the caller didn't add these keys)
        ("Manga", m.get("manga_chapters", 0) * XP_PER_CHAPTER + m.get("manga_completed", 0) * XP_PER_MANGA_COMPLETED),
    ]
    xp = sum(points for _, points in breakdown)
    level = level_for_xp(xp)
    start, end = xp_for_level(level), xp_for_level(level + 1)
    badges = []
    for badge_id, icon, name, description, key, goal in BADGES:
        value = m.get(key, 0)  # .get: activity metrics are optional (older callers don't add them)
        earned = value >= goal
        secret = badge_id in SECRET_BADGES
        if secret and not earned:
            # hide what it is until it's earned (the toast shows the real name when it unlocks)
            name, description, icon = SECRET_NAME, SECRET_DESCRIPTION, "❔"
        badges.append({
            "id": badge_id, "icon": icon, "name": name, "description": description,
            "earned": earned, "progress": min(value, goal), "goal": goal, "secret": secret,
        })
    return {
        "level": level,
        "title": title_for_level(level),
        "xp": xp,
        "level_xp": start,
        "next_level_xp": end,
        "progress": round((xp - start) / (end - start), 4),
        "next_title": next_title(level),
        "breakdown": [{"label": label, "xp": points} for label, points in breakdown],
        "badges": badges,
    }
