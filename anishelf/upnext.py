"""Up Next: your own order for the Plan to Watch (plan_to_watch) list.

Storage: one extra column, library.queue_pos (1 = watch first). Only plan_to_watch rows
have a number; every other status keeps it NULL.

Rules:
  * a show that becomes plan_to_watch goes to the BOTTOM of the queue
  * a show that leaves plan_to_watch loses its place (coming back = bottom again)
  * PUT /api/queue sends the full new order; it must contain every queued show exactly once
"""

from __future__ import annotations

import sqlite3

from .logic import ValidationError

PLAN = "plan_to_watch"
MAX_QUEUE = 5000  # a reorder list longer than this is surely a bug, so it's refused


# ---------------------------------------------------------------- schema
def upgrade_schema(conn: sqlite3.Connection) -> None:
    """Add the queue_pos column if it's missing. Safe to run on every start."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(library)")}
    if "queue_pos" not in columns:
        conn.execute("ALTER TABLE library ADD COLUMN queue_pos INTEGER")


# ---------------------------------------------------------------- keeping the numbers tidy
def _bottom(conn: sqlite3.Connection) -> int:
    """The next free number at the end of the queue."""
    row = conn.execute("SELECT MAX(queue_pos) FROM library WHERE status = ?", (PLAN,)).fetchone()
    return (row[0] or 0) + 1


def normalize(db) -> None:
    """Fix the queue after anything that skipped the hooks (imports, auto status changes...).

    1. Shows that are no longer plan_to_watch lose their number.
    2. plan_to_watch shows without a number join the bottom, oldest-added first.
    """
    with db._write_lock, db.connect() as conn:
        conn.execute("UPDATE library SET queue_pos = NULL WHERE status != ? AND queue_pos IS NOT NULL", (PLAN,))
        missing = conn.execute(
            "SELECT mal_id FROM library WHERE status = ? AND queue_pos IS NULL ORDER BY added_at, mal_id", (PLAN,)
        ).fetchall()
        next_pos = _bottom(conn)
        for row in missing:
            conn.execute("UPDATE library SET queue_pos = ? WHERE mal_id = ?", (next_pos, row["mal_id"]))
            next_pos += 1


def on_status(db, mal_id: int, new_status: str, old_status: str | None) -> None:
    """Called by service.py after a status change (add or PATCH)."""
    if new_status == old_status:
        return  # nothing moved, keep the place in the queue
    with db._write_lock, db.connect() as conn:
        if new_status == PLAN:
            conn.execute("UPDATE library SET queue_pos = ? WHERE mal_id = ?", (_bottom(conn), mal_id))
        else:
            conn.execute("UPDATE library SET queue_pos = NULL WHERE mal_id = ?", (mal_id,))


def ordered_ids(db) -> list[int]:
    """The queued mal_ids, first to watch first."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT mal_id FROM library WHERE status = ? ORDER BY queue_pos, added_at, mal_id", (PLAN,)
        ).fetchall()
    return [row["mal_id"] for row in rows]


# ---------------------------------------------------------------- the endpoints
def up_next(shelf, limit: int | None = None) -> dict:
    """GET /api/queue: plan_to_watch entries in queue order."""
    normalize(shelf.db)
    ids = ordered_ids(shelf.db)
    # shelf.library() also adds the season grouping; then we just put the entries in queue order
    by_id = {entry["mal_id"]: entry for entry in shelf.library(PLAN)}
    entries = [by_id[i] for i in ids if i in by_id]
    for position, entry in enumerate(entries, start=1):
        entry["queue_position"] = position
    total = len(entries)
    if limit is not None:
        entries = entries[:limit]
    return {"entries": entries, "total": total}


def validate_order(order, current: list[int]) -> list[int]:
    """The new order must be the same shows as the queue, each once. Returns it as ints."""
    if not isinstance(order, list):
        raise ValidationError("order must be a list of anime ids")
    if len(order) > MAX_QUEUE:
        raise ValidationError("That list is too long")
    for value in order:
        # bool is a subclass of int in Python (True == 1), so it has to be refused on purpose
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValidationError("order must only contain anime ids")
    if len(set(order)) != len(order):
        raise ValidationError("An anime appears twice in the order")
    if set(order) != set(current):
        raise ValidationError("The order must contain exactly the shows in your queue (reload and try again)")
    return list(order)


def reorder(shelf, order) -> dict:
    """PUT /api/queue {"order": [ids]}: save a new order (position = index + 1)."""
    normalize(shelf.db)
    clean = validate_order(order, ordered_ids(shelf.db))
    with shelf.db._write_lock, shelf.db.connect() as conn:
        conn.executemany("UPDATE library SET queue_pos = ? WHERE mal_id = ?",
                         [(position, mal_id) for position, mal_id in enumerate(clean, start=1)])
    return up_next(shelf)


# ---------------------------------------------------------------- backup
def import_extras(conn: sqlite3.Connection, payload: dict, imported_ids: set[int]) -> None:
    """Restore queue positions from a backup (the export already has queue_pos in each entry).

    Runs inside import_backup's transaction. Bad values are skipped; normalize() later gives
    any plan_to_watch show without a number a place at the bottom.
    """
    for raw in payload.get("entries") or []:
        try:
            mal_id = int(raw["mal_id"])
        except (KeyError, TypeError, ValueError):
            continue
        position = raw.get("queue_pos")
        if mal_id not in imported_ids:
            continue
        if isinstance(position, bool) or not isinstance(position, int) or position < 1 or raw.get("status") != PLAN:
            position = None
        conn.execute("UPDATE library SET queue_pos = ? WHERE mal_id = ?", (position, mal_id))
