"""Manga tracking (anishelf/manga.py): parsing, the shelf, chapter progress, backup, stats and XP."""

from datetime import date

import pytest

from anishelf import manga
from anishelf.clients import ApiError
from anishelf.logic import ValidationError
from conftest import FakeAniList

TODAY = date.today().isoformat()


# ---------------------------------------------------------------- parsing (pure)
def test_normalize_full_manga():
    meta = manga.normalize_manga(FakeAniList.raw_manga(100, id_mal=55))
    assert meta["anilist_id"] == 100 and meta["id_mal"] == 55
    assert meta["title"] == "Manga 100" and meta["title_english"] == "Manga 100 EN"
    assert meta["chapters"] == 10 and meta["volumes"] == 2 and meta["finished"] is True
    assert meta["anilist_score"] == 8.7
    assert meta["color"] == "#e4a15d"
    assert meta["synopsis"] == "A manga story.\nLine two."
    # only Story/Art staff count as authors
    assert meta["authors"] == [{"id": 7, "name": "Mangaka One", "role": "Story & Art"}]


def test_ongoing_manga_has_no_totals():
    meta = manga.normalize_manga(FakeAniList.raw_manga(200, status="RELEASING", chapters=120, volumes=9))
    assert meta["chapters"] is None and meta["volumes"] is None
    assert meta["publishing_status"] == "Publishing"


def test_adult_and_broken_media_are_skipped():
    assert manga.normalize_manga(FakeAniList.raw_manga(300, is_adult=True)) is None
    assert manga.normalize_manga({"id": None}) is None
    assert manga.normalize_manga(None) is None


def test_reading_links_only_official_hosts():
    links = manga.reading_links(FakeAniList.raw_manga(100)["externalLinks"])
    # the fake "MANGA Plus" host and the SOCIAL link are dropped; http becomes https
    assert links == [
        {"site": "MANGA Plus", "url": "https://mangaplus.shueisha.co.jp/titles/1"},
        {"site": "Viz", "url": "https://www.viz.com/manga-books/x"},
    ]
    assert manga.reader_name("https://notviz.com/x") is None


def test_adaptations_need_anime_with_mal_id():
    adaptations = manga.parse_adaptations(FakeAniList.raw_manga(100)["relations"])
    assert [a["mal_id"] for a in adaptations] == [1]  # SEQUEL and the one without a MAL id are skipped
    assert adaptations[0]["relation"] == "ADAPTATION"


def test_parse_source_finds_the_manga():
    source = manga.parse_source(FakeAniList().anime_source(1))
    assert source["anilist_id"] == 100
    assert manga.parse_source(None) is None
    assert manga.parse_source({"relations": {"edges": [{"relationType": "SOURCE", "node": {"type": "NOVEL"}}]}}) is None


def test_auto_status_rules():
    assert manga.auto_status("plan_to_read", 1, None) == "reading"
    assert manga.auto_status("on_hold", 3, 10) == "reading"
    assert manga.auto_status("reading", 10, 10) == "completed"
    assert manga.auto_status("dropped", 5, 10) == "dropped"
    assert manga.auto_status("reading", 500, None) == "reading"  # ongoing: never auto-completes


def test_validate_patch():
    assert manga.validate_patch({"score": 8, "notes": "hi", "started_on": "2026-01-02"}) == {
        "score": 8, "notes": "hi", "started_on": "2026-01-02"}
    assert manga.validate_patch({"score": None, "finished_on": ""}) == {"score": None, "finished_on": None}
    for bad in ({"score": 11}, {"score": True}, {"status": "watching"}, {"started_on": "yesterday"},
                {"volumes_read": -1}, {"notes": 5}, {"chapters": 3}, "nope"):
        with pytest.raises(ValidationError):
            manga.validate_patch(bad)


# ---------------------------------------------------------------- search + add
def test_search_filters_adult_and_is_cached(shelf, anilist):
    results = shelf.manga.search("frieren")
    assert [m["anilist_id"] for m in results] == [100, 200]
    assert all(m["library_status"] is None for m in results)
    shelf.manga.search("Frieren")  # same query, different case: from the cache
    assert anilist.manga_calls == 1


def test_search_validation(shelf):
    with pytest.raises(ValidationError):
        shelf.manga.search("a")
    with pytest.raises(ValidationError):
        shelf.manga.search("x" * 101)


def test_add_and_library(shelf):
    entry = shelf.manga.add(100, "plan_to_read")
    assert entry["status"] == "plan_to_read" and entry["chapters_read"] == 0
    assert entry["total_chapters"] == 10 and entry["id_mal"] == 55
    assert entry["started_on"] is None
    reading = shelf.manga.add(200, "reading")
    assert reading["started_on"] == TODAY and reading["total_chapters"] is None
    assert sorted(e["anilist_id"] for e in shelf.manga.library()) == [100, 200]
    assert [e["anilist_id"] for e in shelf.manga.library("reading")] == [200]
    assert shelf.manga.search("frieren")[0]["library_status"] == "plan_to_read"


def test_add_validation(shelf):
    for bad_id in (0, -1, True, "100", None):
        with pytest.raises(ValidationError):
            shelf.manga.add(bad_id)
    with pytest.raises(ValidationError):
        shelf.manga.add(100, "watching")


# ---------------------------------------------------------------- progress + auto status
def test_first_chapter_starts_reading(shelf):
    shelf.manga.add(100, "plan_to_read")
    result = shelf.manga.change_progress(100, {"action": "increment"})
    assert result["status_changed"] == "reading"
    assert result["entry"]["chapters_read"] == 1 and result["entry"]["started_on"] == TODAY


def test_last_chapter_completes_finished_manga(shelf):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 9})
    result = shelf.manga.change_progress(100, {"action": "increment"})
    assert result["status_changed"] == "completed"
    entry = result["entry"]
    assert entry["status"] == "completed" and entry["finished_on"] == TODAY and entry["progress"] == 1.0
    with pytest.raises(ValidationError):  # can't read past the last chapter
        shelf.manga.change_progress(100, {"action": "increment"})


def test_ongoing_manga_never_auto_completes(shelf):
    shelf.manga.add(200, "reading")
    result = shelf.manga.change_progress(200, {"action": "set", "chapter": 500})
    assert result["entry"]["status"] == "reading" and result["entry"]["progress"] is None


def test_progress_validation(shelf):
    shelf.manga.add(100)
    for body in ({"action": "set", "chapter": -1}, {"action": "set", "chapter": "5"}, {"action": "jump"},
                 {"action": "set", "chapter": 11}, "x"):
        with pytest.raises(ValidationError):
            shelf.manga.change_progress(100, body)
    with pytest.raises(manga.MangaNotInLibrary):
        shelf.manga.change_progress(999, {"action": "increment"})


def test_reading_log_follows_chapters(shelf):
    shelf.manga.add(200, "reading")
    shelf.manga.change_progress(200, {"action": "set", "chapter": 3})
    with shelf.db.connect() as conn:
        assert [r["chapter"] for r in conn.execute("SELECT chapter FROM manga_log ORDER BY chapter")] == [1, 2, 3]
    shelf.manga.change_progress(200, {"action": "set", "chapter": 1})  # going back un-logs 2 and 3
    shelf.manga.change_progress(200, {"action": "set", "chapter": 400})  # a big jump isn't "today's reading"
    with shelf.db.connect() as conn:
        assert [r["chapter"] for r in conn.execute("SELECT chapter FROM manga_log")] == [1]


def test_patch_fields_and_dates(shelf):
    shelf.manga.add(100, "plan_to_read")
    entry = shelf.manga.update(100, {"score": 9, "notes": "Great", "volumes_read": 1})
    assert entry["score"] == 9 and entry["notes"] == "Great" and entry["volumes_read"] == 1
    entry = shelf.manga.update(100, {"status": "completed"})
    assert entry["started_on"] == TODAY and entry["finished_on"] == TODAY
    with pytest.raises(ValidationError):
        shelf.manga.update(100, {"volumes_read": 3})  # it only has 2 volumes
    with pytest.raises(manga.MangaNotInLibrary):
        shelf.manga.update(999, {"score": 5})


def test_remove(shelf):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "increment"})
    shelf.manga.remove(100)
    assert shelf.manga.library() == []
    with shelf.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM manga_log").fetchone()[0] == 0
    with pytest.raises(manga.MangaNotInLibrary):
        shelf.manga.remove(100)


# ---------------------------------------------------------------- page + anime links
def test_page_lists_adaptations_with_library_status(shelf):
    shelf.add(1, "watching")
    page = shelf.manga.page(100)
    assert page["entry"] is None
    assert page["meta"]["reading"][0]["site"] == "MANGA Plus"
    assert page["adaptations"][0]["mal_id"] == 1 and page["adaptations"][0]["library_status"] == "watching"


def test_anime_source_is_cached(shelf, anilist):
    first = shelf.manga.anime_source(1)
    assert first["source"]["anilist_id"] == 100 and first["source"]["library_status"] is None
    calls = anilist.calls
    shelf.manga.anime_source(1)
    assert anilist.calls == calls  # from the cache
    assert shelf.manga.anime_source(2) == {"source": None}


def test_stale_cache_when_anilist_is_down(shelf, anilist):
    shelf.manga.meta(100)
    anilist.fail = True
    assert shelf.manga.meta(100, force=True)["anilist_id"] == 100
    with pytest.raises(ApiError):
        shelf.manga.meta(200)


# ---------------------------------------------------------------- stats + XP
def test_stats_key_and_existing_keys_kept(shelf):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 10})  # completes it
    shelf.manga.add(200, "reading")
    shelf.manga.change_progress(200, {"action": "set", "chapter": 4})
    stats = shelf.stats()
    assert "episodes_watched" in stats and "status_counts" in stats
    assert stats["manga"]["chapters_read"] == 14
    assert stats["manga"]["completed"] == 1 and stats["manga"]["reading"] == 1
    assert stats["manga"]["chapters_last_30_days"] == 14


def test_manga_xp_line(shelf):
    def manga_xp():
        return next(b["xp"] for b in shelf.profile()["breakdown"] if b["label"] == "Manga")

    assert manga_xp() == 0
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 3})
    assert manga_xp() == 3 * 2
    shelf.manga.change_progress(100, {"action": "set", "chapter": 10})
    assert manga_xp() == 10 * 2 + 40
    # anime XP is unchanged: no episodes, no anime XP
    assert next(b["xp"] for b in shelf.profile()["breakdown"] if b["label"] == "Episodes watched") == 0


# ---------------------------------------------------------------- backup + reset
def test_export_import_round_trip(shelf, tmp_path, jikan, anilist):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 4})
    shelf.manga.update(100, {"score": 8, "notes": "Keep going"})
    backup = shelf.db.export()
    assert len(backup["manga"]["entries"]) == 1 and len(backup["manga"]["log"]) == 4

    from anishelf.db import Database
    from anishelf.service import AniShelf
    fresh = AniShelf(Database(tmp_path / "fresh.db"), jikan, anilist)
    fresh.db.import_backup(backup)
    fresh.db.import_backup(backup)  # importing twice doesn't duplicate the log
    entry = fresh.manga.library()[0]
    assert entry["anilist_id"] == 100 and entry["chapters_read"] == 4 and entry["score"] == 8
    assert entry["notes"] == "Keep going" and entry["id_mal"] == 55
    assert fresh.stats()["manga"]["chapters_last_30_days"] == 4


def test_import_without_manga_and_damaged_manga(shelf):
    backup = shelf.db.export()
    del backup["manga"]
    assert shelf.db.import_backup(backup) == 0  # older backups still import
    damaged = shelf.db.export()
    damaged["manga"] = {"entries": [{"anilist_id": 5, "meta": {"anilist_id": 6}, "status": "reading"}]}
    with pytest.raises(ValidationError):
        shelf.db.import_backup(damaged)


def test_reset_clears_manga(shelf):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "increment"})
    shelf.reset_everything("RESET")
    assert shelf.manga.library() == []
    assert shelf.stats()["manga"]["chapters_read"] == 0


# ---------------------------------------------------------------- HTTP endpoints
def test_http_flow(client):
    assert client.get("/api/manga/search?q=fr").get_json()["results"][0]["anilist_id"] == 100
    assert client.post("/api/manga", json={"anilist_id": 100, "status": "plan_to_read"}).status_code == 200
    assert client.post("/api/manga", json={"anilist_id": "x"}).status_code == 400
    assert client.post("/api/manga", json={"anilist_id": 999}).status_code == 404
    res = client.put("/api/manga/100/progress", json={"action": "increment"}).get_json()
    assert res["status_changed"] == "reading"
    assert client.patch("/api/manga/100", json={"score": 7}).get_json()["entry"]["score"] == 7
    assert client.patch("/api/manga/100", json={"score": 70}).status_code == 400
    page = client.get("/api/manga/100").get_json()
    assert page["entry"]["chapters_read"] == 1 and page["adaptations"][0]["mal_id"] == 1
    assert client.get("/api/manga/999").status_code == 404
    assert client.get("/api/manga?status=reading").get_json()["entries"][0]["anilist_id"] == 100
    assert client.get("/api/manga?status=bogus").status_code == 400
    assert client.get("/api/anime/1/source").get_json()["source"]["library_status"] == "reading"
    assert client.get("/api/stats").get_json()["manga"]["chapters_read"] == 1
    assert client.delete("/api/manga/100").get_json() == {"ok": True}
    assert client.delete("/api/manga/100").status_code == 404
    assert client.patch("/api/manga/100", json={"score": 7}).status_code == 404
