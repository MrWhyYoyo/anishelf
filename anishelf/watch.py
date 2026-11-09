"""Opening streaming sites in the user's normal browser (where they are logged in).

AniShelf never plays or downloads video itself: streaming services use DRM and block
embedding, so the right thing is to send you to their own site/app.
"""

from __future__ import annotations

import webbrowser
from urllib.parse import urlparse

STREAMING_DOMAINS = (
    "crunchyroll.com", "netflix.com", "hulu.com", "primevideo.com", "amazon.com", "amazon.co.uk",
    "hidive.com", "disneyplus.com", "youtube.com", "bilibili.tv", "funimation.com", "max.com",
    "adultswim.com", "tubitv.com", "retrocrush.tv", "ani-one.com", "muse.asia",
)
INFO_DOMAINS = ("myanimelist.net", "anilist.co")


def _host_matches(url: str, domains) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        return False
    return any(host == d or host.endswith("." + d) for d in domains)


def is_streaming_url(url: str) -> bool:
    return _host_matches(url, STREAMING_DOMAINS)


def is_openable(url: str) -> bool:
    return _host_matches(url, STREAMING_DOMAINS + INFO_DOMAINS)


def open_in_browser(url: str, opener=webbrowser.open) -> None:
    if not is_openable(url):
        raise ValueError("That link isn't on a known streaming or anime site")
    opener(url)
