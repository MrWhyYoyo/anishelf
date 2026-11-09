"""Downloads cover/banner images once and keeps them on disk."""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from urllib.parse import urlparse

import requests

from .clients import TIMEOUT, USER_AGENT, ApiError

ALLOWED_HOSTS = {"cdn.myanimelist.net", "s4.anilist.co", "img1.ak.crunchyroll.com"}  # last one: episode thumbnails
CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAX_BYTES = 8 * 1024 * 1024


class ImageCache:
    def __init__(self, folder: Path, session: requests.Session | None = None, max_downloads: int = 3000):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.max_downloads = max_downloads
        self.downloads = 0
        self._count_lock = threading.Lock()
        self._parallel = threading.Semaphore(4)  # at most 4 downloads at once
        self._key_locks: dict[str, threading.Lock] = {}
        self._key_locks_lock = threading.Lock()

    @staticmethod
    def is_allowed(url: str) -> bool:
        try:
            parsed = urlparse(url)
        except ValueError:
            return False
        return parsed.scheme == "https" and parsed.hostname in ALLOWED_HOSTS

    def _lock_for(self, key: str) -> threading.Lock:
        with self._key_locks_lock:
            return self._key_locks.setdefault(key, threading.Lock())

    def _existing(self, key: str) -> Path | None:
        for ext in CONTENT_TYPES.values():
            path = self.folder / f"{key}{ext}"
            if path.exists():
                return path
        return None

    def get(self, url: str) -> Path:
        """Return the local path of the image, downloading it the first time."""
        if not self.is_allowed(url):
            raise ApiError("Image host not allowed")
        key = hashlib.sha1(url.encode("utf-8")).hexdigest()

        found = self._existing(key)
        if found:
            return found

        with self._lock_for(key):  # two requests for the same image download it once
            found = self._existing(key)
            if found:
                return found
            with self._count_lock:
                if self.downloads >= self.max_downloads:
                    raise ApiError("Image download safety limit reached - restart AniShelf")
                self.downloads += 1
            with self._parallel:
                try:
                    resp = self.session.get(url, timeout=TIMEOUT, stream=True)
                except requests.RequestException as exc:
                    raise ApiError("Could not download image") from exc
                try:
                    if resp.status_code != 200:
                        raise ApiError(f"Image not available (HTTP {resp.status_code})")
                    ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
                    ext = CONTENT_TYPES.get(ctype)
                    if not ext:
                        raise ApiError("Not an image")
                    data = bytearray()
                    for chunk in resp.iter_content(64 * 1024):
                        data.extend(chunk)
                        if len(data) > MAX_BYTES:
                            raise ApiError("Image too large")
                finally:
                    resp.close()

            path = self.folder / f"{key}{ext}"
            tmp = path.with_suffix(path.suffix + ".part")
            tmp.write_bytes(bytes(data))
            tmp.replace(path)  # atomic: never leaves a half-written image
            return path
