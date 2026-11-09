"""Volumes read -> chapters (anishelf/mangadex.py + the "volumes" progress action in manga.py)."""

import time

import pytest

from anishelf import manga, mangadex
from anishelf.clients import ApiError
from anishelf.logic import ValidationError

# A MangaDex /aggregate answer: dicts of dicts with TEXT keys, like the real API.
AGGREGATE = {
    "result": "ok",
    "volumes": {
        "none": {"volume": "none", "chapters": {"30": {"chapter": "30"}, "31": {"chapter": "31"}}},
        "1": {"volume": "1", "chapters": {"2": {}, "1": {}, "3": {}, "0": {}}},
        "2": {"volume": "2", "chapters": {"4": {}, "10.5": {}, "10": {}}},   # ends with extra chapter 10.5
        "3": {"volume": "3", "chapters": {"11": {}, "Oneshot": {}, "15": {}}},
        "5": {"volume": "5", "chapters": {"20": {}}},     # gap: volume 4 is missing
        "7": {"volume": "7", "chapters": {"25": {}, "28": {}}},  # newest volume
        "1.5": {"volume": "1.5", "chapters": {"99": {}}},       # a special, not a real volume
    },
}


# ---------------------------------------------------------------- parsing (pure)
def test_parse_aggregate():
    ends = mangadex.parse_aggregate(AGGREGATE)
    # 1 -> 3 (volume 2 starts at 4); 2 -> 10 (10.5 is an extra, whole chapters only); 7 is the newest.
    # Volumes 3 and 5 are dropped: we can't see where they end (volumes 4 and 6 are missing).
    # "none" (not in a volume yet), "1.5" (a special) and the "Oneshot" chapter are ignored.
    assert ends == {1: 3, 2: 10, 7: 28}


def test_parse_aggregate_next_volume_decides_the_end():
    # MangaDex lists only chapters 1-2 for volume 1, but volume 2 starts at chapter 8
    data = {"volumes": {"1": {"chapters": {"1": {}, "2": {}}}, "2": {"chapters": {"8": {}, "9": {}}}}}
    assert mangadex.parse_aggregate(data) == {1: 7, 2: 9}


def test_parse_aggregate_ignores_misfiled_chapters():
    # real Chainsaw Man data: volume 1 also lists chapter 232, the newest volume lists a stray 203
    data = {"volumes": {
        "1": {"chapters": {c: {} for c in ("1", "2", "7", "7.5", "232")}},
        "2": {"chapters": {c: {} for c in ("8", "16", "16.5")}},
        "3": {"chapters": {c: {} for c in ("176", "180", "186", "203")}},
        "4": {"chapters": {"5": {}}},  # a volume that ends BEFORE the one before it: dropped
    }}
    # 3 has a next volume, but that one starts at 5 (odd), so 3 uses its own run: 176, 180 (186 is a jump)
    assert mangadex.parse_aggregate(data) == {1: 7, 2: 175, 3: 180}


def test_parse_aggregate_empty_and_broken():
    assert mangadex.parse_aggregate({"result": "ok", "volumes": []}) == {}  # empty comes back as a list
    assert mangadex.parse_aggregate(None) == {}
    assert mangadex.parse_aggregate({"volumes": {"1": "junk", "2": {"chapters": []}}}) == {}
    assert mangadex.parse_aggregate({"volumes": {"none": {"chapters": {"5": {}}}}}) == {}


def test_find_manga_id_matches_anilist_then_mal():
    results = [
        {"id": "wrong", "attributes": {"links": {"al": "999", "mal": "55"}}},  # other manga, same MAL id
        {"id": "no-links", "attributes": {"links": None}},
        {"id": "empty-links", "attributes": {"links": []}},
        {"id": "by-mal", "attributes": {"links": {"mal": "55"}}},
        {"id": "by-al", "attributes": {"links": {"al": "100"}}},
    ]
    assert mangadex.find_manga_id(results, 100, 55) == "by-al"
    assert mangadex.find_manga_id(results[:4], 100, 55) == "by-mal"  # MAL only when there's no AniList link
    assert mangadex.find_manga_id(results[:1], 100, 55) is None
    assert mangadex.find_manga_id(results[:4], 100, None) is None
    assert mangadex.find_manga_id(None, 100, 55) is None


def test_chapter_for_volume_rules():
    finished = {"chapters": 120, "volumes": 12}
    assert manga.chapter_for_volume(5, {5: 42}, finished) == (42, "mangadex")
    assert manga.chapter_for_volume(5, {}, finished) == (50, "estimate")  # round(5 * 120 / 12)
    assert manga.chapter_for_volume(12, {12: 110}, finished) == (120, "anilist")  # last volume = final chapter
    assert manga.chapter_for_volume(5, {}, {"chapters": None, "volumes": None}) == (None, None)
    assert manga.chapter_for_volume(0, {1: 7}, finished) == (0, None)
    assert manga.volumes_passed(42, {4: 33, 5: 42, 6: 50}) == 5
    assert manga.volumes_passed(3, {4: 33}) == 0


# ---------------------------------------------------------------- the real client, with a fake session
class FakeResponse:
    def __init__(self, data, status=200):
        self.data, self.status_code = data, status

    def json(self):
        return self.data


class FakeSession:
    def __init__(self, search_results):
        self.headers = {}
        self.requests = []
        self.search_results = search_results

    def get(self, url, params=None, timeout=None):
        self.requests.append((url, params, timeout))
        if url.endswith("/aggregate"):
            return FakeResponse(AGGREGATE)
        return FakeResponse({"data": self.search_results})


def test_client_lookup_uses_at_most_three_requests():
    session = FakeSession([{"id": "md-1", "attributes": {"links": {"al": "100"}}}])
    client = mangadex.MangaDexClient(session=session)
    answer = client.volume_ends(100, None, ["Romaji", "English"])
    assert answer["found"] and answer["volumes"][0] == {"volume": 1, "last_chapter": 3}
    assert len(session.requests) == 2  # one search was enough + the aggregate
    assert all(timeout == 10 for _, _, timeout in session.requests)
    assert "AniShelf personal tracker" in session.headers["User-Agent"]
    assert session.requests[1][0] == "https://api.mangadex.org/manga/md-1/aggregate"

    # no match on any title: 2 searches max, never more than 3 requests
    session = FakeSession([{"id": "md-x", "attributes": {"links": {"al": "5"}}}])
    client = mangadex.MangaDexClient(session=session)
    assert client.volume_ends(100, None, ["a", "b", "c", "d"]) == {"found": False}
    assert len(session.requests) == 2


def test_request_budget_is_a_hard_cap():
    budget = mangadex.RequestBudget(1)
    budget.spend()
    with pytest.raises(ApiError):
        budget.spend()


# ---------------------------------------------------------------- the "volumes" progress action
def test_volumes_set_chapters_from_mangadex(shelf):
    shelf.manga.add(100, "plan_to_read")
    result = shelf.manga.change_progress(100, {"action": "volumes", "volumes": 1})
    entry = result["entry"]
    assert entry["volumes_read"] == 1 and entry["chapters_read"] == 4  # fake MangaDex: vol 1 ends at ch 4
    assert result["status_changed"] == "reading" and entry["started_on"]
    assert result["chapters_from_volumes"] == {"volume": 1, "chapter": 4, "source": "mangadex",
                                               "estimated": False, "kept_higher": False}
    with shelf.db.connect() as conn:  # logged like a set
        assert [r["chapter"] for r in conn.execute("SELECT chapter FROM manga_log ORDER BY chapter")] == [1, 2, 3, 4]


def test_volumes_never_lower_chapters(shelf):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 7})
    result = shelf.manga.change_progress(100, {"action": "volumes", "volumes": 1})
    assert result["entry"]["chapters_read"] == 7  # you were ahead of volume 1's end (ch 4): kept
    assert result["entry"]["volumes_read"] == 1
    assert result["chapters_from_volumes"]["kept_higher"] is True


def test_estimate_when_mangadex_has_no_map(shelf, mangadex):
    mangadex.answers = {}
    shelf.manga.add(100, "reading")
    result = shelf.manga.change_progress(100, {"action": "volumes", "volumes": 1})
    assert result["entry"]["chapters_read"] == 5  # round(1 * 10 chapters / 2 volumes)
    assert result["chapters_from_volumes"]["source"] == "estimate"
    assert result["chapters_from_volumes"]["estimated"] is True


def test_last_volume_completes(shelf):
    shelf.manga.add(100, "reading")
    result = shelf.manga.change_progress(100, {"action": "volumes", "volumes": 2})
    entry = result["entry"]
    assert entry["chapters_read"] == 10 and entry["status"] == "completed" and entry["finished_on"]
    assert result["status_changed"] == "completed"


def test_ongoing_without_map_only_saves_volumes(shelf, mangadex):
    shelf.manga.add(200, "plan_to_read")
    result = shelf.manga.change_progress(200, {"action": "volumes", "volumes": 3})
    assert result["entry"]["volumes_read"] == 3 and result["entry"]["chapters_read"] == 0
    assert result["entry"]["status"] == "reading"  # you started it
    assert result["chapters_from_volumes"] == {"volume": 3, "chapter": None, "source": None,
                                               "estimated": False, "kept_higher": False}


def test_volumes_validation(shelf, mangadex):
    shelf.manga.add(100, "reading")
    shelf.manga.add(200, "reading")
    for bad in (-1, True, "2", 2.5, None, 3):  # 3: manga 100 only has 2 volumes
        with pytest.raises(ValidationError):
            shelf.manga.change_progress(100, {"action": "volumes", "volumes": bad})
    with pytest.raises(ValidationError):  # ongoing: no known total, but still capped
        shelf.manga.change_progress(200, {"action": "volumes", "volumes": 1001})
    assert mangadex.calls == 0  # bad input never reaches MangaDex
    with pytest.raises(manga.MangaNotInLibrary):
        shelf.manga.change_progress(999, {"action": "volumes", "volumes": 1})


def test_volume_zero_keeps_chapters(shelf, mangadex):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 3})
    entry = shelf.manga.change_progress(100, {"action": "volumes", "volumes": 0})["entry"]
    assert entry["volumes_read"] == 0 and entry["chapters_read"] == 3
    assert mangadex.calls == 0


# ---------------------------------------------------------------- caching
def _age_cache(shelf, key, seconds):
    with shelf.db.connect() as conn:
        conn.execute("UPDATE api_cache SET fetched_at = ? WHERE key = ?", (time.time() - seconds, key))


def test_map_is_cached_for_a_week(shelf, mangadex):
    shelf.manga.volume_info(100)
    shelf.manga.volume_info(100)
    assert mangadex.calls == 1
    _age_cache(shelf, "mangadex:volumes:100", 3 * 86400)  # 3 days old: still fresh
    shelf.manga.volume_info(100)
    assert mangadex.calls == 1
    _age_cache(shelf, "mangadex:volumes:100", 8 * 86400)  # 8 days old: asked again
    shelf.manga.volume_info(100)
    assert mangadex.calls == 2


def test_not_found_is_cached_for_a_day(shelf, mangadex):
    shelf.manga.volume_info(200)
    shelf.manga.volume_info(200)
    assert mangadex.calls == 1
    _age_cache(shelf, "mangadex:volumes:200", 2 * 86400)  # "not found" only lasts a day
    shelf.manga.volume_info(200)
    assert mangadex.calls == 2


def test_mangadex_down_falls_back_without_caching(shelf, mangadex):
    mangadex.fail = True
    info = shelf.manga.volume_info(100)
    assert info["source"] == "estimate" and info["volumes"][0] == {"volume": 1, "last_chapter": 5, "source": "estimate"}
    mangadex.fail = False
    assert shelf.manga.volume_info(100)["source"] == "mangadex"  # the failure wasn't remembered
    assert mangadex.calls == 2


def test_volume_info_shapes(shelf):
    info = shelf.manga.volume_info(100)
    # volume 1 from MangaDex; volume 2 is the last one, so it ends at the final chapter
    assert info["volumes"] == [{"volume": 1, "last_chapter": 4, "source": "mangadex"},
                               {"volume": 2, "last_chapter": 10, "source": "anilist"}]
    assert shelf.manga.volume_info(200) == {"anilist_id": 200, "source": None, "volumes": [],
                                            "total_volumes": None, "total_chapters": None}


# ---------------------------------------------------------------- chapters -> volumes
def test_passing_a_volume_end_updates_volumes(shelf, mangadex):
    shelf.manga.add(100, "reading")
    shelf.manga.change_progress(100, {"action": "set", "chapter": 3})
    assert shelf.manga.get(100)["volumes_read"] == 0  # no map cached yet, and no network on +1
    assert mangadex.calls == 0
    shelf.manga.volume_info(100)  # the page loads the map (cached)
    entry = shelf.manga.change_progress(100, {"action": "increment"})["entry"]
    assert entry["chapters_read"] == 4 and entry["volumes_read"] == 1
    entry = shelf.manga.change_progress(100, {"action": "set", "chapter": 2})["entry"]
    assert entry["volumes_read"] == 1  # undo never lowers volumes
    entry = shelf.manga.change_progress(100, {"action": "set", "chapter": 10})["entry"]
    assert entry["volumes_read"] == 2  # the final chapter means every volume


# ---------------------------------------------------------------- HTTP
def test_http_volumes(client):
    client.post("/api/manga", json={"anilist_id": 100, "status": "plan_to_read"})
    info = client.get("/api/manga/100/volumes").get_json()
    assert info["source"] == "mangadex" and info["volumes"][0]["last_chapter"] == 4
    assert client.get("/api/manga/999/volumes").status_code == 404
    res = client.put("/api/manga/100/progress", json={"action": "volumes", "volumes": 1}).get_json()
    assert res["entry"]["chapters_read"] == 4 and res["chapters_from_volumes"]["source"] == "mangadex"
    assert client.put("/api/manga/100/progress", json={"action": "volumes", "volumes": 9}).status_code == 400
