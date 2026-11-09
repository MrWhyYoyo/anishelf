"""Manga tracking (AniShelf 1.15): search, a manga shelf, chapter progress and anime links.

Why a separate file: the anime side is keyed by the MyAnimeList id, but many manga have no
MAL id. So manga use the AniList media id as their key and live in their own tables
(`manga` and `manga_log`). Everything here is free: AniList's GraphQL API needs no key.

The parts:
  * parse_* / normalize_* functions turn raw AniList data into our own small dicts
    (pure functions, easy to test with fake data)
  * MangaShelf is the "service" for manga: it combines the database, the cache and AniList
  * export_data / parse_backup / write_backup plug manga into the backup file
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

from .anilist import clean_description, https
from .clients import DAY, HOUR, ApiError, NotFoundError
from .logic import ValidationError

log = logging.getLogger(__name__)

# ---------------------------------------------------------------- rules
STATUSES = ("reading", "completed", "plan_to_read", "on_hold", "dropped")
MAX_CHAPTER = 10000      # sanity cap so a typo can't store chapter 99999999
MAX_VOLUME = 1000
MAX_NOTES = 20000
BULK_LOG_LIMIT = 25      # a bigger jump is "catching up records", not today's reading (same as anime)
SEARCH_LIMIT = 20        # results per search (one AniList request)
MAX_ADAPTATIONS = 12     # anime links shown on a manga page
MAX_AUTHORS = 6

SCHEMA = """
CREATE TABLE IF NOT EXISTS manga (
    anilist_id    INTEGER PRIMARY KEY,
    id_mal        INTEGER,
    meta          TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    chapters_read INTEGER NOT NULL DEFAULT 0,
    volumes_read  INTEGER NOT NULL DEFAULT 0,
    score         INTEGER,
    notes         TEXT    NOT NULL DEFAULT '',
    started_on    TEXT,
    finished_on   TEXT,
    added_at      TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS manga_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    anilist_id INTEGER NOT NULL,
    chapter    INTEGER NOT NULL,
    read_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manga_log_time ON manga_log (read_at);
CREATE INDEX IF NOT EXISTS idx_manga_log_manga ON manga_log (anilist_id, chapter);
"""


def upgrade_schema(conn) -> None:
    """Create the manga tables if they don't exist yet. Safe to run on every start."""
    conn.executescript(SCHEMA)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ================================================================ AniList -> our shapes
FORMATS = {"MANGA": "Manga", "ONE_SHOT": "One-shot", "NOVEL": "Light novel"}
PUBLISHING = {"FINISHED": "Finished", "RELEASING": "Publishing", "NOT_YET_RELEASED": "Not yet published",
              "CANCELLED": "Cancelled", "HIATUS": "On hiatus"}

# Official places to read. We match the link's web address (host), not just the site name,
# so an unofficial site can never sneak in by calling itself "MANGA Plus".
OFFICIAL_READERS = {
    "mangaplus.shueisha.co.jp": "MANGA Plus",
    "viz.com": "VIZ",
    "kmanga.kodansha.com": "K MANGA",
    "kodansha.us": "Kodansha",
    "azuki.co": "Azuki",
    "comikey.com": "Comikey",
    "webtoons.com": "WEBTOON",
    "bookwalker.jp": "BookWalker",
    "inkr.com": "INKR",
    "manga-up.com": "Manga UP!",
    "mangamo.com": "Mangamo",
    "tapas.io": "Tapas",
    "tappytoon.com": "Tappytoon",
    "pocketcomics.com": "Pocket Comics",
    "lezhin.com": "Lezhin",
    "piccoma.com": "Piccoma",
    "comic-walker.com": "ComicWalker",
    "j-novel.club": "J-Novel Club",
    "yenpress.com": "Yen Press",
}


def _positive_int(value) -> int | None:
    """Keep a value only if it is a whole number above 0 (True/False don't count)."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    return value


def _title_parts(media: dict) -> dict:
    title = media.get("title") or {}
    return {
        "title": title.get("romaji") or title.get("english") or "Untitled",
        "title_english": title.get("english"),
        "title_japanese": title.get("native"),
    }


def _cover(media: dict) -> str | None:
    cover = media.get("coverImage") or {}
    return cover.get("extraLarge") or cover.get("large")


def reader_name(url: str) -> str | None:
    """The official reader a link goes to, or None if it isn't one we know."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    for domain, name in OFFICIAL_READERS.items():
        # "www.viz.com" and "viz.com" both count, "fakeviz.com" does not
        if host == domain or host.endswith("." + domain):
            return name
    return None


def reading_links(links) -> list[dict]:
    """"Where to read": INFO/STREAMING links that go to an official reader. Links only."""
    out = []
    seen = set()
    for link in links or []:
        if not isinstance(link, dict) or link.get("type") not in ("INFO", "STREAMING"):
            continue
        url = https(link.get("url"))
        if not url or not url.startswith("https://"):
            continue
        name = reader_name(url)
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"site": link.get("site") or name, "url": url})
    return out


def parse_authors(staff) -> list[dict]:
    """Staff with Story/Art roles -> [{"id", "name", "role"}]. One person can have both roles."""
    out = []
    by_id = {}
    for edge in ((staff or {}).get("edges")) or []:
        role = str(edge.get("role") or "")
        node = edge.get("node") or {}
        person_id = node.get("id")
        if not isinstance(person_id, int):
            continue
        lowered = role.lower()
        if "story" not in lowered and "art" not in lowered:
            continue  # translators, letterers, editors ... aren't the authors
        if person_id in by_id:
            if role not in by_id[person_id]["role"]:
                by_id[person_id]["role"] += f", {role}"
            continue
        person = {"id": person_id, "name": (node.get("name") or {}).get("full") or "Unknown", "role": role}
        by_id[person_id] = person
        out.append(person)
    return out[:MAX_AUTHORS]


def parse_adaptations(relations) -> list[dict]:
    """Anime made from this manga (relation ADAPTATION or ALTERNATIVE, type ANIME, with a MAL id)."""
    out = []
    seen = set()
    for edge in ((relations or {}).get("edges")) or []:
        if edge.get("relationType") not in ("ADAPTATION", "ALTERNATIVE"):
            continue
        node = edge.get("node") or {}
        mal_id = _positive_int(node.get("idMal"))
        # the anime side of the app is keyed by MAL id, so an anime without one can't be linked
        if node.get("type") != "ANIME" or node.get("isAdult") or not mal_id or mal_id in seen:
            continue
        seen.add(mal_id)
        out.append({
            "mal_id": mal_id,
            "anilist_id": node.get("id"),
            **{k: v for k, v in _title_parts(node).items() if k != "title_japanese"},
            "image": _cover(node),
            "format": node.get("format"),
            "year": (node.get("startDate") or {}).get("year"),
            "relation": edge.get("relationType"),
        })
    return out[:MAX_ADAPTATIONS]


def normalize_manga(media: dict | None, full: bool = True) -> dict | None:
    """AniList Media (type MANGA) -> our manga Meta. None for adult or broken entries.

    full=False is the lighter version used in search results (no synopsis, links or relations).
    """
    if not isinstance(media, dict) or media.get("isAdult"):
        return None
    anilist_id = _positive_int(media.get("id"))
    if not anilist_id:
        return None
    status = media.get("status")
    finished = status == "FINISHED"
    cover = media.get("coverImage") or {}
    score = media.get("averageScore")
    meta = {
        "anilist_id": anilist_id,
        "id_mal": _positive_int(media.get("idMal")),
        **_title_parts(media),
        "image": _cover(media),
        "color": cover.get("color"),
        "format": FORMATS.get(media.get("format"), "Manga"),
        "publishing_status": PUBLISHING.get(status),
        "finished": finished,
        # The spec: chapter/volume totals are only real once the manga has finished.
        # While it is still publishing, AniList's number (if any) is just "so far".
        "chapters": _positive_int(media.get("chapters")) if finished else None,
        "volumes": _positive_int(media.get("volumes")) if finished else None,
        "year": (media.get("startDate") or {}).get("year"),
        "genres": list(media.get("genres") or []),
        "anilist_score": round(score / 10, 1) if isinstance(score, (int, float)) and not isinstance(score, bool) else None,
        "url": media.get("siteUrl") or f"https://anilist.co/manga/{anilist_id}",
    }
    if full:
        meta.update({
            "banner": media.get("bannerImage"),
            "synopsis": clean_description(media.get("description")),
            "authors": parse_authors(media.get("staff")),
            "reading": reading_links(media.get("externalLinks")),
            "adaptations": parse_adaptations(media.get("relations")),
        })
    return meta


def parse_source(media: dict | None) -> dict | None:
    """An ANIME's relations -> the manga it is based on (relation SOURCE, type MANGA), or None."""
    for edge in (((media or {}).get("relations") or {}).get("edges")) or []:
        node = edge.get("node") or {}
        if edge.get("relationType") != "SOURCE" or node.get("type") != "MANGA":
            continue
        meta = normalize_manga(node, full=False)
        if meta:
            return meta
    return None


# ================================================================ pure progress rules
def auto_status(current: str, chapters_read: int, total: int | None) -> str:
    """The status that makes sense after the chapter count changes (same idea as the anime side).

    - read the last chapter of a finished manga -> completed
    - started a planned / paused manga          -> reading
    - dropped stays dropped: that was a deliberate choice
    """
    if total and chapters_read >= total and current != "completed":
        return "completed"
    if chapters_read > 0 and current in ("plan_to_read", "on_hold"):
        return "reading"
    return current


def chapter_for_volume(volume: int, ends: dict[int, int], meta: dict) -> tuple[int | None, str | None]:
    """Which chapter "I've read `volume` volumes" means -> (chapter, source).

    source is "mangadex" (a real volume -> chapter map), "estimate" (an average),
    "anilist" (the last volume of a finished manga ends at AniList's final chapter) or None (unknown).
    """
    if volume <= 0:
        return 0, None
    total_chapters = meta.get("chapters")
    total_volumes = meta.get("volumes")
    chapter, source = None, None
    if total_chapters and total_volumes and volume >= total_volumes:
        # the last volume ends at the final chapter, whatever MangaDex says (it may lack chapters)
        return min(total_chapters, MAX_CHAPTER), "anilist"
    if volume in ends:
        chapter, source = ends[volume], "mangadex"
    elif total_chapters and total_volumes:
        # Finished manga with known totals: assume volumes are about the same size.
        # e.g. 120 chapters in 12 volumes, read 5 -> round(5 * 120 / 12) = chapter 50
        chapter, source = round(volume * total_chapters / total_volumes), "estimate"
    if chapter is None:
        return None, None
    if total_chapters:
        chapter = min(chapter, total_chapters)
    return min(chapter, MAX_CHAPTER), source


def volumes_passed(chapters_read: int, ends: dict[int, int]) -> int:
    """The highest volume whose last chapter you have read (0 if none)."""
    passed = [volume for volume, last in ends.items() if last <= chapters_read]
    return max(passed, default=0)


def dates_for_status(row: dict, status: str, today: str) -> dict:
    """Fill started_on / finished_on when they are missing (never overwrite a date you typed)."""
    extra = {}
    if status in ("reading", "completed") and not row.get("started_on"):
        extra["started_on"] = today
    if status == "completed" and not row.get("finished_on"):
        extra["finished_on"] = today
    return extra


def _iso_date_or_none(value, field: str):
    if value is None or value == "":
        return None
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise ValidationError(f"{field} must be a date like 2026-11-07") from None


def _whole_number(value, low: int, high: int, message: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValidationError(message)
    return value


def validate_patch(patch) -> dict:
    """Check a PATCH body. Unknown fields are an error (a typo shouldn't silently do nothing)."""
    if not isinstance(patch, dict):
        raise ValidationError("Expected a JSON object")
    clean = {}
    for key, value in patch.items():
        if key == "status":
            if value not in STATUSES:
                raise ValidationError("Unknown manga status")
            clean[key] = value
        elif key == "score":
            clean[key] = None if value is None else _whole_number(value, 1, 10, "Score must be a whole number from 1 to 10")
        elif key == "notes":
            if not isinstance(value, str):
                raise ValidationError("Notes must be text")
            if len(value) > MAX_NOTES:
                raise ValidationError("Notes are too long")
            clean[key] = value
        elif key in ("started_on", "finished_on"):
            label = "Started" if key == "started_on" else "Finished"
            clean[key] = _iso_date_or_none(value, label)
        elif key == "volumes_read":
            clean[key] = _whole_number(value, 0, MAX_VOLUME, f"Volumes must be a whole number from 0 to {MAX_VOLUME}")
        else:
            raise ValidationError(f"Unknown field: {key}")
    return clean


# ================================================================ the manga service
class MangaShelf:
    """Manga features. Uses the main AniShelf object for its database, cache and AniList client."""

    def __init__(self, shelf):
        self.shelf = shelf

    # The tests swap the AniList client on the shelf, so always read it from there.
    @property
    def db(self):
        return self.shelf.db

    @property
    def anilist(self):
        return self.shelf.anilist

    @property
    def mangadex(self):
        return self.shelf.mangadex

    # ------------------------------------------------------------ browsing
    def search(self, query: str) -> list[dict]:
        query = (query or "").strip()
        if len(query) < 2:
            raise ValidationError("Type at least 2 characters to search")
        if len(query) > 100:
            raise ValidationError("Search text is too long")

        def fetch():
            results = []
            for media in self.anilist.manga_search(query, SEARCH_LIMIT)[:SEARCH_LIMIT]:
                meta = normalize_manga(media, full=False)
                if meta:
                    results.append(meta)
            return results

        found = self.shelf._cached(f"manga:search:{query.lower()}", DAY, fetch)
        statuses = self.statuses()
        return [{**meta, "library_status": statuses.get(meta["anilist_id"])} for meta in found]

    def meta(self, anilist_id: int, force: bool = False) -> dict:
        """Full manga info, cached. Publishing manga are re-checked more often (new chapters)."""
        key = f"manga:{anilist_id}"
        previous = self.db.cache_get(key, None)
        publishing = bool(previous and previous[0] and not previous[0].get("finished"))
        ttl = 12 * HOUR if publishing else 3 * DAY

        def fetch():
            meta = normalize_manga(self.anilist.manga(anilist_id))
            if not meta:
                raise NotFoundError("Manga not found")
            return meta

        return self.shelf._cached(key, ttl, fetch, force)

    def page(self, anilist_id: int) -> dict:
        """Everything the manga page needs: info, my entry (or None) and the anime adaptations."""
        meta = self.meta(anilist_id)
        row = self.get(anilist_id)
        if row:
            self._save_meta(anilist_id, meta)  # keep the library snapshot current
            row["meta"] = meta
        anime_statuses = self.db.statuses()
        adaptations = [{**a, "library_status": anime_statuses.get(a["mal_id"])} for a in meta.get("adaptations") or []]
        return {"meta": meta, "entry": build_entry(row) if row else None, "adaptations": adaptations}

    def anime_source(self, mal_id: int) -> dict:
        """The manga an anime is based on (for a "Read the manga" link). Cached for a week."""
        def fetch():
            return parse_source(self.anilist.anime_source(mal_id))

        source = self.shelf._cached(f"anime_source:{mal_id}", 7 * DAY, fetch)
        if not source:
            return {"source": None}
        return {"source": {**source, "library_status": self.statuses().get(source["anilist_id"])}}

    # ------------------------------------------------------------ database helpers
    def get(self, anilist_id: int) -> dict | None:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM manga WHERE anilist_id = ?", (anilist_id,)).fetchone()
        return _row_to_dict(row) if row else None

    def _row(self, anilist_id: int) -> dict:
        row = self.get(anilist_id)
        if row is None:
            raise MangaNotInLibrary(anilist_id)
        return row

    def statuses(self) -> dict[int, str]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT anilist_id, status FROM manga").fetchall()
        return {r["anilist_id"]: r["status"] for r in rows}

    def _save_meta(self, anilist_id: int, meta: dict) -> None:
        with self.db._write_lock, self.db.connect() as conn:
            conn.execute("UPDATE manga SET meta = ?, id_mal = ? WHERE anilist_id = ?",
                         (json.dumps(meta), meta.get("id_mal"), anilist_id))

    def _update_fields(self, anilist_id: int, fields: dict) -> dict:
        """Write the given columns (already validated) and bump updated_at."""
        allowed = ("status", "score", "notes", "started_on", "finished_on", "volumes_read", "chapters_read")
        fields = {k: v for k, v in fields.items() if k in allowed}
        assignments = "".join(f"{k} = ?, " for k in fields)
        with self.db._write_lock, self.db.connect() as conn:
            conn.execute(f"UPDATE manga SET {assignments}updated_at = ? WHERE anilist_id = ?",
                         [*fields.values(), utc_now(), anilist_id])
        return self._row(anilist_id)

    # ------------------------------------------------------------ library
    def library(self, status: str | None = None) -> list[dict]:
        if status and status not in STATUSES:
            raise ValidationError("Unknown manga status")
        with self.db.connect() as conn:
            if status:
                rows = conn.execute("SELECT * FROM manga WHERE status = ? ORDER BY updated_at DESC, anilist_id",
                                    (status,)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM manga ORDER BY updated_at DESC, anilist_id").fetchall()
        return [build_entry(_row_to_dict(r)) for r in rows]

    def add(self, anilist_id, status="plan_to_read") -> dict:
        if isinstance(anilist_id, bool) or not isinstance(anilist_id, int) or anilist_id < 1:
            raise ValidationError("anilist_id must be a positive whole number")
        if status not in STATUSES:
            raise ValidationError("Unknown manga status")
        meta = self.meta(anilist_id)
        now = utc_now()
        with self.db._write_lock, self.db.connect() as conn:
            existing = conn.execute("SELECT anilist_id FROM manga WHERE anilist_id = ?", (anilist_id,)).fetchone()
            if existing:  # adding again just changes the status
                conn.execute("UPDATE manga SET status = ?, meta = ?, id_mal = ?, updated_at = ? WHERE anilist_id = ?",
                             (status, json.dumps(meta), meta.get("id_mal"), now, anilist_id))
            else:
                conn.execute("INSERT INTO manga (anilist_id, id_mal, meta, status, added_at, updated_at) "
                             "VALUES (?, ?, ?, ?, ?, ?)",
                             (anilist_id, meta.get("id_mal"), json.dumps(meta), status, now, now))
        row = self._row(anilist_id)
        extra = dates_for_status(row, status, date.today().isoformat())
        if extra:
            row = self._update_fields(anilist_id, extra)
        return build_entry(row)

    def update(self, anilist_id: int, patch) -> dict:
        clean = validate_patch(patch)
        row = self._row(anilist_id)
        if "status" in clean:
            for key, value in dates_for_status(row, clean["status"], date.today().isoformat()).items():
                clean.setdefault(key, value)  # a date sent in the same patch wins
        total_volumes = row["meta"].get("volumes")
        if "volumes_read" in clean and total_volumes and clean["volumes_read"] > total_volumes:
            raise ValidationError(f"This manga has {total_volumes} volumes")
        return build_entry(self._update_fields(anilist_id, clean))

    def remove(self, anilist_id: int) -> None:
        with self.db._write_lock, self.db.connect() as conn:
            cur = conn.execute("DELETE FROM manga WHERE anilist_id = ?", (anilist_id,))
            conn.execute("DELETE FROM manga_log WHERE anilist_id = ?", (anilist_id,))
        if cur.rowcount == 0:
            raise MangaNotInLibrary(anilist_id)

    # ------------------------------------------------------------ volumes -> chapters (MangaDex)
    def _volume_ends(self, anilist_id: int, meta: dict, lookup: bool = True) -> dict[int, int]:
        """{volume: last chapter} from MangaDex, cached. lookup=False only reads the cache (no network)."""
        key = f"mangadex:volumes:{anilist_id}"
        previous = self.db.cache_get(key, None)
        if lookup:
            # "not found" is only remembered for 1 day (MangaDex may add it); a real map for 7 days
            not_found = bool(previous and not (previous[0] or {}).get("found"))
            ttl = DAY if not_found else 7 * DAY
            titles = list(dict.fromkeys(t for t in (meta.get("title"), meta.get("title_english")) if t))

            def fetch():
                return self.mangadex.volume_ends(anilist_id, meta.get("id_mal"), titles)

            try:
                found = self.shelf._cached(key, ttl, fetch)
            except ApiError as exc:  # MangaDex down and nothing cached: carry on without a map
                log.warning("MangaDex lookup for %s failed: %s", anilist_id, exc)
                found = {}
        else:
            found = previous[0] if previous else {}
        if not found or not found.get("found"):
            return {}
        # the cache holds a list of {"volume", "last_chapter"}; turn it back into a dict
        return {int(v["volume"]): int(v["last_chapter"]) for v in found.get("volumes") or []}

    def volume_info(self, anilist_id: int) -> dict:
        """GET /api/manga/<id>/volumes: where every volume we know of ends."""
        meta = self.meta(anilist_id)
        ends = self._volume_ends(anilist_id, meta)
        total_volumes = meta.get("volumes")
        if ends:
            numbers = sorted(ends)
            if total_volumes:  # the last volume always ends at the final chapter, even if MangaDex lacks it
                numbers = sorted(set(n for n in numbers if n <= total_volumes) | {total_volumes})
        elif meta.get("chapters") and total_volumes:
            numbers = list(range(1, total_volumes + 1))  # estimate every volume
        else:
            numbers = []
        volumes = []
        for number in numbers:
            chapter, source = chapter_for_volume(number, ends, meta)
            if chapter is not None:
                volumes.append({"volume": number, "last_chapter": chapter, "source": source})
        return {
            "anilist_id": anilist_id,
            "source": "mangadex" if ends else ("estimate" if volumes else None),
            "volumes": volumes,
            "total_volumes": total_volumes,
            "total_chapters": meta.get("chapters"),
        }

    # ------------------------------------------------------------ chapters
    def change_progress(self, anilist_id: int, body) -> dict:
        """{"action": "increment"} reads one more chapter; {"action": "set", "chapter": 45} jumps;
        {"action": "volumes", "volumes": 5} catches up by volume.

        Returns {"entry", "status_changed"} like the anime episode endpoint
        (+ "chapters_from_volumes" for the volumes action).
        """
        if not isinstance(body, dict):
            raise ValidationError("Expected a JSON object")
        if body.get("action") == "volumes":
            return self._progress_from_volumes(anilist_id, body)
        row = self._row(anilist_id)
        before = row["chapters_read"]
        total = row["meta"].get("chapters")
        action = body.get("action")
        if action == "increment":
            new = before + 1
        elif action == "set":
            new = _whole_number(body.get("chapter"), 0, MAX_CHAPTER, f"Chapter must be a whole number from 0 to {MAX_CHAPTER}")
        else:
            raise ValidationError("Unknown chapter action")
        if total and new > total:
            raise ValidationError(f"This manga has {total} chapters")
        if new > MAX_CHAPTER:
            raise ValidationError(f"Chapter must be at most {MAX_CHAPTER}")

        fields = {"chapters_read": new, "status": auto_status(row["status"], new, total)}
        # Passing the end of a volume counts that volume as read. Only the CACHED map is used
        # (no network on every +1 click), and volumes only go up here: undoing a chapter keeps them.
        passed = volumes_passed(new, self._volume_ends(anilist_id, row["meta"], lookup=False))
        if total and new >= total and row["meta"].get("volumes"):
            passed = row["meta"]["volumes"]  # the final chapter means every volume is read
        if passed > row["volumes_read"]:
            fields["volumes_read"] = passed
        status_changed = self._save_progress(row, fields)
        return {"entry": build_entry(self._row(anilist_id)), "status_changed": status_changed}

    def _progress_from_volumes(self, anilist_id: int, body: dict) -> dict:
        """"I've read N volumes": save N and move the chapter count to the end of volume N."""
        row = self._row(anilist_id)
        meta = row["meta"]
        total_volumes = meta.get("volumes")
        volumes = _whole_number(body.get("volumes"), 0, MAX_VOLUME, f"Volumes must be a whole number from 0 to {MAX_VOLUME}")
        if total_volumes and volumes > total_volumes:
            raise ValidationError(f"This manga has {total_volumes} volumes")

        # only ask MangaDex when there is a volume to look up (validation first, network second)
        ends = self._volume_ends(anilist_id, meta) if volumes > 0 else {}
        chapter, source = chapter_for_volume(volumes, ends, meta)

        before = row["chapters_read"]
        # The never-lower rule: volumes are a quick way to catch UP. If you've already read past
        # the end of volume N (say chapter 50, and volume 5 ends at 42), we keep your 50.
        new = before if chapter is None else max(before, chapter)

        status = auto_status(row["status"], new, meta.get("chapters"))
        if volumes > 0 and status in ("plan_to_read", "on_hold"):
            status = "reading"  # started reading, even if we couldn't work out the chapter
        if total_volumes and volumes == total_volumes and meta.get("finished"):
            status = "completed"  # read the last volume of a finished manga
        fields = {"chapters_read": new, "volumes_read": volumes, "status": status}
        status_changed = self._save_progress(row, fields)
        return {
            "entry": build_entry(self._row(anilist_id)),
            "status_changed": status_changed,
            "chapters_from_volumes": {
                "volume": volumes,
                "chapter": chapter,
                "source": source,
                "estimated": source == "estimate",
                "kept_higher": chapter is not None and before > chapter,  # you were already ahead
            },
        }

    def _save_progress(self, row: dict, fields: dict) -> str | None:
        """Write chapters_read (+ status / volumes_read), fill the dates and keep the reading log.
        Returns the new status if it changed, else None."""
        anilist_id = row["anilist_id"]
        before = row["chapters_read"]
        new = fields["chapters_read"]
        new_status = fields.get("status", row["status"])
        status_changed = None
        if new_status != row["status"]:
            status_changed = new_status
        else:
            fields.pop("status", None)
        today = date.today().isoformat()
        # dates follow the chapters even when the status was set by hand
        started = new > 0 or fields.get("volumes_read", 0) > 0
        if started and not row.get("started_on"):
            fields["started_on"] = today
        if new_status == "completed" and not row.get("finished_on"):
            fields["finished_on"] = today

        now = utc_now()
        with self.db._write_lock, self.db.connect() as conn:
            assignments = "".join(f"{k} = ?, " for k in fields)
            conn.execute(f"UPDATE manga SET {assignments}updated_at = ? WHERE anilist_id = ?",
                         [*fields.values(), now, anilist_id])
            added = new - before
            if 0 < added <= BULK_LOG_LIMIT:
                # one log row per chapter read, so stats can count chapters per day
                conn.executemany("INSERT INTO manga_log (anilist_id, chapter, read_at) VALUES (?, ?, ?)",
                                 [(anilist_id, ch, now) for ch in range(before + 1, new + 1)])
            elif added < 0:
                # going back un-reads chapters, so their log rows go too
                conn.execute("DELETE FROM manga_log WHERE anilist_id = ? AND chapter > ?", (anilist_id, new))
        return status_changed

    # ------------------------------------------------------------ stats + XP
    def stats(self, today: date | None = None) -> dict:
        """The `manga` key of GET /api/stats."""
        today = today or date.today()
        entries = self.library()
        since = (datetime.combine(today - timedelta(days=29), datetime.min.time()).astimezone()
                 .astimezone(timezone.utc).isoformat(timespec="seconds"))
        with self.db.connect() as conn:
            recent = conn.execute("SELECT COUNT(*) AS n FROM manga_log WHERE read_at >= ?", (since,)).fetchone()["n"]
        return {
            "chapters_read": sum(e["chapters_read"] for e in entries),
            "volumes_read": sum(e["volumes_read"] for e in entries),
            "completed": sum(1 for e in entries if e["status"] == "completed"),
            "reading": sum(1 for e in entries if e["status"] == "reading"),
            "total_entries": len(entries),
            "chapters_last_30_days": recent,
        }

    def xp_metrics(self) -> dict:
        """Numbers progression.profile turns into the "Manga" XP line."""
        entries = self.library()
        return {
            "manga_chapters": sum(e["chapters_read"] for e in entries),
            "manga_completed": sum(1 for e in entries if e["status"] == "completed"),
        }


class MangaNotInLibrary(KeyError):
    pass


def _row_to_dict(row) -> dict:
    data = dict(row)
    data["meta"] = json.loads(data["meta"])
    return data


def build_entry(row: dict) -> dict:
    """A database row -> the MangaEntry the frontend gets (see docs/API.md)."""
    meta = row["meta"]
    total = meta.get("chapters")
    read = row["chapters_read"]
    return {
        "anilist_id": row["anilist_id"],
        "id_mal": row.get("id_mal"),
        "meta": meta,
        "status": row["status"],
        "chapters_read": read,
        "volumes_read": row["volumes_read"],
        "total_chapters": total,
        "total_volumes": meta.get("volumes"),
        "progress": round(min(read / total, 1.0), 4) if total else None,
        "score": row["score"],
        "notes": row["notes"],
        "started_on": row["started_on"],
        "finished_on": row["finished_on"],
        "added_at": row["added_at"],
        "updated_at": row["updated_at"],
    }


# ================================================================ backup + reset
def export_data(db) -> dict:
    """The `manga` part of the backup file."""
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM manga ORDER BY anilist_id").fetchall()
        log = conn.execute("SELECT anilist_id, chapter, read_at FROM manga_log ORDER BY id").fetchall()
    entries = [_row_to_dict(row) for row in rows]  # meta back to a dict, so the file stays readable
    return {"entries": entries, "log": [dict(r) for r in log]}


def _clean_date(value) -> str | None:
    try:
        return date.fromisoformat(str(value)).isoformat() if value else None
    except ValueError:
        return None


def parse_backup(section) -> tuple[list[tuple], list[tuple]]:
    """Check the backup's `manga` section BEFORE anything is written.

    Older backups have no manga section: that's fine, nothing to import.
    A damaged entry stops the import (like a damaged anime entry does).
    """
    if section is None:
        return [], []
    if not isinstance(section, dict) or not isinstance(section.get("entries", []), list):
        raise ValidationError("The backup file is damaged (bad manga section)")
    rows = []
    for raw in section.get("entries") or []:
        try:
            anilist_id = int(raw["anilist_id"])
            meta = raw["meta"]
            if anilist_id < 1 or not isinstance(meta, dict) or int(meta.get("anilist_id", -1)) != anilist_id:
                raise ValueError
            status = raw["status"]
            if status not in STATUSES:
                raise ValueError
            chapters = int(raw.get("chapters_read") or 0)
            volumes = int(raw.get("volumes_read") or 0)
            if not 0 <= chapters <= MAX_CHAPTER or not 0 <= volumes <= MAX_VOLUME:
                raise ValueError
            score = raw.get("score")
            score = score if isinstance(score, int) and not isinstance(score, bool) and 1 <= score <= 10 else None
            id_mal = raw.get("id_mal")
            id_mal = id_mal if isinstance(id_mal, int) and not isinstance(id_mal, bool) and id_mal > 0 else None
        except (KeyError, TypeError, ValueError):
            raise ValidationError("The backup file is damaged (bad manga entry)") from None
        rows.append((
            anilist_id, id_mal, json.dumps(meta), status, chapters, volumes, score,
            str(raw.get("notes") or "")[:MAX_NOTES], _clean_date(raw.get("started_on")), _clean_date(raw.get("finished_on")),
            str(raw.get("added_at") or utc_now()), str(raw.get("updated_at") or utc_now()),
        ))
    log_rows = []
    for item in section.get("log") or []:
        try:
            log_rows.append((int(item["anilist_id"]), int(item["chapter"]), str(item["read_at"])))
        except (KeyError, TypeError, ValueError):
            continue  # one bad log line isn't worth failing the restore for
    return rows, log_rows


def write_backup(conn, rows: list[tuple], log_rows: list[tuple]) -> None:
    """Write the checked manga rows. Runs inside import_backup's transaction."""
    if not rows:
        return
    conn.executemany(
        "INSERT OR REPLACE INTO manga (anilist_id, id_mal, meta, status, chapters_read, volumes_read, score, notes, "
        "started_on, finished_on, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    imported = {r[0] for r in rows}
    # replace the reading history of the imported manga (no duplicates when importing twice)
    conn.executemany("DELETE FROM manga_log WHERE anilist_id = ?", [(i,) for i in imported])
    conn.executemany("INSERT INTO manga_log (anilist_id, chapter, read_at) VALUES (?, ?, ?)",
                     [r for r in log_rows if r[0] in imported])


def reset(conn) -> None:
    """Delete all personal manga data (part of the full reset)."""
    conn.execute("DELETE FROM manga")
    conn.execute("DELETE FROM manga_log")
