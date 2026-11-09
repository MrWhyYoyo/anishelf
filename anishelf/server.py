"""Flask app: JSON API (docs/API.md) + the static frontend."""

from __future__ import annotations

import json
import logging
import mimetypes
import threading
import webbrowser
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory

from . import inbox, __version__
from .clients import ApiError, NotFoundError
from .manga import MangaNotInLibrary
from .games import GameScores
from .quests import QuestBook
from .wrapped import wrapped_for
from .warmup import Warmup
from .images import ImageCache
from .logic import ValidationError
from . import profile_extras
from .service import AniShelf, NotInLibrary
from .watch import open_in_browser
from . import watching
from .anilist import DISCOVER_GENRES
from . import seasonal, taste, upnext  # seasonal chart, taste profile, Up Next queue
from .autobackup import AutoBackup
from . import undo
from . import bulk, user_collections  # bulk edit + custom collections

log =logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

# Some Windows installs map .js to text/plain in the registry; browsers then refuse to run
# ES modules and the UI stays blank. Force the correct types.
for _type, _ext in (("text/javascript", ".js"), ("text/javascript", ".mjs"), ("text/css", ".css"),
                    ("image/svg+xml", ".svg"), ("image/webp", ".webp"), ("application/json", ".json"),
                    ("application/manifest+json", ".webmanifest"), ("image/x-icon", ".ico")):
    mimetypes.add_type(_type, _ext)


def default_backup_dir(shelf: AniShelf) -> Path | None:
    """Automatic backups go next to the database: <data>/backups/auto (None for an in-memory db)."""
    if shelf.db.path == ":memory:":
        return None
    return Path(shelf.db.path).parent / "backups" / "auto"


def create_app(shelf: AniShelf, images: ImageCache, backup_dir: Path | str | None = None) -> Flask:
    app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")
    app.config["JSON_SORT_KEYS"] = False
    app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # backups can be a few MB
    scores = GameScores(shelf.db)
    # run.py starts this after launch; tests never start it, so they stay offline and fast
    warmup = Warmup(shelf)
    app.config["WARMUP"] = warmup
    # Daily automatic backups (autobackup.py). Like warmup, run.py starts the daily thread;
    # tests pass a temporary backup_dir and only call the routes.
    auto_backup = AutoBackup(shelf.db, backup_dir or default_backup_dir(shelf))
    app.config["AUTO_BACKUP"] = auto_backup

    # ------------------------------------------------------------ safety
    @app.before_request
    def block_other_websites():
        """Only our own page may change data (stops other sites poking 127.0.0.1)."""
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            abort(403)
        # JSON bodies can't be sent cross-site without the browser asking permission first.
        # Requests with no body at all (e.g. "refresh") are fine; HTML forms always send a Content-Type.
        if request.method in ("POST", "PUT", "PATCH"):
            has_body = bool(request.content_length) or request.content_type is not None
            if has_body and not request.is_json:
                return jsonify(error="Expected JSON"), 415

    @app.after_request
    def headers(resp: Response):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.path == "/" or request.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    # ------------------------------------------------------------ errors
    @app.errorhandler(ValidationError)
    def on_validation(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(NotInLibrary)
    def on_missing(exc):
        return jsonify(error="That anime isn't in your library"), 404

    @app.errorhandler(ApiError)
    def on_api(exc):
        return jsonify(error=str(exc)), 502

    @app.errorhandler(403)
    def on_forbidden(exc):
        return jsonify(error="Forbidden"), 403

    @app.errorhandler(404)
    def on_404(exc):
        return jsonify(error="Not found"), 404

    @app.errorhandler(405)
    def on_405(exc):
        return jsonify(error="Method not allowed"), 405

    @app.errorhandler(413)
    def on_413(exc):
        return jsonify(error="File too large"), 413

    @app.errorhandler(Exception)
    def on_crash(exc):
        if hasattr(exc, "code") and hasattr(exc, "get_response"):  # other HTTP errors
            return jsonify(error=getattr(exc, "description", "Error")), exc.code
        log.exception("Unexpected error")
        return jsonify(error="Something went wrong inside AniShelf (see the terminal for details)"), 500

    def body() -> dict:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValidationError("Expected a JSON object")
        return data

    # ------------------------------------------------------------ pages
    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/favicon.ico")
    def favicon():
        # Browsers (and Edge's app window) ask for this file directly, so serve the real icon.
        return send_from_directory(STATIC / "icons", "favicon.ico", max_age=7 * 24 * 3600)

    @app.get("/img")
    def image():
        url = request.args.get("u", "")
        if not images.is_allowed(url):
            return jsonify(error="Image host not allowed"), 400
        try:
            path = images.get(url)
        except ApiError as exc:
            return jsonify(error=str(exc)), 502
        return send_file(path, max_age=30 * 24 * 3600)

    # ------------------------------------------------------------ browsing
    @app.get("/api/health")
    def health():
        return jsonify(ok=True, version=__version__)

    @app.get("/api/warmup")
    def warmup_status():
        return jsonify(warmup.snapshot())

    @app.get("/api/search")
    def search():
        return jsonify(results=shelf.search(request.args.get("q", "")))

    @app.get("/api/discover")
    def discover():
        return jsonify(shelf.discover())

    @app.get("/api/anime/<int:mal_id>")
    def anime(mal_id):
        return jsonify(shelf.anime_page(mal_id))

    @app.get("/api/anime/<int:mal_id>/episodes")
    def episodes(mal_id):
        return jsonify(shelf.episodes(mal_id))

    @app.get("/api/anime/<int:mal_id>/characters")
    def characters(mal_id):
        return jsonify(characters=shelf.characters(mal_id))

    @app.post("/api/open")
    def open_link():
        url = body().get("url")
        if not isinstance(url, str):
            raise ValidationError("url is required")
        try:
            open_in_browser(url, app.config.get("OPENER") or webbrowser.open)
        except ValueError as exc:
            raise ValidationError(str(exc)) from None
        return jsonify(ok=True)

    @app.get("/api/me")
    def me():
        return jsonify(shelf.me())

    @app.patch("/api/me")
    def update_me():
        return jsonify(shelf.update_me(body()))

    @app.get("/api/me/banners")
    def me_banners():
        return jsonify(profile_extras.banner_choices(shelf))

    @app.get("/api/me/fav-characters")
    def me_fav_characters():
        return jsonify(profile_extras.fav_characters(shelf))

    @app.get("/api/avatars")
    def avatars():
        raw_page = request.args.get("page") or "1"
        page = int(raw_page) if raw_page.isdigit() else 1
        return jsonify(shelf.avatars(request.args.get("source") or "popular", page, request.args.get("q")))

    @app.get("/api/profile")
    def profile():
        return jsonify(shelf.profile())

    @app.get("/api/anime/<int:mal_id>/recommendations")
    def recommendations(mal_id):
        return jsonify(results=shelf.recommendations(mal_id))

    # ------------------------------------------------------------ library
    @app.get("/api/library")
    def library():
        entries = shelf.library(request.args.get("status") or None)
        if any(e["franchise"] is None for e in entries):
            # group a few ungrouped shows in the background; the next load shows them grouped
            threading.Thread(target=shelf.backfill_franchises, daemon=True).start()
        return jsonify(entries=entries)

    @app.get("/api/anime/<int:mal_id>/seasons")
    def seasons(mal_id):
        return jsonify(shelf.seasons(mal_id))

    @app.post("/api/library")
    def add():
        data = body()
        mal_id = data.get("mal_id")
        if isinstance(mal_id, bool) or not isinstance(mal_id, int) or mal_id < 1:
            raise ValidationError("mal_id must be a positive whole number")
        return jsonify(entry=shelf.add(mal_id, data.get("status") or "plan_to_watch"))

    @app.patch("/api/library/<int:mal_id>")
    def update(mal_id):
        return jsonify(entry=shelf.update(mal_id, body()))

    @app.delete("/api/library/<int:mal_id>")
    def remove(mal_id):
        # Copy everything about the show first, so the "Undo" toast can bring it back (undo.py)
        snapshot = undo.snapshot(shelf.db, mal_id)
        shelf.remove(mal_id)
        return jsonify(ok=True, snapshot=snapshot)

    @app.post("/api/library/<int:mal_id>/restore")
    def restore(mal_id):
        """Undo a remove: the body is the snapshot that DELETE returned."""
        undo.restore(shelf.db, mal_id, request.get_json(silent=True))
        # built from the restored row only (no API call), same shape as GET /api/anime/<id> "entry"
        return jsonify(entry=shelf._with_franchise(shelf.build_entry(shelf._row(mal_id))))

    @app.put("/api/library/<int:mal_id>/episodes")
    def change_episodes(mal_id):
        return jsonify(shelf.change_episodes(mal_id, body()))

    @app.post("/api/library/<int:mal_id>/group")
    def set_group(mal_id):
        """Body {"with": other_mal_id} joins this anime to that series; {"with": null} keeps it separate."""
        return jsonify(shelf.set_group(mal_id, body().get("with")))

    @app.post("/api/library/<int:mal_id>/refresh")
    def refresh(mal_id):
        return jsonify(entry=shelf.refresh(mal_id))

    # ------------------------------------------------------------ bulk edit + collections
    @app.post("/api/library/bulk")
    def library_bulk():
        """Body {"ids": [...], "action": "status|tier|collection|watch_all|remove", "value": ...} (bulk.py)."""
        return jsonify(bulk.apply(shelf.db, body()))

    shelf_collections = user_collections.Collections(shelf.db)

    def collection_or_404(fetch):
        """An unknown collection id is a 404, like a missing anime."""
        try:
            return jsonify(fetch())
        except KeyError:
            return jsonify(error="That collection doesn't exist"), 404

    @app.get("/api/collections")
    def collections_list():
        return jsonify(collections=shelf_collections.all())

    @app.post("/api/collections")
    def collections_create():
        return jsonify(collection=shelf_collections.create(body()))

    @app.patch("/api/collections/<int:collection_id>")
    def collections_update(collection_id):
        data = body()
        return collection_or_404(lambda: {"collection": shelf_collections.update(collection_id, data)})

    @app.delete("/api/collections/<int:collection_id>")
    def collections_delete(collection_id):
        return collection_or_404(lambda: shelf_collections.delete(collection_id) or {"ok": True})

    @app.post("/api/collections/<int:collection_id>/anime")
    def collections_add(collection_id):
        data = body()
        # accept {"mal_id": 1} for one show or {"mal_ids": [1, 2]} for several
        ids = data.get("mal_ids") if "mal_ids" in data else [data.get("mal_id")]
        return collection_or_404(lambda: {"collection": shelf_collections.add_anime(collection_id, ids)})

    @app.delete("/api/collections/<int:collection_id>/anime/<int:mal_id>")
    def collections_remove(collection_id, mal_id):
        return collection_or_404(lambda: {"collection": shelf_collections.remove_anime(collection_id, mal_id)})

    # ------------------------------------------------------------ history (rewatch + diary)
    @app.post("/api/library/<int:mal_id>/rewatch")
    def rewatch(mal_id):
        return jsonify(entry=shelf.rewatch(mal_id, body().get("action")))

    @app.get("/api/diary")
    def diary():
        raw_id = request.args.get("mal_id") or ""
        mal_id = int(raw_id) if raw_id.isdigit() else None
        return jsonify(shelf.history.diary(request.args.get("mood") or None, mal_id))

    @app.post("/api/diary")
    def add_diary():
        return jsonify(note=shelf.history.add_note(body()))

    @app.patch("/api/diary/<int:note_id>")
    def update_diary(note_id):
        try:
            return jsonify(note=shelf.history.update_note(note_id, body()))
        except KeyError:
            return jsonify(error="That diary note doesn't exist"), 404

    @app.delete("/api/diary/<int:note_id>")
    def delete_diary(note_id):
        try:
            shelf.history.delete_note(note_id)
        except KeyError:
            return jsonify(error="That diary note doesn't exist"), 404
        return jsonify(ok=True)

    # ------------------------------------------------------------ ranking & fun
    @app.get("/api/versus")
    def versus():
        return jsonify(shelf.versus_pair())

    @app.post("/api/versus")
    def versus_vote():
        data = body()
        return jsonify(shelf.versus_result(data.get("winner"), data.get("loser")))

    @app.get("/api/random")
    def random_pick():
        genre = request.args.get("genre") or None
        raw_max = request.args.get("max_episodes") or None
        max_episodes = None
        if raw_max:
            if not raw_max.isdigit() or int(raw_max) < 1:
                raise ValidationError("max_episodes must be a positive number")
            max_episodes = int(raw_max)
        mood = request.args.get("mood") or None
        if request.args.get("source") == "discover":
            if mood and not genre:
                # AniList can only filter one genre, so a mood picks one of its genres
                genre = watching.discover_genre_for_mood(mood, shelf.rng, DISCOVER_GENRES)
            return jsonify(shelf.surprise(genre, max_episodes))
        statuses = [s for s in (request.args.get("statuses") or "plan_to_watch").split(",") if s]
        return jsonify(shelf.random_pick(genre, max_episodes, statuses or ["plan_to_watch"], mood))

    # ------------------------------------------------------------ watching (Home + calendar)
    @app.get("/api/memories")
    def memories():
        return jsonify(memories=watching.memories(shelf))

    @app.get("/api/calendar")
    def airing_calendar():
        tz_offset = watching.parse_tz_offset(request.args.get("tz_offset"))
        return jsonify(watching.calendar(shelf, tz_offset))

    @app.get("/api/nudges")
    def nudges():
        return jsonify(nudges=watching.nudges(shelf))

    # ---- season inbox (1.2): sequel news for shows you've finished
    @app.get("/api/inbox")
    def inbox_items():
        return jsonify(inbox.items(shelf))

    @app.post("/api/inbox/seen")
    def inbox_seen():
        return jsonify(inbox.mark_seen(shelf))

    @app.get("/api/stats")
    def stats():
        return jsonify(shelf.stats())

    # ------------------------------------------------------------ seasonal chart, Up Next, taste
    @app.get("/api/season")
    def season_chart():
        """?season=fall&year=2026 (both optional = this season). See seasonal.py."""
        return jsonify(seasonal.season_chart(shelf, request.args.get("season"), request.args.get("year")))

    @app.get("/api/queue")
    def queue():
        raw_limit = request.args.get("limit") or ""
        limit = min(int(raw_limit), 50) if raw_limit.isdigit() else None
        return jsonify(upnext.up_next(shelf, limit))

    @app.put("/api/queue")
    def reorder_queue():
        return jsonify(upnext.reorder(shelf, body().get("order")))

    @app.get("/api/taste")
    def taste_profile():
        return jsonify(taste.taste_for(shelf))

    # ------------------------------------------------------------ mini games
    @app.get("/api/games")
    def games():
        return jsonify(scores=scores.all())

    @app.post("/api/games/<game_id>/score")
    def game_score(game_id):
        return jsonify(scores.submit(game_id, body().get("score")))

    # ------------------------------------------------------------ progression (quests, wrapped)
    @app.get("/api/quests")
    def quests_today():
        return jsonify(QuestBook(shelf).today())

    @app.get("/api/wrapped")
    def wrapped():
        return jsonify(wrapped_for(shelf, request.args.get("year")))

    # ------------------------------------------------------------ backup
    @app.get("/api/export")
    def export():
        payload = json.dumps(shelf.db.export(), ensure_ascii=False, indent=2)
        filename = f"anishelf-backup-{date.today().isoformat()}.json"
        return Response(
            payload,
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/backups/auto")
    def auto_backup_status():
        """The newest automatic daily backup (autobackup.py), for the Settings page."""
        return jsonify(auto_backup.status())

    @app.post("/api/backups/auto")
    def auto_backup_now():
        """"Back up now": write today's automatic backup straight away."""
        if auto_backup.folder is None:
            raise ValidationError("Automatic backups are switched off")
        return jsonify(auto_backup.write_now())

    @app.post("/api/reset")
    def reset():
        shelf.reset_everything(body().get("confirm"))
        return jsonify(ok=True)

    @app.post("/api/import")
    def import_backup():
        return jsonify(imported=shelf.db.import_backup(request.get_json(silent=True)))

    # ------------------------------------------------------------ manga (AniShelf 1.15, code in manga.py)
    @app.errorhandler(MangaNotInLibrary)
    def on_manga_missing(exc):
        return jsonify(error="That manga isn't in your library"), 404

    def manga_or_404(fetch):
        """AniList saying "no such manga" is a 404 for the page, not a server error."""
        try:
            return jsonify(fetch())
        except NotFoundError:
            return jsonify(error="Couldn't find that manga"), 404

    @app.get("/api/manga/search")
    def manga_search():
        return jsonify(results=shelf.manga.search(request.args.get("q", "")))

    @app.get("/api/manga")
    def manga_library():
        return jsonify(entries=shelf.manga.library(request.args.get("status") or None))

    @app.post("/api/manga")
    def manga_add():
        data = body()
        return manga_or_404(lambda: {"entry": shelf.manga.add(data.get("anilist_id"), data.get("status") or "plan_to_read")})

    @app.get("/api/manga/<int:anilist_id>")
    def manga_page(anilist_id):
        return manga_or_404(lambda: shelf.manga.page(anilist_id))

    @app.patch("/api/manga/<int:anilist_id>")
    def manga_update(anilist_id):
        return jsonify(entry=shelf.manga.update(anilist_id, body()))

    @app.put("/api/manga/<int:anilist_id>/progress")
    def manga_progress(anilist_id):
        return jsonify(shelf.manga.change_progress(anilist_id, body()))

    @app.get("/api/manga/<int:anilist_id>/volumes")
    def manga_volumes(anilist_id):
        """Where each volume ends (MangaDex map, or an estimate for finished manga)."""
        return manga_or_404(lambda: shelf.manga.volume_info(anilist_id))

    @app.delete("/api/manga/<int:anilist_id>")
    def manga_remove(anilist_id):
        shelf.manga.remove(anilist_id)
        return jsonify(ok=True)

    @app.get("/api/anime/<int:mal_id>/source")
    def anime_source(mal_id):
        return jsonify(shelf.manga.anime_source(mal_id))

    return app
