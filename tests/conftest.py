import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from anishelf.clients import ApiError, NotFoundError  # noqa: E402
from anishelf.db import Database  # noqa: E402
from anishelf.images import ImageCache  # noqa: E402
from anishelf.server import create_app  # noqa: E402
from anishelf.service import AniShelf  # noqa: E402


def make_meta(mal_id, title="Show", episodes=12, airing=False, genres=("Action",), duration=24):
    return {
        "mal_id": mal_id, "title": f"{title} {mal_id}", "title_english": None, "title_japanese": None,
        "image": f"https://cdn.myanimelist.net/images/anime/{mal_id}.jpg", "type": "TV",
        "episodes": episodes, "duration_min": duration,
        "airing_status": "Currently Airing" if airing else "Finished Airing", "airing": airing,
        "year": 2024, "season": "fall", "genres": list(genres), "studios": ["Studio X"],
        "synopsis": "A story.", "mal_score": 8.0, "rank": 10, "popularity": 5, "rating": "PG-13",
        "url": "https://myanimelist.net/anime/1", "trailer_youtube_id": None, "anilist": None,
    }


class FakeJikan:
    def __init__(self):
        self.calls = 0
        self.fail = False
        self.catalog = {
            1: make_meta(1, episodes=12, genres=("Action", "Fantasy")),
            2: make_meta(2, episodes=24, genres=("Comedy",)),
            3: make_meta(3, episodes=None, airing=True),
            4: make_meta(4, episodes=1, genres=("Drama",), duration=110),
        }

    def _tick(self):
        self.calls += 1
        if self.fail:
            raise ApiError("Jikan is down")

    def search(self, q):
        self._tick()
        return [m for m in self.catalog.values()]

    def season_now(self):
        self._tick()
        return [self.catalog[1], self.catalog[3]]

    def top_airing(self):
        self._tick()
        return [self.catalog[3]]

    def anime(self, mal_id):
        self._tick()
        if mal_id not in self.catalog:
            raise NotFoundError("Anime not found")
        return dict(self.catalog[mal_id])

    def episodes(self, mal_id):
        self._tick()
        return [{"number": 1, "title": "Ep 1", "filler": False, "recap": False, "aired": None}], False

    def recommendations(self, mal_id):
        self._tick()
        return [{"mal_id": 2, "title": "Show 2", "image": None, "votes": 3}]


class FakeAniList:
    """Also acts as the fallback provider when FakeJikan.fail is True."""

    def __init__(self):
        self.fail = False
        self.calls = 0

    def _fallback(self):
        self.calls += 1
        if self.fail:
            raise ApiError("AniList is down")

    def search(self, q):
        self._fallback()
        meta = make_meta(10, title="Fallback")
        meta["anilist"] = {"banner": None, "color": "#00aa00", "cover_xl": None, "next_airing": None}
        return [meta]

    def season_now(self):
        self._fallback()
        return []

    def top_airing(self):
        self._fallback()
        return []

    def anime(self, mal_id):
        self._fallback()
        meta = make_meta(mal_id, title="Fallback")
        meta["anilist"] = {"banner": "https://s4.anilist.co/fb.jpg", "color": "#00aa00", "cover_xl": None, "next_airing": None}
        return meta

    def recommendations(self, mal_id):
        self._fallback()
        return []

    def episodes(self, mal_id):
        self._fallback()
        if mal_id == 404:
            return [], False
        return [{"number": 1, "title": "From AniList", "filler": False, "recap": False, "aired": None,
                 "thumbnail": "https://img1.ak.crunchyroll.com/t.jpg"}], False

    def popular(self, page, genre=None):
        self._fallback()
        return [make_meta(1, episodes=12), make_meta(2, episodes=24), make_meta(4, episodes=1)]

    # a 3-entry franchise 1 -> 2 -> 4(movie), plus 3 standing alone
    RELATIONS = {
        1: {"format": "TV", "start": "2013-04-07", "neighbours": [2], "title_english": "Show One"},
        2: {"format": "TV", "start": "2017-04-01", "neighbours": [1, 4], "title_english": None},
        4: {"format": "MOVIE", "start": "2019-01-01", "neighbours": [2], "title_english": None},
    }

    def relations_node(self, mal_id):
        self._fallback()
        info = self.RELATIONS.get(mal_id)
        if not info:
            return None
        return {"mal_id": mal_id, "title": f"Show {mal_id}", "title_english": info["title_english"],
                "format": info["format"], "episodes": 12, "status": "FINISHED", "year": int(info["start"][:4]),
                "start": info["start"], "image": None, "neighbours": info["neighbours"]}

    def popular_characters(self, page):
        self._fallback()
        return [{"id": page, "name": f"Popular {page}", "image": "https://s4.anilist.co/p.png", "anime": "Show"}]

    def search_characters(self, q):
        self._fallback()
        return [{"id": 99, "name": q.title(), "image": "https://s4.anilist.co/s.png", "anime": None}]

    def characters(self, mal_id):
        self._fallback()
        return [{"id": 1, "name": "Hero", "image": "https://s4.anilist.co/h.png", "role": "MAIN",
                 "sub": [{"id": 5, "name": "JP Actor", "image": None, "language": "Japanese"}], "dub": []}]

    # upcoming episodes for the airing calendar; tests may replace this dict
    AIRING = {}

    def airing_schedule(self, mal_ids):
        self._fallback()
        self.airing_calls = getattr(self, "airing_calls", 0) + 1
        out = []
        for mal_id in mal_ids:
            for episode, airing_at in self.AIRING.get(mal_id, []):
                out.append({"mal_id": mal_id, "episode": episode, "airing_at": airing_at})
        return sorted(out, key=lambda item: item["airing_at"])

    # ---------------------------------------------------------------- manga (raw AniList shapes)
    # 100: a finished manga with 10 chapters and an anime adaptation (MAL id 1)
    # 200: a publishing manga (no chapter total), no MAL id
    # 300: an adult manga that must be filtered out
    @staticmethod
    def raw_manga(anilist_id, status="FINISHED", chapters=10, volumes=2, is_adult=False, id_mal=None):
        return {
            "id": anilist_id, "idMal": id_mal, "isAdult": is_adult, "type": "MANGA", "format": "MANGA",
            "status": status, "chapters": chapters, "volumes": volumes,
            "title": {"romaji": f"Manga {anilist_id}", "english": f"Manga {anilist_id} EN", "native": None},
            "coverImage": {"extraLarge": f"https://s4.anilist.co/m{anilist_id}.jpg", "large": None, "color": "#e4a15d"},
            "startDate": {"year": 2020}, "genres": ["Fantasy"], "averageScore": 87,
            "siteUrl": f"https://anilist.co/manga/{anilist_id}",
            "bannerImage": "https://s4.anilist.co/banner.jpg",
            "description": "A <i>manga</i> story.<br>Line two.",
            "staff": {"edges": [
                {"role": "Story & Art", "node": {"id": 7, "name": {"full": "Mangaka One"}}},
                {"role": "Translator", "node": {"id": 8, "name": {"full": "Some Translator"}}},
            ]},
            "externalLinks": [
                {"site": "MANGA Plus", "url": "https://mangaplus.shueisha.co.jp/titles/1", "type": "STREAMING"},
                {"site": "Viz", "url": "http://www.viz.com/manga-books/x", "type": "INFO"},
                {"site": "Twitter", "url": "https://twitter.com/x", "type": "SOCIAL"},
                {"site": "MANGA Plus", "url": "https://fake-mangaplus.example/titles/1", "type": "STREAMING"},
            ],
            "relations": {"edges": [
                {"relationType": "ADAPTATION", "node": {"id": 5001, "idMal": 1, "type": "ANIME", "format": "TV",
                                                         "isAdult": False, "title": {"romaji": "Show 1", "english": None},
                                                         "coverImage": {"large": None, "extraLarge": None},
                                                         "startDate": {"year": 2022}}},
                {"relationType": "SEQUEL", "node": {"id": 5002, "idMal": 2, "type": "ANIME", "format": "TV", "isAdult": False,
                                                     "title": {"romaji": "Sequel"}, "coverImage": {}, "startDate": {}}},
                {"relationType": "ALTERNATIVE", "node": {"id": 5003, "idMal": None, "type": "ANIME", "format": "TV",
                                                         "isAdult": False, "title": {"romaji": "No MAL"}, "coverImage": {},
                                                         "startDate": {}}},
            ]},
        }

    def manga_search(self, q, limit=20):
        self._fallback()
        self.manga_calls = getattr(self, "manga_calls", 0) + 1
        return [self.raw_manga(100, id_mal=55), self.raw_manga(200, status="RELEASING", chapters=None, volumes=None),
                self.raw_manga(300, is_adult=True)]

    def manga(self, anilist_id):
        self._fallback()
        self.manga_calls = getattr(self, "manga_calls", 0) + 1
        if anilist_id == 100:
            return self.raw_manga(100, id_mal=55)
        if anilist_id == 200:
            return self.raw_manga(200, status="RELEASING", chapters=120, volumes=None)
        raise NotFoundError("Manga not found")

    def anime_source(self, mal_id):
        self._fallback()
        if mal_id != 1:
            return None
        return {"relations": {"edges": [
            {"relationType": "SEQUEL", "node": {"id": 5002, "type": "ANIME"}},
            {"relationType": "SOURCE", "node": {**self.raw_manga(100, id_mal=55), "type": "MANGA"}},
        ]}}

    def extras(self, mal_id):
        if self.fail:
            raise ApiError("AniList is down")
        if mal_id == 3:
            return {"banner": "https://s4.anilist.co/b.jpg", "color": "#ff8800", "cover_xl": None,
                    "next_airing": {"episode": 6, "airing_at": 1999999999}}
        return {"banner": None, "color": "#3366ff", "cover_xl": None, "next_airing": None}


class FakeMangaDex:
    """Stands in for MangaDexClient (no network). `answers` maps AniList id -> volume_ends() answer."""

    def __init__(self):
        self.calls = 0
        self.fail = False
        # manga 100 (finished, 10 chapters, 2 volumes): MangaDex says volume 1 ends at chapter 4
        self.answers = {100: {"found": True, "mangadex_id": "md-100", "volumes": [{"volume": 1, "last_chapter": 4}]}}

    def volume_ends(self, anilist_id, id_mal, titles):
        self.calls += 1
        if self.fail:
            raise ApiError("MangaDex is down")
        return self.answers.get(anilist_id, {"found": False})


@pytest.fixture
def mangadex():
    return FakeMangaDex()


@pytest.fixture
def jikan():
    return FakeJikan()


@pytest.fixture
def anilist():
    return FakeAniList()


@pytest.fixture
def shelf(tmp_path, jikan, anilist, mangadex):
    return AniShelf(Database(tmp_path / "test.db"), jikan, anilist, rng=random.Random(7), mangadex=mangadex)


@pytest.fixture
def client(shelf, tmp_path):
    app = create_app(shelf, ImageCache(tmp_path / "images"))
    app.config["TESTING"] = True
    return app.test_client()
