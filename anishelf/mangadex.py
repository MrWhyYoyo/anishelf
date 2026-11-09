"""MangaDex client: which chapter each manga volume ends at (free public API, no key).

Why MangaDex: AniList (our manga source) knows how many volumes and chapters a manga has,
but not WHICH chapters are in which volume. MangaDex's "aggregate" endpoint lists every
volume with its chapter numbers, so "I've read 5 volumes" can become "up to chapter 42".

Rules this file follows:
  * metadata only: we never fetch chapter pages or images, and never link to MangaDex for reading
  * at most 3 requests per lookup (a search or two + one aggregate), >= 0.25 s apart, 10 s timeout
  * a polite User-Agent naming the app, with no personal data
  * the service caches the answer (7 days, or 1 day for "not found"), so this runs rarely
"""

from __future__ import annotations

import logging
import math

import requests

from .clients import ApiError, RateLimiter

log = logging.getLogger(__name__)

MANGADEX = "https://api.mangadex.org"
USER_AGENT = "AniShelf personal tracker (manga volume lookup)"
TIMEOUT = 10            # seconds per request
MAX_REQUESTS_PER_LOOKUP = 3
SEARCH_LIMIT = 10


# ================================================================ pure parsing (easy to test)
def _number(text) -> float | None:
    """'12' -> 12.0, '10.5' -> 10.5, 'none' / 'Oneshot' / None -> None."""
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    # float("nan") and float("inf") are valid floats, but not chapter numbers
    return value if math.isfinite(value) and value >= 0 else None


MAX_GAP = 5  # a jump of more chapters than this inside one volume is a mis-filed chapter


def _end_of_run(numbers: list[float]) -> float:
    """The last chapter of the unbroken run from the start: [1, 2, ... 7, 7.5, 232] -> 7.5.

    Walks up the sorted list and stops at the first big jump, so one mis-filed chapter
    (232 listed in volume 1) can't stretch a volume to the end of the manga.
    """
    end = numbers[0]
    for n in numbers[1:]:
        if n - end > MAX_GAP:
            break
        end = n
    return end


def parse_aggregate(data) -> dict[int, int]:
    """MangaDex /aggregate answer -> {volume_number: last_whole_chapter_in_that_volume}.

    The answer is dicts inside dicts:
        {"volumes": {"1": {"volume": "1", "chapters": {"1": {...}, "2": {...}, "2.5": {...}}},
                     "none": {"volume": "none", "chapters": {"140": {...}}}}}
    The keys are TEXT, so we turn them into numbers ourselves.
    """
    volumes = (data or {}).get("volumes") if isinstance(data, dict) else None
    # an empty answer comes back as a list [] instead of a dict, so check the type
    if not isinstance(volumes, dict):
        return {}

    # Step 1: for each real volume, the lowest and highest chapter number in it
    ranges = {}  # volume number -> (first chapter, last chapter)
    for volume_key, volume in volumes.items():
        number = _number(volume_key)
        # "none" = chapters not collected in a volume yet; "1.5"-style specials aren't real volumes
        if number is None or number != int(number) or number < 1 or not isinstance(volume, dict):
            continue
        chapters = volume.get("chapters")
        if not isinstance(chapters, dict):
            continue
        numbers = sorted(n for n in (_number(key) for key in chapters) if n is not None)
        if numbers:
            ranges[int(number)] = (numbers[0], _end_of_run(numbers))

    # Step 2: decide where each volume ENDS. MangaDex data is made by volunteers, so it has holes:
    #   * missing chapters (Frieren's volume 1 only lists chapters 1-2 of 7)
    #   * mis-filed chapters (Chainsaw Man's volume 1 also lists chapter 232)
    # So we trust a volume when we can see where the NEXT volume starts ("volume 6 starts at 43"
    # means volume 5 ends at 42), or when it's the newest volume (then we use its last chapter).
    newest = max(ranges, default=0)
    ends = {}
    for number, (first, last) in sorted(ranges.items()):
        if number + 1 in ranges:
            # math.ceil: if the next volume starts with extra chapter 42.5, this one ends at 42
            end = math.ceil(ranges[number + 1][0]) - 1
            if end < first:  # the next volume's first chapter is odd itself
                end = last
        elif number == newest:
            end = last
        else:
            continue  # can't see where it ends
        # math.floor: a volume ending with extra chapter 10.5 still ends at whole chapter 10
        ends[number] = math.floor(end)

    # Step 3: volume ends must go up (volume 6 can't end before volume 5). Drop any that don't.
    clean = {}
    previous_end = -1
    for number, end in sorted(ends.items()):
        if end > previous_end:
            clean[number] = end
            previous_end = end
    return clean


def find_manga_id(results, anilist_id: int, id_mal: int | None) -> str | None:
    """Pick the MangaDex manga that is OUR manga, from a list of search results.

    MangaDex stores other sites' ids under attributes.links as text: {"al": "118586", "mal": "126287"}.
    The AniList id is the best match (that's our key). The MAL id is a fallback, but only for
    results with no AniList link at all: a result linking to a DIFFERENT AniList id is another manga.
    """
    wanted_al = str(anilist_id)
    wanted_mal = str(id_mal) if id_mal else None
    mal_match = None
    for item in results or []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        links = (item.get("attributes") or {}).get("links")
        if not isinstance(links, dict):  # MangaDex sends null or [] when there are no links
            continue
        if str(links.get("al") or "") == wanted_al:
            return item["id"]
        if wanted_mal and mal_match is None and not links.get("al") and str(links.get("mal") or "") == wanted_mal:
            mal_match = item["id"]
    return mal_match


# ================================================================ the client
class RequestBudget:
    """Counts the requests of ONE lookup, so a bug can never loop over the API."""

    def __init__(self, limit: int = MAX_REQUESTS_PER_LOOKUP):
        self.left = limit

    def spend(self) -> None:
        if self.left <= 0:
            raise ApiError("MangaDex lookup used its request limit")
        self.left -= 1


class MangaDexClient:
    def __init__(self, session: requests.Session | None = None, max_calls: int = 300):
        # >= 0.25 s between requests (we use 0.3), 20 a minute, 300 per app session
        self.limiter = RateLimiter(0.3, 20, max_calls, name="MangaDex")
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

    def _get(self, path: str, params: dict | None, budget: RequestBudget) -> dict:
        """One GET. No automatic retry: with only 3 requests per lookup, a retry would eat the budget.
        The service caches "not found", and a failure is simply tried again next time."""
        budget.spend()
        self.limiter.acquire()  # waits so requests are never closer than 0.3 s
        try:
            resp = self.session.get(f"{MANGADEX}{path}", params=params, timeout=TIMEOUT)
        except requests.RequestException as exc:
            log.warning("MangaDex %s failed: %s", path, type(exc).__name__)
            raise ApiError("MangaDex is unreachable right now") from exc
        if resp.status_code == 404:
            return {}
        if resp.status_code >= 400:
            raise ApiError(f"MangaDex error (HTTP {resp.status_code})")
        try:
            data = resp.json()
        except ValueError as exc:
            raise ApiError("MangaDex sent an invalid response") from exc
        return data if isinstance(data, dict) else {}

    def volume_ends(self, anilist_id: int, id_mal: int | None, titles: list[str]) -> dict:
        """Find our manga on MangaDex and return where its volumes end.

        -> {"found": True, "mangadex_id": "...", "volumes": [{"volume": 1, "last_chapter": 7}, ...]}
        or {"found": False}. Volumes are a list (not a dict) because JSON turns number keys into text.
        """
        budget = RequestBudget()
        mangadex_id = None
        # try each title (romaji, then English), but always keep 1 request for the aggregate
        for title in titles:
            if budget.left < 2:
                break
            data = self._get("/manga", {"title": title, "limit": SEARCH_LIMIT}, budget)
            mangadex_id = find_manga_id(data.get("data"), anilist_id, id_mal)
            if mangadex_id:
                break
        if not mangadex_id:
            return {"found": False}

        # No language filter on purpose: it covers more volumes than translatedLanguage[]=en
        ends = parse_aggregate(self._get(f"/manga/{mangadex_id}/aggregate", None, budget))
        if not ends:
            return {"found": False, "mangadex_id": mangadex_id}
        return {
            "found": True,
            "mangadex_id": mangadex_id,
            "volumes": [{"volume": v, "last_chapter": c} for v, c in ends.items()],
        }
