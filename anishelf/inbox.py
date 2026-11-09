"""The season inbox (AniShelf 1.2): news about sequels to shows you've finished.

It is built from the show-state badges (show_state.py), so it costs no extra API calls:
every Done show whose next season is announced or already out becomes one inbox item.
The ids of items you've already seen are kept in the settings table, so the bell only
lights up for news you haven't looked at yet.

    GET  /api/inbox       -> {"items": [...], "unread": n}
    POST /api/inbox/seen  -> marks everything currently in the inbox as seen
"""

from __future__ import annotations

SEEN_KEY = "inbox_seen"
MAX_SEEN = 500   # keep the remembered list small; old ids drop off the front


def _item_id(state: dict) -> str:
    # The id includes the kind, so "Season 2 announced" and later "Season 2 is out" are two
    # separate pieces of news: seeing the first doesn't hide the second.
    return f"{state['kind']}:{state['next']['mal_id']}"


def items(shelf) -> dict:
    seen = set(shelf.db.setting(SEEN_KEY, []) or [])
    out = []
    for entry in shelf.library():
        state = entry.get("show_state") or {}
        if entry["status"] != "completed" or state.get("kind") not in ("new_season", "announced"):
            continue
        item_id = _item_id(state)
        meta = entry["meta"]
        out.append({
            "id": item_id,
            "kind": state["kind"],
            "unread": item_id not in seen,
            "from": {"mal_id": entry["mal_id"], "title": meta.get("title"),
                     "title_english": meta.get("title_english"), "image": meta.get("image")},
            "next": state["next"],
            "airing": state.get("airing", False),
        })
    # Unread first, then "out now" before "announced", then by title
    out.sort(key=lambda i: (not i["unread"], i["kind"] != "new_season",
                            (i["from"]["title_english"] or i["from"]["title"] or "").lower()))
    return {"items": out, "unread": sum(1 for i in out if i["unread"])}


def mark_seen(shelf) -> dict:
    current = [i["id"] for i in items(shelf)["items"]]
    seen = list(shelf.db.setting(SEEN_KEY, []) or [])
    for item_id in current:
        if item_id not in seen:
            seen.append(item_id)
    shelf.db.set_setting(SEEN_KEY, seen[-MAX_SEEN:])
    return items(shelf)
