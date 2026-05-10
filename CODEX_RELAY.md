# Codex Media Relay

This project can be used without an OpenAI API key through the `life` MySQL queue.

## Human workflow

1. Open `life` page `/lxj/pages/codex-media.html`.
2. Submit a prompt. The page writes a row into `codex_media_jobs`.
3. Start the local worker:

```powershell
$env:LIFE_BASE_URL="http://127.0.0.1:8007"
npm run worker
```

Or run one job:

```powershell
$env:LIFE_BASE_URL="http://127.0.0.1:8007"
npm run worker:once
```

4. The worker reads the latest pending job from:

```text
GET /api/codex-media/jobs?status=pending&limit=1
```

5. The worker opens `codex exec`, passes the prompt, asks Codex to save generated assets under:

```text
life/src/main/resources/static/lxj/generated/codex-media/<requestId>/
```

6. If assets were written, the worker marks the job:

```text
POST /api/codex-media/jobs/{requestId}/complete
```

Payload:

```json
{
  "resultText": "Generated in Codex conversation.",
  "assets": [],
  "notes": "Image files are visible in the Codex thread."
}
```

## Why this is a relay

Codex subscriptions do not expose a local HTTP API that `life` can call directly. The database queue gives the browser and a local Codex CLI worker a shared task mailbox. Whether final bitmap files can be produced depends on the `codex exec` session having access to an image generation tool that can write files to disk.
