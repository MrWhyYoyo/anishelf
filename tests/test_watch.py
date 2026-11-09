import pytest

from anishelf.anilist import extras_from, parse_streaming_episodes, streaming_links
from anishelf.watch import is_openable, is_streaming_url, open_in_browser


@pytest.mark.parametrize("url,ok", [
    ("https://www.crunchyroll.com/watch/G2XU04E88/the-journeys-end", True),
    ("https://crunchyroll.com/series/x", True),
    ("https://www.netflix.com/title/81726714", True),
    ("http://www.crunchyroll.com/watch/x", False),          # https only
    ("https://crunchyroll.com.evil.example/x", False),      # look-alike host
    ("https://evilcrunchyroll.com/x", False),
    ("javascript:alert(1)", False),
    ("file:///C:/Windows/system32/calc.exe", False),
])
def test_streaming_allowlist(url, ok):
    assert is_streaming_url(url) is ok


def test_open_in_browser_uses_allowlist():
    opened = []
    open_in_browser("https://myanimelist.net/anime/52991", opened.append)
    assert opened == ["https://myanimelist.net/anime/52991"]
    with pytest.raises(ValueError):
        open_in_browser("https://evil.example", opened.append)
    assert is_openable("https://anilist.co/anime/1") and not is_streaming_url("https://anilist.co/anime/1")


def test_streaming_links_and_episode_urls():
    links = streaming_links([
        {"site": "Official Site", "url": "https://frieren-anime.jp/", "type": "INFO"},
        {"site": "Crunchyroll", "url": "https://www.crunchyroll.com/series/GG5H5XQX4", "type": "STREAMING"},
        {"site": "Crunchyroll", "url": "https://www.crunchyroll.com/series/dupe", "type": "STREAMING"},
        {"site": "Sketchy", "url": "https://unknown-stream.example/x", "type": "STREAMING"},
        {"site": "Netflix", "url": "http://www.netflix.com/title/1", "type": "STREAMING"},
    ])
    assert links == [{"site": "Crunchyroll", "url": "https://www.crunchyroll.com/series/GG5H5XQX4"},
                     {"site": "Netflix", "url": "https://www.netflix.com/title/1"}]
    assert extras_from({"externalLinks": None})["streaming"] == []
    ep = parse_streaming_episodes([{"title": "Episode 1 - X", "url": "http://www.crunchyroll.com/watch/A/x", "site": "Crunchyroll"}])[0]
    assert ep["watch_url"] == "https://www.crunchyroll.com/watch/A/x" and ep["watch_site"] == "Crunchyroll"


def test_open_endpoint(client):
    opened = []
    client.application.config["OPENER"] = opened.append
    assert client.post("/api/open", json={"url": "https://www.crunchyroll.com/watch/A/x"}).get_json() == {"ok": True}
    assert opened == ["https://www.crunchyroll.com/watch/A/x"]
    assert client.post("/api/open", json={"url": "https://evil.example"}).status_code == 400
    assert client.post("/api/open", json={}).status_code == 400
    r = client.post("/api/open", json={"url": "https://www.crunchyroll.com/x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and len(opened) == 1  # other websites can't make it open tabs


def test_meta_always_has_streaming(shelf):
    assert shelf.meta(1)["streaming"] == []
