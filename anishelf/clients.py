"""HTTP plumbing + the Jikan (MyAnimeList) client. AniList lives in anilist.py.

Safety rules (so a bug can never spam an API):
  * every request goes through a RateLimiter (min gap + per-minute window)
  * a hard per-session maximum number of calls
  * timeouts on every request, at most one retry
  * responses are cached in SQLite, and a stale cache is used if the API is down
"""

from __future__ import annotations

import collections
import logging
import threading
import time

import requests

from .logic import parse_duration_minutes

log = logging.getLogger(__name__)

USER_AGENT = "AniShelf/1.0 (personal anime tracker)"
TIMEOUT = (4, 15)  # (connect, read) seconds

JIKAN = "https://api.jikan.moe/v4"

HOUR = 3600
DAY = 24 * HOUR


class ApiError(RuntimeError):
    """A problem talking to an external API. The message is shown to the user."""


class NotFoundError(ApiError):
    """The API answered, but the anime doesn't exist (no point trying another API)."""


class RateLimiter:
    """Blocks until a call is allowed. Thread-safe.

    min_interval: minimum seconds between two calls
    per_minute:   max calls in any rolling 60 s window
    max_calls:    hard cap for the whole session (restart the app to reset)
    """

    def __init__(self, min_interval: float, per_minute: int, max_calls: int, name: str = "api"):
        self.min_interval = min_interval
        self.per_minute = per_minute
        self.max_calls = max_calls
        self.name = name
        self.calls = 0
        self._recent: collections.deque[float] = collections.deque()
        self._last = 0.0
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            if self.calls >= self.max_calls:
                raise ApiError(
                    f"Safety limit reached: {self.max_calls} {self.name} requests this session. "
                    "Restart AniShelf to continue."
                )
            now = time.monotonic()
            # rolling one-minute window
            while self._recent and now - self._recent[0] >= 60:
                self._recent.popleft()
            if len(self._recent) >= self.per_minute:
                time.sleep(60 - (now - self._recent[0]) + 0.05)
            # minimum gap between calls
            gap = self._last + self.min_interval - time.monotonic()
            if gap > 0:
                time.sleep(gap)
            self._last = time.monotonic()
            self._recent.append(self._last)
            self.calls += 1


class _HttpClient:
    def __init__(self, limiter: RateLimiter, session: requests.Session | None = None):
        self.limiter = limiter
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        """One request with at most one retry on 429/5xx/connection errors."""
        last_error: Exception | None = None
        for attempt in range(2):
            self.limiter.acquire()
            try:
                resp = self.session.request(method, url, timeout=TIMEOUT, **kwargs)
            except requests.RequestException as exc:
                last_error = exc
                log.warning("%s %s failed: %s", method, url, type(exc).__name__)
                # can't even connect -> don't make the user wait for a second timeout
                if attempt == 0 and not isinstance(exc, requests.ConnectionError):
                    time.sleep(1.5)
                    continue
                raise ApiError(f"{self.limiter.name} is unreachable - check your internet connection") from exc

            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == 0:
                    retry_after = resp.headers.get("Retry-After", "2")
                    try:
                        wait = min(float(retry_after), 5.0)
                    except ValueError:
                        wait = 2.0
                    time.sleep(max(wait, 1.0))
                    continue
                raise ApiError(f"{self.limiter.name} is busy right now (HTTP {resp.status_code}). Try again in a moment.")
            return resp
        raise ApiError(f"{self.limiter.name} request failed: {last_error}")


# ======================================================================= Jikan
class JikanClient(_HttpClient):
    def __init__(self, session=None, max_calls: int = 600):
        # Jikan's documented limits: 3 req/s and 60 req/min. We stay below both.
        super().__init__(RateLimiter(0.4, 50, max_calls, name="Jikan (MyAnimeList)"), session)

    def _get(self, path: str, params: dict | None = None) -> dict:
        resp = self._request("GET", f"{JIKAN}{path}", params=params)
        if resp.status_code == 404:
            raise NotFoundError("Anime not found")
        if resp.status_code >= 400:
            raise ApiError(f"Jikan error (HTTP {resp.status_code})")
        try:
            return resp.json()
        except ValueError as exc:
            raise ApiError("Jikan sent an invalid response") from exc

    def ping(self) -> None:
        """Cheap check that Jikan is reachable (raises ApiError if not)."""
        self._get("/anime/1")

    def search(self, query: str, limit: int = 20) -> list[dict]:
        data = self._get("/anime",{"q": query, "limit": limit, "sfw": "true", "order_by": "members", "sort": "desc"})
        return _dedupe([normalize_jikan(item) for item in data.get("data") or []])

    def season_now(self, limit: int = 24) -> list[dict]:
        data = self._get("/seasons/now", {"limit": limit, "sfw": "true"})
        items = [normalize_jikan(item) for item in data.get("data") or []]
        items = _dedupe(items)
        items.sort(key=lambda m: m.get("popularity") or 10**9)
        return items

    def top_airing(self, limit: int = 24) -> list[dict]:
        data = self._get("/top/anime", {"filter": "airing", "limit": limit, "sfw": "true"})
        return _dedupe([normalize_jikan(item) for item in data.get("data") or []])

    def anime(self, mal_id: int) -> dict:
        data = self._get(f"/anime/{mal_id}/full")
        if not data.get("data"):
            raise NotFoundError("Anime not found")
        return normalize_jikan(data["data"])

    def episodes(self, mal_id: int, max_pages: int = 15) -> tuple[list[dict], bool]:
        """All episode titles (100 per page). Capped so huge shows can't loop forever."""
        episodes: list[dict] = []
        truncated = False
        for page in range(1, max_pages + 1):
            data = self._get(f"/anime/{mal_id}/episodes", {"page": page})
            for ep in data.get("data") or []:
                number = ep.get("mal_id")
                if not isinstance(number, int):
                    continue
                aired = ep.get("aired")
                episodes.append({
                    "number": number,
                    "title": ep.get("title") or None,
                    "filler": bool(ep.get("filler")),
                    "recap": bool(ep.get("recap")),
                    "aired": aired[:10] if isinstance(aired, str) else None,
                    "thumbnail": None,
                    "watch_url": None,
                    "watch_site": None,
                })
            if not (data.get("pagination") or {}).get("has_next_page"):
                break
        else:
            truncated = True
        return episodes, truncated

    def recommendations(self, mal_id: int, limit: int = 12) -> list[dict]:
        data = self._get(f"/anime/{mal_id}/recommendations")
        results = []
        for rec in (data.get("data") or [])[:limit]:
            entry = rec.get("entry") or {}
            if not isinstance(entry.get("mal_id"), int):
                continue
            results.append({
                "mal_id": entry["mal_id"],
                "title": entry.get("title") or "Untitled",
                "title_english": None,  # Jikan's recommendation list only has the main title
                "image": _image_from(entry.get("images")),
                "votes": rec.get("votes") or 0,
            })
        return results


def _image_from(images) -> str | None:
    images = images or {}
    for fmt in ("webp", "jpg"):
        block = images.get(fmt) or {}
        for size in ("large_image_url", "image_url"):
            if block.get(size):
                return block[size]
    return None


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for item in items:
        if item["mal_id"] in seen:
            continue
        seen.add(item["mal_id"])
        out.append(item)
    return out


def _names(items) -> list[str]:
    return [i["name"] for i in items or [] if isinstance(i, dict) and i.get("name")]


def normalize_jikan(item: dict) -> dict:
    """Turn a Jikan anime object into our compact Meta shape (see docs/API.md)."""
    status = item.get("status")
    trailer = item.get("trailer") or {}
    genres = _names(item.get("genres")) + _names(item.get("themes")) + _names(item.get("demographics"))
    year = item.get("year")
    if not year:
        aired_from = ((item.get("aired") or {}).get("from") or "")[:4]
        year = int(aired_from) if aired_from.isdigit() else None
    episodes = item.get("episodes")
    return {
        "mal_id": int(item["mal_id"]),
        "title": item.get("title") or item.get("title_english") or "Untitled",
        "title_english": item.get("title_english"),
        "title_japanese": item.get("title_japanese"),
        "image": _image_from(item.get("images")),
        "type": item.get("type"),
        "episodes": episodes if isinstance(episodes, int) and episodes > 0 else None,
        "duration_min": parse_duration_minutes(item.get("duration")),
        "airing_status": status,
        "airing": status == "Currently Airing",
        "year": year,
        "season": item.get("season"),
        "genres": list(dict.fromkeys(genres)),
        "studios": _names(item.get("studios")),
        "synopsis": item.get("synopsis"),
        "mal_score": item.get("score"),
        "rank": item.get("rank"),
        "popularity": item.get("popularity"),
        "rating": item.get("rating"),
        "url": item.get("url"),
        "trailer_youtube_id": trailer.get("youtube_id"),
        "anilist": None,
    }
