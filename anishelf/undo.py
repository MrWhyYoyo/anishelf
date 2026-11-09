"""Undo for "Remove from library".

How it works (the "snapshot" approach):
1. Before DELETE /api/library/<id> removes a show, snapshot() copies everything about it into a
   small dict that looks exactly like a one-anime backup file: the library row (episodes, score,
   tier, notes, journal fields, rewatch fields, Elo...), its watch history and its diary notes.
2. The DELETE answer sends that snapshot to the browser, which keeps it while the "Undo" toast shows.
3. Clicking Undo posts the snapshot back to POST /api/library/<id>/restore, and restore() feeds it
   through the normal backup import (Database.import_backup). That import already checks every
   field, so a damaged or edited snapshot can't put bad data in the database.

Why not a server-side "trash"? The snapshot needs no extra table and nothing to clean up later,
and it survives a server restart while the toast is still open. Reusing the import code also
means any field added to backups in the future is automatically covered by undo too.
"""

from __future__ import annotations

from .logic import ValidationError


def snapshot(db, mal_id: int) -> dict | None:
    """Everything about one library entry, in backup-file format. None if it isn't in the library."""
    row = db.get(mal_id)
    if row is None:
        return None
    return {
        "app": "AniShelf",
        "format": 1,
        "kind": "undo-remove",   # just a label for people reading the JSON; import ignores it
        "entries": [row],
        "watch_log": [item for item in db.watch_log() if item["mal_id"] == mal_id],
        # db.export() includes the diary; we only keep this anime's notes
        "diary": [note for note in db._export_diary() if note["mal_id"] == mal_id],
    }


def restore(db, mal_id: int, payload) -> None:
    """Put a removed anime back from its snapshot."""
    if not isinstance(payload, dict) or payload.get("app") != "AniShelf":
        raise ValidationError("That isn't an undo snapshot")
    entries = payload.get("entries")
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        raise ValidationError("An undo snapshot holds exactly one anime")
    if entries[0].get("mal_id") != mal_id:
        raise ValidationError("That snapshot belongs to a different anime")
    if db.get(mal_id) is not None:
        # Restoring would overwrite whatever is there now (maybe you added it again by hand)
        raise ValidationError("That anime is already back in your library")

    def only_this_anime(items):
        return [i for i in (items or []) if isinstance(i, dict) and i.get("mal_id") == mal_id]

    # Build a clean payload with only the parts undo needs. Leaving out "profile", "progression"
    # and "manga" means import_backup can't change anything else, whatever the browser sent.
    clean = {
        "app": "AniShelf",
        "entries": entries,
        "watch_log": only_this_anime(payload.get("watch_log")),
        "diary": only_this_anime(payload.get("diary")),
    }
    db.import_backup(clean)
