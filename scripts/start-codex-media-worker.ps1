param(
    [string]$LifeBaseUrl = "",
    [string]$ProjectRoot = "e:\works\project\codexImages"
)

$ErrorActionPreference = "Continue"
$logDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "codex-media-worker.log"
$envFile = Join-Path $ProjectRoot ".env"

function Write-WorkerLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

Write-WorkerLog "Starting Codex Media worker loop. LifeBaseUrl=$LifeBaseUrl ProjectRoot=$ProjectRoot"

if (Test-Path -LiteralPath $envFile) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $name, $value = $line.Split("=", 2)
            if ($name) {
                $cleanName = $name.Trim().TrimStart([char]0xFEFF)
                [Environment]::SetEnvironmentVariable($cleanName, $value.Trim(), "Process")
            }
        }
    }
    Write-WorkerLog "Loaded worker environment from .env"
}

while ($true) {
    try {
        Set-Location -LiteralPath $ProjectRoot
        $resolvedLifeBaseUrl = if (-not [string]::IsNullOrWhiteSpace($LifeBaseUrl)) {
            $LifeBaseUrl
        } elseif (-not [string]::IsNullOrWhiteSpace($env:LIFE_BASE_URL)) {
            $env:LIFE_BASE_URL
        } else {
            "http://127.0.0.1:8080"
        }
        $env:LIFE_BASE_URL = $resolvedLifeBaseUrl
        $env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL = if ($env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL) { $env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL } else { $resolvedLifeBaseUrl }
        $env:CODEX_MEDIA_POLL_MS = if ($env:CODEX_MEDIA_POLL_MS) { $env:CODEX_MEDIA_POLL_MS } else { "10000" }
        $env:CODEX_MEDIA_UPLOAD_TO_LIFE = if ($env:CODEX_MEDIA_UPLOAD_TO_LIFE) { $env:CODEX_MEDIA_UPLOAD_TO_LIFE } else { "true" }
        $env:CODEX_MEDIA_OUTPUT_DIR = if ($env:CODEX_MEDIA_OUTPUT_DIR) { $env:CODEX_MEDIA_OUTPUT_DIR } else { Join-Path $ProjectRoot "generated\codex-media" }
        if (-not $env:FFMPEG_COMMAND) {
            $localFfmpeg = Join-Path $ProjectRoot "tools\ffmpeg\bin\ffmpeg.exe"
            if (Test-Path $localFfmpeg) {
                $env:FFMPEG_COMMAND = $localFfmpeg
            }
        }
        if (-not $env:CODEX_COMMAND) {
            $codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue
            if ($codexCommand) {
                $env:CODEX_COMMAND = $codexCommand.Source
            } elseif (Test-Path "E:\nvm4w\nodejs\codex.cmd") {
                $env:CODEX_COMMAND = "E:\nvm4w\nodejs\codex.cmd"
            }
        }
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $node) {
            $node = Get-Command node -ErrorAction Stop
        }
        Write-WorkerLog "Launching node scripts/codex-media-worker.js"
        & $node.Source (Join-Path $ProjectRoot "scripts\codex-media-worker.js") *>> $logFile
        Write-WorkerLog "worker exited with code $LASTEXITCODE; restarting in 10 seconds"
    } catch {
        Write-WorkerLog ("worker launch failed: " + $_.Exception.Message)
    }
    Start-Sleep -Seconds 10
}
