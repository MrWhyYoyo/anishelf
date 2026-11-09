import pytest

from anishelf import franchise
from anishelf.logic import ValidationError


def media(mal_id, fmt, year, rels, english=None):
    return {"idMal": mal_id, "format": fmt, "episodes": 12, "title": {"romaji": f"R{mal_id}", "english": english},
            "startDate": {"year": year, "month": 4, "day": 1}, "coverImage": {"large": None},
            "relations": {"edges": [{"relationType": r, "node": {"idMal": i, "type": t, "format": f}} for r, i, t, f in rels]}}


def test_node_only_follows_main_story():
    node = franchise.node_from_media(media(1, "TV", 2013, [
        ("SEQUEL", 2, "ANIME", "TV"), ("PREQUEL", 3, "ANIME", "OVA"), ("SPIN_OFF", 4, "ANIME", "TV"),
        ("SOURCE", 5, "MANGA", "MANGA"), ("SEQUEL", 6, "ANIME", "MOVIE"), ("ALTERNATIVE", 7, "ANIME", "MOVIE"),
        ("SEQUEL", None, "ANIME", "TV"),
    ], english="Attack on Titan"))
    assert node["neighbours"] == [2, 6] and node["title_english"] == "Attack on Titan"
    assert franchise.node_from_media({"idMal": None}) is None


def test_walk_and_order_labels():
    graph = {
        10: franchise.node_from_media(media(10, "TV", 2017, [("PREQUEL", 9, "ANIME", "TV"), ("SEQUEL", 11, "ANIME", "MOVIE")])),
        9: franchise.node_from_media(media(9, "TV", 2013, [("SEQUEL", 10, "ANIME", "TV")])),
        11: franchise.node_from_media(media(11, "MOVIE", 2019, [("PREQUEL", 10, "ANIME", "TV"), ("SEQUEL", 12, "ANIME", "TV")])),
        12: franchise.node_from_media(media(12, "TV", 2021, [("PREQUEL", 11, "ANIME", "MOVIE")])),
    }
    nodes = franchise.order(franchise.walk(10, graph.get))  # start in the middle
    assert [(n["mal_id"], n["label"]) for n in nodes] == [(9, "Season 1"), (10, "Season 2"), (11, "Movie"), (12, "Season 3")]
    assert "neighbours" not in nodes[0]


def test_walk_is_capped():
    chain = {i: {"mal_id": i, "format": "TV", "neighbours": [i + 1], "start": f"{2000 + i}-01-01"} for i in range(1, 100)}
    assert len(franchise.walk(1, chain.get, max_nodes=15)) == 15


def test_seasons_service_and_library_grouping(shelf):
    shelf.add(1, "completed")
    shelf.add(2, "watching")
    assert all(e["franchise"] is None for e in shelf.library())  # not grouped until computed
    result = shelf.seasons(2)
    assert result["franchise_id"] == 1 and result["title_english"] == "Show One"
    assert [(s["mal_id"], s["label"], s["is_current"], s["library_status"]) for s in result["seasons"]] == [
        (1, "Season 1", False, "completed"), (2, "Season 2", True, "watching"), (4, "Movie", False, None)]
    refs = {e["mal_id"]: e["franchise"] for e in shelf.library()}
    assert refs[1]["id"] == refs[2]["id"] == 1 and refs[2]["label"] == "Season 2" and refs[2]["size"] == 3


def test_single_show_is_a_series_of_one(shelf):
    result = shelf.seasons(3)  # AniList knows no relations for 3
    assert result["franchise_id"] == 3 and len(result["seasons"]) == 1 and result["seasons"][0]["label"] == "Season 1"


def test_backfill_groups_library_in_background(shelf):
    shelf.add(1)
    shelf.add(3)
    assert shelf.backfill_franchises() == 2
    assert all(e["franchise"] for e in shelf.library())
    assert shelf.backfill_franchises() == 0  # nothing left to do


def test_title_language(shelf):
    assert shelf.me()["title_language"] == "english"
    assert shelf.update_me({"title_language": "romaji"})["title_language"] == "romaji"
    with pytest.raises(ValidationError):
        shelf.update_me({"title_language": "klingon"})


def test_reset_everything(shelf):
    shelf.add(1)
    shelf.change_episodes(1, {"action": "up_to", "episode": 3})
    shelf.update_me({"display_name": "Yassin"})
    shelf.search("show")  # fills the cache
    with pytest.raises(ValidationError):
        shelf.reset_everything("yes")
    shelf.reset_everything("RESET")
    assert shelf.library() == [] and shelf.db.watch_log() == [] and shelf.me()["display_name"] == "Anime Fan"
    assert shelf.profile()["xp"] == 0
    assert shelf.db.cache_get("search:show", None) is not None  # anime info cache kept


def test_round4_endpoints(client):
    client.post("/api/library", json={"mal_id": 2})
    assert client.get("/api/anime/2/seasons").get_json()["franchise_id"] == 1
    assert client.post("/api/reset", json={"confirm": "nope"}).status_code == 400
    assert client.post("/api/reset", json={"confirm": "RESET"}).get_json() == {"ok": True}
    assert client.get("/api/library").get_json()["entries"] == []


def test_season_labels_follow_official_titles():
    titles = ["Attack on Titan", "Attack on Titan Season 2", "Attack on Titan Season 3",
              "Attack on Titan Season 3 Part 2", "Attack on Titan Final Season", "Attack on Titan Final Season Part 2"]
    season, labels = 0, []
    for t in titles:
        label, season = franchise.season_label(t, season)
        labels.append(label)
    assert labels == ["Season 1", "Season 2", "Season 3", "Season 3 Part 2", "Final Season", "Final Season Part 2"]
    assert franchise.season_label("Sousou no Frieren 3rd Season", 2) == ("Season 3", 3)
    assert franchise.season_label("Mob Psycho 100 II", 1) == ("Season 2", 2)
    assert franchise.season_label("Spy x Family Part 2", 1) == ("Season 1 Part 2", 1)
