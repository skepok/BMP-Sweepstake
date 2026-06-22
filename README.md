# The Blair Mitch Project — WC 2026 Sweepstake Dashboard

A free, self-hosted dashboard for our 24-player World Cup 2026 sweepstake. Hosted on
**GitHub Pages**; the data is scraped from **SofaScore** by a small script you run on your
own machine (a cron job) which commits the results back to the repo.

- **Live standings** for the Winner (£120) and Runner-up (£48) race.
- **Three side-prize leaderboards** (£24 each): most goals conceded, most red cards, most own
  goals — all **group stage only**, frozen once the groups finish.
- **Next-match countdown** and **last result** banner.

Total pot: **£240** (24 × £10).

---

## Why this design

We need **red cards and own goals per match** (3 of the 5 prizes depend on them), and **no free
football API exposes those for the 2026 season** — API-Football and football-data.org both gate
it behind paid plans. SofaScore has the data, but it's behind Cloudflare and blocks datacenter
IPs (so it can't run from GitHub Actions). The fix: scrape it from a **residential connection
(your machine)** and push the result up. Hosting stays free and static.

| Piece | Where it runs | What it does |
|-------|---------------|--------------|
| `scripts/scrape.py` | **Your machine** | Pulls fixtures, scores, standings, cards & own goals from SofaScore. Writes `cache/raw_matches.json`. Heavily cached — a finished match is fetched once. |
| `scripts/build.mjs` | Your machine (or Actions) | Turns `raw_matches.json` into `data/standings.json` (all the sweepstake logic). |
| `index.html` + `app.js` + `styles.css` | **GitHub Pages** | Static site, reads `data/standings.json`. No keys, no server. |

The scrape technique (`curl_cffi` Chrome TLS impersonation + XHR headers) gets past Cloudflare
from a home IP without a proxy.

---

## One-time setup

### 1. Get the repo on your machine
```bash
git clone https://github.com/skepok/BMP-Sweepstake.git
cd BMP-Sweepstake
```

### 2. Install prerequisites
- **Node.js 18+** and **Python 3.9+**
- Python dependency:
  ```bash
  pip install -r requirements.txt
  ```

### 3. Season id — already set
The WC 2026 season id (`58210`, tournament `16`) is baked into `scripts/scrape.py`, confirmed
against the live API — **no lookup needed**. If SofaScore ever changes it, override with
`export SOFA_SEASON=<id>` or put it in a git-ignored `.sofa-season` file.

### 4. First run — scrape, build, preview
```bash
python scripts/scrape.py        # (use .venv\Scripts\python on Windows)
node scripts/build.mjs

# preview locally:
python -m http.server 8000      # open http://localhost:8000
```
Check `data/standings.json` looks right, then commit + push:
```bash
git add data/standings.json cache/raw_matches.json
git commit -m "first real data"
git push
```
Your live site updates within a minute: **https://skepok.github.io/BMP-Sweepstake/**

### 5. GitHub Pages (already enabled)
Settings → Pages → **Deploy from a branch → `main` / `(root)`**. Nothing more to do — every
push of `data/standings.json` redeploys the site automatically. The repo must stay **public**
for free Pages.

---

## Automate it (cron)

`scripts/refresh.sh` does the whole loop — scrape → build → commit → push (only if something
changed). Point cron at it:

```cron
# every 30 minutes
*/30 * * * * /full/path/to/BMP-Sweepstake/scripts/refresh.sh >> /tmp/bmp.log 2>&1
```
It reads the season id from `.sofa-season`. On **Windows**, run it via Git Bash, or use Task
Scheduler to call `bash scripts/refresh.sh` (or replicate the three commands in a `.bat`).

Because finished matches are cached, most runs do almost no work; only newly-finished games
trigger a fetch. Running every 30–60 min means the board updates within an hour of full time.

---

## Editing the players / teams

Everything about who owns what lives in **`data/players.json`** — the single source of truth,
generated from `WC 2026_Sweepstake_BMP.pdf`. Each team has `code`, `name`, `iso2` (flag),
`pot`, `odds`, and `aliases` (alternate names for matching).

If a team's stats never appear, SofaScore is probably spelling its name differently — the
scripts **log any unmatched team names**. Add the spelling to that team's `aliases` array,
re-run `node scripts/build.mjs`, and push.

---

## Notes & assumptions

- **Side prizes are group-stage only** and freeze automatically once every group match is
  finished (`groupStageComplete` in the data).
- **Winner / Runner-up** resolve from the Final once it's played.
- **Red cards** come straight from each match in the events feed (`homeRedCards`/`awayRedCards`)
  — the authoritative count (handles two-yellows-equals-red correctly).
- **Own goals** come from the per-match incidents feed and are attributed to the **committing
  team** (verified against real data: SofaScore credits the own goal to the benefiting side, so
  the scraper flips it). If one ever lands on the wrong team, swap the names in
  `fetch_own_goals()` in `scripts/scrape.py` (there's a comment).
- **Flags** use emoji — country flags on phones/Mac, country codes on Windows (no flag font).
- Standings reflect **completed matches only** — no live in-progress scores by design.
- `cache/raw_matches.json` is **committed on purpose**; it's the cache that avoids re-scraping.

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| Scraper prints `HTTP 403 … giving up` | You're likely on a blocked/VPN/datacenter IP. Run from a normal home connection. Don't run the scraper in GitHub Actions. |
| `Missing dependency` | `pip install -r requirements.txt` |
| Scraper lists seasons and exits | `SOFA_SEASON`/`.sofa-season` isn't set — set it (step 3). |
| Site shows "Couldn't load standings" | No `data/standings.json` pushed yet — run step 4. |
| A team never gets stats | Name mismatch — add an alias in `data/players.json`. |
| Own-goal on the wrong team | Flip the attribution in `fetch_incidents()` (see notes above). |

---

*Data scraped from SofaScore for personal, non-commercial use. Not affiliated with FIFA or SofaScore.*
