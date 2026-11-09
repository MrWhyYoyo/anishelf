"""Undo for remove (undo.py) and automatic daily backups (autobackup.py)."""

import json
import os
from datetime import date, timedelta

import pytest

from anishelf.autobackup import KEEP, AutoBackup
from anishelf.images import ImageCache
from anishelf.server import create_app


@pytest.fixture
def backup_dir(tmp_path):
    return tmp_path / "my-backups" / "auto"


@pytest.fixture
def app_client(shelf, tmp_path, backup_dir):
    """Like the shared `client` fixture, but with an explicit backup folder."""
    app = create_app(shelf, ImageCache(tmp_path / "images"), backup_dir=backup_dir)
    app.config["TESTING"] = True
    return app.test_client()


# ====================================================================== undo remove
def build_full_entry(client):
    """A show with a bit of everything: episodes, score, tier, journal, rewatch, diary, favourite."""
    client.post("/api/library", json={"mal_id": 1, "status": "watching"})
    client.put("/api/library/1/episodes", json={"action": "up_to", "episode": 12})  # -> completed
    client.patch("/api/library/1", json={
        "score": 9, "tier": "A", "notes": "Great show", "fav_character": "Hero", "fav_moment": "Ep 7",
        "favorite": True, "rewatch_count": 2,
    })
    client.post("/api/library/1/rewatch", json={"action": "start"})
    client.put("/api/library/1/episodes", json={"action": "toggle", "episode": 3, "target": "rewatch"})
    client.post("/api/diary", json={"mal_id": 1, "text": "Loved it", "mood": "hyped"})
    return client.get("/api/anime/1").get_json()["entry"]


def test_delete_returns_snapshot_and_restore_brings_everything_back(app_client, shelf):
    before = build_full_entry(app_client)
    log_before = [(i["episode"], i["rewatch"]) for i in shelf.db.watch_log() if i["mal_id"] == 1]
    assert log_before  # the episodes were logged

    r = app_client.delete("/api/library/1")
    assert r.status_code == 200
    snapshot = r.get_json()["snapshot"]
    assert snapshot["entries"][0]["mal_id"] == 1
    assert app_client.get("/api/anime/1").get_json()["entry"] is None
    assert not [i for i in shelf.db.watch_log() if i["mal_id"] == 1]

    r = app_client.post("/api/library/1/restore", json=snapshot)
    assert r.status_code == 200
    restored = r.get_json()["entry"]

    for key in ("status", "score", "tier", "watched", "notes", "fav_character", "fav_moment", "favorite",
                "started_on", "finished_on", "rewatch_count", "rewatching", "rewatch_watched", "elo",
                "added_at"):
        assert restored[key] == before[key], key
    log_after = [(i["episode"], i["rewatch"]) for i in shelf.db.watch_log() if i["mal_id"] == 1]
    assert sorted(log_after) == sorted(log_before)
    notes = app_client.get("/api/diary?mal_id=1").get_json()
    assert "Loved it" in json.dumps(notes)


def test_restore_is_checked(app_client):
    app_client.post("/api/library", json={"mal_id": 1})
    app_client.post("/api/library", json={"mal_id": 2})
    snapshot = app_client.delete("/api/library/1").get_json()["snapshot"]

    # wrong anime id in the URL
    assert app_client.post("/api/library/2/restore", json=snapshot).status_code == 400
    # not a snapshot at all
    assert app_client.post("/api/library/1/restore", json={"hello": 1}).status_code == 400
    # two anime in one snapshot
    two = dict(snapshot, entries=snapshot["entries"] * 2)
    assert app_client.post("/api/library/1/restore", json=two).status_code == 400
    # a damaged field is refused by the backup import's checks
    bad = json.loads(json.dumps(snapshot))
    bad["entries"][0]["status"] = "binge"
    assert app_client.post("/api/library/1/restore", json=bad).status_code == 400

    # restoring works once, and not on top of an anime that is already back
    assert app_client.post("/api/library/1/restore", json=snapshot).status_code == 200
    assert app_client.post("/api/library/1/restore", json=snapshot).status_code == 400


def test_restore_cannot_touch_profile_or_other_anime(app_client, shelf):
    app_client.post("/api/library", json={"mal_id": 1})
    app_client.post("/api/library", json={"mal_id": 2, "status": "watching"})
    snapshot = app_client.delete("/api/library/1").get_json()["snapshot"]
    snapshot["profile"] = {"display_name": "Hacker"}
    snapshot["watch_log"].append({"mal_id": 2, "episode": 5, "watched_at": "2020-01-01T00:00:00+00:00"})
    assert app_client.post("/api/library/1/restore", json=snapshot).status_code == 200
    assert shelf.db.setting("profile") is None
    assert not [i for i in shelf.db.watch_log() if i["mal_id"] == 2]


def test_delete_missing_still_404(app_client):
    assert app_client.delete("/api/library/1").status_code == 404


# ====================================================================== automatic backups
def test_default_backup_folder_is_next_to_the_database(client, shelf, tmp_path):
    status = client.get("/api/backups/auto").get_json()
    assert status["enabled"] is True
    assert status["folder"] == str(tmp_path / "backups" / "auto")
    assert status["last"] is None


def test_back_up_now_writes_an_export(app_client, backup_dir):
    app_client.post("/api/library", json={"mal_id": 1, "status": "watching"})
    r = app_client.post("/api/backups/auto")
    assert r.status_code == 200
    status = r.get_json()
    today = date.today().isoformat()
    assert status["last"]["date"] == today
    path = backup_dir / f"anishelf-{today}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["app"] == "AniShelf" and [e["mal_id"] for e in data["entries"]] == [1]
    assert app_client.get("/api/backups/auto").get_json()["last"]["file"] == path.name
    # a second click the same day replaces the file instead of adding one
    app_client.post("/api/backups/auto")
    assert len(list(backup_dir.iterdir())) == 1


def test_the_file_can_be_imported_again(shelf, tmp_path):
    shelf.add(1, "watching")
    backup = AutoBackup(shelf.db, tmp_path / "auto")
    backup.write_now()
    payload = json.loads(backup.backups()[0].read_text(encoding="utf-8"))
    shelf.remove(1)
    assert shelf.db.import_backup(payload) == 1


def test_keeps_only_the_newest_seven_and_ignores_other_files(shelf, tmp_path):
    folder = tmp_path / "backups" / "auto"
    folder.mkdir(parents=True)
    # files that are NOT automatic backups must never be deleted
    keep_me = [folder / "my-manual-backup.json", folder / "anishelf-backup-2020-01-01.json", folder / "notes.txt"]
    for path in keep_me:
        path.write_text("{}", encoding="utf-8")
    manual = tmp_path / "backups" / "anishelf-2000-01-01.json"  # outside the auto folder
    manual.write_text("{}", encoding="utf-8")

    backup = AutoBackup(shelf.db, folder)
    start = date(2026, 1, 1)
    for i in range(10):
        backup.write_now(start + timedelta(days=i))

    names = [p.name for p in backup.backups()]
    assert len(names) == KEEP == 7
    assert names[0] == "anishelf-2026-01-10.json" and names[-1] == "anishelf-2026-01-04.json"
    for path in keep_me + [manual]:
        assert path.exists()
    assert not [p for p in folder.iterdir() if p.name.endswith(".tmp")]


def test_run_if_due_only_once_a_day(shelf, tmp_path):
    backup = AutoBackup(shelf.db, tmp_path / "auto")
    day = date(2026, 3, 1)
    assert backup.run_if_due(day) is True
    first = backup.backups()[0]
    mtime = first.stat().st_mtime
    os.utime(first, (mtime - 100, mtime - 100))
    assert backup.run_if_due(day) is False          # already done today
    assert first.stat().st_mtime == mtime - 100     # not rewritten
    assert backup.run_if_due(day + timedelta(days=1)) is True
    assert len(backup.backups()) == 2


def test_switched_off_without_a_folder(shelf):
    backup = AutoBackup(shelf.db, None)
    assert backup.status()["enabled"] is False
    assert backup.run_if_due() is False
    backup.start()  # does nothing, no thread
    assert backup._thread is None
