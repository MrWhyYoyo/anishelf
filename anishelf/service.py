"""App logic that combines the database, the API clients and the cache."""

from __future__ import annotations

import collections
import logging
import random
import threading
import time
from datetime import date, datetime, timedelta

from . import franchise, history, manga, merges, progression, show_state
from . import upnext  # Up Next order for Plan to Watch (upnext.py)
from .anilist import DISCOVER_GENRES, AniListClient
from .clients import DAY, HOUR, ApiError, JikanClient, NotFoundError
from .db import Database
from .mangadex import MangaDexClient
from .games import game_xp_total
from .quests import QuestBook
from .logic import (
    STATUSES,
    ValidationError,
    auto_status,
    clean_episode_list,
    compress_ranges,
    elo_update,
    next_episode,
    parse_episode_ranges,
    validate_patch,
    validate_profile,
)

log = logging.getLogger(__name__)

DEFAULT_EPISODE_MINUTES = 24
BULK_LOG_LIMIT = 25  # marking more than this at once counts as "catching up records", not today's activity
EMPTY_ANILIST = {"banner": None, "color": None, "cover_xl": None, "next_airing": None, "streaming": []}
JIKAN_COOLDOWN = 300  # after Jikan fails, use AniList directly for 5 minutes (no waiting on timeouts)


class NotInLibrary(KeyError):
    pass


class AniShelf:
    def __init__(self, db: Database, jikan: JikanClient, anilist: AniListClient, rng: random.Random | None = None,
                 mangadex: MangaDexClient | None = None):
        self.db = db
        self.jikan = jikan
        self.anilist = anilist
        # volume -> chapter lookups for manga (mangadex.py); creating it makes no request
        self.mangadex = mangadex or MangaDexClient()
        self.rng = rng or random.Random()
        self._jikan_down_until = 0.0
        self._backfill_lock = threading.Lock()
        self.history = history.History(db)  # watch diary + rewatch storage
        self.manga = manga.MangaShelf(self)  # manga shelf + chapter progress (manga.py)

    # ================================================================ providers
    def probe_jikan(self) -> bool:
        """Run once at startup (in the background) so a dead Jikan is known before the first click."""
        try:
            self.jikan.ping()
            return True
        except ApiError as exc:
            self._jikan_down_until = time.monotonic() + JIKAN_COOLDOWN
            log.warning("Jikan is unavailable (%s) - using AniList for now", exc)
            return False

    @property
    def jikan_available(self) -> bool:
        return time.monotonic() >= self._jikan_down_until

    def _provider(self, method: str, *args):
        """Ask Jikan first; if it is down, ask AniList for the same thing."""
        if self.jikan_available:
            try:
                return getattr(self.jikan, method)(*args)
            except NotFoundError:
                raise
            except ApiError as exc:
                self._jikan_down_until = time.monotonic() + JIKAN_COOLDOWN
                log.warning("Jikan failed (%s) - using AniList for the next %ss", exc, JIKAN_COOLDOWN)
        return getattr(self.anilist, method)(*args)

    # ================================================================ caching
    def _cached(self, key: str, ttl: float, fetch, force: bool = False):
        hit = self.db.cache_get(key, ttl)
        if hit and hit[1] and not force:
            return hit[0]
        try:
            value = fetch()
        except ApiError:
            if hit:  # API down: an old answer is better than an error
                log.warning("Using stale cache for %s", key)
                return hit[0]
            raise
        self.db.cache_set(key, value)
        return value

    # ================================================================ browsing
    def _with_status(self, items: list[dict]) -> list[dict]:
        statuses = self.db.statuses()
        return [{**m, "library_status": statuses.get(m["mal_id"])} for m in items]

    def search(self, query: str) -> list[dict]:
        query = (query or "").strip()
        if len(query) < 2:
            raise ValidationError("Type at least 2 characters to search")
        if len(query) > 100:
            raise ValidationError("Search text is too long")
        key = f"search:{query.lower()}"
        return self._with_status(self._cached(key, DAY, lambda: self._provider("search", query)))

    def discover(self) -> dict:
        season = self._cached("discover:season", 6 * HOUR, lambda: self._provider("season_now"))
        top = self._cached("discover:top_airing", 6 * HOUR, lambda: self._provider("top_airing"))
        return {"season": self._with_status(season), "top_airing": self._with_status(top)}

    def meta(self, mal_id: int, force: bool = False) -> dict:
        """Full metadata: Jikan details + AniList banner/colour/next episode."""
        key = f"anime:{mal_id}"
        previous = self.db.cache_get(key, None)
        # airing shows change (episode counts, status) - refresh them more often
        ttl = 12 * HOUR if previous and previous[0].get("airing") else 2 * DAY
        base = self._cached(key, ttl, lambda: self._provider("anime", mal_id), force)
        meta = dict(base)
        if base.get("anilist"):
            # came from the AniList fallback - it already has banner/colour/countdown
            meta["anilist"] = {**EMPTY_ANILIST, **base["anilist"]}
            meta["streaming"] = meta["anilist"]["streaming"]
            return meta
        try:
            extras = self._cached(f"anilist:{mal_id}", 6 * HOUR, lambda: self.anilist.extras(mal_id), force)
        except ApiError as exc:  # banners are nice-to-have; never fail the page for them
            log.warning("AniList extras failed for %s: %s", mal_id, exc)
            extras = {}
        meta["anilist"] = {**EMPTY_ANILIST, **(extras or {})}
        meta["streaming"] = meta["anilist"]["streaming"]
        return meta

    def anime_page(self, mal_id: int) -> dict:
        meta = self.meta(mal_id)
        row = self.db.get(mal_id)
        if row:
            self.db.update_meta(mal_id, meta)  # keep the library snapshot current
            row["meta"] = meta
        return {"meta": meta, "entry": self._with_franchise(self.build_entry(row)) if row else None}

    def episodes(self, mal_id: int) -> dict:
        """Episode titles: Jikan first, AniList (streaming sites) as fallback."""
        key = f"episodes:{mal_id}"
        row = self.db.get(mal_id)
        airing = bool(row and row["meta"].get("airing"))
        previous = self.db.cache_get(key, None)
        from_fallback = bool(previous and previous[0].get("source") == "anilist")
        # fallback titles are re-checked daily so Jikan's fuller data replaces them once it's back
        ttl = DAY if from_fallback else ((12 * HOUR) if airing else (7 * DAY))
        hit = self.db.cache_get(key, ttl)
        if hit and hit[1]:
            return hit[0]

        value = None
        if self.jikan_available:
            try:
                eps, truncated = self.jikan.episodes(mal_id)
                value = {"episodes": eps, "truncated": truncated, "source": "jikan"}
            except NotFoundError:
                pass
            except ApiError as exc:
                self._jikan_down_until = time.monotonic() + JIKAN_COOLDOWN
                log.warning("Jikan episodes failed (%s) - trying AniList", exc)
        if value is None or not value["episodes"]:
            try:
                eps, truncated = self.anilist.episodes(mal_id)
                if eps:
                    value = {"episodes": eps, "truncated": truncated, "source": "anilist"}
            except ApiError as exc:
                log.warning("AniList episodes failed (%s)", exc)
        if value and value["episodes"]:
            self.db.cache_set(key, value)
            return value
        if hit:
            return hit[0]
        return {"episodes": [], "truncated": False, "source": None}  # not cached, so it retries later

    # ================================================================ seasons
    def merge_map(self) -> dict[int, int]:
        """Extra "this belongs to that series" links, automatic + manual (see merges.py)."""
        return merges.combined(self.db.setting(merges.AUTO_KEY), self.db.setting(merges.MANUAL_KEY))

    def _node_from_meta(self, mal_id: int) -> dict | None:
        """A franchise node built from library data, for entries AniList can't give us."""
        row = self.db.get(mal_id)
        if not row:
            return None
        meta = row["meta"]
        formats = {"TV": "TV", "Movie": "MOVIE", "ONA": "ONA", "OVA": "OVA", "Special": "SPECIAL"}
        return {"mal_id": mal_id, "title": meta["title"], "title_english": meta.get("title_english"),
                "format": formats.get(meta.get("type"), "SPECIAL"), "episodes": meta.get("episodes"),
                "status": None, "year": meta.get("year"), "start": f"{meta.get('year') or 9999:04d}-12-31",
                "image": meta.get("image"), "neighbours": []}

    def seasons(self, mal_id: int, _redirected: bool = False) -> dict:
        """All main-story entries of this show (Season 1, 2, ..., movies) in order."""
        def get_node(node_id: int):
            try:
                return self._cached(f"relations:{node_id}", 7 * DAY, lambda: self.anilist.relations_node(node_id))
            except ApiError:
                return None

        merge = self.merge_map()
        # A stray movie that was joined to a series: show (and store) that whole series instead.
        if not _redirected and mal_id in merge:
            result = self.seasons(merge[mal_id], _redirected=True)
            for season in result["seasons"]:
                season["is_current"] = season["mal_id"] == mal_id
            return result

        raw_nodes = franchise.walk(mal_id, get_node)
        linked_ids = {node["mal_id"] for node in raw_nodes}
        # Add the entries that were joined to this series (capped, so a bad merge map can't loop forever).
        extra_ids = [member for member, target in merge.items() if target in linked_ids and member not in linked_ids]
        for extra_id in extra_ids[:10]:
            extra = get_node(extra_id) or self._node_from_meta(extra_id)
            if extra:
                raw_nodes.append({**extra, "neighbours": []})
        nodes = franchise.order(raw_nodes)
        if not nodes:  # AniList doesn't know it: it's a series of one
            meta = self.meta(mal_id)
            nodes = [{"mal_id": mal_id, "title": meta["title"], "title_english": meta.get("title_english"),
                      "format": None, "episodes": meta.get("episodes"), "status": None, "year": meta.get("year"),
                      "start": "", "image": meta.get("image"), "label": "Season 1"}]
        root = nodes[0]
        ref = {"id": root["mal_id"], "title": root["title"], "title_english": root["title_english"], "size": len(nodes)}
        for node in nodes:  # remember the grouping for every member (used by the library, no network)
            self.db.cache_set(f"franchise:{node['mal_id']}", {**ref, "label": node["label"]})

        rows = {r["mal_id"]: r for r in self.db.all()}
        seasons = []
        for node in nodes:
            row = rows.get(node["mal_id"])
            entry = self.build_entry(row) if row else None
            seasons.append({
                **{k: node[k] for k in ("mal_id", "title", "title_english", "format", "episodes", "year", "image", "label")},
                "is_current": node["mal_id"] == mal_id,
                "library_status": entry["status"] if entry else None,
                "watched_count": entry["watched_count"] if entry else 0,
                "total": entry["total"] if entry else node["episodes"],
            })
        return {"franchise_id": root["mal_id"], "title": root["title"], "title_english": root["title_english"],
                "seasons": seasons}

    def refresh_merges(self) -> list[int]:
        """Recompute the automatic merges and regroup anything that changed. Returns changed ids.
        Uses cached data only for matching; regrouping reads cached AniList relations."""
        before = self.merge_map()
        self.db.set_setting(merges.AUTO_KEY, {str(k): v for k, v in merges.auto_merges(self.library()).items()})
        after = self.merge_map()
        changed = sorted({k for k in set(before) | set(after) if before.get(k) != after.get(k)})
        for member in changed[:20]:  # hard cap on regrouping work
            self._regroup(member, before.get(member))
        return changed

    def set_group(self, mal_id: int, target: int | None) -> dict:
        """Manually join `mal_id` to the series `target` is in, or keep it separate (target None)."""
        self._row(mal_id)  # must be in the library (raises NotInLibrary)
        if target is not None:
            if isinstance(target, bool) or not isinstance(target, int) or target == mal_id:
                raise ValidationError("Pick a different anime to group with")
            self._row(target)
            target_ref = self._franchise_ref(target) or {}
            if target_ref.get("id") and target_ref.get("id") == (self._franchise_ref(mal_id) or {}).get("id"):
                raise ValidationError("These are already in the same series")
        before = self.merge_map().get(mal_id)
        manual = {str(k): v for k, v in (self.db.setting(merges.MANUAL_KEY) or {}).items()}
        manual[str(mal_id)] = target if target is not None else merges.KEEP_SEPARATE
        self.db.set_setting(merges.MANUAL_KEY, manual)
        self._regroup(mal_id, before)
        return self.seasons(mal_id)

    def _regroup(self, member: int, old_target: int | None) -> None:
        """Rewrite the stored grouping for a member and for the series it left (sizes change)."""
        try:
            self.seasons(member)
            if old_target is not None:
                self.seasons(old_target)
        except ApiError as exc:
            log.warning("Regrouping %s failed: %s", member, exc)

    def _franchise_ref(self, mal_id: int) -> dict | None:
        hit = self.db.cache_get(f"franchise:{mal_id}", None)
        return hit[0] if hit else None

    def backfill_franchises(self, limit: int = 5) -> int:
        """Group library entries that were never grouped (e.g. quick-added from search).
        Runs in a background thread; a lock makes sure only one runs at a time."""
        if not self._backfill_lock.acquire(blocking=False):
            return 0
        done = 0
        try:
            for row in self.db.all():
                if done >= limit:
                    break
                if self._franchise_ref(row["mal_id"]) is None:
                    try:
                        self.seasons(row["mal_id"])
                    except ApiError as exc:
                        log.warning("Grouping seasons for %s failed: %s", row["mal_id"], exc)
                    done += 1
            if done:
                self.refresh_merges()  # newly grouped entries may let a stray movie find its series
        finally:
            self._backfill_lock.release()
        return done

    def characters(self, mal_id: int) -> list[dict]:
        """Cast with sub (Japanese) and dub (English) voice actors. AniList only - Jikan isn't needed."""
        return self._cached(f"characters:{mal_id}", 7 * DAY, lambda: self.anilist.characters(mal_id))

    # ================================================================ "me" + avatars
    DEFAULT_PROFILE = {
        "display_name": "Anime Fan", "bio": "", "avatar": None, "title_language": "english",
        "banner": None,   # {"mal_id", "image", "position_y", "color"} - see logic.validate_banner
        "top5": [],       # up to 5 mal_ids, best first
        "showcase": [],   # up to 3 badge ids featured at the top of the profile
    }

    def me(self) -> dict:
        profile = {**self.DEFAULT_PROFILE, **(self.db.setting("profile") or {})}
        return {**profile, "member_since": self.db.first_added()}

    def update_me(self, patch: dict) -> dict:
        current = {**self.DEFAULT_PROFILE, **(self.db.setting("profile") or {})}
        # The Top 5 may only hold anime from the library, so look the ids up when it changes.
        library_ids = None
        if isinstance(patch, dict) and "top5" in patch:
            library_ids = set(self.db.statuses())
        self.db.set_setting("profile", validate_profile(patch, current, library_ids))
        return self.me()

    def reset_everything(self, confirm) -> None:
        """Delete the library, watch history and profile. Anime info cache and images are kept
        (they're not personal and make the fresh start fast)."""
        if confirm != "RESET":
            raise ValidationError('Type RESET to confirm')
        self.db.reset_personal_data()

    def avatars(self, source: str, page: int | None = None, query: str | None = None) -> dict:
        if source == "popular":
            page = page if isinstance(page, int) and 1 <= page <= 50 else 1
            chars = self._cached(f"avatars:popular:{page}", 7 * DAY, lambda: self.anilist.popular_characters(page))
            return {"characters": chars, "page": page}
        if source == "search":
            q = (query or "").strip()
            if len(q) < 2:
                raise ValidationError("Type at least 2 characters to search")
            if len(q) > 60:
                raise ValidationError("Search text is too long")
            chars = self._cached(f"avatars:search:{q.lower()}", 7 * DAY, lambda: self.anilist.search_characters(q))
            return {"characters": chars}
        if source == "library":
            return {"characters": self._library_characters()}
        raise ValidationError("Unknown avatar source")

    def _library_characters(self, max_new_fetches: int = 4) -> list[dict]:
        """Main characters from my shows. Uses the cache; fetches at most a few missing shows per call."""
        out, seen, fetched = [], set(), 0
        for entry in self.library():
            if entry["status"] == "plan_to_watch" and not entry["favorite"]:
                continue
            key = f"characters:{entry['mal_id']}"
            hit = self.db.cache_get(key, None)
            if hit:
                cast = hit[0]
            elif fetched < max_new_fetches:
                fetched += 1
                try:
                    cast = self.characters(entry["mal_id"])
                except ApiError:
                    continue
            else:
                continue
            for c in cast:
                if c["role"] != "MAIN" or not c.get("image") or c["id"] in seen or "default.jpg" in c["image"]:
                    continue
                seen.add(c["id"])
                out.append({"id": c["id"], "name": c["name"], "image": c["image"], "anime": entry["meta"].get("title_english") or entry["meta"]["title"]})
        return out

    def profile(self) -> dict:
        """Level, XP and badges, calculated fresh from the library."""
        days = set()
        log = self.db.watch_log()
        for item in log:
            try:
                days.add(datetime.fromisoformat(item["watched_at"]).astimezone().date())
            except ValueError:
                continue
        longest = streaks(days, date.today())["longest"]
        entries = self.library()
        m = progression.metrics(entries, longest)
        m.update(progression.activity_metrics(log, entries))  # night owl, marathon, speedrun ...
        # Stored bonus XP: checking today's quests first awards any that were just completed.
        m["quest_xp"] = QuestBook(self).today()["xp_total"]
        m["game_xp"] = game_xp_total(self.db)
        m.update(self.manga.xp_metrics())  # manga_chapters + manga_completed -> the "Manga" XP line
        return progression.profile(m)

    def recommendations(self, mal_id: int) -> list[dict]:
        return self._cached(f"recs:{mal_id}", 7 * DAY, lambda: self._provider("recommendations", mal_id))

    # ================================================================ entries
    @staticmethod
    def build_entry(row: dict) -> dict:
        meta = row["meta"]
        watched = row["watched"]
        total = row.get("total_override") or meta.get("episodes")
        aired = None
        nxt = (meta.get("anilist") or {}).get("next_airing")
        if meta.get("airing") and nxt and isinstance(nxt.get("episode"), int):
            aired = max(nxt["episode"] - 1, 0)
        count = len(watched)
        return {
            "mal_id": row["mal_id"],
            "meta": meta,
            "status": row["status"],
            "score": row["score"],
            "tier": row["tier"],
            "elo": round(row["elo"], 1),
            "matches": row["matches"],
            "watched": watched,
            "watched_count": count,
            "watched_text": compress_ranges(watched),
            "total": total,
            "total_override": row.get("total_override"),
            "aired": aired,
            "progress": round(min(count / total, 1.0), 4) if total else None,
            "next_episode": next_episode(watched, total),
            "notes": row["notes"],
            "fav_character": row["fav_character"],
            "fav_moment": row["fav_moment"],
            "started_on": row["started_on"],
            "finished_on": row["finished_on"],
            "rewatch_count": row["rewatch_count"],
            "favorite": row["favorite"],
            "added_at": row["added_at"],
            "updated_at": row["updated_at"],
            **history.entry_extras(row, total),  # rewatch progress + score prediction fields
        }

    def _row(self, mal_id: int) -> dict:
        row = self.db.get(mal_id)
        if row is None:
            raise NotInLibrary(mal_id)
        return row

    def library(self, status: str | None = None) -> list[dict]:
        if status and status not in STATUSES:
            raise ValidationError("Unknown status")
        entries = [self.build_entry(row) for row in self.db.all(status)]
        # Fetch every entry's franchise info in one query instead of one query per entry.
        keys = [f"franchise:{entry['mal_id']}" for entry in entries]
        refs = self.db.cache_get_many(keys)
        last = self.db.last_watched()
        for entry in entries:
            entry["franchise"] = refs.get(f"franchise:{entry['mal_id']}")
            entry["last_watched_at"] = last.get(entry["mal_id"])  # None if you never marked an episode
        # "Waiting for Season 3", "New season out", "Caught up"... (cached data only, no API calls)
        show_state.annotate(self, entries, None if status is None else self.db.statuses())
        return entries

    def _with_franchise(self, entry: dict) -> dict:
        entry["franchise"] = self._franchise_ref(entry["mal_id"])
        show_state.annotate(self, [entry], self.db.statuses())
        return entry

    def add(self, mal_id: int, status: str = "plan_to_watch") -> dict:
        if status not in STATUSES:
            raise ValidationError("Unknown status")
        meta = self.meta(mal_id)
        before = self.db.get(mal_id)  # None for a new show (needed for the Up Next queue below)
        row = self.db.add(meta, status)
        upnext.on_status(self.db, mal_id, status, before["status"] if before else None)  # new plans join the bottom
        extra = self._dates_for_status(row, status)
        if extra:
            row = self.db.update(mal_id, extra)
        return self.build_entry(row)

    @staticmethod
    def _dates_for_status(row: dict, status: str) -> dict:
        today = date.today().isoformat()
        extra = {}
        if status == "watching" and not row.get("started_on"):
            extra["started_on"] = today
        if status == "completed":
            if not row.get("finished_on"):
                extra["finished_on"] = today
            if not row.get("started_on"):
                extra["started_on"] = today
        return extra

    def update(self, mal_id: int, patch: dict) -> dict:
        clean = validate_patch(patch)
        row = self._row(mal_id)
        history.check_prediction(clean, row)  # predictions: only before you really know the show
        if clean.get("status", "completed") != "completed" and row.get("rewatching"):
            # a rewatch only makes sense for a completed show, so leaving Completed ends it
            row = self.history.rewatch_action(row, "cancel")
        if "status" in clean:
            for key, value in self._dates_for_status(row, clean["status"]).items():
                clean.setdefault(key, value)
        if "total_override" in clean and clean["total_override"]:
            too_high = [e for e in row["watched"] if e > clean["total_override"]]
            if too_high:
                raise ValidationError(f"You already marked episode {max(too_high)} as watched")
        saved = self.db.update(mal_id, clean)
        if "status" in clean:  # Up Next: joining Plan to Watch = bottom of the queue, leaving it = no place
            upnext.on_status(self.db, mal_id, clean["status"], row["status"])
        return self.build_entry(saved)

    def remove(self, mal_id: int) -> None:
        if not self.db.remove(mal_id):
            raise NotInLibrary(mal_id)

    def refresh(self, mal_id: int) -> dict:
        self._row(mal_id)
        meta = self.meta(mal_id, force=True)
        self.db.update_meta(mal_id, meta)
        return self.build_entry(self._row(mal_id))

    # ================================================================ episodes
    def change_episodes(self, mal_id: int, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValidationError("Expected a JSON object")
        row = self._row(mal_id)
        entry = self.build_entry(row)
        total = entry["total"]
        watched = set(row["watched"])
        # "watch" = the first watch (the old behaviour), "rewatch" = the running rewatch (history.py)
        target = history.episode_target(body, row)
        if target == "rewatch":
            watched = set(row["rewatch_watched"])
        action = body.get("action")

        if action == "toggle":
            ep = clean_episode_list([body.get("episode")], total)
            watched ^= ep
        elif action == "up_to":
            (ep,) = clean_episode_list([body.get("episode")], total)
            watched |= set(range(1, ep + 1))
        elif action == "add_range":
            watched |= parse_episode_ranges(body.get("text"), total)
        elif action == "remove_range":
            watched -= parse_episode_ranges(body.get("text"), total)
        elif action == "set":
            watched = clean_episode_list(body.get("episodes"), total)
        elif action == "all":
            if not total:
                raise ValidationError("The total number of episodes isn't known yet - set it first")
            watched = set(range(1, total + 1))
        elif action == "clear":
            watched = set()
        else:
            raise ValidationError("Unknown episode action")

        if target == "rewatch":
            # A rewatch never changes the status or the first watch's dates
            added_count = len(watched - set(row["rewatch_watched"]))
            saved, finished = self.history.save_rewatch(row, watched, total, log_new=added_count <= BULK_LOG_LIMIT)
            return {"entry": self.build_entry(saved), "status_changed": None,
                    "rewatch_finished": finished}

        new_status = auto_status(row["status"], len(watched), total)
        extra = {}
        status_changed = None
        if new_status != row["status"]:
            extra["status"] = new_status
            status_changed = new_status
        # dates follow the episodes even when the status was already set by hand
        if watched and not row.get("started_on"):
            extra["started_on"] = date.today().isoformat()
        if new_status == "completed" and not row.get("finished_on"):
            extra["finished_on"] = date.today().isoformat()

        added_count = len(watched - set(row["watched"]))
        saved, _, _ = self.db.set_watched(mal_id, watched, extra, log_new=added_count <= BULK_LOG_LIMIT)
        return {"entry": self.build_entry(saved), "status_changed": status_changed, "rewatch_finished": None}

    # ================================================================ rewatch + diary (history.py)
    def rewatch(self, mal_id: int, action) -> dict:
        """Start, finish or cancel a rewatch of a completed show."""
        row = self._row(mal_id)
        return self.build_entry(self.history.rewatch_action(row, action))

    # ================================================================ ranking
    @staticmethod
    def _rankable(entry: dict) -> bool:
        return entry["status"] == "completed" or (entry["status"] != "plan_to_watch" and entry["watched_count"] > 0)

    def versus_pair(self) -> dict:
        pool = [e for e in self.library() if self._rankable(e)]
        if len(pool) < 2:
            return {"pair": None, "reason": "Watch at least 2 anime (or mark them completed) to start head-to-head battles."}
        fewest = min(e["matches"] for e in pool)
        first = self.rng.choice([e for e in pool if e["matches"] == fewest])
        others = sorted((e for e in pool if e["mal_id"] != first["mal_id"]), key=lambda e: abs(e["elo"] - first["elo"]))
        second = self.rng.choice(others[:4])
        pair = [first, second]
        self.rng.shuffle(pair)
        return {"pair": pair}

    def versus_result(self, winner_id, loser_id) -> dict:
        for value in (winner_id, loser_id):
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValidationError("winner and loser must be anime ids")
        if winner_id == loser_id:
            raise ValidationError("An anime can't battle itself")
        winner, loser = self._row(winner_id), self._row(loser_id)
        new_w, new_l = elo_update(winner["elo"], loser["elo"])
        self.db.record_match(winner_id, loser_id, new_w, new_l)
        return {"winner": self.build_entry(self._row(winner_id)), "loser": self.build_entry(self._row(loser_id))}

    # ================================================================ random
    def random_pick(self, genre: str | None, max_episodes: int | None, statuses: list[str],
                    mood: str | None = None) -> dict:
        from .watching import matches_mood, mood_genres  # mood -> genre list (see watching.py)

        for s in statuses:
            if s not in STATUSES:
                raise ValidationError("Unknown status")
        wanted = mood_genres(mood)  # None = any mood
        candidates = []
        for entry in self.library():
            if entry["status"] not in statuses:
                continue
            if genre and genre not in entry["meta"].get("genres", []):
                continue
            if not matches_mood(entry["meta"].get("genres"), wanted):
                continue
            if max_episodes:
                remaining = (entry["total"] - entry["watched_count"]) if entry["total"] else None
                if remaining is None or remaining > max_episodes:
                    continue
            candidates.append(entry)
        pick = self.rng.choice(candidates) if candidates else None
        return {"pick": pick, "candidates": candidates}

    def surprise(self, genre: str | None, max_episodes: int | None) -> dict:
        """Pick a popular anime that is NOT in the library yet (for empty or boring watch lists)."""
        if genre and genre not in DISCOVER_GENRES:
            raise ValidationError("Unknown genre")
        mine = set(self.db.statuses())
        pages = [1, 2, 3, 4] if genre else [1, 2, 3, 4, 5, 6]  # top 200-300 shows; each page cached for a week
        page = self.rng.choice(pages)
        pool = self._cached(f"popular:{genre or 'all'}:{page}", 7 * DAY, lambda: self.anilist.popular(page, genre))
        candidates = []
        for meta in pool:
            if meta["mal_id"] in mine:
                continue
            if max_episodes and not (meta.get("episodes") and meta["episodes"] <= max_episodes):
                continue
            candidates.append({**meta, "library_status": None})
        pick = self.rng.choice(candidates) if candidates else None
        return {"pick": pick, "candidates": candidates[:30], "source": "discover", "genres": DISCOVER_GENRES}

    # ================================================================ stats
    def stats(self, today: date | None = None) -> dict:
        today = today or date.today()
        entries = self.library()
        counts = {s: 0 for s in STATUSES}
        genres: collections.Counter = collections.Counter()
        studios: collections.Counter = collections.Counter()
        scores = {str(i): 0 for i in range(1, 11)}
        episodes = minutes = 0
        scored = []
        completed_this_year = 0

        for e in entries:
            counts[e["status"]] += 1
            n = e["watched_count"]
            episodes += n
            minutes += n * (e["meta"].get("duration_min") or DEFAULT_EPISODE_MINUTES)
            if e["status"] != "plan_to_watch":
                genres.update(e["meta"].get("genres") or [])
                studios.update(e["meta"].get("studios") or [])
            if e["score"]:
                scores[str(e["score"])] += 1
                scored.append(e["score"])
            if e["status"] == "completed" and (e["finished_on"] or "").startswith(str(today.year)):
                completed_this_year += 1

        # activity by local calendar day
        since = datetime.combine(today - timedelta(days=400), datetime.min.time()).astimezone()
        per_day: collections.Counter = collections.Counter()
        for item in self.db.watch_log(since.isoformat()):
            try:
                day = datetime.fromisoformat(item["watched_at"]).astimezone().date()
            except ValueError:
                continue
            per_day[day] += 1

        year_ago = today - timedelta(days=364)
        activity = [{"date": d.isoformat(), "count": c} for d, c in sorted(per_day.items()) if year_ago <= d <= today]

        months = []
        y, m = today.year, today.month
        for _ in range(12):
            months.append((y, m))
            y, m = (y, m - 1) if m > 1 else (y - 1, 12)
        monthly = []
        for y, m in reversed(months):
            total = sum(c for d, c in per_day.items() if d.year == y and d.month == m)
            monthly.append({"month": f"{y:04d}-{m:02d}", "episodes": total})

        return {
            "total_entries": len(entries),
            "status_counts": counts,
            "episodes_watched": episodes,
            "minutes_watched": minutes,
            "hours_watched": round(minutes / 60, 1),
            "days_watched": round(minutes / 1440, 1),
            "mean_score": round(sum(scored) / len(scored), 2) if scored else None,
            "score_distribution": scores,
            "top_genres": [{"name": n, "count": c} for n, c in genres.most_common(10)],
            "top_studios": [{"name": n, "count": c} for n, c in studios.most_common(5)],
            "activity": activity,
            "monthly": monthly,
            "streak": streaks(set(per_day), today),
            "favorites": sum(1 for e in entries if e["favorite"]),
            "completed_this_year": completed_this_year,
            "predictions": history.prediction_summary(entries),  # predicted vs real score
            "manga": self.manga.stats(today),  # chapters_read, completed, reading ... (manga.py)
        }


def streaks(days: set[date], today: date) -> dict:
    """Current streak counts if you watched today or yesterday."""
    longest = run = 0
    prev = None
    for d in sorted(days):
        run = run + 1 if prev and d - prev == timedelta(days=1) else 1
        longest = max(longest, run)
        prev = d
    current = 0
    cursor = today if today in days else today - timedelta(days=1)
    while cursor in days:
        current += 1
        cursor -= timedelta(days=1)
    return {"current": current, "longest": longest}
