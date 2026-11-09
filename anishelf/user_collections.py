"""Custom collections: your own lists like "Comfort shows" or "Watch with friends".

A collection is just a name (and an optional colour). A show can be in several collections,
so the link between them lives in its own table (a "many-to-many" relation):

    collections        (id, name, color, created_at)
    collection_items   (collection_id, mal_id, added_at)   <- one row per (collection, anime) pair

Why not a column on the library table? A column holds one value, but a show can belong to many
collections. A separate table with one row per pair is the standard way to model that in SQL.

The file is called user_collections.py (not collections.py) so it never gets mixed up with
Python's built-in `collections` module.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone

from .logic import ValidationError

MAX_COLLECTIONS = 100   # plenty for a personal shelf, and stops a runaway script
MAX_NAME = 40           # characters
MAX_ADD_AT_ONCE = 500   # same cap as bulk edit
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")  # "#rrggbb"

SCHEMA = """
CREATE TABLE IF NOT EXISTS collections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    color      TEXT,
    created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    mal_id        INTEGER NOT NULL,
    added_at      TEXT    NOT NULL,
    PRIMARY KEY (collection_id, mal_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_items_anime ON collection_items (mal_id);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def upgrade_schema(conn: sqlite3.Connection) -> None:
    """Create the two tables if they don't exist yet. Safe to run on every start."""
    conn.executescript(SCHEMA)


# ====================================================================== validation (pure functions)
def clean_name(value) -> str:
    """A collection name: text, trimmed, 1-40 characters."""
    if not isinstance(value, str):
        raise ValidationError("A collection needs a name")
    name = " ".join(value.split())  # trim and squash double spaces
    if not name:
        raise ValidationError("A collection needs a name")
    if len(name) > MAX_NAME:
        raise ValidationError(f"Collection names can be at most {MAX_NAME} characters")
    return name


def clean_color(value) -> str | None:
    """Optional colour: "#rrggbb" or null."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not COLOR_RE.match(value):
        raise ValidationError('color must look like "#ff8800" (or null)')
    return value.lower()


def clean_ids(value, limit: int = MAX_ADD_AT_ONCE) -> list[int]:
    """A list of positive whole numbers (MAL ids), without duplicates, keeping the order."""
    if not isinstance(value, list) or not value:
        raise ValidationError("Send a non-empty list of anime ids")
    if len(value) > limit:
        raise ValidationError(f"At most {limit} anime at once")
    ids: list[int] = []
    for item in value:
        # bool is a subclass of int in Python (True == 1), so reject it on purpose
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise ValidationError("Anime ids must be positive whole numbers")
        if item not in ids:
            ids.append(item)
    return ids


# ====================================================================== database work
class Collections:
    """All collection reads and writes. Uses the app's Database for connections (like History)."""

    def __init__(self, db):
        self.db = db

    @staticmethod
    def _as_dict(row: sqlite3.Row, mal_ids: list[int]) -> dict:
        return {"id": row["id"], "name": row["name"], "color": row["color"],
                "created_at": row["created_at"], "count": len(mal_ids), "mal_ids": mal_ids}

    @staticmethod
    def _members(conn: sqlite3.Connection) -> dict[int, list[int]]:
        """{collection_id: [mal_id, ...]} - only anime that are still in the library."""
        rows = conn.execute(
            "SELECT ci.collection_id, ci.mal_id FROM collection_items ci "
            "JOIN library l ON l.mal_id = ci.mal_id ORDER BY ci.added_at, ci.mal_id"
        ).fetchall()
        members: dict[int, list[int]] = {}
        for row in rows:
            members.setdefault(row["collection_id"], []).append(row["mal_id"])
        return members

    def all(self) -> list[dict]:
        """Every collection, A-Z, each with the MAL ids it holds."""
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM collections ORDER BY name COLLATE NOCASE, id").fetchall()
            members = self._members(conn)
        return [self._as_dict(row, members.get(row["id"], [])) for row in rows]

    def get(self, collection_id: int) -> dict:
        for item in self.all():
            if item["id"] == collection_id:
                return item
        raise KeyError(collection_id)

    @staticmethod
    def _name_taken(conn: sqlite3.Connection, name: str, except_id: int | None = None) -> bool:
        row = conn.execute(
            "SELECT id FROM collections WHERE name = ? COLLATE NOCASE AND id IS NOT ?", (name, except_id)
        ).fetchone()
        return row is not None

    def create(self, body: dict) -> dict:
        name = clean_name(body.get("name"))
        color = clean_color(body.get("color"))
        with self.db._write_lock, self.db.connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
            if count >= MAX_COLLECTIONS:
                raise ValidationError(f"You can have at most {MAX_COLLECTIONS} collections")
            if self._name_taken(conn, name):
                raise ValidationError(f'You already have a collection called "{name}"')
            cur = conn.execute(
                "INSERT INTO collections (name, color, created_at) VALUES (?, ?, ?)", (name, color, utc_now())
            )
            new_id = cur.lastrowid
        return self.get(new_id)

    def update(self, collection_id: int, body: dict) -> dict:
        """Rename and/or recolour. Only the fields that are sent change."""
        unknown = set(body) - {"name", "color"}
        if unknown:
            raise ValidationError(f"Unknown field: {sorted(unknown)[0]}")
        with self.db._write_lock, self.db.connect() as conn:
            if not conn.execute("SELECT id FROM collections WHERE id = ?", (collection_id,)).fetchone():
                raise KeyError(collection_id)
            if "name" in body:
                name = clean_name(body["name"])
                if self._name_taken(conn, name, collection_id):
                    raise ValidationError(f'You already have a collection called "{name}"')
                conn.execute("UPDATE collections SET name = ? WHERE id = ?", (name, collection_id))
            if "color" in body:
                conn.execute("UPDATE collections SET color = ? WHERE id = ?", (clean_color(body["color"]), collection_id))
        return self.get(collection_id)

    def delete(self, collection_id: int) -> None:
        """Delete a collection. The anime themselves stay in the library."""
        with self.db._write_lock, self.db.connect() as conn:
            # ON DELETE CASCADE would do this too, but saying it out loud is clearer
            conn.execute("DELETE FROM collection_items WHERE collection_id = ?", (collection_id,))
            cur = conn.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
            if cur.rowcount == 0:
                raise KeyError(collection_id)

    def add_anime(self, collection_id: int, mal_ids) -> dict:
        ids = clean_ids(mal_ids)
        with self.db._write_lock, self.db.connect() as conn:
            if not conn.execute("SELECT id FROM collections WHERE id = ?", (collection_id,)).fetchone():
                raise KeyError(collection_id)
            add_in_conn(conn, collection_id, ids)
        return self.get(collection_id)

    def remove_anime(self, collection_id: int, mal_id: int) -> dict:
        with self.db._write_lock, self.db.connect() as conn:
            if not conn.execute("SELECT id FROM collections WHERE id = ?", (collection_id,)).fetchone():
                raise KeyError(collection_id)
            conn.execute("DELETE FROM collection_items WHERE collection_id = ? AND mal_id = ?", (collection_id, mal_id))
        return self.get(collection_id)


def add_in_conn(conn: sqlite3.Connection, collection_id: int, ids: list[int]) -> int:
    """Put anime into a collection inside an open transaction (also used by bulk edit).

    Only anime that are in the library are added. INSERT OR IGNORE skips pairs that already
    exist, so adding a show twice is harmless. Returns how many anime were in the library.
    """
    if not ids:
        return 0
    placeholders = ", ".join("?" for _ in ids)
    in_library = [r[0] for r in conn.execute(f"SELECT mal_id FROM library WHERE mal_id IN ({placeholders})", ids)]
    now = utc_now()
    conn.executemany(
        "INSERT OR IGNORE INTO collection_items (collection_id, mal_id, added_at) VALUES (?, ?, ?)",
        [(collection_id, mal_id, now) for mal_id in in_library],
    )
    return len(in_library)


def forget_anime(conn: sqlite3.Connection, mal_ids) -> None:
    """Take removed anime out of every collection (called when a show leaves the library)."""
    conn.executemany("DELETE FROM collection_items WHERE mal_id = ?", [(int(i),) for i in mal_ids])


# ====================================================================== backup
def export_data(conn: sqlite3.Connection) -> list[dict]:
    """The `collections` part of the backup file: [{"name", "color", "created_at", "mal_ids"}]."""
    members = Collections._members(conn)
    rows = conn.execute("SELECT * FROM collections ORDER BY id").fetchall()
    return [{"name": r["name"], "color": r["color"], "created_at": r["created_at"],
             "mal_ids": members.get(r["id"], [])} for r in rows]


def parse_backup(section) -> list[tuple[str, str | None, str, list[int]]]:
    """Check the backup's collections BEFORE anything is written.

    Older backups have no `collections` key: nothing to import. A damaged collection is skipped
    (losing a list is less bad than refusing the whole backup).
    """
    if not isinstance(section, list):
        return []
    parsed = []
    for raw in section[:MAX_COLLECTIONS]:
        if not isinstance(raw, dict):
            continue
        try:
            name = clean_name(raw.get("name"))
            color = clean_color(raw.get("color"))
        except ValidationError:
            continue
        ids = []
        for value in raw.get("mal_ids") or []:
            if isinstance(value, int) and not isinstance(value, bool) and value >= 1 and value not in ids:
                ids.append(value)
        created = str(raw.get("created_at") or utc_now())
        parsed.append((name, color, created, ids))
    return parsed


def write_backup(conn: sqlite3.Connection, parsed: list, imported_ids: set[int]) -> None:
    """Restore collections. Runs inside import_backup's transaction.

    Collections are matched by name (ignoring case), so importing twice doesn't duplicate them.
    Like the watch log: for the imported anime, the backup decides which collections they're in.
    """
    if not parsed:
        return
    conn.executemany("DELETE FROM collection_items WHERE mal_id = ?", [(i,) for i in imported_ids])
    now = utc_now()
    for name, color, created, ids in parsed:
        row = conn.execute("SELECT id FROM collections WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if row:
            collection_id = row[0]
            conn.execute("UPDATE collections SET color = ? WHERE id = ?", (color, collection_id))
        else:
            count = conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
            if count >= MAX_COLLECTIONS:
                continue
            collection_id = conn.execute(
                "INSERT INTO collections (name, color, created_at) VALUES (?, ?, ?)", (name, color, created)
            ).lastrowid
        conn.executemany(
            "INSERT OR IGNORE INTO collection_items (collection_id, mal_id, added_at) VALUES (?, ?, ?)",
            [(collection_id, i, now) for i in ids if i in imported_ids],
        )


def reset(conn: sqlite3.Connection) -> None:
    """Delete every collection (part of the full reset)."""
    conn.execute("DELETE FROM collection_items")
    conn.execute("DELETE FROM collections")
