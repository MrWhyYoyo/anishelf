"""Bulk edit: change many library entries at once (POST /api/library/bulk).

Body: {"ids": [1, 2, 3], "action": "status", "value": "completed"}

Actions:
  status      value = a status key        -> same date rules as changing one show
  tier        value = "S".."D" or null    -> tier list placement
  collection  value = a collection id     -> add every show to that collection
  watch_all   (no value)                  -> mark every episode watched (needs a known total)
  remove      (no value)                  -> delete the shows from the library

Why one transaction? Everything happens inside ONE `with db.connect()` block. If anything goes
wrong halfway, SQLite rolls back the whole batch, so you never end up with "half the shows
changed". The hard cap (MAX_IDS) stops a buggy page from sending a huge request.
"""

from __future__ import annotations

import json
from datetime import date

from . import user_collections
from .db import utc_now
from .logic import STATUSES, TIERS, ValidationError, auto_status

MAX_IDS = 500
ACTIONS = ("status", "tier", "collection", "watch_all", "remove")
BULK_LOG_LIMIT = 25  # same rule as service.py: a bigger jump is "catching up records", not today's activity


def clean_request(body) -> tuple[list[int], str, object]:
    """Check the whole request before touching the database. Returns (ids, action, value)."""
    if not isinstance(body, dict):
        raise ValidationError("Expected a JSON object")
    ids = user_collections.clean_ids(body.get("ids"), limit=MAX_IDS)
    action = body.get("action")
    if action not in ACTIONS:
        raise ValidationError(f"action must be one of: {', '.join(ACTIONS)}")
    value = body.get("value")
    if action == "status" and value not in STATUSES:
        raise ValidationError("Unknown status")
    if action == "tier" and value is not None and value not in TIERS:
        raise ValidationError("tier must be S, A, B, C, D or null")
    if action == "collection" and (isinstance(value, bool) or not isinstance(value, int) or value < 1):
        raise ValidationError("value must be a collection id")
    return ids, action, value


def _dates_for_status(row: dict, status: str) -> dict:
    """Fill started_on / finished_on like a single status change does (service._dates_for_status)."""
    today = date.today().isoformat()
    extra = {}
    if status == "watching" and not row.get("started_on"):
        extra["started_on"] = today
    if status == "completed":
        if not row.get("finished_on"):
            extra["finished_on"] = today
        if not row.get("started_on"):
            extra["started_on"] = today
    return extra


def _update(conn, mal_id: int, fields: dict, now: str) -> None:
    """UPDATE one library row. Column names come from our own code, never from the request."""
    assignments = ", ".join(f"{key} = ?" for key in fields)
    conn.execute(f"UPDATE library SET {assignments}, updated_at = ? WHERE mal_id = ?",
                 [*fields.values(), now, mal_id])


def apply(db, body) -> dict:
    """Run one bulk action. Returns {"action", "changed", "skipped", "missing"}.

    changed = shows that really changed, skipped = shows where the action didn't apply
    (e.g. "mark all watched" on a show with an unknown episode count), missing = ids not in the library.
    """
    ids, action, value = clean_request(body)
    now = utc_now()
    changed: list[int] = []
    skipped: list[int] = []

    with db._write_lock, db.connect() as conn:  # one connection = one transaction
        placeholders = ", ".join("?" for _ in ids)
        rows = conn.execute(f"SELECT * FROM library WHERE mal_id IN ({placeholders})", ids).fetchall()
        found = {row["mal_id"]: db._row_to_dict(row) for row in rows}
        missing = [i for i in ids if i not in found]
        targets = [found[i] for i in ids if i in found]

        if action == "collection":
            if not conn.execute("SELECT id FROM collections WHERE id = ?", (value,)).fetchone():
                raise ValidationError("That collection doesn't exist")
            user_collections.add_in_conn(conn, value, [row["mal_id"] for row in targets])
            changed = [row["mal_id"] for row in targets]

        elif action == "remove":
            for row in targets:
                conn.execute("DELETE FROM library WHERE mal_id = ?", (row["mal_id"],))
                conn.execute("DELETE FROM watch_log WHERE mal_id = ?", (row["mal_id"],))
            user_collections.forget_anime(conn, [row["mal_id"] for row in targets])
            changed = [row["mal_id"] for row in targets]

        else:
            for row in targets:
                fields = _fields_for(action, value, row)
                if fields is None:
                    skipped.append(row["mal_id"])
                    continue
                _update(conn, row["mal_id"], fields, now)
                if action == "watch_all":
                    _log_new_episodes(conn, row, fields, now)
                changed.append(row["mal_id"])

    return {"action": action, "changed": changed, "skipped": skipped, "missing": missing}


def _fields_for(action: str, value, row: dict) -> dict | None:
    """The columns to change for one show, or None when there's nothing to do."""
    if action == "tier":
        return None if row["tier"] == value else {"tier": value}

    if action == "status":
        if row["status"] == value:
            return None
        fields = {"status": value, **_dates_for_status(row, value)}
        if value != "completed" and row.get("rewatching"):
            # leaving Completed ends a running rewatch (same rule as a single PATCH)
            fields["rewatching"] = 0
            fields["rewatch_watched"] = "[]"
        return fields

    if action == "watch_all":
        total = row.get("total_override") or row["meta"].get("episodes")
        if not total:
            return None  # unknown length: we can't know what "all" means
        watched = list(range(1, total + 1))
        if row["watched"] == watched:
            return None
        fields = {"watched": json.dumps(watched)}
        new_status = auto_status(row["status"], total, total)
        if new_status != row["status"]:
            fields["status"] = new_status
        today = date.today().isoformat()
        if not row.get("started_on"):
            fields["started_on"] = today
        if new_status == "completed" and not row.get("finished_on"):
            fields["finished_on"] = today
        return fields

    return None


def _log_new_episodes(conn, row: dict, fields: dict, now: str) -> None:
    """Add watch-log lines for newly marked episodes, unless it's a big catch-up (> 25)."""
    added = sorted(set(json.loads(fields["watched"])) - set(row["watched"]))
    if 0 < len(added) <= BULK_LOG_LIMIT:
        conn.executemany("INSERT INTO watch_log (mal_id, episode, watched_at) VALUES (?, ?, ?)",
                         [(row["mal_id"], ep, now) for ep in added])

