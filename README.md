# Codex Media Workflow

Local workflow service for generating continuous image sequences and Sora videos from user prompts.

For the no-API-key Codex relay path, see `CODEX_RELAY.md`.

## Codex relay worker

Run one queued `life` media job:

```powershell
$env:LIFE_BASE_URL="http://127.0.0.1:8080"
npm run worker:once
```

Keep polling:

```powershell
$env:LIFE_BASE_URL="http://127.0.0.1:8080"
npm run worker
```

For cloud-deployed `life`, point the worker at the public site so generated files are uploaded back to the cloud host:

```powershell
$env:LIFE_BASE_URL="https://www.liaoxianjun.com"
$env:CODEX_MEDIA_UPLOAD_TO_LIFE="true"
npm run worker
```

Install Windows startup task:

```powershell
npm run startup:install
```

Cloud startup example:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-startup-task.ps1 -LifeBaseUrl https://www.liaoxianjun.com
```

Remove it:

```powershell
npm run startup:uninstall
```

## Start

```powershell
$env:OPENAI_API_KEY="sk-..."
npm start
```

Open `http://127.0.0.1:3027`.

## What it does

- Generates image sequences frame by frame with continuity-aware prompts.
- Can keep generating until stopped.
- Can create a Sora video directly from a prompt.
- Can optionally stitch generated image frames into an MP4 if `ffmpeg` is installed.
- Stores generated files under `outputs/<jobId>/`.

## API

- `GET /api/health`
- `POST /api/workflows`
- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows/:id/extend`
- `POST /api/workflows/:id/stop`

Example:

```json
{
  "prompt": "A tiny glass city growing inside a rainy window, cinematic",
  "mode": "images",
  "imageCount": 6,
  "continuous": false,
  "size": "1024x1024",
  "quality": "medium"
}
```
