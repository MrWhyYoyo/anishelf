"""Tests for the seasonal chart, the Up Next queue and the taste profile."""

import sqlite3
from datetime import date

import pytest

from anishelf import seasonal, taste, upnext
from anishelf.clients import ApiError
from anishelf.db import Database
from anishelf.logic import ValidationError

TODAY = date(2026, 11, 9)  # Fall 2026


# ====================================================================== seasonal chart
def raw_media(mal_id, popularity=1000, fmt="TV", month=10, day=5, adult=False, airing_at=None):
    """A raw AniList media object, as season_page() returns it."""
    return {
        "id": mal_id + 1000, "idMal": mal_id, "isAdult": adult,
        "title": {"romaji": f"Show {mal_id}", "english": None, "native": None},
        "coverImage": {"extraLarge": f"https://s4.anilist.co/{mal_id}.jpg", "large": None, "color": "#112233"},
        "bannerImage": None, "format": fmt, "episodes": 12, "duration": 24, "status": "RELEASING",
        "season": "FALL", "seasonYear": 2026, "startDate": {"year": 2026, "month": month, "day": day},
        "genres": ["Action"], "studios": {"nodes": [{"name": "Studio X"}]}, "description": "Story",
        "averageScore": 80, "popularity": popularity, "siteUrl": "", "trailer": None,
        "nextAiringEpisode": {"episode": 3, "airingAt": airing_at} if airing_at else None, "externalLinks": [],
    }


@pytest.fixture
def season_api(anilist):
    """Give the fake AniList a season_page() and count the pages asked for."""
    anilist.season_pages = []

    def season_page(season, year, page, per_page):
        anilist._fallback()
        anilist.season_pages.append((season, year, page))
        if page == 1:
            return {"media": [raw_media(1, 900, airing_at=1999999999), raw_media(2, 800, fmt="MOVIE"),
                              raw_media(60, 700, adult=True), {**raw_media(0), "idMal": None}],
                    "has_next": True}
        return {"media": [raw_media(70, 100, fmt="ONA", month=None, day=None)], "has_next": True}

    anilist.season_page = season_page
    return anilist


def test_season_index_round_trips_across_years():
    assert seasonal.from_index(seasonal.season_index("fall", 2026) + 1) == {"season": "winter", "year": 2027}
    assert seasonal.from_index(seasonal.season_index("winter", 2026) - 1) == {"season": "fall", "year": 2025}


def test_pick_season_defaults_and_limits():
    assert seasonal.pick_season(None, None, TODAY) == {"season": "fall", "year": 2026}
    assert seasonal.pick_season("Winter", "2027", TODAY) == {"season": "winter", "year": 2027}
    with pytest.raises(ValidationError):
        seasonal.pick_season("spring", "2027", TODAY)  # two seasons ahead
    with pytest.raises(ValidationError):
        seasonal.pick_season("summer", "2024", TODAY)  # 9 seasons back
    with pytest.raises(ValidationError):
        seasonal.pick_season("autumn", "2026", TODAY)
    with pytest.raises(ValidationError):
        seasonal.pick_season("fall", "soon", TODAY)


def test_pick_season_furthest_back_allowed():
    assert seasonal.pick_season("fall", "2024", TODAY) == {"season": "fall", "year": 2024}  # exactly 8 back


def test_season_chart_caps_pages_filters_and_caches(shelf, season_api):
    shelf.add(2, "completed")
    data = seasonal.season_chart(shelf, today=TODAY)
    assert data["label"] == "Fall 2026" and data["is_current"]
    assert data["prev"] == {"season": "summer", "year": 2026}
    assert data["next"] == {"season": "winter", "year": 2027}
    # adult show and the one without a MAL id are dropped; page 2 was fetched, page 3 never (cap)
    assert [item["mal_id"] for item in data["items"]] == [1, 2, 70]
    assert len(season_api.season_pages) == seasonal.MAX_PAGES
    assert data["truncated"] is True
    by_id = {item["mal_id"]: item for item in data["items"]}
    assert by_id[2]["library_status"] == "completed" and by_id[1]["library_status"] is None
    assert by_id[1]["start_date"] == "2026-10-05" and by_id[70]["start_date"] == "2026-99-99"
    assert by_id[1]["anilist"]["next_airing"]["airing_at"] == 1999999999
    assert by_id[2]["type"] == "Movie" and by_id[1]["popularity_rank"] == 1

    seasonal.season_chart(shelf, today=TODAY)  # second view: served from the cache
    assert len(season_api.season_pages) == seasonal.MAX_PAGES


def test_season_chart_edge_has_no_further_link(shelf, season_api):
    data = seasonal.season_chart(shelf, "winter", 2027, today=TODAY)
    assert data["next"] is None and data["prev"] == {"season": "fall", "year": 2026}


def test_season_chart_falls_back_to_discover_when_anilist_is_down(shelf, season_api):
    season_api.fail = True
    data = seasonal.season_chart(shelf, today=TODAY)
    assert data["source"] == "discover"
    assert [item["mal_id"] for item in data["items"]] == [1, 3]  # FakeJikan's season_now
    assert data["error"] is None


def test_season_route(client, season_api):
    resp = client.get("/api/season")
    assert resp.status_code == 200 and resp.get_json()["items"]
    assert client.get("/api/season?season=summer&year=1990").status_code == 400


# ====================================================================== Up Next queue
def queue_ids(shelf):
    return [e["mal_id"] for e in upnext.up_next(shelf)["entries"]]


def test_new_plans_go_to_the_bottom_and_leavers_lose_their_place(shelf):
    for mal_id in (1, 2, 3):
        shelf.add(mal_id, "plan_to_watch")
    assert queue_ids(shelf) == [1, 2, 3]
    shelf.update(1, {"status": "watching"})
    assert queue_ids(shelf) == [2, 3]
    shelf.update(1, {"status": "plan_to_watch"})  # coming back = bottom
    assert queue_ids(shelf) == [2, 3, 1]
    shelf.add(4, "plan_to_watch")
    assert queue_ids(shelf) == [2, 3, 1, 4]
    shelf.add(2, "plan_to_watch")  # adding again with the same status keeps the place
    assert queue_ids(shelf) == [2, 3, 1, 4]


def test_auto_status_change_drops_out_of_queue(shelf):
    shelf.add(1, "plan_to_watch")
    shelf.add(2, "plan_to_watch")
    shelf.change_episodes(1, {"action": "toggle", "episode": 1})  # plan_to_watch -> watching
    assert queue_ids(shelf) == [2]


def test_reorder_saves_and_validates(shelf):
    for mal_id in (1, 2, 3):
        shelf.add(mal_id, "plan_to_watch")
    result = upnext.reorder(shelf, [3, 1, 2])
    assert [e["mal_id"] for e in result["entries"]] == [3, 1, 2]
    assert [e["queue_position"] for e in result["entries"]] == [1, 2, 3]
    for bad in ([3, 1], [3, 1, 2, 2], [3, 1, 2, 4], [3, 1, True], "3,1,2", [3, 1, "2"]):
        with pytest.raises(ValidationError):
            upnext.reorder(shelf, bad)
    assert queue_ids(shelf) == [3, 1, 2]  # a refused order changes nothing


def test_queue_routes(client, shelf):
    for mal_id in (1, 2):
        shelf.add(mal_id, "plan_to_watch")
    assert [e["mal_id"] for e in client.get("/api/queue").get_json()["entries"]] == [1, 2]
    resp = client.put("/api/queue", json={"order": [2, 1]})
    assert resp.status_code == 200
    data = client.get("/api/queue?limit=1").get_json()
    assert [e["mal_id"] for e in data["entries"]] == [2] and data["total"] == 2
    assert client.put("/api/queue", json={"order": [2]}).status_code == 400
    assert client.put("/api/queue", json={"order": None}).status_code == 400


def test_queue_survives_export_import_and_reset(shelf, tmp_path):
    for mal_id in (1, 2, 3):
        shelf.add(mal_id, "plan_to_watch")
    upnext.reorder(shelf, [2, 3, 1])
    backup = shelf.db.export()
    assert {e["mal_id"]: e["queue_pos"] for e in backup["entries"]} == {2: 1, 3: 2, 1: 3}

    fresh = shelf.__class__(Database(tmp_path / "other.db"), shelf.jikan, shelf.anilist)
    fresh.db.import_backup(backup)
    assert queue_ids(fresh) == [2, 3, 1]

    shelf.reset_everything("RESET")
    assert queue_ids(shelf) == []


def test_queue_column_upgrade_is_idempotent(tmp_path):
    path = tmp_path / "old.db"
    Database(path)
    Database(path)  # opening twice must not fail on "duplicate column"
    with sqlite3.connect(path) as conn:
        columns = [row[1] for row in conn.execute("PRAGMA table_info(library)")]
    assert columns.count("queue_pos") == 1


# ====================================================================== taste profile
def lib_entry(mal_id, status="completed", score=None, watched=12, genres=("Action",), studios=("Studio X",),
              year=2015, season="fall", fmt="TV", mal_score=7.0):
    return {"mal_id": mal_id, "status": status, "score": score, "watched_count": watched,
            "meta": {"title": f"Show {mal_id}", "title_english": None, "image": None, "genres": list(genres),
                     "studios": list(studios), "year": year, "season": season, "type": fmt,
                     "mal_score": mal_score}}


def test_weight_rules():
    assert taste.weight(lib_entry(1, status="plan_to_watch", score=10)) == 0
    assert taste.weight(lib_entry(1, status="dropped", watched=0)) == 0
    assert taste.weight(lib_entry(1, status="dropped", watched=0, score=7)) == pytest.approx(1.0)  # scored from memory
    # Completed with no episodes ticked counts as the whole show
    assert taste.weight({**lib_entry(1, watched=0), "total": 12}) == taste.weight(lib_entry(1, watched=12))
    # a 10 counts more than an unscored show, which counts more than a 3
    assert taste.weight(lib_entry(1, score=10)) > taste.weight(lib_entry(1)) > taste.weight(lib_entry(1, score=3))
    # more episodes count more, but only logarithmically
    assert taste.weight(lib_entry(1, watched=100)) < 3 * taste.weight(lib_entry(1, watched=12))


def test_profile_picks_favourites_gems_and_hot_takes():
    entries = [
        lib_entry(1, score=10, genres=("Fantasy", "Drama"), studios=("Madhouse",), mal_score=7.5, year=2023),
        lib_entry(2, score=9, genres=("Fantasy",), studios=("Madhouse",), mal_score=8.8, year=2021),
        lib_entry(3, score=4, genres=("Action",), studios=("MAPPA",), mal_score=8.6, year=2019, season="spring"),
        lib_entry(4, score=8, genres=("Comedy",), fmt="Movie", mal_score=None, year=2005),
        lib_entry(5, status="plan_to_watch", score=None, genres=("Horror",)),
    ]
    p = taste.profile(entries)
    assert p["shows_counted"] == 4
    assert p["top_genres"][0]["name"] == "Fantasy" and p["top_genres"][0]["share"] == 1
    assert "Horror" not in [g["name"] for g in p["top_genres"]]
    assert p["top_studios"][0] == {**p["top_studios"][0], "name": "Madhouse", "shows": 2, "avg_score": 9.5}
    assert p["favourite_decade"]["name"] == "2020s"
    assert p["favourite_season"]["name"] == "fall"
    assert [g["mal_id"] for g in p["hidden_gems"]] == [1]
    assert p["hidden_gems"][0]["diff"] == 2.5
    assert [h["mal_id"] for h in p["hot_takes"]] == [3]
    assert p["you_vs_mal"]["count"] == 3  # show 4 has no MAL score
    assert {f["name"]: f["count"] for f in p["format_split"]} == {"TV": 3, "Movie": 1}
    assert p["summary"].startswith("You lean towards Fantasy")


def test_empty_library_profile():
    p = taste.profile([])
    assert p["shows_counted"] == 0 and p["top_genres"] == [] and p["you_vs_mal"] is None
    assert p["favourite_decade"] is None and p["summary"] == ""


def test_taste_route_makes_no_api_calls(client, shelf, jikan, anilist):
    shelf.add(1, "completed")
    shelf.update(1, {"score": 9})
    before = (jikan.calls, anilist.calls)
    data = client.get("/api/taste").get_json()
    assert (jikan.calls, anilist.calls) == before
    assert data["shows_counted"] == 1 and data["you_vs_mal"]["diff"] == 1.0
