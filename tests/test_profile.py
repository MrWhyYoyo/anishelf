import pytest

from anishelf.logic import ValidationError

AVATAR = {"id": 417, "name": "Lelouch Lamperouge", "image": "https://s4.anilist.co/c.png", "anime": "Code Geass"}


def test_me_defaults_and_update(shelf):
    me = shelf.me()
    assert me["display_name"] == "Anime Fan" and me["avatar"] is None and me["member_since"] is None
    me = shelf.update_me({"display_name": "  Yassin ", "avatar": AVATAR, "bio": "Frieren enjoyer"})
    assert me["display_name"] == "Yassin" and me["avatar"]["name"] == "Lelouch Lamperouge"
    me = shelf.update_me({"bio": ""})  # partial update keeps the rest
    assert me["display_name"] == "Yassin" and me["avatar"]["id"] == 417
    assert shelf.update_me({"avatar": None})["avatar"] is None
    shelf.add(1)
    assert shelf.me()["member_since"] is not None


@pytest.mark.parametrize("bad", [
    {"display_name": ""}, {"display_name": "x" * 41}, {"bio": "x" * 201}, {"level": 99},
    {"avatar": {**AVATAR, "image": "https://evil.example/x.png"}},
    {"avatar": {**AVATAR, "id": "417"}}, {"avatar": "Lelouch"},
])
def test_me_validation(shelf, bad):
    with pytest.raises(ValidationError):
        shelf.update_me(bad)


def test_avatar_sources(shelf):
    assert shelf.avatars("popular", 7) == {"characters": [AVATAR | {"id": 7, "name": "Popular 7", "image": "https://s4.anilist.co/p.png", "anime": "Show"}], "page": 7}
    assert shelf.avatars("popular", 999)["page"] == 1  # out of range -> page 1
    assert shelf.avatars("search", query="gojo")["characters"][0]["name"] == "Gojo"
    with pytest.raises(ValidationError):
        shelf.avatars("search", query="g")
    with pytest.raises(ValidationError):
        shelf.avatars("nonsense")
    assert shelf.avatars("library") == {"characters": []}
    shelf.add(1, "watching")
    assert [c["name"] for c in shelf.avatars("library")["characters"]] == ["Hero"]


def test_profile_survives_backup(shelf, tmp_path):
    from anishelf.db import Database
    from anishelf.service import AniShelf

    shelf.add(1)
    shelf.update_me({"display_name": "Yassin", "avatar": AVATAR})
    other = AniShelf(Database(tmp_path / "b.db"), shelf.jikan, shelf.anilist)
    other.db.import_backup(shelf.db.export())
    assert other.me()["display_name"] == "Yassin" and other.me()["avatar"]["id"] == 417


def test_me_endpoints(client):
    assert client.get("/api/me").get_json()["display_name"] == "Anime Fan"
    r = client.patch("/api/me", json={"display_name": "Yassin"})
    assert r.status_code == 200 and r.get_json()["display_name"] == "Yassin"
    assert client.patch("/api/me", json={"display_name": ""}).status_code == 400
    assert client.get("/api/avatars?source=popular&page=3").get_json()["page"] == 3
    assert client.get("/api/avatars?source=popular&page=abc").get_json()["page"] == 1
    assert client.get("/api/avatars?source=search&q=x").status_code == 400


def test_crunchyroll_thumbnails_allowed():
    from anishelf.images import ImageCache
    assert ImageCache.is_allowed("https://img1.ak.crunchyroll.com/i/x.jpg")
    assert not ImageCache.is_allowed("https://crunchyroll.com.evil.example/x.jpg")


def test_parse_streaming_episodes():
    from anishelf.anilist import parse_streaming_episodes
    eps = parse_streaming_episodes([
        {"title": "Episode 2 - It Didn't Have to Be Magic...", "thumbnail": "t2"},
        {"title": "Episode 1 - The Journey's End", "thumbnail": "t1"},
        {"title": "Episode 1 - Duplicate from another site", "thumbnail": "x"},
        {"title": "Episode 3", "thumbnail": None},
        {"title": "Special: Recap", "thumbnail": None},
        {"title": None},
    ])
    assert [(e["number"], e["title"], e["thumbnail"]) for e in eps] == [
        (1, "The Journey's End", "t1"), (2, "It Didn't Have to Be Magic...", "t2"), (3, None, None)]
    assert parse_streaming_episodes(None) == []
