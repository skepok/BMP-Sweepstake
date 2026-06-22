# Scheduled task — auto-refresh the dashboard

Runs the full pipeline on your Windows machine every 30 minutes:
**scrape SofaScore → rebuild `standings.json` → commit & push** (only when data changed).

## Files
- `run-update.ps1` — does the whole refresh. Logs to `refresh.log` here.
- `.env` — optional config (git-ignored; safe for a token). All optional.
- `register-task.ps1` — registers the 30-minute Scheduled Task for you.

## Setup

1. **Test the script once** (from a normal PowerShell window):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\run-update.ps1"
   ```
   Watch `refresh.log`. It should scrape, build, and push. If you see
   "command not found", set `NODE_EXE` / `GIT_EXE` / `PYTHON_EXE` in `.env`
   (find them with `where.exe node`, `where.exe git`, `where.exe python`).
   If `git push` prompts for credentials, add a `GITHUB_TOKEN` in `.env`.

2. **Register the schedule:**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\register-task.ps1"
   ```
   This creates task **BMP-Sweepstake-Refresh**, running every 30 minutes while
   you're logged in.

3. **Confirm it works:**
   ```powershell
   Start-ScheduledTask -TaskName 'BMP-Sweepstake-Refresh'
   ```
   then check `refresh.log` and your live site.

## Notes
- The task runs only while you're logged in (no stored password needed). Matches
  finish and the board updates within ~30 min — fine for a sweepstake.
- Remove it anytime: `Unregister-ScheduledTask -TaskName 'BMP-Sweepstake-Refresh' -Confirm:$false`
- `refresh.log` is git-ignored (it matches `*.log`).
