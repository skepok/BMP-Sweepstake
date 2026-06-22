# run-update.ps1
# Full refresh for The Blair Mitch Project sweepstake dashboard:
#   scrape SofaScore -> rebuild standings.json -> commit & push (only if changed).
# Designed to be run by Windows Task Scheduler. Logs to refresh.log next to this script.

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repo      = Split-Path $scriptDir -Parent
$logFile   = Join-Path $scriptDir 'refresh.log'

function Log($msg) {
  ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) |
    Tee-Object -FilePath $logFile -Append
}

# --- load .env (KEY=VALUE lines) -----------------------------------------
$cfg = @{}
$envFile = Join-Path $scriptDir '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    $l = $line.Trim()
    if ($l -and -not $l.StartsWith('#') -and $l.Contains('=')) {
      $parts = $l.Split('=', 2)
      $cfg[$parts[0].Trim()] = $parts[1].Trim().Trim('"')
    }
  }
}

# Tool paths — override in .env only if they aren't on the scheduled task's PATH.
$python = if ($cfg['PYTHON_EXE']) { $cfg['PYTHON_EXE'] } else { 'python' }
$node   = if ($cfg['NODE_EXE'])   { $cfg['NODE_EXE'] }   else { 'node' }
$git    = if ($cfg['GIT_EXE'])    { $cfg['GIT_EXE'] }    else { 'git' }

try {
  Set-Location $repo
  Log '=== refresh start ==='

  # --- ensure the Python virtualenv exists --------------------------------
  $venvPy = Join-Path $repo '.venv\Scripts\python.exe'
  if (-not (Test-Path $venvPy)) {
    Log 'Creating virtualenv and installing dependencies...'
    & $python -m venv (Join-Path $repo '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create virtualenv (check PYTHON_EXE in .env).' }
    & $venvPy -m pip install --quiet -r (Join-Path $repo 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed.' }
  }

  if ($cfg['SOFA_SEASON']) { $env:SOFA_SEASON = $cfg['SOFA_SEASON'] }

  # --- scrape --------------------------------------------------------------
  Log 'Scraping SofaScore...'
  & $venvPy (Join-Path $repo 'scripts\scrape.py') 2>&1 | Tee-Object -FilePath $logFile -Append
  if ($LASTEXITCODE -ne 0) { throw 'scrape.py failed.' }

  # --- build ---------------------------------------------------------------
  Log 'Building standings...'
  & $node (Join-Path $repo 'scripts\build.mjs') 2>&1 | Tee-Object -FilePath $logFile -Append
  if ($LASTEXITCODE -ne 0) { throw 'build.mjs failed.' }

  # --- commit & push if anything changed ----------------------------------
  & $git add data/standings.json cache/raw_matches.json
  & $git diff --staged --quiet
  if ($LASTEXITCODE -ne 0) {
    $stamp = Get-Date -Format 'u'
    & $git -c user.name='bmp-bot' -c user.email='bmp-bot@users.noreply.github.com' `
        commit -m "chore: update standings $stamp" | Out-Null

    if ($cfg['GITHUB_TOKEN']) {
      # Push using a token (good for unattended runs). Token is not stored anywhere.
      $origin  = (& $git remote get-url origin).Trim()
      $authUrl = $origin -replace '^https://', ("https://{0}@" -f $cfg['GITHUB_TOKEN'])
      & $git push $authUrl HEAD:main 2>&1 | Tee-Object -FilePath $logFile -Append
    } else {
      # Use existing Windows credential manager / SSH key.
      & $git push 2>&1 | Tee-Object -FilePath $logFile -Append
    }
    if ($LASTEXITCODE -ne 0) { throw 'git push failed (check credentials / GITHUB_TOKEN).' }
    Log 'Pushed updated standings.'
  } else {
    Log 'No changes to commit.'
  }

  Log '=== refresh done ==='
}
catch {
  Log ("ERROR: " + $_.Exception.Message)
  exit 1
}
