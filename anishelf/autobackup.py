"""Automatic daily backups.

Once a day AniShelf writes the same JSON file that Settings > Export gives you into
data/backups/auto/anishelf-YYYY-MM-DD.json and keeps only the newest KEEP files.

Why a separate "auto" folder? So we can safely delete old automatic backups without ever
touching a backup you made yourself (anything else inside data/backups/ is left alone).

run.py starts the background thread. The tests never start it: they call write_now() directly
with a temporary folder, so they never touch your real data.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import date, datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

KEEP = 7                      # how many automatic backups to keep
CHECK_EVERY_SECONDS = 3600    # while the app keeps running, check once an hour if a new day started
PREFIX = "anishelf-"
# Only files that look exactly like "anishelf-2026-11-09.json" count as automatic backups.
# A regular expression (regex) is a pattern for text: \d{4} means "exactly four digits".
NAME_PATTERN = re.compile(r"^anishelf-(\d{4}-\d{2}-\d{2})\.json$")


def file_name_for(day: date) -> str:
    return f"{PREFIX}{day.isoformat()}.json"


class AutoBackup:
    def __init__(self, db, folder: Path | str | None):
        self.db = db
        # folder None = automatic backups are switched off (e.g. an in-memory test database)
        self.folder = Path(folder) if folder else None
        self._lock = threading.Lock()   # two "Back up now" clicks must not write the same file at once
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------ files
    def backups(self) -> list[Path]:
        """The automatic backup files, newest first. Other files in the folder are ignored."""
        if self.folder is None or not self.folder.is_dir():
            return []
        found = [p for p in self.folder.iterdir() if p.is_file() and NAME_PATTERN.match(p.name)]
        # The date is in the name, and ISO dates sort correctly as text, so sorting by name works.
        return sorted(found, key=lambda p: p.name, reverse=True)

    def status(self) -> dict:
        """What the Settings page shows: the newest automatic backup (or None)."""
        files = self.backups()
        last = None
        if files:
            newest = files[0]
            saved_at = datetime.fromtimestamp(newest.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
            last = {"date": NAME_PATTERN.match(newest.name).group(1), "file": newest.name, "saved_at": saved_at}
        return {
            "enabled": self.folder is not None,
            "folder": str(self.folder) if self.folder else None,
            "keep": KEEP,
            "count": len(files),
            "last": last,
        }

    def write_now(self, today: date | None = None) -> dict:
        """Write today's backup (replacing today's file if it already exists) and prune old ones."""
        if self.folder is None:
            raise RuntimeError("Automatic backups are switched off")
        today = today or date.today()
        with self._lock:
            self.folder.mkdir(parents=True, exist_ok=True)
            target = self.folder / file_name_for(today)
            # Write to a temporary file first, then rename it. A rename is instant, so a crash
            # halfway through can never leave a half-written backup with the real name.
            temp = self.folder / (target.name + ".tmp")
            temp.write_text(json.dumps(self.db.export(), ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp, target)
            self.prune()
        return self.status()

    def prune(self) -> list[str]:
        """Delete automatic backups beyond the newest KEEP. Returns the deleted file names."""
        removed = []
        for old in self.backups()[KEEP:]:
            try:
                old.unlink()
                removed.append(old.name)
            except OSError:
                log.warning("Couldn't delete old automatic backup %s", old)
        return removed

    def run_if_due(self, today: date | None = None) -> bool:
        """Back up only if there is no backup for today yet. Returns True when it wrote one."""
        if self.folder is None:
            return False
        today = today or date.today()
        if (self.folder / file_name_for(today)).exists():
            return False
        self.write_now(today)
        return True

    # ------------------------------------------------------------ background thread
    def start(self) -> None:
        """Back up now (if not done today), then keep checking once an hour while the app runs."""
        if self.folder is None or self._thread is not None:
            return

        def loop():
            while True:
                try:
                    if self.run_if_due():
                        log.info("Automatic backup written to %s", self.folder)
                except Exception:  # a failed backup must never crash the app
                    log.exception("Automatic backup failed")
                # wait() returns True when stop() was called, otherwise after the timeout
                if self._stop.wait(CHECK_EVERY_SECONDS):
                    return

        self._thread = threading.Thread(target=loop, name="auto-backup", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
