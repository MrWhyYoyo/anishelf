"""AniList GraphQL client (free, no key).

Used for two things:
  1. extras Jikan doesn't have: wide banner, cover colour, next-episode countdown
  2. a complete fallback when Jikan (MyAnimeList) is down - same MAL ids,
     same Meta shape, so the rest of the app doesn't notice the difference.
"""

from __future__ import annotations

import html
import re
from datetime import date

from .clients import ApiError, NotFoundError, RateLimiter, _HttpClient

ANILIST = "https://graphql.anilist.co"

MEDIA_FIELDS = """
  id idMal isAdult
  title { romaji english native }
  coverImage { extraLarge large color }
  bannerImage format episodes duration status season seasonYear
  startDate { year }
  genres
  studios(isMain: true) { nodes { name } }
  description(asHtml: false)
  averageScore popularity siteUrl
  trailer { id site }
  nextAiringEpisode { episode airingAt }
  externalLinks { site url type }
"""

# The seasonal chart also wants the full start date (to sort by it) and AniList's popularity count.
SEASON_FIELDS = MEDIA_FIELDS.replace("startDate { year }", "startDate { year month day }")

FORMATS = {"TV": "TV", "TV_SHORT": "TV", "MOVIE": "Movie", "SPECIAL": "Special",
           "OVA": "OVA", "ONA": "ONA", "MUSIC": "Music"}
STATUSES = {"FINISHED": "Finished Airing", "RELEASING": "Currently Airing",
            "NOT_YET_RELEASED": "Not yet aired", "CANCELLED": "Cancelled", "HIATUS": "On Hiatus"}


def current_season(today: date | None = None) -> tuple[str, int]:
    today = today or date.today()
    season = ("WINTER", "WINTER", "WINTER", "SPRING", "SPRING", "SPRING",
              "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL")[today.month - 1]
    return season, today.year


def clean_description(text: str | None) -> str | None:
    """AniList descriptions contain bits of HTML like <br> and <i>."""
    if not text:
        return None
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() or None


def extras_from(media: dict) -> dict:
    cover = media.get("coverImage") or {}
    nxt = media.get("nextAiringEpisode")
    return {
        "banner": media.get("bannerImage"),
        "color": cover.get("color"),
        "cover_xl": cover.get("extraLarge"),
        "next_airing": {"episode": nxt["episode"], "airing_at": nxt["airingAt"]}
        if nxt and isinstance(nxt.get("episode"), int) else None,
        "streaming": streaming_links(media.get("externalLinks")),
    }


def https(url: str | None) -> str | None:
    if not isinstance(url, str):
        return None
    return "https://" + url[len("http://"):] if url.startswith("http://") else url


def streaming_links(links) -> list[dict]:
    """"Where to watch": only STREAMING links on known sites (Crunchyroll, Netflix, ...)."""
    from .watch import is_streaming_url  # small module, no cycle
    out, seen = [], set()
    for link in links or []:
        url = https(link.get("url"))
        if link.get("type") != "STREAMING" or not url or not is_streaming_url(url) or link.get("site") in seen:
            continue
        seen.add(link.get("site"))
        out.append({"site": link.get("site") or "Watch", "url": url})
    return out


def normalize_anilist(media: dict) -> dict | None:
    """AniList Media -> our Meta shape. None if it has no MyAnimeList id."""
    mal_id = media.get("idMal")
    if not isinstance(mal_id, int) or mal_id < 1:
        return None
    title = media.get("title") or {}
    cover = media.get("coverImage") or {}
    trailer = media.get("trailer") or {}
    status = STATUSES.get(media.get("status"))
    score = media.get("averageScore")
    year = media.get("seasonYear") or (media.get("startDate") or {}).get("year")
    episodes = media.get("episodes")
    return {
        "mal_id": mal_id,
        "title": title.get("romaji") or title.get("english") or "Untitled",
        "title_english": title.get("english"),
        "title_japanese": title.get("native"),
        "image": cover.get("extraLarge") or cover.get("large"),
        "type": FORMATS.get(media.get("format")),
        "episodes": episodes if isinstance(episodes, int) and episodes > 0 else None,
        "duration_min": media.get("duration") or None,
        "airing_status": status,
        "airing": status == "Currently Airing",
        "year": year,
        "season": (media.get("season") or "").lower() or None,
        "genres": list(media.get("genres") or []),
        "studios": [n["name"] for n in ((media.get("studios") or {}).get("nodes") or []) if n.get("name")],
        "synopsis": clean_description(media.get("description")),
        "mal_score": round(score / 10, 2) if isinstance(score, (int, float)) else None,
        "rank": None,
        "popularity": None,
        "rating": None,
        "url": f"https://myanimelist.net/anime/{mal_id}",
        "trailer_youtube_id": trailer.get("id") if trailer.get("site") == "youtube" else None,
        "anilist": extras_from(media),
    }


class AniListClient(_HttpClient):
    def __init__(self, session=None, max_calls: int = 600):
        # AniList allows 90 req/min (sometimes lowered to 30). We use at most 25.
        super().__init__(RateLimiter(0.7, 25, max_calls, name="AniList"), session)

    def _query(self, query: str, variables: dict) -> dict | None:
        resp = self._request("POST", ANILIST, json={"query": query, "variables": variables})
        if resp.status_code == 404:  # AniList answers 404 when the anime isn't found
            return None
        if resp.status_code >= 400:
            raise ApiError(f"AniList error (HTTP {resp.status_code})")
        try:
            return resp.json().get("data") or None
        except ValueError as exc:
            raise ApiError("AniList sent an invalid response") from exc

    def _media_list(self, query: str, variables: dict) -> list[dict]:
        data = self._query(query, variables) or {}
        items = ((data.get("Page") or {}).get("media")) or []
        out, seen = [], set()
        for media in items:
            if media.get("isAdult"):
                continue
            meta = normalize_anilist(media)
            if meta and meta["mal_id"] not in seen:
                seen.add(meta["mal_id"])
                out.append(meta)
        return out

    # ------------------------------------------------------------ extras
    def extras(self, mal_id: int) -> dict:
        """Banner, accent colour and next-episode countdown. {} if AniList doesn't know it."""
        query = "query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { bannerImage coverImage { extraLarge color } nextAiringEpisode { episode airingAt } externalLinks { site url type } } }"
        media = (self._query(query, {"idMal": mal_id}) or {}).get("Media")
        return extras_from(media) if media else {}

    # ------------------------------------------------------------ fallback provider
    def search(self, query: str, limit: int = 20) -> list[dict]:
        q = f"query ($q: String, $n: Int) {{ Page(perPage: $n) {{ media(search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {{ {MEDIA_FIELDS} }} }} }}"
        return self._media_list(q, {"q": query, "n": limit})

    def season_now(self, limit: int = 24) -> list[dict]:
        season, year = current_season()
        q = (f"query ($s: MediaSeason, $y: Int, $n: Int) {{ Page(perPage: $n) {{ media(season: $s, seasonYear: $y, "
             f"type: ANIME, isAdult: false, sort: POPULARITY_DESC) {{ {MEDIA_FIELDS} }} }} }}")
        return self._media_list(q, {"s": season, "y": year, "n": limit})

    def top_airing(self, limit: int = 24) -> list[dict]:
        q = (f"query ($n: Int) {{ Page(perPage: $n) {{ media(status: RELEASING, type: ANIME, isAdult: false, "
             f"sort: SCORE_DESC, popularity_greater: 15000) {{ {MEDIA_FIELDS} }} }} }}")
        return self._media_list(q, {"n": limit})

    def season_page(self, season: str, year: int, page: int = 1, per_page: int = 50) -> dict:
        """One page of a whole season's anime, most popular first (for the seasonal chart, seasonal.py).

        Returns {"media": [raw AniList media], "has_next": bool}. seasonal.py turns the raw media
        into Meta and decides how many pages to ask for (it caps and caches them).
        """
        q = (f"query ($s: MediaSeason, $y: Int, $p: Int, $n: Int) {{ Page(page: $p, perPage: $n) {{ "
             f"pageInfo {{ hasNextPage }} media(season: $s, seasonYear: $y, type: ANIME, isAdult: false, "
             f"sort: POPULARITY_DESC) {{ {SEASON_FIELDS} }} }} }}")
        data = self._query(q, {"s": season.upper(), "y": year, "p": page, "n": max(1, min(per_page, 50))}) or {}
        block = data.get("Page") or {}
        return {"media": block.get("media") or [], "has_next": bool((block.get("pageInfo") or {}).get("hasNextPage"))}

    def anime(self, mal_id: int) -> dict:
        q = f"query ($idMal: Int) {{ Media(idMal: $idMal, type: ANIME) {{ {MEDIA_FIELDS} }} }}"
        media = (self._query(q, {"idMal": mal_id}) or {}).get("Media")
        meta = normalize_anilist(media) if media else None
        if not meta:
            raise NotFoundError("Anime not found")
        return meta

    def recommendations(self, mal_id: int, limit: int = 12) -> list[dict]:
        q = ("query ($idMal: Int, $n: Int) { Media(idMal: $idMal, type: ANIME) { recommendations(perPage: $n, sort: RATING_DESC) "
             "{ nodes { rating mediaRecommendation { idMal isAdult title { romaji english } coverImage { extraLarge large } } } } } }")
        media = (self._query(q, {"idMal": mal_id, "n": limit}) or {}).get("Media") or {}
        results = []
        for node in ((media.get("recommendations") or {}).get("nodes")) or []:
            rec = node.get("mediaRecommendation") or {}
            if not isinstance(rec.get("idMal"), int) or rec.get("isAdult"):
                continue
            title = rec.get("title") or {}
            results.append({
                "mal_id": rec["idMal"],
                "title": title.get("romaji") or title.get("english") or "Untitled",
                "title_english": title.get("english"),
                "image": (rec.get("coverImage") or {}).get("extraLarge") or (rec.get("coverImage") or {}).get("large"),
                "votes": max(node.get("rating") or 0, 0),
            })
        return results

    def episodes(self, mal_id: int) -> tuple[list[dict], bool]:
        """Episode titles + thumbnails from streaming sites (fallback when Jikan is down)."""
        q = "query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { streamingEpisodes { title thumbnail url site } } }"
        media = (self._query(q, {"idMal": mal_id}) or {}).get("Media") or {}
        return parse_streaming_episodes(media.get("streamingEpisodes")), False

    def popular(self, page: int, genre: str | None = None, per_page: int = 50) -> list[dict]:
        """Popular anime (optionally one genre) - the pool for "Surprise me"."""
        q = (f"query ($p: Int, $n: Int, $g: String) {{ Page(page: $p, perPage: $n) {{ media(type: ANIME, isAdult: false, "
             f"sort: POPULARITY_DESC, genre: $g, status_not: NOT_YET_RELEASED) {{ {MEDIA_FIELDS} }} }} }}")
        return self._media_list(q, {"p": page, "n": per_page, "g": genre})

    def popular_characters(self, page: int, per_page: int = 24) -> list[dict]:
        q = ("query ($p: Int, $n: Int) { Page(page: $p, perPage: $n) { characters(sort: FAVOURITES_DESC) "
             f"{{ {AVATAR_FIELDS} }} }} }}")
        data = self._query(q, {"p": page, "n": per_page}) or {}
        return _avatars((data.get("Page") or {}).get("characters"))

    def search_characters(self, query: str, per_page: int = 24) -> list[dict]:
        q = ("query ($q: String, $n: Int) { Page(perPage: $n) { characters(search: $q, sort: [SEARCH_MATCH, FAVOURITES_DESC]) "
             f"{{ {AVATAR_FIELDS} }} }} }}")
        data = self._query(q, {"q": query, "n": per_page}) or {}
        return _avatars((data.get("Page") or {}).get("characters"))

    def relations_node(self, mal_id: int) -> dict | None:
        """One entry + its SEQUEL/PREQUEL links (for grouping seasons). None if AniList doesn't know it."""
        from .franchise import node_from_media
        q = ("query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { idMal format episodes status "
             "title { romaji english } startDate { year month day } coverImage { large extraLarge } "
             "relations { edges { relationType(version: 2) node { idMal type format } } } } }")
        media = (self._query(q, {"idMal": mal_id}) or {}).get("Media")
        return node_from_media(media) if media else None

    def characters(self, mal_id: int, limit: int = 25) -> list[dict]:
        """Main + supporting characters with sub (Japanese) and dub (English) voice actors."""
        data = self._query(CHARACTERS_QUERY, {"idMal": mal_id, "n": limit}) or {}
        return normalize_characters(data.get("Media"))

    def airing_schedule(self, mal_ids: list[int]) -> list[dict]:
        """Upcoming episodes for many anime at once (for the airing calendar).

        ONE request for the whole batch: AniList's `idMal_in` filter takes a list of ids.
        We cut the list to AIRING_BATCH_MAX so a huge library can never build a giant query.
        Returns [{"mal_id", "episode", "airing_at"}] (airing_at = unix seconds, UTC).
        """
        ids = []
        for mal_id in mal_ids:
            if isinstance(mal_id, int) and mal_id > 0 and mal_id not in ids:
                ids.append(mal_id)
        ids = ids[:AIRING_BATCH_MAX]
        if not ids:
            return []  # nothing to ask, so don't spend a request
        data = self._query(AIRING_QUERY, {"ids": ids, "n": AIRING_BATCH_MAX}) or {}
        return parse_airing_schedule(data)

    # ------------------------------------------------------------ manga (AniShelf 1.15, see manga.py)
    # These return raw AniList data; anishelf/manga.py turns it into our own shapes.
    def manga_search(self, query: str, limit: int = 20) -> list[dict]:
        """One request: up to `limit` (max 50) non-adult manga matching the text."""
        q = (f"query ($q: String, $n: Int) {{ Page(perPage: $n) {{ media(search: $q, type: MANGA, isAdult: false, "
             f"sort: SEARCH_MATCH) {{ {MANGA_SEARCH_FIELDS} }} }} }}")
        data = self._query(q, {"q": query, "n": max(1, min(limit, 50))}) or {}
        return ((data.get("Page") or {}).get("media")) or []

    def manga(self, anilist_id: int) -> dict:
        """Full info for one manga by its AniList id. Raises NotFoundError if AniList doesn't know it."""
        q = f"query ($id: Int) {{ Media(id: $id, type: MANGA) {{ {MANGA_FIELDS} }} }}"
        media = (self._query(q, {"id": anilist_id}) or {}).get("Media")
        if not media:
            raise NotFoundError("Manga not found")
        return media

    def anime_source(self, mal_id: int) -> dict | None:
        """An anime's relations (to find the manga it adapts). None if AniList doesn't know it."""
        q = ("query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { relations { edges { relationType(version: 2) "
             f"node {{ {MANGA_SEARCH_FIELDS} type }} }} }} }} }}")
        return (self._query(q, {"idMal": mal_id}) or {}).get("Media")


# ------------------------------------------------------------------ manga fields
MANGA_SEARCH_FIELDS = """
  id idMal isAdult format status chapters volumes
  title { romaji english native }
  coverImage { extraLarge large color }
  startDate { year }
  genres averageScore siteUrl
"""

MANGA_FIELDS = MANGA_SEARCH_FIELDS + """
  bannerImage
  description(asHtml: false)
  staff(perPage: 12, sort: [RELEVANCE, ID]) { edges { role node { id name { full } } } }
  externalLinks { site url type }
  relations { edges { relationType(version: 2) node {
    id idMal type format isAdult title { romaji english } coverImage { large extraLarge } startDate { year }
  } } }
"""


# ------------------------------------------------------------------ airing calendar
AIRING_BATCH_MAX = 50  # hard cap on ids per request (AniList pages hold at most 50 items)

# notYetAired: true -> only future episodes. perPage: 8 -> about two weeks for a weekly show.
AIRING_QUERY = """
query ($ids: [Int], $n: Int) {
  Page(perPage: $n) {
    media(idMal_in: $ids, type: ANIME) {
      idMal
      airingSchedule(notYetAired: true, perPage: 8) { nodes { episode airingAt } }
    }
  }
}
"""


def parse_airing_schedule(data: dict | None) -> list[dict]:
    """AniList's Page.media[].airingSchedule -> a flat list sorted by time.

    Anything malformed (missing ids, non-numbers) is skipped instead of crashing the page.
    """
    media_list = ((data or {}).get("Page") or {}).get("media") or []
    out = []
    seen = set()  # (mal_id, episode) pairs, so a duplicate node can't show twice
    for media in media_list:
        mal_id = media.get("idMal")
        if not isinstance(mal_id, int) or mal_id < 1:
            continue
        nodes = ((media.get("airingSchedule") or {}).get("nodes")) or []
        for node in nodes:
            episode = node.get("episode")
            airing_at = node.get("airingAt")
            if not isinstance(episode, int) or not isinstance(airing_at, int):
                continue
            if (mal_id, episode) in seen:
                continue
            seen.add((mal_id, episode))
            out.append({"mal_id": mal_id, "episode": episode, "airing_at": airing_at})
    out.sort(key=lambda item: (item["airing_at"], item["mal_id"]))
    return out


# ------------------------------------------------------------------ cast
CHARACTERS_QUERY = """
query ($idMal: Int, $n: Int) {
  Media(idMal: $idMal, type: ANIME) {
    characters(perPage: $n, sort: [ROLE, RELEVANCE, ID]) {
      edges {
        role
        node { id name { full } image { large } }
        voiceActors { id name { full } image { large } languageV2 }
      }
    }
  }
}
"""

ROLE_ORDER = {"MAIN": 0, "SUPPORTING": 1, "BACKGROUND": 2}


def normalize_characters(media: dict | None) -> list[dict]:
    """Characters with their Japanese (sub) and English (dub) voice actors."""
    edges = (((media or {}).get("characters") or {}).get("edges")) or []
    out = []
    for edge in edges:
        node = edge.get("node") or {}
        if not isinstance(node.get("id"), int):
            continue
        sub, dub = [], []
        for va in edge.get("voiceActors") or []:
            if not isinstance(va.get("id"), int):
                continue
            person = {
                "id": va["id"],
                "name": (va.get("name") or {}).get("full") or "Unknown",
                "image": (va.get("image") or {}).get("large"),
                "language": va.get("languageV2"),
            }
            if va.get("languageV2") == "Japanese":
                sub.append(person)
            elif va.get("languageV2") == "English":
                dub.append(person)
        out.append({
            "id": node["id"],
            "name": (node.get("name") or {}).get("full") or "Unknown",
            "image": (node.get("image") or {}).get("large"),
            "role": edge.get("role") or "BACKGROUND",
            "sub": sub,
            "dub": dub,
        })
    out.sort(key=lambda c: ROLE_ORDER.get(c["role"], 3))  # stable: keeps AniList's order within a role
    return out



# ------------------------------------------------------------------ episodes & avatars
EPISODE_TITLE = re.compile(r"^\s*Episode\s+(\d+)\s*(?:[-:–—]\s*(.*))?$", re.I)

AVATAR_FIELDS = "id name { full } image { large } media(perPage: 1, sort: POPULARITY_DESC) { nodes { title { romaji english } } }"


def parse_streaming_episodes(items) -> list[dict]:
    """"Episode 3 - Killing Magic" -> {"number": 3, "title": "Killing Magic", ...}. Unnumbered ones are skipped."""
    by_number: dict[int, dict] = {}
    for item in items or []:
        match = EPISODE_TITLE.match(item.get("title") or "")
        if not match:
            continue
        number = int(match.group(1))
        if number < 1 or number in by_number:  # first one wins (some shows list several sites)
            continue
        by_number[number] = {
            "number": number,
            "title": (match.group(2) or "").strip() or None,
            "filler": False,
            "recap": False,
            "aired": None,
            "thumbnail": item.get("thumbnail") or None,
            "watch_url": https(item.get("url")),
            "watch_site": item.get("site") or None,
        }
    return [by_number[n] for n in sorted(by_number)]


def _avatars(characters) -> list[dict]:
    out = []
    for c in characters or []:
        image = (c.get("image") or {}).get("large")
        if not isinstance(c.get("id"), int) or not image or "default.jpg" in image:
            continue  # skip characters without a real picture
        nodes = ((c.get("media") or {}).get("nodes")) or []
        title = (nodes[0].get("title") or {}) if nodes else {}
        out.append({
            "id": c["id"],
            "name": (c.get("name") or {}).get("full") or "Unknown",
            "image": image,
            "anime": title.get("english") or title.get("romaji"),
        })
    return out


# AniList's fixed genre list (used by the "Surprise me" filter); Ecchi/Hentai left out on purpose
DISCOVER_GENRES = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha",
                   "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports",
                   "Supernatural", "Thriller"]
