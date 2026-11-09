"""AniShelf 1.1 progression: daily quests, mini-game XP, new badges and Anime Wrapped."""

from datetime import date, datetime, timedelta, timezone

import pytest

from anishelf import quests
from anishelf.games import GameScores, game_xp_total
from anishelf.progression import (
    GAME_XP_DAILY_CAP, SECRET_BADGES, activity_metrics, metrics, profile,
)
from anishelf.quests import QUEST_POOL, QuestBook, draw_quests
from anishelf.wrapped import build_wrapped


def utc_text(local: datetime) -> str:
    """A naive LOCAL time -> the UTC text the watch log stores (same as db.utc_now())."""
    return local.astimezone().astimezone(timezone.utc).isoformat(timespec="seconds")


def log_row(mal_id, episode, local: datetime) -> dict:
    return {"mal_id": mal_id, "episode": episode, "watched_at": utc_text(local)}


def breakdown(p: dict, label: str) -> int:
    return next(b["xp"] for b in p["breakdown"] if b["label"] == label)


# ---------------------------------------------------------------- daily quests
def test_quest_draw_is_deterministic_per_date():
    day = date(2026, 11, 6)
    first = draw_quests(day)
    assert first == draw_quests(day)                       # same day -> same quests
    assert len(first) == 3 and len(set(first)) == 3        # three different quests
    assert all(q in QUEST_POOL for q in first)
    draws = {tuple(draw_quests(day + timedelta(days=i))) for i in range(14)}
    assert len(draws) > 1                                  # ...but the days differ


def test_watch_quests_progress_and_award_xp(shelf, monkeypatch):
    monkeypatch.setattr(quests, "draw_quests", lambda day: ["watch_2", "two_shows", "revisit"])
    book = QuestBook(shelf)
    shelf.add(1, "watching")
    shelf.add(2, "watching")

    # show 2 was last watched 10 days ago (move its log entry back in time)
    shelf.change_episodes(2, {"action": "toggle", "episode": 1})
    with shelf.db.connect() as conn:
        conn.execute("UPDATE watch_log SET watched_at = ? WHERE mal_id = 2",
                     (utc_text(datetime.now() - timedelta(days=10)),))

    shelf.change_episodes(1, {"action": "toggle", "episode": 1})
    result = book.today()
    by_id = {q["id"]: q for q in result["quests"]}
    assert by_id["watch_2"]["progress"] == 1 and not by_id["watch_2"]["done"]
    assert by_id["revisit"]["progress"] == 0
    assert result["xp_today"] == 0

    shelf.change_episodes(2, {"action": "toggle", "episode": 2})   # back to an old show
    result = book.today()
    assert all(q["done"] for q in result["quests"])
    assert result["xp_today"] == 20 + 25 + 30
    assert breakdown(shelf.profile(), "Daily quests") == 75

    # XP is kept even after unwatching (it was claimed), and is not awarded twice
    shelf.change_episodes(1, {"action": "clear"})
    shelf.change_episodes(2, {"action": "clear"})
    again = book.today()
    assert again["xp_total"] == 75 and all(q["done"] for q in again["quests"])


def test_library_quests(shelf, monkeypatch):
    monkeypatch.setattr(quests, "draw_quests", lambda day: ["rate_or_tier", "finish_show", "plan_add"])
    book = QuestBook(shelf)
    assert [q["progress"] for q in book.today()["quests"]] == [0, 0, 0]
    shelf.add(2)                                   # plan to watch, added today
    shelf.add(1, "watching")
    shelf.update(1, {"tier": "A"})
    shelf.change_episodes(1, {"action": "all"})    # completes it today
    done = {q["id"]: q["done"] for q in book.today()["quests"]}
    assert done == {"rate_or_tier": True, "finish_show": True, "plan_add": True}


def test_game_best_quest(shelf, monkeypatch):
    monkeypatch.setattr(quests, "draw_quests", lambda day: ["game_best", "watch_2", "watch_5"])
    book = QuestBook(shelf)
    assert book.today()["quests"][0]["progress"] == 0
    GameScores(shelf.db).submit("zoltraak", 50)
    assert book.today()["quests"][0]["done"]


def test_quests_endpoint(client):
    data = client.get("/api/quests").get_json()
    assert data["date"] == date.today().isoformat() and len(data["quests"]) == 3
    for q in data["quests"]:
        assert set(q) == {"id", "text", "progress", "goal", "done", "xp"}


# ---------------------------------------------------------------- mini-game XP
def test_game_xp_is_capped_per_day(shelf):
    scores = GameScores(shelf.db)
    day = date(2026, 11, 6)
    awarded = [scores.submit("cover-reveal", s, today=day)["xp_awarded"] for s in (100, 200, 300, 400, 500)]
    assert awarded == [15, 15, 15, 15, 0]                       # 60 XP cap reached
    assert scores.submit("cover-reveal", 50, today=day)["xp_awarded"] == 0   # not a best
    assert game_xp_total(shelf.db) == GAME_XP_DAILY_CAP
    assert scores.submit("cover-reveal", 600, today=day + timedelta(days=1))["xp_awarded"] == 15
    assert breakdown(shelf.profile(), "Mini games") == 75


def test_game_xp_api_and_new_game(client):
    resp = client.post("/api/games/whos-that-character/score", json={"score": 4200})
    assert resp.status_code == 200 and resp.get_json()["xp_awarded"] == 15
    assert client.post("/api/games/whos-that-character/score", json={"score": 10_001}).status_code == 400


def test_bonus_xp_survives_backup(shelf, tmp_path):
    from anishelf.db import Database

    GameScores(shelf.db).submit("zoltraak", 10)
    shelf.db.set_setting("quest_xp", {"2026-11-01": {"watch_2": 20}})
    shelf.add(1)
    payload = shelf.db.export()
    payload["progression"]["game_xp"]["not-a-date"] = 999   # junk is dropped on import
    other = Database(tmp_path / "copy.db")
    other.import_backup(payload)
    assert other.setting("quest_xp") == {"2026-11-01": {"watch_2": 20}}
    assert game_xp_total(other) == 15


# ---------------------------------------------------------------- new badges
def entry(mal_id, status="completed", total=12, franchise=None, score=None):
    return {"mal_id": mal_id, "status": status, "total": total, "franchise": franchise, "score": score}


def test_night_owl_badge_is_secret_until_earned():
    day = datetime(2026, 3, 1)
    late = activity_metrics([log_row(1, 1, day.replace(hour=3, minute=30))], [])
    early = activity_metrics([log_row(1, 1, day.replace(hour=5, minute=0))], [])
    assert late["night_owl"] == 1 and early["night_owl"] == 0

    m = metrics([], 0)
    hidden = next(b for b in profile(m)["badges"] if b["id"] == "night_owl")
    assert hidden["secret"] and hidden["name"] == "Secret badge" and hidden["description"] == "Keep watching..."
    shown = next(b for b in profile({**m, **late})["badges"] if b["id"] == "night_owl")
    assert shown["earned"] and shown["name"] == "Night Owl"
    normal = next(b for b in profile(m)["badges"] if b["id"] == "century")
    assert normal["secret"] is False
    assert SECRET_BADGES <= {b["id"] for b in profile(m)["badges"]}


def test_marathon_badge():
    day = datetime(2026, 3, 1, 12)
    nine = [log_row(1, i, day + timedelta(minutes=20 * i)) for i in range(1, 10)]
    assert activity_metrics(nine, [])["best_day"] == 9
    ten = nine + [log_row(2, 1, day.replace(hour=23))]
    m = {**metrics([], 0), **activity_metrics(ten, [])}
    assert next(b for b in profile(m)["badges"] if b["id"] == "marathon")["earned"]


def test_speedrunner_badge():
    start = datetime(2026, 3, 1, 20)
    fast = [log_row(1, i, start + timedelta(hours=5 * i)) for i in range(1, 13)]     # 12 eps in 2.5 days
    slow = [log_row(2, i, start + timedelta(days=i)) for i in range(1, 13)]          # 12 eps in 11 days
    assert activity_metrics(fast + slow, [entry(1), entry(2)])["speedruns"] == 1
    # an unfinished show or a short one doesn't count
    assert activity_metrics(fast, [entry(1, status="watching")])["speedruns"] == 0
    assert activity_metrics(fast, [entry(1, total=11)])["speedruns"] == 0


def test_comeback_badge():
    start = datetime(2026, 1, 1, 20)
    assert activity_metrics([log_row(1, 1, start), log_row(1, 2, start + timedelta(days=40))], [])["comebacks"] == 1
    assert activity_metrics([log_row(1, 1, start), log_row(1, 2, start + timedelta(days=20))], [])["comebacks"] == 0


def test_loyal_badge():
    ref = {"id": 100, "title": "Long Show", "size": 5}
    all_done = [entry(100 + i, franchise=ref) for i in range(5)]
    assert activity_metrics([], all_done)["loyal"] == 1
    one_missing = all_done[:4] + [entry(104, status="watching", franchise=ref)]
    assert activity_metrics([], one_missing)["loyal"] == 0
    small = {"id": 200, "title": "Short", "size": 3}
    assert activity_metrics([], [entry(200 + i, franchise=small) for i in range(3)])["loyal"] == 0


def test_perfect_ten_badge(shelf):
    shelf.add(1, "completed")
    assert not next(b for b in shelf.profile()["badges"] if b["id"] == "perfect_ten")["earned"]
    shelf.update(1, {"score": 10})
    assert next(b for b in shelf.profile()["badges"] if b["id"] == "perfect_ten")["earned"]


# ---------------------------------------------------------------- Anime Wrapped
def wrapped_entry(mal_id, title, genres, duration=24, status="completed", finished_on=None):
    return {"mal_id": mal_id, "status": status, "finished_on": finished_on, "updated_at": "2026-01-01T00:00:00+00:00",
            "meta": {"title": title, "title_english": None, "image": None, "genres": genres, "duration_min": duration}}


def test_wrapped_numbers():
    entries = [
        wrapped_entry(1, "Frieren", ["Fantasy", "Adventure"], finished_on="2026-03-02"),
        wrapped_entry(2, "Bocchi", ["Comedy"], finished_on="2026-07-20"),
        wrapped_entry(3, "Old Show", ["Drama"], finished_on="2025-05-01"),
        wrapped_entry(4, "Movie", ["Drama"], duration=120, status="watching"),
    ]
    log = []
    for i in range(1, 6):                               # Frieren: 5 eps on 1-5 March (a 5-day streak)
        log.append(log_row(1, i, datetime(2026, 3, i, 20)))
    for i in range(1, 4):                               # Bocchi: 3 eps in July
        log.append(log_row(2, i, datetime(2026, 7, 10 + 2 * i, 20)))
    log.append(log_row(4, 1, datetime(2026, 7, 30, 20)))  # a 2-hour movie
    log.append(log_row(3, 1, datetime(2025, 5, 1, 20)))   # last year: not counted

    w = build_wrapped(entries, log, 2026, today=date(2026, 11, 6))
    assert w["episodes"] == 9 and w["shows_watched"] == 3
    assert w["minutes"] == 8 * 24 + 120 and w["hours"] == 5.2
    assert w["most_watched"]["mal_id"] == 1 and w["most_watched"]["episodes"] == 5
    assert [m["episodes"] for m in w["months"]] == [0, 0, 5, 0, 0, 0, 4, 0, 0, 0, 0, 0]
    assert w["busiest_month"] == {"month": 3, "name": "March", "episodes": 5}
    assert w["longest_streak"] == 5
    assert w["top_genre"]["name"] == "Fantasy"
    assert w["completed"] == 2
    assert w["first_finished"]["mal_id"] == 1 and w["last_finished"]["mal_id"] == 2
    assert w["years"] == [2026, 2025]
    assert "9 episodes" in w["summary"] and "Frieren" in w["summary"]

    last_year = build_wrapped(entries, log, 2025, today=date(2026, 11, 6))
    assert last_year["episodes"] == 1 and last_year["completed"] == 1

    empty = build_wrapped([], [], None, today=date(2026, 11, 6))
    assert empty["year"] == 2026 and not empty["has_data"] and empty["busiest_month"] is None


def test_wrapped_endpoint(client):
    data = client.get("/api/wrapped").get_json()
    assert data["year"] == date.today().year and len(data["months"]) == 12
    assert client.get("/api/wrapped?year=2025").get_json()["year"] == 2025
    assert client.get("/api/wrapped?year=abc").status_code == 400
    assert client.get("/api/wrapped?year=1500").status_code == 400


@pytest.mark.parametrize("quest_id", sorted(QUEST_POOL))
def test_every_quest_has_a_progress_function(quest_id):
    assert quest_id in quests.PROGRESS
