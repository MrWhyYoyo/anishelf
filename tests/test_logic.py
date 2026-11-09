import pytest

from anishelf.clients import normalize_jikan
from anishelf.logic import (
    ValidationError,
    auto_status,
    clean_episode_list,
    compress_ranges,
    elo_update,
    next_episode,
    parse_duration_minutes,
    parse_episode_ranges,
    validate_patch,
)


class TestRanges:
    def test_mixed(self):
        assert parse_episode_ranges("1-3, 5 7-8") == {1, 2, 3, 5, 7, 8}

    def test_reversed_and_spaces(self):
        assert parse_episode_ranges(" 4 - 2 ") == {2, 3, 4}

    @pytest.mark.parametrize("bad", ["", "  ", "abc", "1-", "0", "-3", "1.5"])
    def test_invalid(self, bad):
        with pytest.raises(ValidationError):
            parse_episode_ranges(bad)

    def test_beyond_total(self):
        with pytest.raises(ValidationError, match="beyond"):
            parse_episode_ranges("1-13", max_episode=12)

    def test_huge_range_is_capped(self):
        with pytest.raises(ValidationError):
            parse_episode_ranges("1-99999999")

    def test_compress_roundtrip(self):
        eps = {1, 2, 3, 5, 7, 8, 10}
        text = compress_ranges(eps)
        assert text == "1-3, 5, 7-8, 10"
        assert parse_episode_ranges(text) == eps
        assert compress_ranges([]) == ""

    def test_clean_list(self):
        assert clean_episode_list([3, 1, 3], 12) == {1, 3}
        for bad in ([0], [13], ["2"], [True], "1,2", [None]):
            with pytest.raises(ValidationError):
                clean_episode_list(bad, 12)


def test_next_episode():
    assert next_episode([], 12) == 1
    assert next_episode([1, 2, 4], 12) == 3
    assert next_episode(range(1, 13), 12) is None
    assert next_episode([1, 2], None) == 3


def test_auto_status():
    assert auto_status("watching", 12, 12) == "completed"
    assert auto_status("plan_to_watch", 1, 12) == "watching"
    assert auto_status("on_hold", 3, None) == "watching"
    assert auto_status("dropped", 5, 12) == "dropped"
    assert auto_status("dropped", 12, 12) == "completed"
    assert auto_status("watching", 0, 12) == "watching"


def test_elo_is_zero_sum_and_favours_upsets():
    w, l = elo_update(1500, 1500)
    assert w == 1516 and l == 1484
    upset_w, _ = elo_update(1400, 1600)
    expected_w, _ = elo_update(1600, 1400)
    assert upset_w - 1400 > expected_w - 1600
    a, b = elo_update(1550, 1450)
    assert round(a + b, 6) == 3000


@pytest.mark.parametrize("text,expected", [
    ("24 min per ep", 24), ("1 hr 55 min", 115), ("2 hr", 120), ("45 sec", 1),
    ("Unknown", None), (None, None), ("", None),
])
def test_duration(text, expected):
    assert parse_duration_minutes(text) == expected


def test_validate_patch():
    assert validate_patch({"score": 9, "favorite": True, "started_on": ""}) == {"score": 9, "favorite": 1, "started_on": None}
    for bad in ({"score": 11}, {"score": "9"}, {"tier": "Z"}, {"status": "x"}, {"started_on": "04/11/2026"},
                {"mal_id": 5}, {"rewatch_count": -1}, {"notes": 5}, {"favorite": "yes"}):
        with pytest.raises(ValidationError):
            validate_patch(bad)


def test_normalize_jikan_handles_missing_fields():
    meta = normalize_jikan({"mal_id": 5, "aired": {"from": "2019-04-06T00:00:00+00:00"}})
    assert meta["title"] == "Untitled"
    assert meta["year"] == 2019
    assert meta["episodes"] is None and meta["image"] is None and meta["genres"] == []

    full = normalize_jikan({
        "mal_id": 52991, "title": "Frieren", "episodes": 28, "duration": "24 min per ep",
        "status": "Finished Airing", "images": {"webp": {"large_image_url": "https://cdn.myanimelist.net/x.webp"}},
        "genres": [{"name": "Fantasy"}], "themes": [{"name": "Fantasy"}], "demographics": [{"name": "Shounen"}],
        "trailer": {"youtube_id": "abc"}, "year": 2023,
    })
    assert full["genres"] == ["Fantasy", "Shounen"]
    assert full["image"].endswith("x.webp") and full["duration_min"] == 24 and full["trailer_youtube_id"] == "abc"


def test_normalize_anilist():
    from anishelf.anilist import clean_description, current_season, normalize_anilist
    from datetime import date

    assert normalize_anilist({"idMal": None}) is None
    meta = normalize_anilist({
        "idMal": 52991, "title": {"romaji": "Sousou no Frieren", "english": "Frieren"},
        "coverImage": {"extraLarge": "https://s4.anilist.co/c.jpg", "color": "#e4a15d"},
        "bannerImage": "https://s4.anilist.co/b.jpg", "format": "TV", "episodes": 28, "duration": 24,
        "status": "RELEASING", "season": "FALL", "seasonYear": 2023, "genres": ["Drama"],
        "studios": {"nodes": [{"name": "Madhouse"}]}, "description": "A <i>long</i> trip.<br><br>&amp; more",
        "averageScore": 91, "trailer": {"id": "xyz", "site": "youtube"},
        "nextAiringEpisode": {"episode": 9, "airingAt": 1767225600},
    })
    assert meta["mal_id"] == 52991 and meta["airing"] is True and meta["season"] == "fall"
    assert meta["mal_score"] == 9.1 and meta["studios"] == ["Madhouse"]
    assert meta["synopsis"] == "A long trip.\n\n& more"
    assert meta["anilist"]["next_airing"] == {"episode": 9, "airing_at": 1767225600}
    assert current_season(date(2026, 11, 4)) == ("FALL", 2026)
    assert current_season(date(2026, 1, 1)) == ("WINTER", 2026)
    assert clean_description(None) is None
