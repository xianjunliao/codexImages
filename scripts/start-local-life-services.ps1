param(
    [string]$ProjectRoot = "e:\works\project\codexImages",
    [string]$LifeBaseUrl = "http://127.0.0.1:8080",
    [string]$TaskName = "CodexMediaWorker",
    [string]$HostName = "127.0.0.1",
    [int]$Port = 3027,
    [string]$ComfyBaseUrl = "",
    [switch]$NoFollowLogs
)

$ErrorActionPreference = "Continue"
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$logDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "local-life-services.log"
$envFile = Join-Path $ProjectRoot ".env"

function Write-ServiceLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $Message
    try {
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        Write-Warning ("Could not write local service log: " + $_.Exception.Message)
    }
    Write-Host $line
}

function Load-DotEnv {
    if (-not (Test-Path -LiteralPath $envFile)) {
        Write-ServiceLog "No .env file found at $envFile"
        return
    }
    Get-Content -LiteralPath $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
            return
        }
        $name, $value = $line.Split("=", 2)
        $cleanName = $name.Trim().TrimStart([char]0xFEFF)
        if ($cleanName) {
            [Environment]::SetEnvironmentVariable($cleanName, $value.Trim(), "Process")
        }
    }
    Write-ServiceLog "Loaded environment from .env"
}

function Test-HttpOk {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Test-PortListening {
    param([int]$PortToTest)
    try {
        return [bool](Get-NetTCPConnection -LocalPort $PortToTest -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

function Stop-ProcessById {
    param(
        [int]$ProcessId,
        [string]$Reason,
        [string[]]$AllowedNames = @()
    )
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
        return
    }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (-not $process) {
            return
        }
        if ($AllowedNames.Count -gt 0 -and ($AllowedNames -notcontains $process.ProcessName)) {
            Write-ServiceLog "Skipping PID $ProcessId ($($process.ProcessName)); expected one of: $($AllowedNames -join ', ')"
            return
        }
        Write-ServiceLog "Stopping PID $ProcessId ($($process.ProcessName)) for $Reason"
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    } catch {
        Write-ServiceLog ("Failed to stop PID ${ProcessId}: " + $_.Exception.Message)
    }
}

function Stop-PortListeners {
    param(
        [int]$PortToStop,
        [int]$WaitSeconds = 10
    )
    $connections = @()
    try {
        $connections = @(Get-NetTCPConnection -LocalPort $PortToStop -State Listen -ErrorAction SilentlyContinue)
    } catch {
        Write-ServiceLog ("Could not inspect port ${PortToStop}: " + $_.Exception.Message)
    }
    if ($connections.Count -eq 0) {
        return $true
    }

    $pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -ne $PID })
    foreach ($listenerPid in $pids) {
        Stop-ProcessById -ProcessId ([int]$listenerPid) -Reason "port $PortToStop listener"
    }

    for ($i = 0; $i -lt $WaitSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-PortListening -PortToTest $PortToStop)) {
            Write-ServiceLog "Port $PortToStop is free."
            return $true
        }
    }

    Write-ServiceLog "Port $PortToStop is still busy after cleanup."
    return $false
}

function Stop-MatchingProcesses {
    param([string[]]$Needles)
    $normalizedNeedles = @($Needles | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant().Replace("/", "\") })
    if ($normalizedNeedles.Count -eq 0) {
        return
    }
    try {
        $processes = Get-CimInstance Win32_Process -ErrorAction Stop
        foreach ($process in $processes) {
            $commandLine = ([string]$process.CommandLine).ToLowerInvariant().Replace("/", "\")
            if (-not $commandLine) {
                continue
            }
            foreach ($needle in $normalizedNeedles) {
                if ($commandLine.Contains($needle)) {
                    Stop-ProcessById -ProcessId ([int]$process.ProcessId) -Reason "old Codex media process"
                    break
                }
            }
        }
    } catch {
        Write-ServiceLog ("Could not inspect process command lines: " + $_.Exception.Message)
    }
}

function Stop-WorkerFromLock {
    $lockFile = Join-Path $logDir "codex-media-worker.lock"
    if (-not (Test-Path -LiteralPath $lockFile)) {
        return
    }
    try {
        $lock = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $lockPid = [int]($lock.pid)
        if ($lockPid -gt 0) {
            Stop-ProcessById -ProcessId $lockPid -Reason "worker lock file" -AllowedNames @("node")
        }
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        Write-ServiceLog "Removed worker lock file."
    } catch {
        Write-ServiceLog ("Could not clean worker lock file: " + $_.Exception.Message)
    }
}

function Remove-StartupTask {
    param([string]$Name)
    try {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
            Write-ServiceLog "Removed scheduled startup task: $Name"
        } else {
            Write-ServiceLog "Scheduled startup task not found: $Name"
        }
    } catch {
        Write-ServiceLog ("Could not remove scheduled startup task ${Name}: " + $_.Exception.Message)
    }
}

function Get-NodeCommand {
    if (-not [string]::IsNullOrWhiteSpace($env:NVM_SYMLINK)) {
        $nodeFromNvm = Join-Path $env:NVM_SYMLINK "node.exe"
        if (Test-Path -LiteralPath $nodeFromNvm) {
            return $nodeFromNvm
        }
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) {
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $node) {
        throw "node.exe was not found in PATH."
    }
    return $node.Source
}

function Test-PythonModule {
    param(
        [string]$Python,
        [string]$Module
    )
    if (-not (Test-Path -LiteralPath $Python)) {
        return $false
    }
    try {
        & $Python -c "import $Module" *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Resolve-ComfyPython {
    param([string]$Root)
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:COMFYUI_PYTHON)) {
        $candidates += $env:COMFYUI_PYTHON
    }
    $venvPython = Join-Path $Root "venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) {
        $candidates += $venvPython
    }
    $pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pathPython) {
        $candidates += $pathPython.Source
    }
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if ((Test-Path -LiteralPath $candidate) -and (Test-PythonModule -Python $candidate -Module "sqlalchemy")) {
            return $candidate
        }
    }
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Get-UriPort {
    param(
        [string]$Url,
        [int]$DefaultPort
    )
    try {
        $uri = [Uri]$Url
        if ($uri.Port -gt 0) {
            return [int]$uri.Port
        }
    } catch {
    }
    return $DefaultPort
}

function Start-ComfyUI {
    param([string]$BaseUrl)
    $uri = [Uri]$BaseUrl
    $listenHost = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
    $listenPort = if ($uri.Port -gt 0) { [int]$uri.Port } else { 8188 }

    $root = $env:COMFYUI_ROOT
    if ([string]::IsNullOrWhiteSpace($root)) {
        $root = "E:\ComfyUI"
    }
    if (-not (Test-Path -LiteralPath $root)) {
        Write-ServiceLog "ComfyUI root not found: $root"
        return
    }

    $python = Resolve-ComfyPython -Root $root
    if (-not $python) {
        Write-ServiceLog "ComfyUI python not found. Set COMFYUI_PYTHON in .env."
        return
    }
    if (-not (Test-PythonModule -Python $python -Module "sqlalchemy")) {
        Write-ServiceLog "Selected ComfyUI python may be missing dependencies: $python"
    }

    if (-not (Stop-PortListeners -PortToStop $listenPort)) {
        Write-ServiceLog "ComfyUI cannot start because port $listenPort is still occupied."
        return
    }

    $outFile = Join-Path $logDir "comfyui.out.log"
    $errFile = Join-Path $logDir "comfyui.err.log"
    Write-ServiceLog "Starting ComfyUI from $root at $BaseUrl with python=$python"
    Start-Process -FilePath $python `
        -ArgumentList "main.py", "--listen", $listenHost, "--port", "$listenPort" `
        -WorkingDirectory $root `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden `
        -PassThru | Out-Null

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Test-HttpOk "$BaseUrl/system_stats") {
            Write-ServiceLog "ComfyUI started at $BaseUrl"
            return
        }
    }
    Write-ServiceLog "ComfyUI did not become healthy yet. Check $errFile"
}

function Start-WebServer {
    $node = Get-NodeCommand
    $url = "http://$HostName`:$Port"
    if (-not (Stop-PortListeners -PortToStop $Port)) {
        Write-ServiceLog "Web server cannot start because port $Port is still occupied."
        return
    }

    $outFile = Join-Path $logDir "server.out.log"
    $errFile = Join-Path $logDir "server.err.log"
    Write-ServiceLog "Starting workspace web server at $url"
    Start-Process -FilePath $node `
        -ArgumentList "server.js" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden `
        -PassThru | Out-Null

    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Test-HttpOk $url) {
            Write-ServiceLog "Workspace web server started at $url"
            return
        }
    }
    Write-ServiceLog "Workspace web server did not become healthy yet. Check $errFile"
}

function Start-MediaWorker {
    $node = Get-NodeCommand
    $outFile = Join-Path $logDir "worker.out.log"
    $errFile = Join-Path $logDir "worker.err.log"
    Write-ServiceLog "Starting Codex media worker. LifeBaseUrl=$env:LIFE_BASE_URL PublicLifeBaseUrl=$env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL"
    Start-Process -FilePath $node `
        -ArgumentList "scripts\codex-media-worker.js" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden `
        -PassThru | Out-Null
}

function Follow-Logs {
    $logSpecs = @(
        @{ Label = "services"; Path = Join-Path $logDir "local-life-services.log" },
        @{ Label = "server:out"; Path = Join-Path $logDir "server.out.log" },
        @{ Label = "server:err"; Path = Join-Path $logDir "server.err.log" },
        @{ Label = "worker:out"; Path = Join-Path $logDir "worker.out.log" },
        @{ Label = "worker:err"; Path = Join-Path $logDir "worker.err.log" },
        @{ Label = "comfy:out"; Path = Join-Path $logDir "comfyui.out.log" },
        @{ Label = "comfy:err"; Path = Join-Path $logDir "comfyui.err.log" }
    )

    foreach ($spec in $logSpecs) {
        if (-not (Test-Path -LiteralPath $spec.Path)) {
            New-Item -ItemType File -Force -Path $spec.Path | Out-Null
        }
    }

    Write-ServiceLog "Following logs. Press Ctrl+C to stop viewing logs; services will keep running."
    $jobs = @()
    foreach ($spec in $logSpecs) {
        $safeName = ("tail-" + $spec.Label).Replace(":", "-")
        $jobs += Start-Job -Name $safeName -ScriptBlock {
            param(
                [string]$Label,
                [string]$Path
            )
            while (-not (Test-Path -LiteralPath $Path)) {
                Start-Sleep -Milliseconds 250
            }
            Get-Content -LiteralPath $Path -Tail 0 -Wait | ForEach-Object {
                if ($null -ne $_) {
                    "[{0}] {1}" -f $Label, $_
                }
            }
        } -ArgumentList $spec.Label, $spec.Path
    }

    try {
        while ($true) {
            foreach ($job in $jobs) {
                Receive-Job -Job $job -ErrorAction SilentlyContinue | ForEach-Object {
                    Write-Host $_
                }
            }
            Start-Sleep -Milliseconds 500
        }
    } finally {
        foreach ($job in $jobs) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-ServiceLog "Starting local life services. ProjectRoot=$ProjectRoot"
Set-Location -LiteralPath $ProjectRoot
Load-DotEnv

if ([string]::IsNullOrWhiteSpace($LifeBaseUrl)) {
    $LifeBaseUrl = "http://127.0.0.1:8080"
}
$LifeBaseUrl = $LifeBaseUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($ComfyBaseUrl)) {
    $ComfyBaseUrl = if ($env:COMFYUI_BASE_URL) { $env:COMFYUI_BASE_URL } else { "http://127.0.0.1:8188" }
}
$ComfyBaseUrl = $ComfyBaseUrl.TrimEnd("/")

$env:LIFE_BASE_URL = $LifeBaseUrl
$env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL = $LifeBaseUrl
$env:CODEX_MEDIA_UPLOAD_TO_LIFE = if ($env:CODEX_MEDIA_UPLOAD_TO_LIFE) { $env:CODEX_MEDIA_UPLOAD_TO_LIFE } else { "true" }
$env:CODEX_MEDIA_POLL_MS = if ($env:CODEX_MEDIA_POLL_MS) { $env:CODEX_MEDIA_POLL_MS } else { "10000" }
$env:CODEX_MEDIA_WORKFLOW_SYNC_REPEAT_ENABLED = "false"
$env:CODEX_MEDIA_OUTPUT_DIR = if ($env:CODEX_MEDIA_OUTPUT_DIR) { $env:CODEX_MEDIA_OUTPUT_DIR } else { Join-Path $ProjectRoot "generated\codex-media" }
$env:COMFYUI_BASE_URL = $ComfyBaseUrl
$env:HOST = $HostName
$env:PORT = "$Port"

if (-not $env:FFMPEG_COMMAND) {
    $localFfmpeg = Join-Path $ProjectRoot "tools\ffmpeg\bin\ffmpeg.exe"
    if (Test-Path -LiteralPath $localFfmpeg) {
        $env:FFMPEG_COMMAND = $localFfmpeg
    }
}

Write-ServiceLog "Local life URL set to $LifeBaseUrl"
Remove-StartupTask -Name $TaskName
Stop-MatchingProcesses -Needles @(
    (Join-Path $ProjectRoot "scripts\codex-media-worker.js"),
    (Join-Path $ProjectRoot "scripts\start-codex-media-worker.ps1"),
    (Join-Path $ProjectRoot "scripts\start-codex-media-worker-hidden.vbs"),
    "scripts\codex-media-worker.js",
    "scripts\start-codex-media-worker.ps1",
    "scripts\start-codex-media-worker-hidden.vbs"
)
Stop-WorkerFromLock

$comfyPort = Get-UriPort -Url $ComfyBaseUrl -DefaultPort 8188
Stop-PortListeners -PortToStop $Port | Out-Null
Stop-PortListeners -PortToStop $comfyPort | Out-Null

Start-ComfyUI -BaseUrl $ComfyBaseUrl
Start-WebServer
Start-MediaWorker

Write-ServiceLog "Local life services start command finished. Web=http://$HostName`:$Port ComfyUI=$ComfyBaseUrl LifeBaseUrl=$LifeBaseUrl"
if (-not $NoFollowLogs) {
    Follow-Logs
}
