"""Profile 1.1: banner, Top 5, badge showcase, favourite characters wall."""

import pytest

from anishelf import profile_extras
from anishelf.logic import (
    ValidationError, match_character, validate_banner, validate_profile, validate_showcase, validate_top5,
)

BANNER = {"mal_id": 3, "image": "https://s4.anilist.co/b.jpg", "position_y": 30, "color": "#ff8800"}


# ---------------------------------------------------------------- validation (pure logic)
def test_banner_validation_good():
    assert validate_banner(None) is None
    clean = validate_banner(BANNER)
    assert clean == {"mal_id": 3, "image": "https://s4.anilist.co/b.jpg", "position_y": 30.0, "color": "#ff8800"}
    # position defaults to the middle, colour is optional
    clean = validate_banner({"mal_id": 3, "image": "https://s4.anilist.co/b.jpg"})
    assert clean["position_y"] == 50.0 and clean["color"] is None
    assert validate_banner({**BANNER, "position_y": 0})["position_y"] == 0
    assert validate_banner({**BANNER, "position_y": 100})["position_y"] == 100
    assert validate_banner({**BANNER, "extra": "dropped"}).get("extra") is None


@pytest.mark.parametrize("bad", [
    "banner.jpg", [], {**BANNER, "image": "https://evil.example/b.jpg"},
    {**BANNER, "image": None}, {**BANNER, "mal_id": "3"}, {**BANNER, "mal_id": True},
    {**BANNER, "mal_id": 0}, {**BANNER, "position_y": 101}, {**BANNER, "position_y": -1},
    {**BANNER, "position_y": "50"}, {**BANNER, "position_y": True}, {**BANNER, "color": "red"},
    {**BANNER, "image": "https://s4.anilist.co/" + "x" * 500},
])
def test_banner_validation_bad(bad):
    with pytest.raises(ValidationError):
        validate_banner(bad)


def test_top5_validation():
    assert validate_top5([]) == []
    assert validate_top5([5, 1, 3]) == [5, 1, 3]  # order is kept: it's a ranking
    assert validate_top5([1, 2], library_ids={1, 2, 9}) == [1, 2]
    for bad in ["1,2", [1, 1], [1, 2, 3, 4, 5, 6], ["1"], [True], [0], [1.5], None]:
        with pytest.raises(ValidationError):
            validate_top5(bad)
    with pytest.raises(ValidationError):
        validate_top5([1, 7], library_ids={1, 2})  # 7 isn't in the library


def test_showcase_validation():
    assert validate_showcase([]) == []
    assert validate_showcase(["first-steps", "marathon"]) == ["first-steps", "marathon"]
    assert validate_showcase(["some-future-badge"]) == ["some-future-badge"]  # unknown ids are allowed
    for bad in ["first-steps", ["a", "a"], ["a", "b", "c", "d"], [1], [""], ["x" * 61], None]:
        with pytest.raises(ValidationError):
            validate_showcase(bad)


def test_validate_profile_merges_new_fields():
    profile = validate_profile({"banner": BANNER, "top5": [1], "showcase": ["a"]}, {"display_name": "Y"})
    assert profile["display_name"] == "Y" and profile["banner"]["mal_id"] == 3
    assert profile["top5"] == [1] and profile["showcase"] == ["a"]


def test_match_character():
    cast = [
        {"id": 1, "name": "Satoru Gojo", "image": "https://s4.anilist.co/g.png"},
        {"id": 2, "name": "Levi Ackerman", "image": "https://s4.anilist.co/l.png"},
        {"id": 3, "name": "Levi", "image": "https://s4.anilist.co/l2.png"},
    ]
    assert match_character("Gojo Satoru", cast)["id"] == 1      # word order doesn't matter
    assert match_character("  satoru gojo! ", cast)["id"] == 1  # case and punctuation don't either
    assert match_character("Levi", cast)["id"] == 3             # an exact name wins over a partial one
    assert match_character("Ackerman", cast)["id"] == 2
    assert match_character("Frieren", cast) is None
    assert match_character("", cast) is None


# ---------------------------------------------------------------- service + API
def test_update_me_round_trip(shelf):
    me = shelf.me()
    assert me["banner"] is None and me["top5"] == [] and me["showcase"] == []
    shelf.add(1)
    shelf.add(3)
    me = shelf.update_me({"banner": BANNER, "top5": [3, 1], "showcase": ["first-steps"]})
    assert me["banner"]["position_y"] == 30.0 and me["top5"] == [3, 1] and me["showcase"] == ["first-steps"]
    # a partial change keeps the rest
    me = shelf.update_me({"bio": "hi"})
    assert me["top5"] == [3, 1] and me["banner"]["mal_id"] == 3
    with pytest.raises(ValidationError):
        shelf.update_me({"top5": [2]})  # 2 isn't in the library
    # removing an anime later doesn't break unrelated profile edits
    shelf.remove(1)
    assert shelf.update_me({"bio": "still fine"})["top5"] == [3, 1]
    assert shelf.update_me({"banner": None})["banner"] is None


def test_new_fields_survive_backup(shelf, tmp_path):
    from anishelf.db import Database
    from anishelf.service import AniShelf

    shelf.add(1)
    shelf.add(3)
    shelf.update_me({"banner": BANNER, "top5": [3, 1], "showcase": ["a", "b"]})
    other = AniShelf(Database(tmp_path / "b.db"), shelf.jikan, shelf.anilist)
    other.db.import_backup(shelf.db.export())
    me = other.me()
    assert me["banner"]["image"] == BANNER["image"] and me["top5"] == [3, 1] and me["showcase"] == ["a", "b"]


def test_patch_me_endpoint_round_trip(client, shelf):
    shelf.add(1)
    shelf.add(3)
    r = client.patch("/api/me", json={"banner": BANNER, "top5": [1, 3], "showcase": ["x", "y", "z"]})
    assert r.status_code == 200
    got = client.get("/api/me").get_json()
    assert got["banner"]["mal_id"] == 3 and got["top5"] == [1, 3] and got["showcase"] == ["x", "y", "z"]
    for bad in [{"top5": [1, 1]}, {"top5": [99]}, {"showcase": ["a", "b", "c", "d"]},
                {"banner": {**BANNER, "image": "https://evil.example/b.jpg"}}]:
        r = client.patch("/api/me", json=bad)
        assert r.status_code == 400 and "error" in r.get_json()
    assert client.get("/api/me").get_json()["top5"] == [1, 3]  # bad patches changed nothing


def test_banner_choices(shelf, client):
    shelf.add(1)  # FakeAniList: no banner
    shelf.add(3)  # FakeAniList: has a banner
    data = profile_extras.banner_choices(shelf)
    assert data["unchecked"] == 0
    assert [c["mal_id"] for c in data["choices"]] == [3]
    assert data["choices"][0]["image"] == "https://s4.anilist.co/b.jpg" and data["choices"][0]["color"] == "#ff8800"
    assert client.get("/api/me/banners").get_json()["choices"][0]["mal_id"] == 3


def test_banner_choices_fetch_cap(shelf):
    shelf.add(3)
    # pretend the snapshot and cache know nothing about AniList, so a lookup is needed
    meta = dict(shelf.db.get(3)["meta"], anilist=None)
    shelf.db.update_meta(3, meta)
    with shelf.db.connect() as conn:
        conn.execute("DELETE FROM api_cache WHERE key = 'anilist:3'")
    assert profile_extras.banner_choices(shelf, max_fetches=0) == {"choices": [], "unchecked": 1}
    data = profile_extras.banner_choices(shelf, max_fetches=1)
    assert data["unchecked"] == 0 and data["choices"][0]["mal_id"] == 3


def test_fav_characters(shelf, client, anilist):
    shelf.add(1)
    shelf.add(2)
    shelf.add(4)
    shelf.update(1, {"fav_character": "hero"})          # FakeAniList cast has "Hero"
    shelf.update(2, {"fav_character": "Nobody, Hero"})  # second name matches
    shelf.update(4, {"fav_character": "Someone Else"})  # no match -> initials in the UI
    data = profile_extras.fav_characters(shelf)
    by_id = {c["mal_id"]: c for c in data["characters"]}
    assert set(by_id) == {1, 2, 4} and data["pending"] == 0
    assert by_id[1]["image"] == "https://s4.anilist.co/h.png" and by_id[1]["matched_name"] == "Hero"
    assert by_id[2]["matched_name"] == "Hero" and by_id[2]["character"] == "Hero"  # unmatched "Nobody" is dropped
    assert by_id[4]["image"] is None
    # everything is cached now: a second call makes no AniList requests
    calls = anilist.calls
    profile_extras.fav_characters(shelf)
    assert anilist.calls == calls
    assert len(client.get("/api/me/fav-characters").get_json()["characters"]) == 3


def test_fav_characters_lookup_cap(shelf, anilist):
    for mal_id in (1, 2, 4):
        shelf.add(mal_id)
        shelf.update(mal_id, {"fav_character": "Hero"})
    calls = anilist.calls
    data = profile_extras.fav_characters(shelf, max_lookups=2)
    assert anilist.calls - calls == 2 and data["pending"] == 1
    assert sum(1 for c in data["characters"] if c["image"]) == 2


def test_fav_matches_one_card_per_heart():
    """The Cast-card hearts save 'Name A, Name B'; the Profile shows a card for each."""
    cast = [{"name": "Spike Spiegel", "image": "s.png"}, {"name": "Faye Valentine", "image": "f.png"}]
    pairs = profile_extras._matches("Spike Spiegel, Faye Valentine", cast)
    assert [(n, m["name"]) for n, m in pairs] == [("Spike Spiegel", "Spike Spiegel"), ("Faye Valentine", "Faye Valentine")]
    # one name matching two ways is still one card, and a whole-text match wins
    assert len(profile_extras._matches("Spike, Spike Spiegel", cast)) == 1
    assert profile_extras._matches("Spike", cast)[0][1]["name"] == "Spike Spiegel"
    # no cast yet, or no match: one card with what was typed
    assert profile_extras._matches("Ein", None) == [("Ein", None)]
    assert profile_extras._matches("Ein, Jet", cast) == [("Ein, Jet", None)]
