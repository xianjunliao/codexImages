param(
    [string]$TaskName = "CodexMediaWorker",
    [string]$LifeBaseUrl = "",
    [string]$ProjectRoot = "e:\works\project\codexImages"
)

$ErrorActionPreference = "Stop"
$launcherPath = Join-Path $ProjectRoot "scripts\start-codex-media-worker-hidden.vbs"
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "Hidden worker launcher not found: $launcherPath"
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

$argument = "`"$launcherPath`""
if (-not [string]::IsNullOrWhiteSpace($LifeBaseUrl)) {
    $argument = "$argument `"$LifeBaseUrl`""
}
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $argument -WorkingDirectory $ProjectRoot
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn)
)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "LifeBaseUrl: $LifeBaseUrl"
Write-Host "Services log file: $(Join-Path $ProjectRoot 'logs\local-services.log')"
