"""Pure helper logic (no database, no network) so it is easy to test."""

from __future__ import annotations

import re
from datetime import date

STATUSES = ("watching", "completed", "plan_to_watch", "on_hold", "dropped")
TIERS = ("S", "A", "B", "C", "D")
DEFAULT_ELO = 1500.0
ELO_K = 32
MAX_EPISODE = 5000  # sanity cap so a typo like "1-99999999" can't hang the app


class ValidationError(ValueError):
    """Raised when user input is invalid. The message is shown to the user."""


# ---------------------------------------------------------------- episodes
def parse_episode_ranges(text: str, max_episode: int | None = None) -> set[int]:
    """Turn text like "1-12, 15, 20-22" into {1, ..., 12, 15, 20, 21, 22}.

    Raises ValidationError with a friendly message on bad input.
    """
    if text is None or not str(text).strip():
        raise ValidationError("Type some episodes, e.g. 1-12, 15")

    limit = max_episode if max_episode else MAX_EPISODE
    limit = min(limit, MAX_EPISODE)
    result: set[int] = set()

    # "4 - 2" and "4–2" (en dash) both mean the range 4-2
    normalized = re.sub(r"\s*[-–—]\s*", "-", str(text).strip())
    for raw_part in re.split(r"[,;\s]+", normalized):
        part = raw_part.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d+)(?:\s*-\s*(\d+))?", part)
        if not match:
            raise ValidationError(f'"{part}" is not an episode number or range')
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else start
        if start > end:
            start, end = end, start
        if start < 1:
            raise ValidationError("Episodes start at 1")
        if end > limit:
            raise ValidationError(f"Episode {end} is beyond the last episode ({limit})")
        result.update(range(start, end + 1))

    if not result:
        raise ValidationError("Type some episodes, e.g. 1-12, 15")
    return result


def clean_episode_list(values, max_episode: int | None = None) -> set[int]:
    """Validate a list of episode numbers coming from the UI."""
    if not isinstance(values, (list, tuple, set)):
        raise ValidationError("Episodes must be a list of numbers")
    limit = min(max_episode or MAX_EPISODE, MAX_EPISODE)
    cleaned: set[int] = set()
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValidationError("Episodes must be whole numbers")
        if value < 1 or value > limit:
            raise ValidationError(f"Episode {value} is out of range (1-{limit})")
        cleaned.add(value)
    return cleaned


def compress_ranges(episodes) -> str:
    """{1,2,3,5,7,8} -> "1-3, 5, 7-8" (used for display and export)."""
    nums = sorted(set(episodes))
    if not nums:
        return ""
    parts = []
    start = prev = nums[0]
    for n in nums[1:]:
        if n == prev + 1:
            prev = n
            continue
        parts.append(f"{start}-{prev}" if start != prev else str(start))
        start = prev = n
    parts.append(f"{start}-{prev}" if start != prev else str(start))
    return ", ".join(parts)


def next_episode(watched, total: int | None) -> int | None:
    """The lowest episode not watched yet (None when finished)."""
    watched = set(watched)
    n = 1
    while n in watched:
        n += 1
    if total and n > total:
        return None
    return n


def auto_status(current: str, watched_count: int, total: int | None) -> str:
    """Pick the status that makes sense after episodes change.

    - Watched every episode of a finished show  -> completed
    - Started watching something planned/on hold -> watching
    - Dropped is left alone: that was a deliberate choice.
    """
    if total and watched_count >= total and current != "completed":
        return "completed"
    if watched_count > 0 and current in ("plan_to_watch", "on_hold"):
        return "watching"
    return current


# ---------------------------------------------------------------- ranking
def elo_update(winner: float, loser: float, k: float = ELO_K) -> tuple[float, float]:
    """Classic Elo: expected score E = 1 / (1 + 10^((Rb - Ra)/400))."""
    expected_winner = 1 / (1 + 10 ** ((loser - winner) / 400))
    change = k * (1 - expected_winner)
    return round(winner + change, 2), round(loser - change, 2)


# ---------------------------------------------------------------- metadata
def parse_duration_minutes(text: str | None) -> int | None:
    """Jikan durations look like "24 min per ep", "1 hr 55 min", "45 sec"."""
    if not text:
        return None
    hours = re.search(r"(\d+)\s*hr", text)
    minutes = re.search(r"(\d+)\s*min", text)
    seconds = re.search(r"(\d+)\s*sec", text)
    total = 0.0
    if hours:
        total += int(hours.group(1)) * 60
    if minutes:
        total += int(minutes.group(1))
    if seconds:
        total += int(seconds.group(1)) / 60
    if total <= 0:
        return None
    return max(1, round(total))


# ---------------------------------------------------------------- validation
def validate_patch(patch: dict) -> dict:
    """Check the editable fields of a library entry. Returns a clean dict."""
    if not isinstance(patch, dict):
        raise ValidationError("Expected a JSON object")

    clean: dict = {}
    for key, value in patch.items():
        if key == "status":
            if value not in STATUSES:
                raise ValidationError("Unknown status")
            clean[key] = value
        elif key == "score":
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10):
                raise ValidationError("Score must be a whole number from 1 to 10")
            clean[key] = value
        elif key == "predicted_score":
            # same rule as score; when you may predict is checked in history.check_prediction
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10):
                raise ValidationError("Predicted score must be a whole number from 1 to 10")
            clean[key] = value
        elif key == "tier":
            if value is not None and value not in TIERS:
                raise ValidationError("Tier must be S, A, B, C or D")
            clean[key] = value
        elif key in ("notes", "fav_character", "fav_moment"):
            if not isinstance(value, str):
                raise ValidationError(f"{key} must be text")
            limit = 20000 if key == "notes" else 300
            if len(value) > limit:
                raise ValidationError(f"{key} is too long (max {limit} characters)")
            clean[key] = value
        elif key in ("started_on", "finished_on"):
            if value in (None, ""):
                clean[key] = None
            else:
                try:
                    date.fromisoformat(str(value))
                except ValueError:
                    raise ValidationError("Dates must look like 2026-11-04") from None
                clean[key] = str(value)
        elif key == "rewatch_count":
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 999:
                raise ValidationError("Rewatch count must be 0-999")
            clean[key] = value
        elif key == "favorite":
            if not isinstance(value, bool):
                raise ValidationError("favorite must be true or false")
            clean[key] = 1 if value else 0
        elif key == "total_override":
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_EPISODE):
                raise ValidationError(f"Total episodes must be 1-{MAX_EPISODE}")
            clean[key] = value
        else:
            raise ValidationError(f"Field '{key}' can't be edited")
    return clean


# ---------------------------------------------------------------- profile
AVATAR_HOSTS = ("https://s4.anilist.co/",)


def validate_profile(patch: dict, current: dict, library_ids=None) -> dict:
    """Merge a profile change into the current profile, checking every field.

    library_ids is the set of mal_ids in the library. When it is given, the Top 5 must only
    contain anime from the library. It is None when restoring a backup (the check is skipped there,
    and the profile page simply ignores ids that are no longer in the library)."""
    if not isinstance(patch, dict):
        raise ValidationError("Expected a JSON object")
    profile = dict(current)
    for key, value in patch.items():
        if key == "display_name":
            if not isinstance(value, str) or not 1 <= len(value.strip()) <= 40:
                raise ValidationError("Your name must be 1-40 characters")
            profile[key] = value.strip()
        elif key == "bio":
            if not isinstance(value, str) or len(value) > 200:
                raise ValidationError("Your bio can be at most 200 characters")
            profile[key] = value.strip()
        elif key == "title_language":
            if value not in ("english", "romaji"):
                raise ValidationError("Title language must be english or romaji")
            profile[key] = value
        elif key == "avatar":
            if value is None:
                profile[key] = None
                continue
            if not isinstance(value, dict):
                raise ValidationError("Invalid avatar")
            image, name, anime = value.get("image"), value.get("name"), value.get("anime")
            if isinstance(value.get("id"), bool) or not isinstance(value.get("id"), int):
                raise ValidationError("Invalid avatar")
            if not isinstance(image, str) or not image.startswith(AVATAR_HOSTS) or len(image) > 500:
                raise ValidationError("Avatar pictures must come from AniList")
            if not isinstance(name, str) or not name or len(name) > 120:
                raise ValidationError("Invalid avatar name")
            if anime is not None and (not isinstance(anime, str) or len(anime) > 200):
                raise ValidationError("Invalid avatar anime")
            profile[key] = {"id": value["id"], "name": name, "image": image, "anime": anime}
        elif key == "banner":
            profile[key] = validate_banner(value)
        elif key == "top5":
            profile[key] = validate_top5(value, library_ids)
        elif key == "showcase":
            profile[key] = validate_showcase(value)
        else:
            raise ValidationError(f"Field '{key}' can't be edited")
    return profile


TOP5_MAX = 5        # how many favourite series can be pinned
SHOWCASE_MAX = 3    # how many badges can be featured
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _is_whole_number(value) -> bool:
    # bool is a subclass of int in Python (True == 1), so it has to be ruled out on purpose
    return isinstance(value, int) and not isinstance(value, bool)


def validate_banner(value) -> dict | None:
    """A profile banner: {"mal_id", "image", "position_y", "color"}, or None to remove it."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValidationError("Invalid banner")
    mal_id = value.get("mal_id")
    image = value.get("image")
    position_y = value.get("position_y", 50)  # 50 = the middle of the picture
    color = value.get("color")
    if not _is_whole_number(mal_id) or mal_id < 1:
        raise ValidationError("Invalid banner anime")
    # Same rule as the avatar: only AniList pictures (they go through the /img proxy).
    if not isinstance(image, str) or not image.startswith(AVATAR_HOSTS) or len(image) > 500:
        raise ValidationError("Banner pictures must come from AniList")
    is_number = isinstance(position_y, (int, float)) and not isinstance(position_y, bool)
    if not is_number or not 0 <= position_y <= 100:
        raise ValidationError("Banner position must be a number from 0 to 100")
    if color is not None and (not isinstance(color, str) or not HEX_COLOR.match(color)):
        raise ValidationError("Banner colour must look like #ff5a36")
    return {"mal_id": mal_id, "image": image, "position_y": round(float(position_y), 1), "color": color}


def validate_top5(value, library_ids=None) -> list[int]:
    """Up to 5 unique mal_ids, in the order the user ranked them."""
    if not isinstance(value, list):
        raise ValidationError("Top 5 must be a list of anime ids")
    if len(value) > TOP5_MAX:
        raise ValidationError(f"You can pin at most {TOP5_MAX} favourite series")
    clean = []
    for mal_id in value:
        if not _is_whole_number(mal_id) or mal_id < 1:
            raise ValidationError("Top 5 must be a list of anime ids")
        if mal_id in clean:
            raise ValidationError("Each series can only be in your Top 5 once")
        if library_ids is not None and mal_id not in library_ids:
            raise ValidationError("Your Top 5 can only contain anime from your library")
        clean.append(mal_id)
    return clean


def validate_showcase(value) -> list[str]:
    """Up to 3 unique badge ids. The ids aren't checked against the badge list on purpose:
    new badges get added over time, and unknown ids are simply skipped when the page draws."""
    if not isinstance(value, list):
        raise ValidationError("Showcase must be a list of badge ids")
    if len(value) > SHOWCASE_MAX:
        raise ValidationError(f"You can feature at most {SHOWCASE_MAX} badges")
    clean = []
    for badge_id in value:
        if not isinstance(badge_id, str) or not 1 <= len(badge_id) <= 60:
            raise ValidationError("Showcase must be a list of badge ids")
        if badge_id in clean:
            raise ValidationError("Each badge can only be featured once")
        clean.append(badge_id)
    return clean


def _name_words(name: str) -> list[str]:
    """'Lamperouge, Lelouch' -> ['lamperouge', 'lelouch'] (lower case, punctuation removed)."""
    cleaned = re.sub(r"[^\w\s]", " ", str(name or "").lower())
    return cleaned.split()


def match_character(query: str, cast: list[dict]) -> dict | None:
    """Find the cast member whose name matches what the user typed in fav_character.

    Tries, in order: the exact name, the same words in any order ("Gojo Satoru" vs "Satoru Gojo"),
    then every typed word appearing in the name ("Levi" finds "Levi Ackerman").
    Returns the character dict, or None when nothing matches."""
    wanted = _name_words(query)
    if not wanted:
        return None
    # Pass 1 and 2: same words (order doesn't matter)
    for character in cast:
        if sorted(_name_words(character.get("name"))) == sorted(wanted):
            return character
    # Pass 3: all typed words are part of the name. Main characters come first in the cast,
    # so a short query like "Edward" picks the main character over a background one.
    for character in cast:
        words = _name_words(character.get("name"))
        if words and all(word in words for word in wanted):
            return character
    return None
