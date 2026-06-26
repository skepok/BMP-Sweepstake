#!/usr/bin/env python3
"""
SofaScore scraper for The Blair Mitch Project WC2026 sweepstake.

Writes a normalised cache/raw_matches.json that scripts/build.mjs turns into the
dashboard. Heavily cached: a finished match's incidents (red cards / own goals)
are fetched ONCE and reused forever.

Run from a RESIDENTIAL connection (your machine) — SofaScore/Cloudflare block
datacenter IPs hard, so this is meant for a local cron, not GitHub Actions.

Bypass technique (same as public scrapers): curl_cffi with Chrome TLS
impersonation defeats Cloudflare's passive fingerprinting, plus the XHR headers
the API expects. No proxy needed from a home IP.

Setup:   pip install -r requirements.txt
Find the season id:  SOFA_SEASON unset -> the script lists available seasons.
Run:     SOFA_SEASON=xxxxx python scripts/scrape.py
Env:     SOFA_UT (default 16 = FIFA World Cup), SOFA_SEASON (required)
"""

import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from curl_cffi import requests  # TLS impersonation
except ImportError:
    sys.exit("Missing dependency. Run:  pip install -r requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
RAW_PATH = CACHE / "raw_matches.json"

UT = int(os.environ.get("SOFA_UT", "16"))               # 16 = FIFA World Cup (confirmed)
SEASON = os.environ.get("SOFA_SEASON", "58210").strip()  # 58210 = "World Cup 2026" (confirmed)
BASE = "https://www.sofascore.com/api/v1"

IMPERSONATE = ["chrome131", "chrome124", "chrome120", "chrome116"]
HEADERS = {
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore.com",
}

_session = requests.Session()


def get_json(path, attempts=5):
    """GET BASE+path as JSON with backoff for 403/429/503 (Cloudflare)."""
    url = BASE + path
    for attempt in range(attempts):
        try:
            r = _session.get(url, headers=HEADERS,
                             impersonate=random.choice(IMPERSONATE), timeout=30)
        except Exception as e:
            print(f"  ! request error ({e}); retrying")
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 200:
            return r.json()
        if r.status_code == 404:
            return None
        wait = min(120, 10 * (2 ** attempt)) if r.status_code == 403 else min(60, 5 * (2 ** attempt))
        print(f"  ! HTTP {r.status_code} on {path}; waiting {wait}s (attempt {attempt + 1}/{attempts})")
        time.sleep(wait)
    print(f"  !! giving up on {path}")
    return None


def polite_sleep():
    time.sleep(random.uniform(0.6, 1.4))


def list_seasons():
    data = get_json(f"/unique-tournament/{UT}/seasons")
    seasons = (data or {}).get("seasons", [])
    print(f"\nAvailable seasons for unique-tournament {UT} (World Cup):\n")
    for s in seasons[:15]:
        print(f"  id={s.get('id'):<8} {s.get('year')}   {s.get('name')}")
    print("\nSet the 2026 one, e.g.:  SOFA_SEASON=<id> python scripts/scrape.py\n")


def map_round(round_info):
    """Map SofaScore roundInfo to the round labels build.mjs classifies."""
    info = round_info or {}
    name = (info.get("name") or info.get("slug") or "").lower().replace("-", " ")
    if "round of 32" in name or "1/16" in name:
        return "Round of 32"
    if "round of 16" in name or "1/8" in name:
        return "Round of 16"
    if "quarter" in name:
        return "Quarter-finals"
    if "semi" in name:
        return "Semi-finals"
    if "3rd" in name or "third" in name:
        return "3rd Place Play-off"
    if name == "final" or name.endswith(" final"):
        return "Final"
    return "Group Stage"


def fetch_all_events():
    """Past (finished/live) + upcoming events, deduped by id."""
    events = {}
    for kind in ("last", "next"):
        page = 0
        while True:
            data = get_json(f"/unique-tournament/{UT}/season/{SEASON}/events/{kind}/{page}")
            evs = (data or {}).get("events", [])
            if not evs:
                break
            for e in evs:
                events.setdefault(e["id"], e)  # past wins over upcoming for same id
            polite_sleep()
            page += 1
            if page > 20:  # safety
                break
    return list(events.values())


def fetch_standings():
    """Per-team group table rows: group, rank, played, w/d/l, gf, ga, pts."""
    data = get_json(f"/unique-tournament/{UT}/season/{SEASON}/standings/total")
    out = []
    for block in (data or {}).get("standings", []):
        group = block.get("name") or None
        # Skip the "Third-placed teams" comparison table — keep only real groups.
        if not group or not group.startswith("Group "):
            continue
        for row in block.get("rows", []):
            team = (row.get("team") or {}).get("name")
            if not team:
                continue
            out.append({
                "team": team, "group": group, "rank": row.get("position"),
                "played": row.get("matches", 0), "w": row.get("wins", 0),
                "d": row.get("draws", 0), "l": row.get("losses", 0),
                "gf": row.get("scoresFor", 0), "ga": row.get("scoresAgainst", 0),
                "pts": row.get("points", 0),
            })
    return out


def fetch_bracket():
    """Knockout bracket (cuptree): rounds -> blocks, each block joined to its
    match event id so build.mjs can attach live scores. Placeholders (2F, 3A/3B,
    W74...) resolve to real teams automatically as SofaScore updates them."""
    data = get_json(f"/unique-tournament/{UT}/season/{SEASON}/cuptrees")
    trees = (data or {}).get("cupTrees", [])
    if not trees:
        return []
    out = []
    for rnd in trees[0].get("rounds", []):
        blocks = []
        for b in rnd.get("blocks", []):
            parts = []
            for p in b.get("participants", []):
                t = p.get("team") or {}
                parts.append({
                    "name": t.get("name"),
                    "code": t.get("nameCode"),
                    "placeholder": bool(t.get("disabled")),
                    "winner": bool(p.get("winner")),
                })
            blocks.append({
                "order": b.get("order"),
                "eventId": (b.get("events") or [None])[0],
                "kickoff": b.get("seriesStartDateTimestamp"),
                "participants": parts,
            })
        out.append({"round": rnd.get("description"), "type": rnd.get("type"),
                    "order": rnd.get("order"), "blocks": blocks})
    return out


def fetch_incidents(event_id, home_name, away_name):
    """From a match's incidents, return:
      - own goals by COMMITTING team (dict)
      - yellow cards by team (dict; reds come from the events feed)
      - the earliest goal in the match (for the 'fastest goal' prize)
      - the earliest own goal in the match (for 'fastest own goal')

    Own-goal attribution confirmed against real data: SofaScore credits the goal
    to the BENEFITING side (isHome); the committing team is the opposite. If one
    ever lands on the wrong team, swap the two names in the own-goal branch.
    """
    data = get_json(f"/event/{event_id}/incidents")
    own = {}
    yellow = {}
    fastest_goal = None
    fastest_own = None

    def earlier(cur, cand):
        if cur is None:
            return cand
        ck = cur["minute"] * 100 + (cur.get("addedTime") or 0)
        nk = cand["minute"] * 100 + (cand.get("addedTime") or 0)
        return cand if nk < ck else cur

    for inc in (data or {}).get("incidents", []):
        itype = inc.get("incidentType")
        cls = (inc.get("incidentClass") or "").lower()
        is_home = inc.get("isHome")
        if itype == "card" and cls == "yellow":  # plain yellows; reds come from the events feed
            team = home_name if is_home else away_name
            yellow[team] = yellow.get(team, 0) + 1
            continue
        if itype != "goal":
            continue
        minute = inc.get("time")
        scorer = (inc.get("player") or {}).get("name")
        if minute is None:
            continue
        if cls == "owngoal":
            committing = away_name if is_home else home_name
            own[committing] = own.get(committing, 0) + 1
            fastest_own = earlier(fastest_own, {"minute": minute, "addedTime": inc.get("addedTime"),
                                                "scorer": scorer, "team": committing})
        else:
            scoring = home_name if is_home else away_name
            fastest_goal = earlier(fastest_goal, {"minute": minute, "addedTime": inc.get("addedTime"),
                                                  "scorer": scorer, "team": scoring})
    return own, yellow, fastest_goal, fastest_own


def main():
    if not SEASON:
        list_seasons()
        sys.exit("\nSOFA_SEASON not set — pick the 2026 id from the list above.")

    CACHE.mkdir(exist_ok=True)
    old = {}
    if RAW_PATH.exists():
        try:
            prev = json.loads(RAW_PATH.read_text(encoding="utf-8"))
            old = {m["id"]: m for m in prev.get("matches", [])}
        except Exception:
            pass

    print(f"Fetching events for tournament {UT}, season {SEASON} ...")
    events = fetch_all_events()
    print(f"  {len(events)} events found.")
    print("Fetching standings ...")
    standings = fetch_standings()
    print("Fetching knockout bracket ...")
    bracket = fetch_bracket()

    matches = []
    fetched_incidents = 0
    for e in events:
        eid = e["id"]
        status = (e.get("status") or {}).get("type", "notstarted")
        finished = status == "finished"
        home = (e.get("homeTeam") or {}).get("name")
        away = (e.get("awayTeam") or {}).get("name")
        wc = e.get("winnerCode")
        hs = (e.get("homeScore") or {}).get("current")
        as_ = (e.get("awayScore") or {}).get("current")

        # Red cards come straight from the events feed (authoritative aggregate).
        red = {}
        if e.get("homeRedCards"):
            red[home] = e["homeRedCards"]
        if e.get("awayRedCards"):
            red[away] = e["awayRedCards"]

        m = {
            "id": eid,
            "round": map_round(e.get("roundInfo")),
            "startTimestamp": e.get("startTimestamp"),
            "status": status,
            "home": {"name": home, "score": hs, "winner": (wc == 1) if finished else None},
            "away": {"name": away, "score": as_, "winner": (wc == 2) if finished else None},
            "redCards": red,
            "ownGoals": {},            # filled from incidents (own goals aren't in the events feed)
            "yellowCards": {},         # filled from incidents (yellows aren't in the events feed)
            "fastestGoal": None,       # earliest goal in this match {minute, addedTime, scorer, team}
            "fastestOwnGoal": None,    # earliest own goal in this match
            "incidentsFetched": False,
        }

        prev_m = old.get(eid)
        if finished and prev_m and prev_m.get("incidentsFetched"):
            # Reuse cached incidents — never re-fetch a finished match's incidents.
            m["incidentsFetched"] = True
            m["ownGoals"] = prev_m.get("ownGoals", {})
            m["yellowCards"] = prev_m.get("yellowCards", {})
            m["fastestGoal"] = prev_m.get("fastestGoal")
            m["fastestOwnGoal"] = prev_m.get("fastestOwnGoal")
        elif finished and home and away:
            own, yellow, fastest_goal, fastest_own = fetch_incidents(eid, home, away)
            m["incidentsFetched"] = True
            m["ownGoals"] = own
            m["yellowCards"] = yellow
            m["fastestGoal"] = fastest_goal
            m["fastestOwnGoal"] = fastest_own
            fetched_incidents += 1
            polite_sleep()
            print(f"  + {home} {hs}-{as_} {away} ({m['round']})"
                  + (f" red={red}" if red else "") + (f" og={own}" if own else ""))

        matches.append(m)

    # Stability: if the match/standings data is identical to what's already on
    # disk, leave the file untouched (don't refresh fetchedAt). That keeps the
    # file byte-identical so the scheduled task commits nothing when no game has
    # changed — only real updates produce a commit.
    new_core = json.dumps({"matches": matches, "standings": standings, "bracket": bracket}, sort_keys=True, ensure_ascii=False)
    if RAW_PATH.exists():
        try:
            prev = json.loads(RAW_PATH.read_text(encoding="utf-8"))
            prev_core = json.dumps({"matches": prev.get("matches"), "standings": prev.get("standings"), "bracket": prev.get("bracket")},
                                   sort_keys=True, ensure_ascii=False)
            if prev_core == new_core:
                print(f"No data changes — left {RAW_PATH.name} unchanged "
                      f"({fetched_incidents} new incident fetches).")
                print("Now run:  node scripts/build.mjs")
                return
        except Exception:
            pass

    payload = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "source": "SofaScore",
        "season": 2026,
        "uniqueTournament": UT,
        "seasonId": SEASON,
        "matches": matches,
        "standings": standings,
        "bracket": bracket,
    }
    RAW_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nWrote {RAW_PATH.relative_to(ROOT)} — {len(matches)} matches, "
          f"{len(standings)} standings rows, {fetched_incidents} new incident fetches.")
    print("Now run:  node scripts/build.mjs")


if __name__ == "__main__":
    main()
