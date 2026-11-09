"""Warm the caches when the server starts, so the first page views are fast.

Some pages need data from AniList (the airing calendar, franchise nudges, banner choices,
character portraits). The first time, that means waiting for the internet. This module runs
those lookups once in a background thread right after start-up, so by the time you click
around, the answers are already in the local cache.

Every step below already has its own hard cap on API calls (see watching.py and
profile_extras.py), so warming up can never turn into hundreds of requests.
"""

from __future__ import annotations

import logging
import threading
import time

from . import profile_extras, show_state, watching

log = logging.getLogger(__name__)


class Warmup:
    def __init__(self, shelf):
        self.shelf = shelf
        self._lock = threading.Lock()
        # Each step is (label shown on the loading screen, function to run).
        self.steps = [
            ("Grouping seasons", lambda: shelf.backfill_franchises(limit=10)),
            ("Joining movies to their series", shelf.refresh_merges),
            ("Checking the airing schedule", lambda: watching.calendar(shelf, watching.server_tz_offset())),
            ("Finding what to watch next", lambda: watching.nudges(shelf)),
            ("Checking for new seasons", lambda: show_state.refresh(shelf)),
            ("Loading banners", lambda: profile_extras.banner_choices(shelf)),
            ("Loading character portraits", lambda: profile_extras.fav_characters(shelf)),
            ("Loading this season", shelf.discover),
        ]
        self.status = {"running": False, "done": False, "step": None, "finished": 0, "total": len(self.steps),
                       "seconds": None}

    def start(self) -> None:
        """Run the warm-up once in a background thread (a second call does nothing)."""
        with self._lock:
            if self.status["running"] or self.status["done"]:
                return
            self.status["running"] = True
        threading.Thread(target=self._run, name="anishelf-warmup", daemon=True).start()

    def _run(self) -> None:
        started = time.perf_counter()
        for label, step in self.steps:
            self.status["step"] = label
            try:
                step()
            except Exception as exc:  # offline or an API hiccup: skip this step, the page will retry later
                log.info("Warm-up step %r skipped: %s", label, exc)
            self.status["finished"] += 1
        self.status.update(running=False, done=True, step=None,
                           seconds=round(time.perf_counter() - started, 1))
        log.info("Warm-up finished in %ss", self.status["seconds"])

    def snapshot(self) -> dict:
        return dict(self.status)
