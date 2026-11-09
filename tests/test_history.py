"""Watch diary, rewatch tracking, score predictions and the schema upgrade (anishelf/history.py)."""

import json
import sqlite3

import pytest

from anishelf.db import Database
from anishelf.logic import ValidationError


def complete(shelf, mal_id=1):
    """Add show 1 (12 episodes) and watch all of it."""
    shelf.add(mal_id, "watching")
    return shelf.change_episodes(mal_id, {"action": "all"})


# ====================================================================== diary
def test_diary_crud(client, shelf):
    shelf.add(1, "completed")
    r = client.post("/api/diary", json={"mal_id": 1, "text": "  What a finale  ", "mood": "hyped"})
    assert r.status_code == 200
    note = r.get_json()["note"]
    assert note["text"] == "What a finale"  # trimmed
    assert note["mood"] == "hyped"
    assert note["title"] == "Show 1"
    assert note["image"].startswith("https://cdn.myanimelist.net/")

    data = client.get("/api/diary").get_json()
    assert data["total"] == 1
    assert data["mood_counts"]["hyped"] == 1
    assert data["moods"] == ["hyped", "moved", "cozy", "mind-blown", "meh"]

    r = client.patch(f"/api/diary/{note['id']}", json={"text": "Still thinking about it", "mood": "moved"})
    assert r.get_json()["note"]["mood"] == "moved"
    assert client.get("/api/diary?mood=hyped").get_json()["entries"] == []
    assert len(client.get("/api/diary?mood=moved").get_json()["entries"]) == 1

    assert client.delete(f"/api/diary/{note['id']}").status_code == 200
    assert client.get("/api/diary").get_json()["entries"] == []
    assert client.delete(f"/api/diary/{note['id']}").status_code == 404
    assert client.patch("/api/diary/999", json={"text": "x"}).status_code == 404


def test_diary_validation(client, shelf):
    shelf.add(1, "completed")
    bad_bodies = [
        {"mal_id": 1, "text": "x" * 281},                 # too long
        {"mal_id": 1, "text": "ok", "mood": "angry"},     # not a mood from the list
        {"mal_id": 1, "text": "   "},                     # nothing to save
        {"mal_id": 2, "text": "not in my library"},
        {"mal_id": True, "text": "bool is not an id"},
        {"mal_id": 1, "text": 5},
    ]
    for bad in bad_bodies:
        assert client.post("/api/diary", json=bad).status_code == 400, bad
    # a mood alone is fine, and so is exactly 280 characters
    assert client.post("/api/diary", json={"mal_id": 1, "mood": "meh"}).status_code == 200
    note_id = client.post("/api/diary", json={"mal_id": 1, "text": "y" * 280}).get_json()["note"]["id"]
    assert client.patch(f"/api/diary/{note_id}", json={"created_at": "2020"}).status_code == 400
    assert client.patch(f"/api/diary/{note_id}", json={"text": ""}).status_code == 400  # would be empty
    assert client.get("/api/diary?mood=angry").status_code == 400


def test_diary_survives_removing_the_anime(client, shelf):
    shelf.add(1, "completed")
    client.post("/api/diary", json={"mal_id": 1, "text": "loved it"})
    shelf.remove(1)
    note = client.get("/api/diary").get_json()["entries"][0]
    assert note["title"] == "Show 1"  # from the cached anime info
    assert note["in_library"] is False


# ====================================================================== rewatch
def test_rewatch_lifecycle(shelf):
    complete(shelf)
    first = shelf.db.get(1)
    finished_on = first["finished_on"]

    # only completed shows can be rewatched
    shelf.add(2, "watching")
    with pytest.raises(ValidationError):
        shelf.rewatch(2, "start")

    entry = shelf.rewatch(1, "start")
    assert entry["rewatching"] is True
    assert entry["rewatch_number"] == 1
    assert entry["rewatch_next_episode"] == 1
    assert entry["watched_count"] == 12  # first watch kept
    with pytest.raises(ValidationError):
        shelf.rewatch(1, "start")  # already rewatching

    # no target: while rewatching, actions go to the rewatch set
    result = shelf.change_episodes(1, {"action": "toggle", "episode": 1})
    entry = result["entry"]
    assert entry["rewatch_watched"] == [1]
    assert entry["watched_count"] == 12
    assert result["status_changed"] is None and result["rewatch_finished"] is None
    result = shelf.change_episodes(1, {"action": "add_range", "text": "2-5"})
    assert result["entry"]["rewatch_next_episode"] == 6
    assert result["entry"]["rewatch_progress"] == round(5 / 12, 4)

    # unmarking a rewatch episode removes only that rewatch's log line
    shelf.change_episodes(1, {"action": "toggle", "episode": 5})
    log = shelf.db.watch_log()
    assert sum(1 for item in log if item["rewatch"] == 0) == 12
    assert sorted(item["episode"] for item in log if item["rewatch"] == 1) == [1, 2, 3, 4]

    # finishing the last episodes ends rewatch mode
    result = shelf.change_episodes(1, {"action": "all"})
    assert result["rewatch_finished"] == 1
    entry = result["entry"]
    assert entry["rewatching"] is False
    assert entry["rewatch_count"] == 1
    assert entry["rewatch_watched"] == [] and entry["rewatch_next_episode"] is None
    assert entry["status"] == "completed"
    assert entry["finished_on"] == finished_on
    assert entry["watched_count"] == 12

    # rewatch episodes count in the stats activity (12 first watch + 12 rewatch)
    stats = shelf.stats()
    assert sum(day["count"] for day in stats["activity"]) == 24

    # the second rewatch is "Rewatch #2"
    assert shelf.rewatch(1, "start")["rewatch_number"] == 2


def test_rewatch_finish_cancel_and_targets(client, shelf):
    complete(shelf)
    # an explicit rewatch target without a running rewatch is an error
    r = client.put("/api/library/1/episodes", json={"action": "toggle", "episode": 1, "target": "rewatch"})
    assert r.status_code == 400
    assert client.post("/api/library/1/rewatch", json={"action": "finish"}).status_code == 400
    assert client.post("/api/library/1/rewatch", json={"action": "dance"}).status_code == 400

    assert client.post("/api/library/1/rewatch", json={"action": "start"}).get_json()["entry"]["rewatching"]
    # target "watch" still edits the first watch while rewatching
    r = client.put("/api/library/1/episodes", json={"action": "toggle", "episode": 12, "target": "watch"})
    entry = r.get_json()["entry"]
    assert entry["watched_count"] == 11 and entry["rewatch_watched"] == []
    client.put("/api/library/1/episodes", json={"action": "toggle", "episode": 12, "target": "watch"})
    assert client.put("/api/library/1/episodes", json={"action": "all", "target": "nope"}).status_code == 400

    # manual finish counts the rewatch even when not every episode was marked
    client.put("/api/library/1/episodes", json={"action": "toggle", "episode": 3})
    entry = client.post("/api/library/1/rewatch", json={"action": "finish"}).get_json()["entry"]
    assert entry["rewatch_count"] == 1 and not entry["rewatching"]

    # cancel stops without counting
    client.post("/api/library/1/rewatch", json={"action": "start"})
    entry = client.post("/api/library/1/rewatch", json={"action": "cancel"}).get_json()["entry"]
    assert entry["rewatch_count"] == 1 and not entry["rewatching"]

    # moving the show out of Completed ends a running rewatch
    client.post("/api/library/1/rewatch", json={"action": "start"})
    entry = client.patch("/api/library/1", json={"status": "on_hold"}).get_json()["entry"]
    assert entry["rewatching"] is False


def test_rewatching_entry_in_library_api(client, shelf):
    complete(shelf)
    shelf.rewatch(1, "start")
    shelf.change_episodes(1, {"action": "toggle", "episode": 1})
    entry = client.get("/api/library").get_json()["entries"][0]
    for key in ("rewatching", "rewatch_number", "rewatch_watched", "rewatch_watched_count",
                "rewatch_next_episode", "rewatch_progress"):
        assert key in entry
    assert entry["rewatch_next_episode"] == 2


def test_old_episode_actions_unchanged(shelf):
    shelf.add(1, "plan_to_watch")
    result = shelf.change_episodes(1, {"action": "toggle", "episode": 1})
    assert result["status_changed"] == "watching"
    assert result["rewatch_finished"] is None
    assert result["entry"]["rewatching"] is False
    shelf.change_episodes(1, {"action": "toggle", "episode": 1})
    assert shelf.db.watch_log() == []  # unmarking still removes the first-watch log line


# ====================================================================== predictions
def test_predictions(client, shelf):
    shelf.add(1, "plan_to_watch")
    entry = client.patch("/api/library/1", json={"predicted_score": 7}).get_json()["entry"]
    assert entry["predicted_score"] == 7 and entry["can_predict"] is True
    assert client.patch("/api/library/1", json={"predicted_score": 11}).status_code == 400
    assert client.patch("/api/library/1", json={"predicted_score": True}).status_code == 400

    # after 3 episodes it's too late to change the prediction, but clearing is allowed
    shelf.change_episodes(1, {"action": "add_range", "text": "1-3"})
    assert client.patch("/api/library/1", json={"predicted_score": 8}).status_code == 400
    assert shelf.build_entry(shelf.db.get(1))["can_predict"] is False

    # completed shows can't get a new prediction
    shelf.add(2, "completed")
    assert client.patch("/api/library/2", json={"predicted_score": 5}).status_code == 400

    stats = client.get("/api/stats").get_json()
    assert stats["predictions"] == {"count": 0, "avg_abs_error": None, "avg_diff": None, "exact": 0}
    assert "status_counts" in stats  # the old shape is still there

    client.patch("/api/library/1", json={"score": 9})
    shelf.add(4, "watching")
    client.patch("/api/library/4", json={"predicted_score": 6})
    client.patch("/api/library/4", json={"score": 6})
    predictions = client.get("/api/stats").get_json()["predictions"]
    assert predictions == {"count": 2, "avg_abs_error": 1.0, "avg_diff": 1.0, "exact": 1}

    client.patch("/api/library/1", json={"predicted_score": None})
    assert client.get("/api/stats").get_json()["predictions"]["count"] == 1


# ====================================================================== schema upgrade
OLD_SCHEMA = """
CREATE TABLE library (
    mal_id INTEGER PRIMARY KEY, meta TEXT NOT NULL, status TEXT NOT NULL, score INTEGER, tier TEXT,
    elo REAL NOT NULL DEFAULT 1500, matches INTEGER NOT NULL DEFAULT 0, watched TEXT NOT NULL DEFAULT '[]',
    total_override INTEGER, notes TEXT NOT NULL DEFAULT '', fav_character TEXT NOT NULL DEFAULT '',
    fav_moment TEXT NOT NULL DEFAULT '', started_on TEXT, finished_on TEXT,
    rewatch_count INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE watch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, mal_id INTEGER NOT NULL, episode INTEGER NOT NULL, watched_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE api_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at REAL NOT NULL);
"""


def test_upgrade_old_database(tmp_path):
    from tests.conftest import make_meta

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript(OLD_SCHEMA)
    conn.execute(
        "INSERT INTO library (mal_id, meta, status, score, watched, rewatch_count, added_at, updated_at) "
        "VALUES (1, ?, 'completed', 8, '[1,2,3]', 2, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
        (json.dumps(make_meta(1)),),
    )
    conn.execute("INSERT INTO watch_log (mal_id, episode, watched_at) VALUES (1, 1, '2026-01-01T00:00:00+00:00')")
    conn.commit()
    conn.close()

    db = Database(path)
    Database(path)  # opening twice must be safe (the upgrade is idempotent)
    with db.connect() as c:
        library_cols = [r[1] for r in c.execute("PRAGMA table_info(library)")]
        log_cols = [r[1] for r in c.execute("PRAGMA table_info(watch_log)")]
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    for column in ("rewatching", "rewatch_watched", "predicted_score"):
        assert column in library_cols
    assert "rewatch" in log_cols
    assert "diary" in tables

    row = db.get(1)
    assert row["score"] == 8 and row["watched"] == [1, 2, 3] and row["rewatch_count"] == 2
    assert row["rewatching"] is False and row["rewatch_watched"] == [] and row["predicted_score"] is None
    assert db.watch_log()[0]["rewatch"] == 0


# ====================================================================== backup
def test_export_import_round_trip(tmp_path, shelf, jikan, anilist):
    from anishelf.service import AniShelf

    complete(shelf)
    shelf.rewatch(1, "start")
    shelf.change_episodes(1, {"action": "add_range", "text": "1-2"})
    shelf.add(2, "plan_to_watch")
    shelf.update(2, {"predicted_score": 7})
    shelf.history.add_note({"mal_id": 1, "text": "Better the second time", "mood": "cozy"})
    backup = json.loads(json.dumps(shelf.db.export()))  # through JSON, like the real file
    assert backup["diary"][0]["mood"] == "cozy"

    other = AniShelf(Database(tmp_path / "other.db"), jikan, anilist)
    assert other.db.import_backup(backup) == 2
    one = other.build_entry(other.db.get(1))
    assert one["rewatching"] is True and one["rewatch_watched"] == [1, 2]
    assert one["watched_count"] == 12
    assert other.build_entry(other.db.get(2))["predicted_score"] == 7
    notes = other.history.diary()["entries"]
    assert [n["text"] for n in notes] == ["Better the second time"]
    assert sorted(item["rewatch"] for item in other.db.watch_log()).count(1) == 2

    # importing again replaces, doesn't duplicate
    other.db.import_backup(backup)
    assert other.history.diary()["total"] == 1

    # older backups without the new keys still import
    for key in ("diary",):
        backup.pop(key)
    for entry in backup["entries"]:
        for key in ("rewatching", "rewatch_watched", "predicted_score"):
            entry.pop(key, None)
    assert other.db.import_backup(backup) == 2


def test_reset_clears_diary(shelf):
    shelf.add(1, "completed")
    shelf.history.add_note({"mal_id": 1, "mood": "meh"})
    shelf.reset_everything("RESET")
    assert shelf.history.diary()["total"] == 0
