param(
    [string]$TaskName = "CodexMediaWorker",
    [string]$LifeBaseUrl = "http://127.0.0.1:8080",
    [string]$ProjectRoot = "e:\works\project\codexImages"
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $ProjectRoot "scripts\start-codex-media-worker.ps1"
$hiddenScriptPath = Join-Path $ProjectRoot "scripts\start-codex-media-worker-hidden.vbs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Worker startup script not found: $scriptPath"
}
if (-not (Test-Path -LiteralPath $hiddenScriptPath)) {
    throw "Hidden startup script not found: $hiddenScriptPath"
}

$argument = "`"$hiddenScriptPath`" `"$LifeBaseUrl`""
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $argument
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
Write-Host "Log file: $(Join-Path $ProjectRoot 'logs\codex-media-worker.log')"
