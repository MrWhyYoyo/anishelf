"""Mini-game high scores.

Scores live in the `settings` table under one key ("game_scores") as a JSON dict:
    {"cover-reveal": {"best": 820, "plays": 4, "last": 610, "last_played": "2026-11-04T18:00:00+00:00"}}

Some games count "points" (higher is better); others count tries or deaths (lower is better).

A new personal best also gives a little XP (GAME_BEST_XP), at most GAME_XP_DAILY_CAP per day.
That XP is stored per local date under the "game_xp" setting: {"2026-11-06": 45}.
"""

from __future__ import annotations

from datetime import date

from .db import Database, utc_now
from .logic import ValidationError
from .progression import GAME_BEST_XP, GAME_XP_DAILY_CAP  # the XP rules live with the other XP rules

SETTING_KEY = "game_scores"
XP_SETTING_KEY = "game_xp"

# game id -> rules. "max" stops a typo (or a bug) from saving a silly number.
GAMES: dict[str, dict] = {
    "cover-reveal":    {"lower_is_better": False, "max": 10_000},  # points over 10 rounds
    "higher-lower":    {"lower_is_better": False, "max": 1_000},   # longest streak
    "return-by-death": {"lower_is_better": True,  "max": 1_000},   # deaths before reaching the end
    "odm-swing":       {"lower_is_better": False, "max": 100_000}, # metres travelled
    "operation-strix": {"lower_is_better": True,  "max": 20},      # guesses needed
    "zoltraak":        {"lower_is_better": False, "max": 10_000},  # demons defeated
    "whos-that-character": {"lower_is_better": False, "max": 10_000},  # points ("pts")
    "devil-arena":     {"lower_is_better": False, "max": 1_000_000},   # kills + wave bonus ("pts")
    "cover-cascade":   {"lower_is_better": False, "max": 10_000_000},  # match-3 points ("pts")
    "broom-courier":   {"lower_is_better": False, "max": 10_000_000},  # distance + pickups ("pts")
}


def game_xp_total(db: Database) -> int:
    """All the XP ever earned from mini-game personal bests (shown as "Mini games" on the profile)."""
    per_day = db.setting(XP_SETTING_KEY) or {}
    total = 0
    for xp in per_day.values():
        total += xp
    return total


def game_xp_today(db: Database, today: date | None = None) -> int:
    today = today or date.today()
    return (db.setting(XP_SETTING_KEY) or {}).get(today.isoformat(), 0)


def _is_better(new: int, old: int | None, lower_is_better: bool) -> bool:
    """True when `new` beats the stored best (or there is no best yet)."""
    if old is None:
        return True
    return new < old if lower_is_better else new > old


def validate_score(game_id: str, score) -> int:
    rules = GAMES.get(game_id)
    if rules is None:
        raise ValidationError("Unknown game")
    # bool is a subclass of int in Python (True == 1), so rule it out explicitly.
    if isinstance(score, bool) or not isinstance(score, int):
        raise ValidationError("Score must be a whole number")
    if not 0 <= score <= rules["max"]:
        raise ValidationError(f"Score must be between 0 and {rules['max']}")
    return score


class GameScores:
    def __init__(self, db: Database):
        self.db = db

    def all(self) -> dict:
        stored = self.db.setting(SETTING_KEY) or {}
        result = {}
        for game_id, rules in GAMES.items():
            record = stored.get(game_id) or {}
            result[game_id] = {
                "best": record.get("best"),
                "plays": record.get("plays", 0),
                "last": record.get("last"),
                "last_played": record.get("last_played"),
                "best_at": record.get("best_at"),
                "lower_is_better": rules["lower_is_better"],
            }
        return result

    def submit(self, game_id: str, score, today: date | None = None) -> dict:
        score = validate_score(game_id, score)
        today = today or date.today()  # the computer's local date, so "per day" means your day
        lower = GAMES[game_id]["lower_is_better"]
        # Read, change and write under the database's write lock, so two saves at the same
        # moment can't both read the old value and overwrite each other ("lost update").
        # It's an RLock, so set_setting() taking the same lock again inside is fine.
        with self.db._write_lock:
            stored = self.db.setting(SETTING_KEY) or {}
            record = stored.get(game_id) or {}

            new_best = _is_better(score, record.get("best"), lower)
            now = utc_now()
            record = {
                "best": score if new_best else record["best"],
                "plays": record.get("plays", 0) + 1,
                "last": score,
                "last_played": now,
                # when the best was set: the "set a personal best" daily quest reads this
                "best_at": now if new_best else record.get("best_at"),
            }
            stored[game_id] = record
            self.db.set_setting(SETTING_KEY, stored)

            xp_awarded = 0
            if new_best:
                xp_awarded = self._award_xp(today)
        return {"game": game_id, **record, "new_best": new_best, "lower_is_better": lower,
                "xp_awarded": xp_awarded}

    def _award_xp(self, today: date) -> int:
        """Give GAME_BEST_XP, but never more than GAME_XP_DAILY_CAP in one day. Returns what was given."""
        per_day = self.db.setting(XP_SETTING_KEY) or {}
        key = today.isoformat()
        already = per_day.get(key, 0)
        room_left = max(0, GAME_XP_DAILY_CAP - already)
        award = min(GAME_BEST_XP, room_left)
        if award > 0:
            per_day[key] = already + award
            self.db.set_setting(XP_SETTING_KEY, per_day)
        return award
