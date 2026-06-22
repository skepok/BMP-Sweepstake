#!/usr/bin/env bash
#
# One-shot refresh for cron: scrape SofaScore -> rebuild standings -> push if changed.
# Run from a residential connection (your machine), not a datacenter/CI.
#
# Example crontab (every 30 min):
#   */30 * * * * /path/to/BMP-Sweepstake/scripts/refresh.sh >> /tmp/bmp.log 2>&1
#
# SOFA_SEASON must be available. Either export it in your crontab, or put the id
# in a file named ".sofa-season" in the repo root (git-ignored).

set -euo pipefail
cd "$(dirname "$0")/.."

# Load SOFA_SEASON from .sofa-season if not already in the environment.
if [ -z "${SOFA_SEASON:-}" ] && [ -f .sofa-season ]; then
  export SOFA_SEASON="$(tr -d '[:space:]' < .sofa-season)"
fi

# Use the local virtualenv if present (so deps stay in this folder), else system python.
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"            # macOS / Linux
elif [ -x ".venv/Scripts/python.exe" ]; then
  PY=".venv/Scripts/python.exe"    # Windows
else
  PY="${PYTHON:-python3}"
  command -v "$PY" >/dev/null 2>&1 || PY=python
fi

"$PY" scripts/scrape.py
node scripts/build.mjs

git add data/standings.json cache/raw_matches.json
if git diff --staged --quiet; then
  echo "No changes to commit."
else
  git commit -m "chore: update standings ($(date -u +%FT%TZ))"
  git push
  echo "Pushed updated standings."
fi
