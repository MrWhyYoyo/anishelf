"""SQLite storage: the library, an episode watch log and the API cache."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path

from . import history
from . import manga
from . import progression
from . import upnext
from . import user_collections
from .logic import DEFAULT_ELO, STATUSES, TIERS, ValidationError, validate_profile

SCHEMA = """
CREATE TABLE IF NOT EXISTS library (
    mal_id         INTEGER PRIMARY KEY,
    meta           TEXT    NOT NULL,
    status         TEXT    NOT NULL,
    score          INTEGER,
    tier           TEXT,
    elo            REAL    NOT NULL DEFAULT 1500,
    matches        INTEGER NOT NULL DEFAULT 0,
    watched        TEXT    NOT NULL DEFAULT '[]',
    total_override INTEGER,
    notes          TEXT    NOT NULL DEFAULT '',
    fav_character  TEXT    NOT NULL DEFAULT '',
    fav_moment     TEXT    NOT NULL DEFAULT '',
    started_on     TEXT,
    finished_on    TEXT,
    rewatch_count  INTEGER NOT NULL DEFAULT 0,
    favorite       INTEGER NOT NULL DEFAULT 0,
    added_at       TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS watch_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    mal_id     INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    watched_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_log_time ON watch_log (watched_at);
CREATE INDEX IF NOT EXISTS idx_watch_log_anime ON watch_log (mal_id, episode);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
"""

EDITABLE = (
    "status", "score", "tier", "notes", "fav_character", "fav_moment", "started_on",
    "finished_on", "rewatch_count", "favorite", "total_override",
    "predicted_score",  # history.py (score predictions)
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso_date(value) -> str | None:
    """Keep a value only if it is a valid YYYY-MM-DD date."""
    try:
        return date.fromisoformat(str(value)).isoformat() if value else None
    except ValueError:
        return None


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            history.upgrade_schema(conn)  # diary table + rewatch/prediction columns (safe to repeat)
            manga.upgrade_schema(conn)    # manga + manga_log tables (safe to repeat)
            upnext.upgrade_schema(conn)   # library.queue_pos for the Up Next order (safe to repeat)
            user_collections.upgrade_schema(conn)  # custom collections tables (safe to repeat)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ------------------------------------------------------------ api cache
    def cache_get(self, key: str, max_age: float | None) -> tuple[object, bool] | None:
        """Return (value, is_fresh) or None if never cached."""
        with self.connect() as conn:
            row = conn.execute("SELECT value, fetched_at FROM api_cache WHERE key = ?", (key,)).fetchone()
        if not row:
            return None
        fresh = max_age is None or (time.time() - row["fetched_at"]) < max_age
        return json.loads(row["value"]), fresh

    def cache_get_many(self, keys: list[str]) -> dict[str, object]:
        """Look up many cache keys in ONE connection and return {key: value} for the ones found.

        Calling cache_get() in a loop opens a new connection per key (the "N+1 query" problem):
        with 186 anime that cost about 0.25 s per library load. One query with IN (...) is
        far faster. SQLite allows a limited number of "?" placeholders per query, so we ask
        in chunks of 500.
        """
        found: dict[str, object] = {}
        if not keys:
            return found
        with self.connect() as conn:
            for start in range(0, len(keys), 500):
                chunk = keys[start:start + 500]
                placeholders = ", ".join("?" for _ in chunk)  # "?, ?, ?" - one per key
                rows = conn.execute(f"SELECT key, value FROM api_cache WHERE key IN ({placeholders})", chunk)
                for row in rows:
                    found[row["key"]] = json.loads(row["value"])
        return found

    def cache_set(self, key: str, value) -> None:
        with self._write_lock, self.connect() as conn:
            conn.execute(
                "INSERT INTO api_cache (key, value, fetched_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at",
                (key, json.dumps(value), time.time()),
            )

    # ------------------------------------------------------------ settings
    def setting(self, key: str, default=None):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value) -> None:
        with self._write_lock, self.connect() as conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    def first_added(self) -> str | None:
        with self.connect() as conn:
            row = conn.execute("SELECT MIN(added_at) AS first FROM library").fetchone()
        return row["first"] if row else None

    def reset_personal_data(self) -> None:
        with self._write_lock, self.connect() as conn:
            conn.execute("DELETE FROM library")
            conn.execute("DELETE FROM watch_log")
            conn.execute("DELETE FROM settings")
            conn.execute("DELETE FROM diary")
            manga.reset(conn)  # the manga shelf and its reading log
            user_collections.reset(conn)  # custom collections

    # ------------------------------------------------------------ library
    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        data = dict(row)
        data["meta"] = json.loads(data["meta"])
        data["watched"] = sorted(json.loads(data["watched"]))
        data["favorite"] = bool(data["favorite"])
        data["rewatching"] = bool(data.get("rewatching"))
        data["rewatch_watched"] = sorted(json.loads(data.get("rewatch_watched") or "[]"))
        return data

    def get(self, mal_id: int) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM library WHERE mal_id = ?", (mal_id,)).fetchone()
        return self._row_to_dict(row) if row else None

    def all(self, status: str | None = None) -> list[dict]:
        with self.connect() as conn:
            if status:
                rows = conn.execute(
                    "SELECT * FROM library WHERE status = ? ORDER BY updated_at DESC, mal_id", (status,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM library ORDER BY updated_at DESC, mal_id").fetchall()
        return [self._row_to_dict(r) for r in rows]

    def last_watched(self) -> dict[int, str]:
        """{mal_id: time of the most recent episode you marked} in one query (for the "Last watched" sort)."""
        with self.connect() as conn:
            rows = conn.execute("SELECT mal_id, MAX(watched_at) AS last FROM watch_log GROUP BY mal_id").fetchall()
        return {r["mal_id"]: r["last"] for r in rows}

    def statuses(self) -> dict[int, str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT mal_id, status FROM library").fetchall()
        return {r["mal_id"]: r["status"] for r in rows}

    def add(self, meta: dict, status: str) -> dict:
        if status not in STATUSES:
            raise ValidationError("Unknown status")
        now = utc_now()
        with self._write_lock, self.connect() as conn:
            existing = conn.execute("SELECT mal_id FROM library WHERE mal_id = ?", (meta["mal_id"],)).fetchone()
            if existing:
                conn.execute(
                    "UPDATE library SET status = ?, meta = ?, updated_at = ? WHERE mal_id = ?",
                    (status, json.dumps(meta), now, meta["mal_id"]),
                )
            else:
                conn.execute(
                    "INSERT INTO library (mal_id, meta, status, elo, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (meta["mal_id"], json.dumps(meta), status, DEFAULT_ELO, now, now),
                )
        return self.get(meta["mal_id"])

    def update_meta(self, mal_id: int, meta: dict) -> None:
        """Refresh the stored metadata snapshot (does not touch updated_at)."""
        with self._write_lock, self.connect() as conn:
            conn.execute("UPDATE library SET meta = ? WHERE mal_id = ?", (json.dumps(meta), mal_id))

    def update(self, mal_id: int, fields: dict) -> dict:
        fields = {k: v for k, v in fields.items() if k in EDITABLE}
        if not fields:
            entry = self.get(mal_id)
            if entry is None:
                raise KeyError(mal_id)
            return entry
        assignments = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [utc_now(), mal_id]
        with self._write_lock, self.connect() as conn:
            cur = conn.execute(f"UPDATE library SET {assignments}, updated_at = ? WHERE mal_id = ?", values)
            if cur.rowcount == 0:
                raise KeyError(mal_id)
        return self.get(mal_id)

    def set_watched(self, mal_id: int, watched: set[int], extra_fields: dict | None = None,
                    log_new: bool = True) -> tuple[dict, set[int], set[int]]:
        """Save the watched episodes. Returns (entry, added, removed)."""
        with self._write_lock:
            entry = self.get(mal_id)
            if entry is None:
                raise KeyError(mal_id)
            before = set(entry["watched"])
            added = watched - before
            removed = before - watched
            now = utc_now()
            fields = {k: v for k, v in (extra_fields or {}).items() if k in EDITABLE}
            assignments = "".join(f", {k} = ?" for k in fields)
            with self.connect() as conn:
                conn.execute(
                    f"UPDATE library SET watched = ?, updated_at = ?{assignments} WHERE mal_id = ?",
                    [json.dumps(sorted(watched)), now, *fields.values(), mal_id],
                )
                if log_new and added:
                    conn.executemany(
                        "INSERT INTO watch_log (mal_id, episode, watched_at) VALUES (?, ?, ?)",
                        [(mal_id, ep, now) for ep in sorted(added)],
                    )
                if removed:
                    conn.executemany(
                        # rewatch = 0: unmarking a first-watch episode keeps the rewatch history
                        "DELETE FROM watch_log WHERE mal_id = ? AND episode = ? AND rewatch = 0",
                        [(mal_id, ep) for ep in removed],
                    )
            return self.get(mal_id), added, removed

    def remove(self, mal_id: int) -> bool:
        with self._write_lock, self.connect() as conn:
            cur = conn.execute("DELETE FROM library WHERE mal_id = ?", (mal_id,))
            conn.execute("DELETE FROM watch_log WHERE mal_id = ?", (mal_id,))
            user_collections.forget_anime(conn, [mal_id])  # a removed show leaves its collections
        return cur.rowcount > 0

    def record_match(self, winner_id: int, loser_id: int, new_winner: float, new_loser: float) -> None:
        with self._write_lock, self.connect() as conn:
            for mal_id, elo in ((winner_id, new_winner), (loser_id, new_loser)):
                conn.execute(
                    "UPDATE library SET elo = ?, matches = matches + 1 WHERE mal_id = ?", (elo, mal_id)
                )

    # ------------------------------------------------------------ stats data
    def watch_log(self, since_iso: str | None = None) -> list[dict]:
        with self.connect() as conn:
            if since_iso:
                rows = conn.execute(
                    "SELECT mal_id, episode, watched_at, rewatch FROM watch_log WHERE watched_at >= ? ORDER BY watched_at",
                    (since_iso,),
                ).fetchall()
            else:
                rows = conn.execute("SELECT mal_id, episode, watched_at, rewatch FROM watch_log ORDER BY watched_at").fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------ backup
    def export(self) -> dict:
        entries = self.all()
        return {
            "app": "AniShelf",
            "format": 1,
            "exported_at": utc_now(),
            "entries": entries,
            "watch_log": self.watch_log(),
            "profile": self.setting("profile"),
            "diary": self._export_diary(),
            # stored bonus XP from daily quests and mini-game bests (progression.py)
            "progression": {"quest_xp": self.setting("quest_xp"), "game_xp": self.setting("game_xp")},
            "manga": manga.export_data(self),  # {"entries": [...], "log": [...]} (manga.py)
            "collections": self._export_collections(),  # [{"name", "color", "mal_ids"}] (user_collections.py)
        }

    def _export_collections(self) -> list[dict]:
        with self.connect() as conn:
            return user_collections.export_data(conn)

    def _export_diary(self) -> list[dict]:
        with self.connect() as conn:
            return history.export_extras(conn)

    def import_backup(self, payload: dict) -> int:
        if not isinstance(payload, dict) or payload.get("app") != "AniShelf" or not isinstance(payload.get("entries"), list):
            raise ValidationError("That file is not an AniShelf backup")
        rows = []
        for raw in payload["entries"]:
            try:
                meta = raw["meta"]
                mal_id = int(raw["mal_id"])
                if not isinstance(meta, dict) or int(meta.get("mal_id", -1)) != mal_id:
                    raise ValueError
                status = raw["status"]
                if status not in STATUSES:
                    raise ValueError
                watched = sorted({int(e) for e in raw.get("watched", []) if int(e) >= 1})
                tier = raw.get("tier") if raw.get("tier") in TIERS else None
                score = raw.get("score")
                score = int(score) if isinstance(score, int) and 1 <= score <= 10 else None
                total_override = raw.get("total_override")
                total_override = int(total_override) if isinstance(total_override, int) and total_override > 0 else None
            except (KeyError, TypeError, ValueError):
                raise ValidationError("The backup file is damaged (bad entry)") from None
            rows.append((
                mal_id, json.dumps(meta), status, score, tier,
                float(raw.get("elo") or DEFAULT_ELO), int(raw.get("matches") or 0),
                json.dumps(watched), total_override,
                str(raw.get("notes") or "")[:20000], str(raw.get("fav_character") or "")[:300],
                str(raw.get("fav_moment") or "")[:300], _iso_date(raw.get("started_on")), _iso_date(raw.get("finished_on")),
                int(raw.get("rewatch_count") or 0), 1 if raw.get("favorite") else 0,
                raw.get("added_at") or utc_now(), raw.get("updated_at") or utc_now(),
            ))

        log_rows = []
        for item in payload.get("watch_log") or []:
            try:
                # rewatch: 0 = first watch, N = rewatch number N (older backups don't have it)
                log_rows.append((int(item["mal_id"]), int(item["episode"]), str(item["watched_at"]),
                                 int(item.get("rewatch") or 0)))
            except (KeyError, TypeError, ValueError):
                continue

        imported_ids = {r[0] for r in rows}
        # checked before anything is written, so a damaged manga entry can't leave half an import
        manga_rows, manga_log_rows = manga.parse_backup(payload.get("manga"))
        collection_rows = user_collections.parse_backup(payload.get("collections"))
        profile = payload.get("profile")
        with self._write_lock, self.connect() as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO library (mal_id, meta, status, score, tier, elo, matches, watched, "
                "total_override, notes, fav_character, fav_moment, started_on, finished_on, rewatch_count, "
                "favorite, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            # replace the history of imported anime with the backup's history (no duplicates)
            conn.executemany("DELETE FROM watch_log WHERE mal_id = ?", [(i,) for i in imported_ids])
            conn.executemany(
                "INSERT INTO watch_log (mal_id, episode, watched_at, rewatch) VALUES (?, ?, ?, ?)",
                [r for r in log_rows if r[0] in imported_ids],
            )
            # rewatch state, predicted scores and diary notes (history.py)
            history.import_extras(conn, payload, imported_ids)
            manga.write_backup(conn, manga_rows, manga_log_rows)
            user_collections.write_backup(conn, collection_rows, imported_ids)  # custom collections
            upnext.import_extras(conn, payload, imported_ids)  # Up Next order (queue_pos in each entry)
        if isinstance(profile, dict):
            try:
                self.set_setting("profile", validate_profile(profile, {}))
            except ValidationError:
                pass  # a damaged profile shouldn't block restoring the library
        bonus = payload.get("progression")
        if isinstance(bonus, dict):  # older backups don't have this; bad values are just dropped
            quest_xp = progression.clean_quest_log(bonus.get("quest_xp"))
            game_xp = progression.clean_game_xp_log(bonus.get("game_xp"))
            if quest_xp:
                self.set_setting("quest_xp", quest_xp)
            if game_xp:
                self.set_setting("game_xp", game_xp)
        return len(rows)
