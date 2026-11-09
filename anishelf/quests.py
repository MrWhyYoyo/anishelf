"""Daily quests: three small goals a day that give bonus XP.

How it works:
- Every day, 3 quests are drawn from QUEST_POOL. The random generator is seeded with the date
  ("2026-11-06"), so the draw is the same all day (and on every reload) but changes tomorrow.
- Progress is read from your real data: today's watch_log, the library and mini-game records.
  Nothing has to be "ticked" by hand.
- When a quest reaches its goal it is completed automatically, and its XP is saved in the
  settings table under "quest_xp": {"2026-11-06": {"watch_2": 20}}. Saving it means the XP stays
  even if you later unwatch an episode, and it shows up as "Daily quests" in the XP breakdown.

"Today" always means the server computer's local date (the same computer you watch on).
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta

from .games import SETTING_KEY as GAME_SCORES_KEY
from .progression import local_time

SETTING_KEY = "quest_xp"
QUESTS_PER_DAY = 3
REVISIT_DAYS = 7  # "a show you haven't touched in 7+ days"

# id -> what the quest says, how much is needed, and the XP it gives.
# The functions that measure progress are in PROGRESS below (same ids).
QUEST_POOL = {
    "watch_2":     {"text": "Watch 2 episodes today", "goal": 2, "xp": 20},
    "watch_5":     {"text": "Watch 5 episodes today", "goal": 5, "xp": 40},
    "two_shows":   {"text": "Watch episodes of 2 different shows", "goal": 2, "xp": 25},
    "revisit":     {"text": "Watch an episode of a show you haven't touched in 7+ days", "goal": 1, "xp": 30},
    "rate_or_tier": {"text": "Rate or tier a show", "goal": 1, "xp": 15},
    "game_best":   {"text": "Set a personal best in any mini game", "goal": 1, "xp": 20},
    "finish_show": {"text": "Finish a show", "goal": 1, "xp": 40},
    "plan_add":    {"text": "Add a show to Want to watch", "goal": 1, "xp": 10},
}


def draw_quests(day: date) -> list[str]:
    """The quest ids for one day. Same date in -> same quests out (deterministic)."""
    # A string seed is hashed in a fixed way by `random`, so this works the same on every run.
    rng = random.Random(f"anishelf-quests-{day.isoformat()}")
    return rng.sample(sorted(QUEST_POOL), QUESTS_PER_DAY)


def _is_today(utc_text: str | None, today: date) -> bool:
    """True when a stored UTC timestamp falls on `today` in local time."""
    when = local_time(utc_text) if utc_text else None
    return when is not None and when.date() == today


# ---------------------------------------------------------------- progress measurers
# Each one gets the same `ctx` dict (built once in build_context) and returns a whole number.
def _watch_count(ctx: dict) -> int:
    return len(ctx["today_log"])


def _two_shows(ctx: dict) -> int:
    shows = set()
    for item in ctx["today_log"]:
        shows.add(item["mal_id"])
    return len(shows)


def _revisit(ctx: dict) -> int:
    """Shows watched today whose last episode BEFORE today was 7+ days ago."""
    cutoff = ctx["today"] - timedelta(days=REVISIT_DAYS)
    count = 0
    watched_today = {item["mal_id"] for item in ctx["today_log"]}
    for mal_id in watched_today:
        last_before = ctx["last_before_today"].get(mal_id)
        if last_before is not None and last_before <= cutoff:
            count += 1
    return count


def _rate_or_tier(ctx: dict) -> int:
    # updated_at changes on any edit, so this is "a scored or tiered show you touched today".
    count = 0
    for e in ctx["entries"]:
        if (e["score"] or e["tier"]) and _is_today(e["updated_at"], ctx["today"]):
            count += 1
    return count


def _game_best(ctx: dict) -> int:
    count = 0
    for record in ctx["game_records"].values():
        if isinstance(record, dict) and _is_today(record.get("best_at"), ctx["today"]):
            count += 1
    return count


def _finish_show(ctx: dict) -> int:
    today_text = ctx["today"].isoformat()
    return sum(1 for e in ctx["entries"] if e["status"] == "completed" and e["finished_on"] == today_text)


def _plan_add(ctx: dict) -> int:
    return sum(1 for e in ctx["entries"]
               if e["status"] == "plan_to_watch" and _is_today(e["added_at"], ctx["today"]))


PROGRESS = {
    "watch_2": _watch_count,
    "watch_5": _watch_count,
    "two_shows": _two_shows,
    "revisit": _revisit,
    "rate_or_tier": _rate_or_tier,
    "game_best": _game_best,
    "finish_show": _finish_show,
    "plan_add": _plan_add,
}


class QuestBook:
    """Works out today's quests for an AniShelf service and stores the XP they earn."""

    def __init__(self, shelf):
        self.shelf = shelf
        self.db = shelf.db

    def build_context(self, today: date) -> dict:
        # Only the last few weeks of the log are needed (today + the "7 days ago" check).
        since = datetime.combine(today - timedelta(days=60), datetime.min.time()).astimezone()
        today_log = []
        last_before_today = {}  # mal_id -> local date of the latest episode before today
        for item in self.db.watch_log(since.isoformat()):
            when = local_time(item["watched_at"])
            if when is None:
                continue
            day = when.date()
            if day == today:
                today_log.append(item)
            elif day < today:
                previous = last_before_today.get(item["mal_id"])
                if previous is None or day > previous:
                    last_before_today[item["mal_id"]] = day
        return {
            "today": today,
            "today_log": today_log,
            "last_before_today": last_before_today,
            "entries": self.shelf.library(),
            "game_records": self.db.setting(GAME_SCORES_KEY) or {},
        }

    def today(self, today: date | None = None) -> dict:
        """Today's 3 quests with progress. Newly finished quests are saved (XP awarded) here."""
        today = today or date.today()
        ctx = self.build_context(today)
        key = today.isoformat()

        # Read-change-write under the database lock so two requests can't award twice.
        with self.db._write_lock:
            claimed_log = self.db.setting(SETTING_KEY) or {}
            claimed_today = dict(claimed_log.get(key) or {})
            quests = []
            for quest_id in draw_quests(today):
                rule = QUEST_POOL[quest_id]
                progress = PROGRESS[quest_id](ctx)
                if progress >= rule["goal"] and quest_id not in claimed_today:
                    claimed_today[quest_id] = rule["xp"]  # completed: lock in the XP
                done = quest_id in claimed_today
                quests.append({
                    "id": quest_id,
                    "text": rule["text"],
                    # once done, show it as full even if an episode was unwatched later
                    "progress": rule["goal"] if done else min(progress, rule["goal"]),
                    "goal": rule["goal"],
                    "done": done,
                    "xp": rule["xp"],
                })
            if claimed_today != (claimed_log.get(key) or {}):
                claimed_log[key] = claimed_today
                self.db.set_setting(SETTING_KEY, claimed_log)

        return {
            "date": key,
            "quests": quests,
            "xp_today": sum(claimed_today.values()),
            "xp_total": total_quest_xp(self.db),
        }


def total_quest_xp(db) -> int:
    """All quest XP ever earned (the "Daily quests" line on the profile)."""
    total = 0
    for quests in (db.setting(SETTING_KEY) or {}).values():
        for xp in quests.values():
            total += xp
    return total
