import pytest

from anishelf.games import GameScores
from anishelf.logic import ValidationError


def test_higher_is_better_keeps_the_best(shelf):
    scores = GameScores(shelf.db)
    assert scores.all()["cover-reveal"]["best"] is None
    first = scores.submit("cover-reveal", 500)
    assert first["new_best"] and first["best"] == 500 and first["plays"] == 1
    worse = scores.submit("cover-reveal", 300)
    assert not worse["new_best"] and worse["best"] == 500 and worse["last"] == 300 and worse["plays"] == 2
    assert scores.submit("cover-reveal", 900)["best"] == 900


def test_lower_is_better_for_deaths(shelf):
    scores = GameScores(shelf.db)
    scores.submit("return-by-death", 7)
    assert scores.submit("return-by-death", 3)["new_best"]
    result = scores.submit("return-by-death", 5)
    assert not result["new_best"] and result["best"] == 3
    assert scores.submit("return-by-death", 0)["best"] == 0  # a flawless run counts


@pytest.mark.parametrize("game, score", [
    ("nope", 5), ("zoltraak", -1), ("zoltraak", 10_001), ("zoltraak", 2.5), ("zoltraak", "9"), ("zoltraak", True),
])
def test_bad_scores_are_rejected(shelf, game, score):
    with pytest.raises(ValidationError):
        GameScores(shelf.db).submit(game, score)


def test_api_round_trip_and_reset(client):
    assert client.get("/api/games").get_json()["scores"]["odm-swing"]["plays"] == 0
    resp = client.post("/api/games/odm-swing/score", json={"score": 120})
    assert resp.status_code == 200 and resp.get_json()["new_best"] is True
    assert client.post("/api/games/odm-swing/score", json={"score": "lots"}).status_code == 400
    assert client.get("/api/games").get_json()["scores"]["odm-swing"]["best"] == 120
    client.post("/api/reset", json={"confirm": "RESET"})
    assert client.get("/api/games").get_json()["scores"]["odm-swing"]["best"] is None
