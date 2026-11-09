import pytest

from anishelf import merges
from anishelf.logic import ValidationError
from tests.conftest import make_meta


def entry(mal_id, title, english=None, group=None, size=1, kind="TV"):
    meta = {**make_meta(mal_id), "title": title, "title_english": english, "type": kind}
    ref = {"id": group or mal_id, "title": title, "title_english": english, "size": size}
    return {"mal_id": mal_id, "meta": meta, "franchise": ref}


@pytest.mark.parametrize("raw, base", [
    ("The Apothecary Diaries: The Late Lady's Treasure", "the apothecary diaries"),
    ("Go-toubun no Hanayome Movie", "go toubun no hanayome"),
    ("Attack on Titan Season 3 Part 2", "attack on titan"),
    ("Re:ZERO -Starting Life in Another World-", "re zero starting life in another world"),
    ("Sousou no Frieren 2nd Season", "sousou no frieren"),
    (None, ""),
])
def test_base_title(raw, base):
    assert merges.base_title(raw) == base


def test_auto_merges_join_lone_movies_only():
    library = [
        entry(1, "Kusuriya no Hitorigoto", "The Apothecary Diaries", group=1, size=2),
        entry(2, "Kusuriya no Hitorigoto 2nd Season", "The Apothecary Diaries Season 2", group=1, size=2),
        entry(3, "Kusuriya no Hitorigoto: Bouhi no Hihou", "The Apothecary Diaries: The Late Lady's Treasure", kind="Movie"),
        entry(4, "Go-toubun no Hanayome", "The Quintessential Quintuplets"),
        entry(5, "Go-toubun no Hanayome Movie", "The Quintessential Quintuplets Movie", kind="Movie"),
        entry(6, "Frieren", "Frieren"),  # unrelated lone show: stays alone
        entry(7, "86", "86 EIGHTY-SIX"),
        entry(8, "86 Something Else"),   # "86" is too short to be a prefix match
    ]
    found = merges.auto_merges(library)
    assert found[3] in (1, 2)
    assert found[5] == 4 or found[4] == 5  # the two Quintuplets entries end up together
    assert 6 not in found and 8 not in found


def test_manual_wins_and_keep_separate():
    assert merges.combined({3: 1}, {"3": merges.KEEP_SEPARATE}) == {}
    assert merges.combined({3: 1}, {"3": 9}) == {3: 9}
    assert merges.combined({}, {"3": 3}) == {}          # never points at itself
    assert merges.combined({3: 1, 1: 3}, {}) == {}       # no loops


def test_set_group_joins_and_separates(shelf):
    shelf.add(1)
    shelf.add(3)  # anime 3 has no AniList relations, like a stray movie
    result = shelf.set_group(3, 1)
    ids = [s["mal_id"] for s in result["seasons"]]
    assert 1 in ids and 3 in ids
    refs = {e["mal_id"]: e["franchise"]["id"] for e in shelf.library()}
    assert refs[1] == refs[3]
    shelf.set_group(3, None)  # keep separate again
    refs = {e["mal_id"]: e["franchise"]["id"] for e in shelf.library()}
    assert refs[1] != refs[3]
    with pytest.raises(ValidationError):
        shelf.set_group(1, 1)


def test_group_endpoint(client, shelf):
    shelf.add(1)
    shelf.add(3)
    resp = client.post("/api/library/3/group", json={"with": 1})
    assert resp.status_code == 200 and 3 in [s["mal_id"] for s in resp.get_json()["seasons"]]
    assert client.post("/api/library/3/group", json={"with": "x"}).status_code == 400
