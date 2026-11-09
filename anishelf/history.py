"""Watch history features: the watch diary, rewatch tracking and score predictions.

Everything here works on top of the existing library table:
- the diary lives in its own `diary` table,
- rewatch mode uses three extra library columns (rewatching, rewatch_watched),
- predictions use one extra library column (predicted_score),
- the watch_log gets a `rewatch` column (0 = first watch, N = rewatch number N),
  so episodes from a rewatch count in the stats (activity, streaks) too.

The schema changes are additive and safe to run every time the app starts.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from .logic import ValidationError, next_episode

MOODS = ("hyped", "moved", "cozy", "mind-blown", "meh")
MAX_DIARY_TEXT = 280
MAX_DIARY_ROWS = 2000           # a hard cap on how many notes one GET returns
PREDICT_STATUSES = ("plan_to_watch", "watching")
PREDICT_MAX_WATCHED = 2         # you can still predict after 0, 1 or 2 episodes


def utc_now() -> str:
    # Same format as db.utc_now (copied to avoid a circular import: db.py imports this module)
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ====================================================================== schema
DIARY_SCHEMA = """
CREATE TABLE IF NOT EXISTS diary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    mal_id     INTEGER NOT NULL,
    text       TEXT    NOT NULL DEFAULT '',
    mood       TEXT,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_time ON diary (created_at);
CREATE INDEX IF NOT EXISTS idx_diary_anime ON diary (mal_id);
"""


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    """The column names a table has right now."""
    # PRAGMA table_info returns one row per column; index 1 is the column's name
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _add_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """ALTER TABLE ... ADD COLUMN, but only if the column is missing (so it's safe to repeat)."""
    if column not in _columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def upgrade_schema(conn: sqlite3.Connection) -> None:
    """Bring an older database up to date. Never deletes or rewrites existing data."""
    conn.executescript(DIARY_SCHEMA)
    _add_column(conn, "library", "rewatching", "INTEGER NOT NULL DEFAULT 0")
    _add_column(conn, "library", "rewatch_watched", "TEXT NOT NULL DEFAULT '[]'")
    _add_column(conn, "library", "predicted_score", "INTEGER")
    _add_column(conn, "watch_log", "rewatch", "INTEGER NOT NULL DEFAULT 0")


# ====================================================================== entry fields
def can_predict(status: str, watched_count: int) -> bool:
    """Predictions only make sense before you really know the show."""
    return status in PREDICT_STATUSES and watched_count <= PREDICT_MAX_WATCHED


def entry_extras(row: dict, total: int | None) -> dict:
    """The extra Entry fields this module adds (used by AniShelf.build_entry)."""
    rewatching = bool(row.get("rewatching"))
    # Only show rewatch progress while a rewatch is running
    rewatch_watched = sorted(row.get("rewatch_watched") or []) if rewatching else []
    count = len(rewatch_watched)
    progress = None
    if rewatching and total:
        progress = round(min(count / total, 1.0), 4)
    return {
        "rewatching": rewatching,
        "rewatch_number": (row.get("rewatch_count") or 0) + 1 if rewatching else None,
        "rewatch_watched": rewatch_watched,
        "rewatch_watched_count": count,
        "rewatch_next_episode": next_episode(rewatch_watched, total) if rewatching else None,
        "rewatch_progress": progress,
        "predicted_score": row.get("predicted_score"),
        "can_predict": can_predict(row["status"], len(row["watched"])),
    }


# ====================================================================== predictions
def check_prediction(clean: dict, row: dict) -> None:
    """Setting a prediction is only allowed for Want to watch / Watching with 0-2 episodes."""
    if clean.get("predicted_score") is None:
        return  # not changing it, or clearing it (always allowed)
    status = clean.get("status", row["status"])
    if not can_predict(status, len(row["watched"])):
        raise ValidationError(
            "You can predict a score only for Want to watch or Watching shows with at most 2 episodes watched"
        )


def prediction_summary(entries: list[dict]) -> dict:
    """How close were my predictions? Uses every entry that has both a prediction and a score."""
    differences = []
    for entry in entries:
        predicted = entry.get("predicted_score")
        actual = entry.get("score")
        if predicted and actual:
            differences.append(actual - predicted)  # positive = liked it more than expected
    if not differences:
        return {"count": 0, "avg_abs_error": None, "avg_diff": None, "exact": 0}
    total_abs = 0
    for diff in differences:
        total_abs += abs(diff)
    return {
        "count": len(differences),
        "avg_abs_error": round(total_abs / len(differences), 2),
        "avg_diff": round(sum(differences) / len(differences), 2),
        "exact": differences.count(0),
    }


# ====================================================================== rewatch
def episode_target(body: dict, row: dict) -> str:
    """Which episode set an episode action changes: "watch" (first watch) or "rewatch".

    Without a "target", it follows the show's mode: while rewatching, the episode buttons
    (and Home's +1) track the rewatch; otherwise the first watch, exactly like before.
    """
    target = body.get("target")
    if target is None:
        return "rewatch" if row.get("rewatching") else "watch"
    if target not in ("watch", "rewatch"):
        raise ValidationError('target must be "watch" or "rewatch"')
    if target == "rewatch" and not row.get("rewatching"):
        raise ValidationError("Start a rewatch first")
    return target


class History:
    """Database work for rewatches and the diary. Uses the app's Database for connections."""

    def __init__(self, db):
        self.db = db

    # ------------------------------------------------------------ rewatch
    def save_rewatch(self, row: dict, watched: set[int], total: int | None, log_new: bool) -> tuple[dict, int | None]:
        """Save the rewatch episode set. Returns (row, finished_number or None).

        When every episode is rewatched, the rewatch ends by itself: rewatch_count goes up by
        one and the rewatch set is cleared. The first watch (watched, finished_on) is never touched.
        """
        mal_id = row["mal_id"]
        number = (row.get("rewatch_count") or 0) + 1
        before = set(row.get("rewatch_watched") or [])
        added = sorted(watched - before)
        removed = sorted(before - watched)
        finished = bool(total) and len(watched) >= total
        now = utc_now()

        with self.db._write_lock, self.db.connect() as conn:  # the lock stops two clicks racing
            if finished:
                conn.execute(
                    "UPDATE library SET rewatching = 0, rewatch_watched = '[]', rewatch_count = ?, "
                    "updated_at = ? WHERE mal_id = ?",
                    (number, now, mal_id),
                )
            else:
                conn.execute(
                    "UPDATE library SET rewatch_watched = ?, updated_at = ? WHERE mal_id = ?",
                    (json.dumps(sorted(watched)), now, mal_id),
                )
            if log_new and added:
                rows = []
                for ep in added:
                    rows.append((mal_id, ep, now, number))
                conn.executemany(
                    "INSERT INTO watch_log (mal_id, episode, watched_at, rewatch) VALUES (?, ?, ?, ?)", rows
                )
            for ep in removed:
                # Undo only the latest log line of this rewatch for that episode
                conn.execute(
                    "DELETE FROM watch_log WHERE id = (SELECT MAX(id) FROM watch_log "
                    "WHERE mal_id = ? AND episode = ? AND rewatch = ?)",
                    (mal_id, ep, number),
                )
        return self.db.get(mal_id), (number if finished else None)

    def rewatch_action(self, row: dict, action) -> dict:
        """start / finish / cancel a rewatch. Returns the updated row."""
        mal_id = row["mal_id"]
        if action == "start":
            if row["status"] != "completed":
                raise ValidationError("Only completed anime can be rewatched")
            if row.get("rewatching"):
                raise ValidationError("You're already rewatching this")
            sql = "UPDATE library SET rewatching = 1, rewatch_watched = '[]', updated_at = ? WHERE mal_id = ?"
            values = (utc_now(), mal_id)
        elif action == "finish":
            # Manual finish, e.g. when the total isn't known or you skipped some episodes
            if not row.get("rewatching"):
                raise ValidationError("There's no rewatch to finish")
            sql = ("UPDATE library SET rewatching = 0, rewatch_watched = '[]', rewatch_count = rewatch_count + 1, "
                   "updated_at = ? WHERE mal_id = ?")
            values = (utc_now(), mal_id)
        elif action == "cancel":
            # Stop without counting it. Episodes already logged stay in the history (you did watch them).
            if not row.get("rewatching"):
                raise ValidationError("There's no rewatch to cancel")
            sql = "UPDATE library SET rewatching = 0, rewatch_watched = '[]', updated_at = ? WHERE mal_id = ?"
            values = (utc_now(), mal_id)
        else:
            raise ValidationError('action must be "start", "finish" or "cancel"')
        with self.db._write_lock, self.db.connect() as conn:
            conn.execute(sql, values)
        return self.db.get(mal_id)

    # ------------------------------------------------------------ diary
    @staticmethod
    def _clean_text(value) -> str:
        if value is None:
            return ""
        if not isinstance(value, str):
            raise ValidationError("The diary text must be text")
        text = value.strip()
        if len(text) > MAX_DIARY_TEXT:
            raise ValidationError(f"Keep it to one line (max {MAX_DIARY_TEXT} characters)")
        return text

    @staticmethod
    def _clean_mood(value):
        if value is None or value == "":
            return None
        if value not in MOODS:
            raise ValidationError("Pick a mood from the list: " + ", ".join(MOODS))
        return value

    def _note_with_anime(self, conn: sqlite3.Connection, note: sqlite3.Row) -> dict:
        """A diary row plus the anime's title and cover, so the timeline can show them."""
        data = dict(note)
        meta = None
        lib = conn.execute("SELECT meta FROM library WHERE mal_id = ?", (data["mal_id"],)).fetchone()
        if lib:
            meta = json.loads(lib["meta"])
        else:
            # The anime was removed from the library: fall back to the cached info (no network)
            cached = conn.execute("SELECT value FROM api_cache WHERE key = ?", (f"anime:{data['mal_id']}",)).fetchone()
            if cached:
                meta = json.loads(cached["value"])
        meta = meta or {}
        data["title"] = meta.get("title") or f"Anime #{data['mal_id']}"
        data["title_english"] = meta.get("title_english")
        data["image"] = meta.get("image")
        data["in_library"] = lib is not None
        return data

    def diary(self, mood: str | None = None, mal_id: int | None = None) -> dict:
        if mood:
            self._clean_mood(mood)
        query = "SELECT * FROM diary"
        conditions = []
        values: list = []
        if mood:
            conditions.append("mood = ?")
            values.append(mood)
        if mal_id:
            conditions.append("mal_id = ?")
            values.append(mal_id)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        values.append(MAX_DIARY_ROWS)

        with self.db.connect() as conn:
            notes = [self._note_with_anime(conn, r) for r in conn.execute(query, values).fetchall()]
            # Counts per mood over the whole diary, so the filter can show them
            counts = {m: 0 for m in MOODS}
            for r in conn.execute("SELECT mood, COUNT(*) AS n FROM diary GROUP BY mood").fetchall():
                if r["mood"] in counts:
                    counts[r["mood"]] = r["n"]
            total = conn.execute("SELECT COUNT(*) FROM diary").fetchone()[0]
        return {"entries": notes, "moods": list(MOODS), "mood_counts": counts, "total": total}

    def add_note(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValidationError("Expected a JSON object")
        mal_id = body.get("mal_id")
        if isinstance(mal_id, bool) or not isinstance(mal_id, int) or mal_id < 1:
            raise ValidationError("mal_id must be a positive whole number")
        if self.db.get(mal_id) is None:
            raise ValidationError("Add this anime to your library first")
        text = self._clean_text(body.get("text"))
        mood = self._clean_mood(body.get("mood"))
        if not text and not mood:
            raise ValidationError("Write a line or pick a mood")
        with self.db._write_lock, self.db.connect() as conn:
            cur = conn.execute(
                "INSERT INTO diary (mal_id, text, mood, created_at) VALUES (?, ?, ?, ?)",
                (mal_id, text, mood, utc_now()),
            )
            note = conn.execute("SELECT * FROM diary WHERE id = ?", (cur.lastrowid,)).fetchone()
            return self._note_with_anime(conn, note)

    def update_note(self, note_id: int, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValidationError("Expected a JSON object")
        fields = {}
        for key, value in body.items():
            if key == "text":
                fields["text"] = self._clean_text(value)
            elif key == "mood":
                fields["mood"] = self._clean_mood(value)
            else:
                raise ValidationError(f"Field '{key}' can't be edited")
        with self.db._write_lock, self.db.connect() as conn:
            note = conn.execute("SELECT * FROM diary WHERE id = ?", (note_id,)).fetchone()
            if note is None:
                raise KeyError(note_id)
            text = fields.get("text", note["text"])
            mood = fields["mood"] if "mood" in fields else note["mood"]
            if not text and not mood:
                raise ValidationError("Write a line or pick a mood")
            conn.execute("UPDATE diary SET text = ?, mood = ? WHERE id = ?", (text, mood, note_id))
            note = conn.execute("SELECT * FROM diary WHERE id = ?", (note_id,)).fetchone()
            return self._note_with_anime(conn, note)

    def delete_note(self, note_id: int) -> None:
        with self.db._write_lock, self.db.connect() as conn:
            cur = conn.execute("DELETE FROM diary WHERE id = ?", (note_id,))
        if cur.rowcount == 0:
            raise KeyError(note_id)


# ====================================================================== backup
def export_extras(conn: sqlite3.Connection) -> list[dict]:
    """The diary for the backup file (rewatch/prediction fields are already in each entry)."""
    rows = conn.execute("SELECT mal_id, text, mood, created_at FROM diary ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def import_extras(conn: sqlite3.Connection, payload: dict, imported_ids: set[int]) -> None:
    """Restore rewatch state, predictions and diary notes. Runs inside import_backup's transaction.

    Damaged values are skipped instead of failing the whole import (like the watch log).
    """
    for raw in payload.get("entries") or []:
        try:
            mal_id = int(raw["mal_id"])
        except (KeyError, TypeError, ValueError):
            continue
        if mal_id not in imported_ids:
            continue
        rewatching = 1 if raw.get("rewatching") else 0
        episodes = []
        if rewatching:
            for value in raw.get("rewatch_watched") or []:
                if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
                    episodes.append(value)
        predicted = raw.get("predicted_score")
        if isinstance(predicted, bool) or not isinstance(predicted, int) or not 1 <= predicted <= 10:
            predicted = None
        conn.execute(
            "UPDATE library SET rewatching = ?, rewatch_watched = ?, predicted_score = ? WHERE mal_id = ?",
            (rewatching, json.dumps(sorted(set(episodes))), predicted, mal_id),
        )

    notes = []
    for item in payload.get("diary") or []:
        try:
            mal_id = int(item["mal_id"])
            text = str(item.get("text") or "")[:MAX_DIARY_TEXT]
            mood = item.get("mood") if item.get("mood") in MOODS else None
            created_at = str(item["created_at"])
        except (KeyError, TypeError, ValueError):
            continue
        if mal_id in imported_ids and (text or mood):
            notes.append((mal_id, text, mood, created_at))
    # Like the watch log: the backup's diary replaces the diary of the imported anime (no duplicates)
    conn.executemany("DELETE FROM diary WHERE mal_id = ?", [(i,) for i in imported_ids])
    conn.executemany("INSERT INTO diary (mal_id, text, mood, created_at) VALUES (?, ?, ?, ?)", notes)
