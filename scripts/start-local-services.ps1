param(
    [string]$LifeBaseUrl = "",
    [string]$ProjectRoot = "e:\works\project\codexImages"
)

$ErrorActionPreference = "Continue"
$logDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "local-services.log"
$envFile = Join-Path $ProjectRoot ".env"

function Write-ServiceLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
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
    param([int]$Port)
    try {
        return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

function Stop-PortListeners {
    param(
        [int]$Port,
        [int]$WaitSeconds = 10
    )
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) {
        return $true
    }

    $pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -ne $PID })
    if ($pids.Count -eq 0) {
        Write-ServiceLog "Port $Port is busy, but no killable listener process was found."
        return $false
    }

    foreach ($listenerPid in $pids) {
        try {
            $process = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
            $processName = if ($process) { $process.ProcessName } else { "unknown" }
            Write-ServiceLog "Port $Port is busy. Stopping PID $listenerPid ($processName)."
            Stop-Process -Id $listenerPid -Force -ErrorAction Stop
        } catch {
            Write-ServiceLog ("Failed to stop PID $listenerPid on port ${Port}: " + $_.Exception.Message)
        }
    }

    for ($i = 0; $i -lt $WaitSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-PortListening -Port $Port)) {
            Write-ServiceLog "Port $Port is free."
            return $true
        }
    }

    Write-ServiceLog "Port $Port is still busy after stopping listener processes."
    return $false
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

function Test-WorkerRunning {
    $needle = (Join-Path $ProjectRoot "scripts\codex-media-worker.js").ToLowerInvariant()
    $lockFile = Join-Path $logDir "codex-media-worker.lock"
    if (Test-Path -LiteralPath $lockFile) {
        try {
            $lock = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $lockPid = [int]($lock.pid)
            if ($lockPid -gt 0) {
                $lockProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $lockPid" -ErrorAction SilentlyContinue
                $lockCommandLine = [string]$lockProcess.CommandLine
                if ($lockProcess -and [string]$lockProcess.Name -ieq "node.exe" -and $lockCommandLine.ToLowerInvariant().Contains($needle)) {
                    return $true
                }
            }
        } catch {
            Write-ServiceLog ("Could not read worker lock: " + $_.Exception.Message)
        }
    }
    try {
        $processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction Stop
        foreach ($process in $processes) {
            $commandLine = [string]$process.CommandLine
            if ($commandLine.ToLowerInvariant().Contains($needle)) {
                return $true
            }
        }
    } catch {
        Write-ServiceLog ("Could not inspect node processes: " + $_.Exception.Message)
    }
    return $false
}

function Resolve-LifeBaseUrl {
    if (-not [string]::IsNullOrWhiteSpace($LifeBaseUrl)) {
        return $LifeBaseUrl
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LIFE_BASE_URL)) {
        return $env:LIFE_BASE_URL
    }
    return "http://127.0.0.1:8080"
}

function Start-ComfyUI {
    $baseUrl = ($env:COMFYUI_BASE_URL)
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $baseUrl = "http://127.0.0.1:8188"
    }
    $baseUrl = $baseUrl.TrimEnd("/")
    $uri = [Uri]$baseUrl
    $hostName = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
    $port = if ($uri.Port -gt 0) { $uri.Port } else { 8188 }

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

    if (Test-PortListening -Port $port) {
        if (-not (Stop-PortListeners -Port $port)) {
            Write-ServiceLog "ComfyUI cannot start because port $port is still occupied."
            return
        }
    }

    $outFile = Join-Path $logDir "comfyui.out.log"
    $errFile = Join-Path $logDir "comfyui.err.log"
    Write-ServiceLog "Starting ComfyUI from $root at $baseUrl with python=$python"
    Start-Process -FilePath $python `
        -ArgumentList "main.py", "--listen", $hostName, "--port", "$port" `
        -WorkingDirectory $root `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden `
        -PassThru | Out-Null

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Test-HttpOk "$baseUrl/system_stats") {
            Write-ServiceLog "ComfyUI started at $baseUrl"
            return
        }
    }
    Write-ServiceLog "ComfyUI did not become healthy yet. Check $errFile"
}

function Start-WebServer {
    $hostName = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }
    $port = if ($env:PORT) { [int]$env:PORT } else { 3027 }
    $url = "http://$hostName`:$port"
    if (Test-HttpOk $url) {
        Write-ServiceLog "Workspace web server is already running at $url"
        return
    }
    $node = Get-NodeCommand
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
}

function Start-MediaWorker {
    if (Test-WorkerRunning) {
        Write-ServiceLog "Codex media worker is already running."
        return
    }
    $outFile = Join-Path $logDir "worker.out.log"
    $errFile = Join-Path $logDir "worker.err.log"
    $node = Get-NodeCommand
    $resolvedLifeBaseUrl = Resolve-LifeBaseUrl
    $env:LIFE_BASE_URL = $resolvedLifeBaseUrl
    $env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL = if ($env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL) { $env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL } else { $resolvedLifeBaseUrl }
    $env:CODEX_MEDIA_POLL_MS = if ($env:CODEX_MEDIA_POLL_MS) { $env:CODEX_MEDIA_POLL_MS } else { "10000" }
    $env:CODEX_MEDIA_UPLOAD_TO_LIFE = if ($env:CODEX_MEDIA_UPLOAD_TO_LIFE) { $env:CODEX_MEDIA_UPLOAD_TO_LIFE } else { "true" }
    $env:CODEX_MEDIA_OUTPUT_DIR = if ($env:CODEX_MEDIA_OUTPUT_DIR) { $env:CODEX_MEDIA_OUTPUT_DIR } else { Join-Path $ProjectRoot "generated\codex-media" }
    Write-ServiceLog "Starting Codex media worker. LifeBaseUrl=$resolvedLifeBaseUrl"
    Start-Process -FilePath $node `
        -ArgumentList "scripts\codex-media-worker.js" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden `
        -PassThru | Out-Null
}

Write-ServiceLog "Starting local services. ProjectRoot=$ProjectRoot"
Set-Location -LiteralPath $ProjectRoot
Load-DotEnv
Start-ComfyUI
Start-WebServer
Start-MediaWorker
Write-ServiceLog "Local services start command finished."
