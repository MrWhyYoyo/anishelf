"""Custom collections + bulk edit (user_collections.py, bulk.py)."""

import random

from anishelf.db import Database
from anishelf.service import AniShelf


def add(client, mal_id, status="plan_to_watch"):
    assert client.post("/api/library", json={"mal_id": mal_id, "status": status}).status_code == 200


def new_collection(client, name, **extra):
    r = client.post("/api/collections", json={"name": name, **extra})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["collection"]


# ------------------------------------------------------------------ collections
def test_collection_crud(client):
    add(client, 1)
    add(client, 2)
    comfy = new_collection(client, "  Comfort   shows ", color="#FF8800")
    assert comfy["name"] == "Comfort shows" and comfy["color"] == "#ff8800" and comfy["mal_ids"] == []

    r = client.post(f"/api/collections/{comfy['id']}/anime", json={"mal_id": 1})
    assert r.get_json()["collection"]["mal_ids"] == [1]
    # several at once; ids not in the library are ignored, duplicates are harmless
    r = client.post(f"/api/collections/{comfy['id']}/anime", json={"mal_ids": [1, 2, 999]})
    assert sorted(r.get_json()["collection"]["mal_ids"]) == [1, 2]

    r = client.patch(f"/api/collections/{comfy['id']}", json={"name": "Cozy"})
    assert r.get_json()["collection"]["name"] == "Cozy"

    r = client.delete(f"/api/collections/{comfy['id']}/anime/1")
    assert r.get_json()["collection"]["mal_ids"] == [2]

    listed = client.get("/api/collections").get_json()["collections"]
    assert [c["name"] for c in listed] == ["Cozy"] and listed[0]["count"] == 1

    assert client.delete(f"/api/collections/{comfy['id']}").get_json() == {"ok": True}
    assert client.get("/api/collections").get_json()["collections"] == []
    # the anime stay in the library
    assert len(client.get("/api/library").get_json()["entries"]) == 2


def test_a_show_can_be_in_several_collections(client):
    add(client, 1)
    a = new_collection(client, "A")
    b = new_collection(client, "B")
    for c in (a, b):
        client.post(f"/api/collections/{c['id']}/anime", json={"mal_id": 1})
    listed = client.get("/api/collections").get_json()["collections"]
    assert all(c["mal_ids"] == [1] for c in listed)


def test_collection_validation(client):
    assert client.post("/api/collections", json={"name": "   "}).status_code == 400
    assert client.post("/api/collections", json={"name": "x" * 41}).status_code == 400
    assert client.post("/api/collections", json={"name": "Ok", "color": "red"}).status_code == 400
    new_collection(client, "Friends")
    assert client.post("/api/collections", json={"name": "friends"}).status_code == 400  # same name, any case
    assert client.patch("/api/collections/999", json={"name": "Nope"}).status_code == 404
    assert client.delete("/api/collections/999").status_code == 404
    assert client.post("/api/collections/999/anime", json={"mal_id": 1}).status_code == 404
    c = new_collection(client, "Other")
    assert client.post(f"/api/collections/{c['id']}/anime", json={"mal_ids": []}).status_code == 400
    assert client.post(f"/api/collections/{c['id']}/anime", json={"mal_ids": [True]}).status_code == 400
    assert client.patch(f"/api/collections/{c['id']}", json={"bogus": 1}).status_code == 400


def test_removing_a_show_takes_it_out_of_collections(client):
    add(client, 1)
    c = new_collection(client, "Rewatch")
    client.post(f"/api/collections/{c['id']}/anime", json={"mal_id": 1})
    client.delete("/api/library/1")
    add(client, 1)  # adding it again starts clean
    assert client.get("/api/collections").get_json()["collections"][0]["mal_ids"] == []


def test_schema_upgrade_is_idempotent(tmp_path):
    path = tmp_path / "again.db"
    Database(path)
    Database(path)  # second start must not fail or change anything


# ------------------------------------------------------------------ backup
def test_collections_round_trip_through_backup(client):
    add(client, 1)
    add(client, 2)
    c = new_collection(client, "Comfort shows", color="#112233")
    client.post(f"/api/collections/{c['id']}/anime", json={"mal_ids": [1, 2]})
    new_collection(client, "Empty one")
    backup = client.get("/api/export").get_json()
    assert {x["name"] for x in backup["collections"]} == {"Comfort shows", "Empty one"}

    assert client.post("/api/reset", json={"confirm": "RESET"}).status_code == 200
    assert client.get("/api/collections").get_json()["collections"] == []

    assert client.post("/api/import", json=backup).get_json()["imported"] == 2
    listed = {x["name"]: x for x in client.get("/api/collections").get_json()["collections"]}
    assert sorted(listed["Comfort shows"]["mal_ids"]) == [1, 2]
    assert listed["Comfort shows"]["color"] == "#112233"
    assert listed["Empty one"]["mal_ids"] == []

    # importing the same file again doesn't duplicate anything
    client.post("/api/import", json=backup)
    assert len(client.get("/api/collections").get_json()["collections"]) == 2


def test_old_backup_without_collections_still_imports(client):
    add(client, 1)
    backup = client.get("/api/export").get_json()
    backup.pop("collections")
    assert client.post("/api/import", json=backup).status_code == 200
    backup["collections"] = [{"name": ""}, "junk", {"name": "Fine", "mal_ids": [1, "x", True]}]
    assert client.post("/api/import", json=backup).status_code == 200  # damaged ones are skipped
    listed = client.get("/api/collections").get_json()["collections"]
    assert [(c["name"], c["mal_ids"]) for c in listed] == [("Fine", [1])]


# ------------------------------------------------------------------ bulk edit
def bulk(client, **payload):
    return client.post("/api/library/bulk", json=payload)


def entries_by_id(client):
    return {e["mal_id"]: e for e in client.get("/api/library").get_json()["entries"]}


def test_bulk_status_fills_dates(client):
    add(client, 1)
    add(client, 2)
    r = bulk(client, ids=[1, 2, 999], action="status", value="completed")
    data = r.get_json()
    assert r.status_code == 200
    assert sorted(data["changed"]) == [1, 2] and data["missing"] == [999]
    entries = entries_by_id(client)
    assert all(e["status"] == "completed" and e["finished_on"] and e["started_on"] for e in entries.values())
    # same status again: nothing to change
    assert bulk(client, ids=[1], action="status", value="completed").get_json()["skipped"] == [1]


def test_bulk_tier_and_clear(client):
    add(client, 1)
    add(client, 2)
    bulk(client, ids=[1, 2], action="tier", value="A")
    assert {e["tier"] for e in entries_by_id(client).values()} == {"A"}
    bulk(client, ids=[1], action="tier", value=None)
    assert entries_by_id(client)[1]["tier"] is None


def test_bulk_watch_all_skips_unknown_totals(client):
    add(client, 1)               # 12 episodes
    add(client, 3, "watching")   # airing, total unknown
    data = bulk(client, ids=[1, 3], action="watch_all").get_json()
    assert data["changed"] == [1] and data["skipped"] == [3]
    one = entries_by_id(client)[1]
    assert one["watched_count"] == 12 and one["status"] == "completed" and one["finished_on"]
    # 12 episodes <= 25, so they count as today's activity like a normal "mark all"
    assert sum(1 for line in client.get("/api/export").get_json()["watch_log"] if line["mal_id"] == 1) == 12


def test_bulk_watch_all_big_catch_up_is_not_logged(client, shelf):
    add(client, 2)  # 24 episodes
    client.patch("/api/library/2", json={"total_override": 30})
    bulk(client, ids=[2], action="watch_all")
    assert entries_by_id(client)[2]["watched_count"] == 30
    assert [line for line in shelf.db.watch_log() if line["mal_id"] == 2] == []


def test_bulk_collection_and_remove(client):
    add(client, 1)
    add(client, 2)
    c = new_collection(client, "Friends")
    assert bulk(client, ids=[1, 2], action="collection", value=c["id"]).status_code == 200
    assert sorted(client.get("/api/collections").get_json()["collections"][0]["mal_ids"]) == [1, 2]
    assert bulk(client, ids=[1], action="collection", value=999).status_code == 400

    data = bulk(client, ids=[1, 2], action="remove").get_json()
    assert sorted(data["changed"]) == [1, 2]
    assert entries_by_id(client) == {}
    assert client.get("/api/collections").get_json()["collections"][0]["mal_ids"] == []


def test_bulk_status_cancels_rewatch(client):
    add(client, 1, "completed")
    client.post("/api/library/1/rewatch", json={"action": "start"})
    bulk(client, ids=[1], action="status", value="on_hold")
    entry = entries_by_id(client)[1]
    assert entry["status"] == "on_hold" and entry["rewatching"] is False


def test_bulk_validation(client):
    add(client, 1)
    assert bulk(client, ids=[], action="tier", value="A").status_code == 400
    assert bulk(client, ids=list(range(1, 502)), action="tier", value="A").status_code == 400  # hard cap
    assert bulk(client, ids=["1"], action="tier", value="A").status_code == 400
    assert bulk(client, ids=[1], action="explode").status_code == 400
    assert bulk(client, ids=[1], action="status", value="finished").status_code == 400
    assert bulk(client, ids=[1], action="tier", value="Z").status_code == 400
    assert bulk(client, ids=[1], action="collection", value=True).status_code == 400
    assert client.post("/api/library/bulk", json=[1, 2]).status_code == 400


def test_bulk_is_all_or_nothing(tmp_path, jikan, anilist, mangadex, monkeypatch):
    """If something breaks halfway, the whole batch is rolled back."""
    from anishelf import bulk as bulk_module

    shelf = AniShelf(Database(tmp_path / "t.db"), jikan, anilist, rng=random.Random(1), mangadex=mangadex)
    shelf.add(1, "plan_to_watch")
    shelf.add(2, "plan_to_watch")
    calls = {"n": 0}
    real_update = bulk_module._update

    def flaky_update(conn, mal_id, fields, now):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk on fire")
        real_update(conn, mal_id, fields, now)

    monkeypatch.setattr(bulk_module, "_update", flaky_update)
    try:
        bulk_module.apply(shelf.db, {"ids": [1, 2], "action": "status", "value": "dropped"})
    except RuntimeError:
        pass
    assert {row["status"] for row in shelf.db.all()} == {"plan_to_watch"}
