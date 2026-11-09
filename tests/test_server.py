def test_health(client):
    assert client.get("/api/health").get_json()["ok"] is True


def test_library_endpoints(client):
    r = client.post("/api/library", json={"mal_id": 1, "status": "watching"})
    assert r.status_code == 200 and r.get_json()["entry"]["status"] == "watching"

    r = client.put("/api/library/1/episodes", json={"action": "up_to", "episode": 12})
    assert r.get_json()["status_changed"] == "completed"

    r = client.patch("/api/library/1", json={"score": 10, "tier": "S"})
    assert r.get_json()["entry"]["score"] == 10

    entries = client.get("/api/library?status=completed").get_json()["entries"]
    assert [e["mal_id"] for e in entries] == [1]

    assert client.delete("/api/library/1").get_json()["ok"] is True  # (+ an undo "snapshot", see test_qol.py)
    assert client.delete("/api/library/1").status_code == 404


def test_errors_are_json(client):
    assert client.get("/api/search?q=a").get_json()["error"].startswith("Type at least")
    assert client.patch("/api/library/1", json={"score": 3}).status_code == 404
    assert client.post("/api/library", json={"mal_id": "1"}).status_code == 400
    assert client.post("/api/library", json={"mal_id": 999}).status_code == 502  # not found upstream
    assert client.get("/api/nope").get_json() == {"error": "Not found"}
    assert client.get("/api/library?status=bogus").status_code == 400
    assert client.get("/api/random?max_episodes=abc").status_code == 400


def test_cross_site_requests_blocked(client):
    r = client.post("/api/library", json={"mal_id": 1}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/library", data="mal_id=1", content_type="application/x-www-form-urlencoded")
    assert r.status_code == 415


def test_image_proxy_rejects_other_hosts(client):
    assert client.get("/img?u=https://evil.example/x.png").status_code == 400
    assert client.get("/img?u=http://cdn.myanimelist.net/x.png").status_code == 400  # https only


def test_search_marks_library_status(client):
    client.post("/api/library", json={"mal_id": 2})
    results = client.get("/api/search?q=show").get_json()["results"]
    by_id = {r["mal_id"]: r["library_status"] for r in results}
    assert by_id[2] == "plan_to_watch" and by_id[1] is None


def test_export_download_and_import(client):
    client.post("/api/library", json={"mal_id": 1})
    r = client.get("/api/export")
    assert "attachment" in r.headers["Content-Disposition"]
    backup = r.get_json()
    client.delete("/api/library/1")
    assert client.post("/api/import", json=backup).get_json() == {"imported": 1}
    assert client.post("/api/import", json={"app": "x"}).status_code == 400


def test_discover_and_detail(client):
    d = client.get("/api/discover").get_json()
    assert len(d["season"]) == 2 and len(d["top_airing"]) == 1
    page = client.get("/api/anime/3").get_json()
    assert page["meta"]["anilist"]["next_airing"]["episode"] == 6
    assert client.get("/api/anime/3/episodes").get_json()["episodes"][0]["title"] == "Ep 1"
    assert client.get("/api/anime/3/recommendations").get_json()["results"][0]["mal_id"] == 2


def test_refresh_without_body_is_allowed(client):
    client.post("/api/library", json={"mal_id": 1})
    r = client.post("/api/library/1/refresh")  # exactly what the frontend sends
    assert r.status_code == 200 and r.get_json()["entry"]["mal_id"] == 1


def test_static_files_have_correct_mime_types(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/js/main.js").mimetype == "text/javascript"
    assert client.get("/static/css/app.css").mimetype == "text/css"


def test_warmup_runs_every_step_and_reports(client, shelf):
    from anishelf.warmup import Warmup
    status = client.get("/api/warmup").get_json()
    assert status["done"] is False and status["total"] >= 1  # not started in tests
    warm = Warmup(shelf)
    warm._run()  # run inline (no thread) so the test is deterministic
    snap = warm.snapshot()
    assert snap["done"] and snap["finished"] == snap["total"] and snap["step"] is None


def test_app_icon_files_are_served(client):
    ico = client.get("/favicon.ico")
    assert ico.status_code == 200 and ico.data[:4] == b"\x00\x00\x01\x00"  # the .ico file signature
    png = client.get("/static/icons/icon-192.png")
    assert png.status_code == 200 and png.data[:4] == b"\x89PNG"
    assert client.get("/static/manifest.webmanifest").status_code == 200
