"""Tests for the WATCHING features: memories, airing calendar, franchise nudges and moods."""

import time
from datetime import date, datetime, timezone

import pytest

from anishelf import watching
from anishelf.anilist import AIRING_BATCH_MAX, AniListClient, parse_airing_schedule
from anishelf.logic import ValidationError


def local_iso(year, month, day, hour=12):
    """A watch-log timestamp for noon on that day in this computer's time zone."""
    return datetime(year, month, day, hour).astimezone().isoformat()


def entry(mal_id, title, started=None, finished=None):
    return {"mal_id": mal_id, "started_on": started, "finished_on": finished,
            "meta": {"title": title, "title_english": None, "image": None}}


# ====================================================================== memories
def test_months_back_handles_year_wrap_and_missing_days():
    assert watching.months_back(date(2026, 2, 15), 3) == date(2025, 11, 15)
    assert watching.months_back(date(2026, 11, 6), 6) == date(2026, 5, 6)
    assert watching.months_back(date(2026, 3, 31), 1) is None  # there is no 31 February


def test_memory_from_earlier_year_prefers_finished():
    today = date(2026, 11, 6)
    entries = [entry(1, "Attack on Titan Season 3", finished="2025-11-06"), entry(2, "Other")]
    log = [{"mal_id": 2, "episode": 1, "watched_at": local_iso(2025, 11, 6)},
           {"mal_id": 1, "episode": 10, "watched_at": local_iso(2025, 11, 6)}]
    events = watching.collect_events(log, entries)
    result = watching.pick_memories(events, {e["mal_id"]: e for e in entries}, today)
    assert [m["mal_id"] for m in result] == [1, 2]
    assert result[0]["text"] == "A year ago today you finished Attack on Titan Season 3"
    assert result[1]["action"] == "you watched 1 episode of"


def test_memory_years_are_most_recent_first():
    today = date(2026, 11, 6)
    entries = [entry(1, "Old"), entry(2, "Newer")]
    log = [{"mal_id": 1, "episode": 1, "watched_at": local_iso(2023, 11, 6)},
           {"mal_id": 2, "episode": 1, "watched_at": local_iso(2025, 11, 6)},
           {"mal_id": 2, "episode": 2, "watched_at": local_iso(2025, 11, 6)}]
    result = watching.pick_memories(watching.collect_events(log, entries), {e["mal_id"]: e for e in entries}, today)
    assert [m["when"] for m in result] == ["A year ago today", "3 years ago today"]
    assert result[0]["episodes"] == 2


def test_memory_falls_back_to_months_ago():
    today = date(2026, 11, 6)
    entries = [entry(5, "Gachiakuta", started="2026-08-06"), entry(6, "Six months", finished="2026-05-06"),
               entry(7, "Random day", finished="2026-10-20")]
    events = watching.collect_events([], entries)
    result = watching.pick_memories(events, {e["mal_id"]: e for e in entries}, today)
    assert [m["text"] for m in result] == ["3 months ago today you started Gachiakuta",
                                           "6 months ago today you finished Six months"]


def test_no_memories_and_removed_shows_are_skipped():
    today = date(2026, 11, 6)
    log = [{"mal_id": 99, "episode": 1, "watched_at": local_iso(2025, 11, 6)}]  # 99 is not in the library
    assert watching.pick_memories(watching.collect_events(log, []), {}, today) == []
    assert watching.pick_memories({}, {}, today) == []


def test_memories_endpoint(client):
    assert client.get("/api/memories").get_json() == {"memories": []}


# ====================================================================== airing calendar
FAKE_ANILIST_RESPONSE = {
    "Page": {"media": [
        {"idMal": 3, "airingSchedule": {"nodes": [
            {"episode": 7, "airingAt": 2000},
            {"episode": 6, "airingAt": 1000},
            {"episode": 6, "airingAt": 1000},       # duplicate
            {"episode": None, "airingAt": 3000},    # broken
        ]}},
        {"idMal": None, "airingSchedule": {"nodes": [{"episode": 1, "airingAt": 5}]}},  # no MAL id
        {"idMal": 8, "airingSchedule": None},
    ]}
}


def test_parse_airing_schedule():
    assert parse_airing_schedule(FAKE_ANILIST_RESPONSE) == [
        {"mal_id": 3, "episode": 6, "airing_at": 1000},
        {"mal_id": 3, "episode": 7, "airing_at": 2000},
    ]
    assert parse_airing_schedule(None) == []


def test_airing_schedule_is_one_request_with_a_cap():
    sent = []

    class FakeAniListClient(AniListClient):
        def _query(self, query, variables):
            sent.append(variables)
            return FAKE_ANILIST_RESPONSE

    client = FakeAniListClient()
    result = client.airing_schedule(list(range(1, 120)))
    assert len(sent) == 1
    assert len(sent[0]["ids"]) == AIRING_BATCH_MAX
    assert result[0]["episode"] == 6
    assert client.airing_schedule([]) == [] and len(sent) == 1  # no ids -> no request


def test_build_calendar_groups_by_local_day():
    # 2026-11-06 20:00 UTC = 22:00 in Finland (UTC+2 -> getTimezoneOffset() == -120)
    now = datetime(2026, 11, 6, 20, 0, tzinfo=timezone.utc).timestamp()
    entries = {3: {"mal_id": 3, "status": "watching", "total": None,
                   "meta": {"title": "Show 3", "title_english": None, "image": None}}}
    schedule = [
        {"mal_id": 3, "episode": 5, "airing_at": int(now) - 60},         # already aired: dropped
        {"mal_id": 3, "episode": 6, "airing_at": int(now) + 90 * 60},    # 23:30 local, still today
        {"mal_id": 3, "episode": 7, "airing_at": int(now) + 3 * 3600},   # 01:00 local, tomorrow
        {"mal_id": 3, "episode": 8, "airing_at": int(now) + 9 * 86400},  # beyond the week
        {"mal_id": 42, "episode": 1, "airing_at": int(now) + 600},       # not my show
    ]
    cal = watching.build_calendar(schedule, entries, now, -120)
    assert [d["date"] for d in cal["days"]][:2] == ["2026-11-06", "2026-11-07"]
    assert len(cal["days"]) == 7
    assert [i["episode"] for i in cal["days"][0]["items"]] == [6]
    assert cal["days"][0]["items"][0]["local_time"] == "23:30"
    assert [i["episode"] for i in cal["days"][1]["items"]] == [7]
    assert cal["next"]["episode"] == 6
    assert [u["episode"] for u in cal["upcoming"]] == [6, 7, 8]


def test_parse_tz_offset():
    assert watching.parse_tz_offset("-120") == -120
    assert isinstance(watching.parse_tz_offset(None), int)
    with pytest.raises(ValidationError):
        watching.parse_tz_offset("abc")
    with pytest.raises(ValidationError):
        watching.parse_tz_offset("5000")


def test_calendar_endpoint_uses_one_cached_request(client, shelf, anilist):
    shelf.add(3, "watching")       # airing show
    shelf.add(1, "plan_to_watch")  # finished show: not asked about
    soon = int(time.time()) + 3600
    anilist.AIRING = {3: [(6, soon), (7, soon + 7 * 86400 + 60)]}
    data = client.get("/api/calendar?tz_offset=-120").get_json()
    assert data["tracked"] == 1
    assert data["next"]["episode"] == 6
    assert sum(len(d["items"]) for d in data["days"]) >= 1
    client.get("/api/calendar?tz_offset=-120")
    assert anilist.airing_calls == 1  # second load came from the 1-hour cache
    assert client.get("/api/calendar?tz_offset=nope").status_code == 400


def test_calendar_with_nothing_airing_makes_no_request(client, shelf, anilist):
    shelf.add(1, "watching")
    data = client.get("/api/calendar").get_json()
    assert data["next"] is None and data["tracked"] == 0
    assert getattr(anilist, "airing_calls", 0) == 0


# ====================================================================== nudges
def test_nudge_for_next_season_from_cached_franchise(client, shelf, anilist):
    shelf.add(1, "completed")
    shelf.add(2, "plan_to_watch")
    shelf.seasons(1)  # caches the franchise 1 -> 2 -> 4 (movie)
    anilist.fail = True  # from now on everything must come from the cache
    nudges = client.get("/api/nudges").get_json()["nudges"]
    assert len(nudges) == 1
    assert nudges[0]["from"]["mal_id"] == 1 and nudges[0]["from"]["label"] == "Season 1"
    assert nudges[0]["next"]["mal_id"] == 2 and nudges[0]["next"]["library_status"] == "plan_to_watch"
    assert nudges[0]["next"]["label"] == "Season 2"


def test_nudge_for_entry_not_in_library_and_skips_started(shelf):
    shelf.add(1, "completed")
    shelf.add(2, "completed")
    shelf.seasons(1)
    nudges = watching.nudges(shelf)
    # Season 1 -> Season 2 is already completed, so only Season 2 -> the movie is suggested
    assert [(n["from"]["mal_id"], n["next"]["mal_id"]) for n in nudges] == [(2, 4)]
    assert nudges[0]["next"]["library_status"] is None
    shelf.add(4, "watching")
    assert watching.nudges(shelf) == []


def test_nudges_cap_uncached_lookups(shelf, jikan, anilist):
    from conftest import make_meta
    for mal_id in range(20, 32):
        jikan.catalog[mal_id] = make_meta(mal_id)
        shelf.add(mal_id, "completed")
    before = anilist.calls
    assert watching.nudges(shelf) == []
    assert anilist.calls - before <= watching.MAX_UNCACHED_LOOKUPS


def test_find_nudges_limit():
    completed = [{"mal_id": i, "meta": {"title": f"S{i}"}} for i in range(1, 10)]

    def ordered_for(mal_id):
        return [{"mal_id": mal_id, "label": "Season 1"}, {"mal_id": mal_id + 100, "label": "Season 2"}]

    assert len(watching.find_nudges(completed, {}, ordered_for)) == watching.NUDGE_LIMIT


# ====================================================================== moods
def test_mood_filter(shelf):
    shelf.add(1, "plan_to_watch")  # Action, Fantasy
    shelf.add(2, "plan_to_watch")  # Comedy
    laugh = shelf.random_pick(None, None, ["plan_to_watch"], "laugh")
    assert [e["mal_id"] for e in laugh["candidates"]] == [2]
    hype = shelf.random_pick(None, None, ["plan_to_watch"], "hype")
    assert [e["mal_id"] for e in hype["candidates"]] == [1]
    anything = shelf.random_pick(None, None, ["plan_to_watch"], "any")
    assert len(anything["candidates"]) == 2
    old_style = shelf.random_pick(None, None, ["plan_to_watch"])  # existing callers still work
    assert len(old_style["candidates"]) == 2
    with pytest.raises(ValidationError):
        shelf.random_pick(None, None, ["plan_to_watch"], "angry")


def test_mood_on_random_endpoint(client, shelf):
    shelf.add(1, "plan_to_watch")
    shelf.add(2, "plan_to_watch")
    data = client.get("/api/random?mood=laugh").get_json()
    assert data["pick"]["mal_id"] == 2
    assert client.get("/api/random?mood=sad").get_json()["pick"] is None
    assert client.get("/api/random?mood=angry").status_code == 400
    discover = client.get("/api/random?source=discover&mood=brain")
    assert discover.status_code == 200


def test_discover_genre_for_mood():
    import random
    genre = watching.discover_genre_for_mood("brain", random.Random(1), ["Mystery", "Sci-Fi", "Action"])
    assert genre in ("Mystery", "Sci-Fi")
    assert watching.discover_genre_for_mood(None, random.Random(1), ["Action"]) is None
