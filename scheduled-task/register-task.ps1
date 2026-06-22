# register-task.ps1
# Registers a Windows Scheduled Task that runs run-update.ps1 every 30 minutes
# while you're logged in. Run once:
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1

$taskName = 'BMP-Sweepstake-Refresh'
$script   = Join-Path $PSScriptRoot 'run-update.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""

# Fire shortly after registration, then repeat every 30 minutes indefinitely.
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Refresh WC2026 sweepstake dashboard from SofaScore' -Force

Write-Host "Registered scheduled task '$taskName' (every 30 min)." -ForegroundColor Green
Write-Host "Run it now to test:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Remove it later:     Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
