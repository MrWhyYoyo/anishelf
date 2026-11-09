"""Start AniShelf: python run.py  (add --no-window to only start the server)."""

from __future__ import annotations

import argparse
import logging
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from anishelf.anilist import AniListClient
from anishelf.clients import JikanClient
from anishelf.db import Database
from anishelf.images import ImageCache
from anishelf.server import create_app
from anishelf.service import AniShelf

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
DEFAULT_PORT = 5178


def data_dir() -> Path:
    """Data lives in ./data unless ANISHELF_DATA points somewhere else (e.g. OneDrive to sync PC + Mac)."""
    custom = os.environ.get("ANISHELF_DATA")
    return Path(custom).expanduser() if custom else ROOT / "data"


def already_running(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


def find_app_browser() -> str | None:
    """Edge/Chrome can show a page as a standalone app window (no tabs or address bar)."""
    if platform.system() == "Windows":
        candidates = [
            shutil.which("msedge"),
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            shutil.which("chrome"),
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ]
    elif platform.system() == "Darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
    else:
        candidates = [shutil.which(n) for n in ("google-chrome", "chromium", "microsoft-edge")]
    return next((c for c in candidates if c and Path(c).exists()), None)


def open_window(url: str, profile: Path) -> None:
    browser = find_app_browser()
    if browser:
        subprocess.Popen(
            [browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1440,920", "--no-first-run"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(description="AniShelf - personal anime tracker")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-window", action="store_true", help="don't open the app window")
    args = parser.parse_args()

    url = f"http://{HOST}:{args.port}"
    folder = data_dir()
    if already_running(url):
        print(f"AniShelf is already running - opening {url}")
        if not args.no_window:
            open_window(url, folder / "window-profile")
        return

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)  # hide one line per request

    shelf = AniShelf(Database(folder / "anishelf.db"), JikanClient(), AniListClient())
    app = create_app(shelf, ImageCache(folder / "images"))
    threading.Thread(target=shelf.probe_jikan, daemon=True).start()
    app.config["WARMUP"].start()  # fill the AniList caches in the background (see anishelf/warmup.py)
    app.config["AUTO_BACKUP"].start()  # daily backup to data/backups/auto (see anishelf/autobackup.py)

    if not args.no_window:
        def open_when_ready():
            for _ in range(50):
                if already_running(url):
                    open_window(url, folder / "window-profile")
                    return
                time.sleep(0.2)
        threading.Thread(target=open_when_ready, daemon=True).start()

    print(f"AniShelf running at {url}  (data: {folder})  - close this window or press Ctrl+C to quit")
    app.run(host=HOST, port=args.port, threaded=True, use_reloader=False, debug=False)


if __name__ == "__main__":
    sys.exit(main())
