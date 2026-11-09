import pytest

from anishelf.anilist import normalize_characters
from anishelf.progression import BADGES, level_for_xp, metrics, profile, title_for_level, xp_for_level


@pytest.mark.parametrize("xp,level", [(0, 1), (99, 1), (100, 2), (299, 2), (300, 3), (4499, 9), (4500, 10), (10**7, 447)])
def test_level_curve(xp, level):
    assert level_for_xp(xp) == level
    assert xp_for_level(level) <= xp < xp_for_level(level + 1) or xp == 0


def test_level_boundaries_exact():
    for level in range(1, 300):
        assert level_for_xp(xp_for_level(level)) == level
        assert level_for_xp(xp_for_level(level) - 1) == max(level - 1, 1)


def test_titles():
    assert title_for_level(1) == "Fresh Viewer"
    assert title_for_level(12) == "Otaku"
    assert title_for_level(99) == "Ascended"


def test_badge_ids_unique():
    ids = [b[0] for b in BADGES]
    assert len(ids) == len(set(ids))


def test_profile_from_library(shelf):
    empty = shelf.profile()
    assert empty["level"] == 1 and empty["xp"] == 0 and not any(b["earned"] for b in empty["badges"])

    shelf.add(1)                                   # 12 episodes
    shelf.change_episodes(1, {"action": "all"})    # 120 xp + completed 50
    shelf.update(1, {"score": 9, "notes": "loved it", "fav_character": "Hero", "tier": "S"})
    p = shelf.profile()
    # today's daily quests may also have been completed by this; they depend on the date
    quest_xp = next(b["xp"] for b in p["breakdown"] if b["label"] == "Daily quests")
    assert p["xp"] - quest_xp == 120 + 50 + 5 + 15 + 5 + 2
    if quest_xp == 0:
        assert p["level"] == 2 and p["level_xp"] == 100 and p["next_level_xp"] == 300
        assert p["progress"] == pytest.approx((197 - 100) / 200)
    earned = {b["id"] for b in p["badges"] if b["earned"]}
    assert {"first_steps", "first_finish"} <= earned and "century" not in earned
    century = next(b for b in p["badges"] if b["id"] == "century")
    assert century["progress"] == 12 and century["goal"] == 100

    shelf.change_episodes(1, {"action": "clear"})  # XP is derived, so it goes back down
    assert shelf.profile()["xp"] < p["xp"]


def test_versus_xp_counts_battles_not_participants(shelf):
    shelf.add(1, "completed")
    shelf.add(4, "completed")
    shelf.versus_result(1, 4)
    m = metrics(shelf.library(), 0)
    assert m["versus"] == 1


def test_normalize_characters():
    media = {"characters": {"edges": [
        {"role": "SUPPORTING", "node": {"id": 2, "name": {"full": "Side"}, "image": {"large": None}}, "voiceActors": []},
        {"role": "MAIN", "node": {"id": 1, "name": {"full": "Frieren"}, "image": {"large": "https://s4.anilist.co/f.png"}},
         "voiceActors": [
             {"id": 10, "name": {"full": "Atsumi Tanezaki"}, "image": {"large": None}, "languageV2": "Japanese"},
             {"id": 11, "name": {"full": "Mallorie Rodak"}, "image": {"large": None}, "languageV2": "English"},
             {"id": 12, "name": {"full": "Someone"}, "image": {"large": None}, "languageV2": "German"},
         ]},
        {"role": "MAIN", "node": {}, "voiceActors": []},  # broken entry is skipped
    ]}}
    chars = normalize_characters(media)
    assert [c["name"] for c in chars] == ["Frieren", "Side"]
    assert [v["name"] for v in chars[0]["sub"]] == ["Atsumi Tanezaki"]
    assert [v["name"] for v in chars[0]["dub"]] == ["Mallorie Rodak"]
    assert normalize_characters(None) == []


def test_new_endpoints(client):
    assert client.get("/api/anime/1/characters").get_json()["characters"][0]["sub"][0]["name"] == "JP Actor"
    p = client.get("/api/profile").get_json()
    assert p["level"] == 1 and p["title"] == "Fresh Viewer" and len(p["badges"]) == len(BADGES)
