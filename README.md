# The Blair Mitch Project — WC 2026 Sweepstake Dashboard

A free, self-updating dashboard for our 24-player World Cup 2026 sweepstake. Hosted on
**GitHub Pages**, updated automatically after every match by a **GitHub Actions** job that
pulls from **API-Football** and commits the results back to the repo.

- **Live standings** for the Winner (£120) and Runner-up (£48) race.
- **Three side-prize leaderboards** (£24 each): most goals conceded, most red cards, most own
  goals — all **group stage only**, frozen once the groups finish.
- **Next-match countdown** and **last result** banner.

Total pot: **£240** (24 × £10).

---

## How it works (and why it's basically free)

The API key must never touch the browser, so the project is split in two:

| Half | What it does |
|------|--------------|
| **Builder** (`scripts/build.mjs`, run by GitHub Actions) | Holds the API key as an encrypted secret. Fetches data, computes standings, writes `data/standings.json`, commits it back. |
| **Viewer** (`index.html` + `app.js` + `styles.css`, served by GitHub Pages) | Static site. Reads the pre-built `data/standings.json`. No API key, no server. |

**API usage stays tiny** because the builder is fixture-aware:

- `/fixtures` and `/standings` are refreshed only when a match has just finished (kickoff +
  120 min) or once a day as a safety net.
- `/fixtures/events` (for red cards & own goals) is fetched **once per finished group-stage
  match**, then cached forever in `cache/`.
- If nothing has finished since the last run, the job makes **zero API calls**.

Across the whole group stage that's roughly **one fetch per match** — well under the free
tier's 100 requests/day. The `cache/` folder is committed on purpose; that's what preserves
state between runs.

---

## Setup (one-time, ~10 minutes)

### 1. Get the code into a GitHub repo
Create a new repository and push these files to the `main` branch (or upload via the web UI).

### 2. Get a free API-Football key
1. Go to **https://www.api-football.com/** and sign up (the **api-sports.io** direct account,
   free plan — 100 requests/day).
2. In your dashboard, copy your **API key**.

> The code targets the direct host `https://v3.football.api-sports.io` with the
> `x-apisports-key` header. If you instead subscribe via **RapidAPI**, the host and headers
> differ — use a direct api-sports.io account to match this code as-is.

### 3. Add the key as a repo secret
In your repo: **Settings → Secrets and variables → Actions → New repository secret**
- **Name:** `API_FOOTBALL_KEY`
- **Value:** *(your key)*

### 4. Confirm the league & season (important)
This project defaults to **League ID `1`** (FIFA World Cup) and **Season `2026`**, set in
`.github/workflows/update.yml`. To double-check the ID for your account, run locally:

```bash
curl -s "https://v3.football.api-sports.io/leagues?search=World Cup" \
  -H "x-apisports-key: YOUR_KEY"
```

Find the "World Cup" entry and confirm its `league.id` and that season `2026` is listed. If it
differs, edit `LEAGUE_ID` / `SEASON` in the workflow's `env:` block.

### 5. Enable GitHub Pages
**Settings → Pages → Build and deployment → Source: _Deploy from a branch_**
- **Branch:** `main`  •  **Folder:** `/ (root)`  → **Save**

Your site will be at `https://<your-username>.github.io/<repo-name>/`.

### 6. Turn on Actions and run the first update
1. **Settings → Actions → General →** allow Actions, and under **Workflow permissions** select
   **Read and write permissions** (so the job can commit the data back). Save.
2. Go to the **Actions** tab → **Update standings** → **Run workflow** to trigger it manually.
3. After it succeeds it commits `data/standings.json`; the Pages site updates within a minute.

From then on it runs every 30 minutes on its own and refreshes after each match finishes.

---

## Local development / preview

No build tooling or dependencies — just Node 18+ and any static file server.

```bash
# Regenerate standings.json from real data (needs the key):
API_FOOTBALL_KEY=yourkey node scripts/build.mjs

# Or generate an empty "skeleton" with no network (great for previewing the UI):
node scripts/build.mjs

# Serve the site locally:
python -m http.server 8000
# then open http://localhost:8000
```

---

## Editing the players / teams

Everything about who owns what lives in **`data/players.json`** — the single source of truth,
generated from `WC 2026_Sweepstake_BMP.pdf`. Each team has:

- `code` – the 3-letter code from the sheet • `name` – display name • `iso2` – for the flag
  emoji • `pot`, `odds`, and `aliases` (alternate names the API might use, for matching).

If a team's stats never appear, the API is probably returning a different spelling — add it to
that team's `aliases` array and re-run. The builder logs any unmatched team names it sees.

---

## Notes & assumptions

- **Side prizes are group-stage only** and freeze automatically once every group match is
  finished (`groupStageComplete`).
- **Winner / Runner-up** resolve from the Final once it's played.
- **Own goals & red cards** are attributed to the **committing team**. API-Football reports an
  own-goal event against the player who scored it, so we credit that player's team. ⚠️ When the
  first real own goal happens, sanity-check the leaderboard against the match; if it's credited
  to the wrong side, flip `OWN_GOAL_TEAM_IS_COMMITTER` at the top of `scripts/build.mjs`.
- **Flags** use emoji. They render as country flags on phones/Mac (where most will view) and may
  fall back to country codes on Windows, which lacks flag-emoji glyphs.
- The standings reflect **completed matches only** — no live in-progress scores by design, so
  the data stays cheap and never shows a wrong "live" number.

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| Site shows "Couldn't load standings" | The first workflow run hasn't committed `data/standings.json` yet — run it from the Actions tab. |
| Job fails to push | Set **Workflow permissions → Read and write** (step 6.1). |
| All teams "Not in data" | Wrong `LEAGUE_ID`/`SEASON`, or the season's fixtures aren't published yet (step 4). |
| A team never gets stats | Name mismatch — add an alias in `data/players.json`. |
| Worried about quota | Each run logs `Requests this run` / `Requests today`; check the Actions logs. |

---

*Data via API-Football (api-sports.io). Not affiliated with FIFA.*
