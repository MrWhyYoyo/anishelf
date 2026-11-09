from datetime import date, timedelta

import pytest

from anishelf.clients import ApiError, RateLimiter
from anishelf.logic import ValidationError
from anishelf.service import NotInLibrary, streaks


def test_add_and_auto_dates(shelf):
    entry = shelf.add(1, "watching")
    assert entry["status"] == "watching" and entry["started_on"] == date.today().isoformat()
    assert entry["meta"]["anilist"]["color"] == "#3366ff"
    assert entry["total"] == 12 and entry["progress"] == 0 and entry["next_episode"] == 1


def test_episode_flow_auto_completes(shelf):
    shelf.add(1)
    result = shelf.change_episodes(1, {"action": "toggle", "episode": 1})
    assert result["status_changed"] == "watching"
    result = shelf.change_episodes(1, {"action": "add_range", "text": "2-11"})
    assert result["status_changed"] is None and result["entry"]["next_episode"] == 12
    result = shelf.change_episodes(1, {"action": "toggle", "episode": 12})
    assert result["status_changed"] == "completed"
    assert result["entry"]["finished_on"] == date.today().isoformat()
    assert result["entry"]["progress"] == 1.0
    # un-watching keeps it completed (deliberate), toggling twice is idempotent
    result = shelf.change_episodes(1, {"action": "remove_range", "text": "12"})
    assert result["entry"]["watched_count"] == 11 and result["entry"]["status"] == "completed"


def test_episode_actions_validate(shelf):
    shelf.add(1)
    for body in ({"action": "toggle", "episode": 13}, {"action": "nope"}, {"action": "up_to"},
                 {"action": "add_range", "text": "x"}, "not a dict"):
        with pytest.raises(ValidationError):
            shelf.change_episodes(1, body)
    with pytest.raises(NotInLibrary):
        shelf.change_episodes(99, {"action": "clear"})


def test_unknown_total(shelf):
    shelf.add(3)  # airing, no episode count
    entry = shelf.build_entry(shelf.db.get(3))
    assert entry["total"] is None and entry["aired"] == 5 and entry["progress"] is None
    with pytest.raises(ValidationError):
        shelf.change_episodes(3, {"action": "all"})
    shelf.change_episodes(3, {"action": "up_to", "episode": 5})
    with pytest.raises(ValidationError):
        shelf.update(3, {"total_override": 4})  # already watched ep 5
    entry = shelf.update(3, {"total_override": 6})
    assert entry["total"] == 6 and entry["progress"] == pytest.approx(5 / 6, abs=1e-4)


def test_bulk_marking_is_not_logged_as_today(shelf):
    shelf.add(2)  # 24 episodes
    shelf.change_episodes(2, {"action": "all"})  # 24 <= limit, counts as activity
    assert len(shelf.db.watch_log()) == 24
    shelf.change_episodes(2, {"action": "clear"})
    assert shelf.db.watch_log() == []  # removing episodes removes their log


def test_versus(shelf):
    assert shelf.versus_pair()["pair"] is None
    shelf.add(1, "completed")
    shelf.add(2, "plan_to_watch")
    assert shelf.versus_pair()["pair"] is None  # plan-to-watch isn't rankable
    shelf.add(4, "completed")
    pair = shelf.versus_pair()["pair"]
    assert {e["mal_id"] for e in pair} == {1, 4}
    result = shelf.versus_result(1, 4)
    assert result["winner"]["elo"] > 1500 > result["loser"]["elo"]
    assert result["winner"]["matches"] == 1
    with pytest.raises(ValidationError):
        shelf.versus_result(1, 1)
    with pytest.raises(NotInLibrary):
        shelf.versus_result(1, 2_000)


def test_random_filters(shelf):
    shelf.add(1)  # 12 eps action/fantasy
    shelf.add(2)  # 24 eps comedy
    shelf.add(3)  # unknown length
    assert {e["mal_id"] for e in shelf.random_pick(None, None, ["plan_to_watch"])["candidates"]} == {1, 2, 3}
    assert [e["mal_id"] for e in shelf.random_pick("Comedy", None, ["plan_to_watch"])["candidates"]] == [2]
    assert [e["mal_id"] for e in shelf.random_pick(None, 13, ["plan_to_watch"])["candidates"]] == [1]
    assert shelf.random_pick("Horror", None, ["plan_to_watch"]) == {"pick": None, "candidates": []}


def test_stats(shelf):
    shelf.add(1)
    shelf.add(4)
    shelf.change_episodes(1, {"action": "up_to", "episode": 3})
    shelf.change_episodes(4, {"action": "all"})
    shelf.update(4, {"score": 8})
    s = shelf.stats()
    assert s["episodes_watched"] == 4
    assert s["minutes_watched"] == 3 * 24 + 110
    assert s["status_counts"]["completed"] == 1 and s["status_counts"]["watching"] == 1
    assert s["mean_score"] == 8 and s["score_distribution"]["8"] == 1
    assert s["activity"] == [{"date": date.today().isoformat(), "count": 4}]
    assert len(s["monthly"]) == 12 and s["monthly"][-1]["episodes"] == 4
    assert s["streak"] == {"current": 1, "longest": 1}
    assert s["completed_this_year"] == 1


def test_streaks():
    t = date(2026, 11, 4)
    days = {t - timedelta(days=i) for i in (1, 2, 3)} | {t - timedelta(days=10)}
    assert streaks(days, t) == {"current": 3, "longest": 3}
    assert streaks(set(), t) == {"current": 0, "longest": 0}
    assert streaks({t - timedelta(days=2)}, t)["current"] == 0


def test_cache_and_stale_fallback(shelf, jikan):
    shelf.search("show")
    shelf.search("SHOW ")  # same cache key
    assert jikan.calls == 1
    shelf.db.cache_set("search:other", [])
    jikan.fail = True
    assert shelf.search("other") == []  # fresh cache, no call
    assert jikan.calls == 1


def test_anilist_fallback_when_jikan_down(shelf, jikan, anilist):
    jikan.fail = True
    results = shelf.search("anything")
    assert results[0]["title"] == "Fallback 10" and jikan.calls == 1
    shelf.search("something else")
    assert jikan.calls == 1  # circuit breaker: Jikan skipped for a while
    meta = shelf.meta(55)
    assert meta["anilist"]["banner"] == "https://s4.anilist.co/fb.jpg"
    eps = shelf.episodes(55)
    assert eps["source"] == "anilist" and eps["episodes"][0]["title"] == "From AniList"
    assert shelf.episodes(404) == {"episodes": [], "truncated": False, "source": None}
    assert shelf.db.cache_get("episodes:404", None) is None  # empty result not cached
    anilist.fail = True
    with pytest.raises(ApiError):
        shelf.search("both down")


def test_not_found_does_not_fall_back(shelf, anilist):
    from anishelf.clients import NotFoundError
    with pytest.raises(NotFoundError):
        shelf.meta(999)
    assert anilist.calls == 0


def test_anilist_failure_does_not_break_page(shelf, anilist):
    anilist.fail = True
    page = shelf.anime_page(1)
    assert page["meta"]["anilist"]["banner"] is None and page["entry"] is None


def test_export_import_roundtrip(shelf, tmp_path):
    from anishelf.db import Database
    from anishelf.service import AniShelf

    shelf.add(1)
    shelf.change_episodes(1, {"action": "up_to", "episode": 4})
    shelf.update(1, {"notes": "great", "tier": "A", "favorite": True})
    backup = shelf.db.export()

    other = AniShelf(Database(tmp_path / "other.db"), shelf.jikan, shelf.anilist)
    assert other.db.import_backup(backup) == 1
    assert other.db.import_backup(backup) == 1  # importing twice doesn't duplicate history
    entry = other.library()[0]
    assert entry["watched"] == [1, 2, 3, 4] and entry["notes"] == "great" and entry["favorite"] is True
    assert len(other.db.watch_log()) == 4
    with pytest.raises(ValidationError):
        other.db.import_backup({"app": "Something else"})


def test_rate_limiter_hard_cap():
    limiter = RateLimiter(0, 1000, max_calls=3, name="Test")
    for _ in range(3):
        limiter.acquire()
    with pytest.raises(ApiError, match="Safety limit"):
        limiter.acquire()


def test_surprise_me_skips_library_and_filters(shelf):
    shelf.add(1)
    result = shelf.surprise(None, None)
    assert {m["mal_id"] for m in result["candidates"]} == {2, 4}
    assert result["pick"]["mal_id"] in {2, 4} and result["source"] == "discover"
    assert [m["mal_id"] for m in shelf.surprise(None, 13)["candidates"]] == [4]
    with pytest.raises(ValidationError):
        shelf.surprise("Hentai", None)
