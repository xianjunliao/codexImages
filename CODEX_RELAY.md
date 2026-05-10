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

When the `life` API is protected by site access keys, put the access key in
the local `.env` file before starting the worker:

```dotenv
CODEX_MEDIA_ACCESS_KEY=life-your-access-key
```

The worker verifies this key with `POST /api/access/verify`, receives a session
token, and then sends that token as `X-Life-Access-Token` on queue, control, and
upload requests. If you already have a valid session token, you can set
`CODEX_MEDIA_SESSION_TOKEN` instead. `CODEX_MEDIA_WORKER_TOKEN` is also sent as
`X-Codex-Chat-Token` for deployments that use a dedicated worker token.

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
codexImages/generated/codex-media/<requestId>/
```

6. For `video` and `both` jobs, the worker can compose generated frames into `clip-0001.mp4` with FFmpeg.

7. If assets were written, the worker uploads them to `life` and marks the job:

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

8. Done/error jobs can be deleted from `life`. The server changes the row to `delete_requested`; the local worker deletes the matching local output folder and calls:

```text
POST /api/codex-media/jobs/{requestId}/deleted
```

## Why this is a relay

Codex subscriptions do not expose a local HTTP API that `life` can call directly. The database queue gives the browser and a local Codex CLI worker a shared task mailbox. Whether final bitmap files can be produced depends on the `codex exec` session having access to an image generation tool that can write files to disk.

## Authentication

Browser authentication does not automatically apply to the local Node worker.
The browser stores the login/session state in cookies or local storage, while
the worker is a separate process. For protected `life` deployments, configure
one of these environment values:

- `CODEX_MEDIA_ACCESS_KEY`: site access key. Recommended for local workers; the worker exchanges it for a session token on startup.
- `CODEX_MEDIA_SESSION_TOKEN`: existing `life_access_token` session token. Useful for short-lived manual runs.
- `LIFE_ACCESS_TOKEN`: backwards-compatible alias for `CODEX_MEDIA_SESSION_TOKEN`.
- `CODEX_MEDIA_WORKER_TOKEN`: optional dedicated worker token, sent as `X-Codex-Chat-Token`.

The local `.env` file is ignored by git and is loaded automatically by
`scripts/start-codex-media-worker.ps1`.

## Current UX notes

- The `life` AI chat detects likely image/video prompts and creates Codex Media jobs.
- Ambiguous long visual prompts ask for confirmation before creating a job.
- The chat task dock shows the current running media task and the next pending media task.
- The media queue page is mobile-friendly, hides completed progress bars, and previews files only after the user clicks.
