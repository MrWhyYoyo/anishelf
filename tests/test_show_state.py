"""Automatic show-state badges (AniShelf 1.2): "Waiting for Season 2", "New season out", ..."""

from anishelf import show_state


def node(mal_id, start, status="FINISHED", neighbours=(), fmt="TV"):
    return {"mal_id": mal_id, "title": f"Show {mal_id}", "title_english": None, "format": fmt,
            "episodes": 12, "status": status, "year": int(start[:4]), "start": start, "image": None,
            "neighbours": list(neighbours)}


def cache_series(shelf, *nodes):
    for n in nodes:
        shelf.db.cache_set(f"relations:{n['mal_id']}", n)


def state_of(shelf, mal_id):
    return next(e for e in shelf.library() if e["mal_id"] == mal_id)["show_state"]


def test_date_text():
    assert show_state._date_text({"start": "2027-04-31"}) == "Apr 2027"   # month known, day unknown
    assert show_state._date_text({"start": "2027-12-31"}) == "2027"       # month unknown
    assert show_state._date_text({"start": "9999-12-31"}) is None


def test_done_with_announced_sequel(shelf):
    shelf.add(1, "completed")
    cache_series(shelf, node(1, "2013-04-07", neighbours=[2]),
                 node(2, "2027-04-31", status="NOT_YET_RELEASED", neighbours=[1]))
    state = state_of(shelf, 1)
    assert state["kind"] == "announced"
    assert state["next"]["mal_id"] == 2 and state["next"]["label"] == "Season 2" and state["next"]["when"] == "Apr 2027"


def test_done_with_sequel_out_and_superseded(shelf):
    shelf.add(1, "completed")
    cache_series(shelf, node(1, "2013-04-07", neighbours=[2]), node(2, "2017-04-01", status="RELEASING", neighbours=[1]))
    assert state_of(shelf, 1) == {"kind": "new_season", "next": state_of(shelf, 1)["next"], "airing": True}
    # sequel on Want to watch: still "new season out"; once you start it, the badge moves on
    shelf.add(2, "plan_to_watch")
    assert state_of(shelf, 1)["kind"] == "new_season"
    shelf.update(2, {"status": "watching"})
    assert state_of(shelf, 1) is None


def test_done_and_ended_or_still_airing(shelf):
    shelf.add(1, "completed")
    cache_series(shelf, node(1, "2015-01-01"))
    assert state_of(shelf, 1) == {"kind": "ended"}
    shelf.add(3, "completed")  # the fake show 3 is still airing
    cache_series(shelf, node(3, "2015-01-01"))
    assert state_of(shelf, 3) == {"kind": "airing"}


def test_unknown_series_has_no_badge(shelf):
    shelf.add(3, "completed")  # nothing cached about its seasons yet
    assert state_of(shelf, 3) is None


def test_refresh_is_capped(shelf, anilist):
    for mal_id in (1, 2, 3):
        shelf.add(mal_id, "completed")
    calls = anilist.calls
    made = show_state.refresh(shelf, max_lookups=1)
    assert made == 1 and anilist.calls - calls == 1


def test_inbox_unread_and_seen(shelf, client):
    from anishelf import inbox
    shelf.add(1, "completed")
    cache_series(shelf, node(1, "2013-04-07", neighbours=[2]),
                 node(2, "2027-04-31", status="NOT_YET_RELEASED", neighbours=[1]))
    data = client.get("/api/inbox").get_json()
    assert data["unread"] == 1 and data["items"][0]["id"] == "announced:2"
    assert client.post("/api/inbox/seen").get_json()["unread"] == 0
    # the sequel comes out: that's new news, so the bell lights up again
    cache_series(shelf, node(2, "2027-04-01", status="RELEASING", neighbours=[1]))
    data = inbox.items(shelf)
    assert data["unread"] == 1 and data["items"][0]["kind"] == "new_season"
