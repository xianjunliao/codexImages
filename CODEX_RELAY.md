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
`CODEX_MEDIA_SESSION_TOKEN` instead. `CODEX_MEDIA_WORKER_TOKEN` is sent as
`X-Codex-Chat-Token` only when a deployment uses a dedicated media worker token.

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

Video frame controls can be tuned from the worker environment:

```dotenv
CODEX_MEDIA_VIDEO_SOURCE_FPS=24
CODEX_MEDIA_VIDEO_OUTPUT_FPS=24
CODEX_MEDIA_VIDEO_SEGMENT_FRAMES=12
CODEX_MEDIA_VIDEO_CONCURRENCY=1
CODEX_MEDIA_VIDEO_INTERPOLATE=true
```

- `SOURCE_FPS` controls how many real image frames Codex is asked to generate per second.
- `OUTPUT_FPS` controls the MP4 frame rate. Keep this at `24` for normal video playback.
- `SEGMENT_FRAMES` splits large frame requests into smaller Codex runs.
- `CONCURRENCY` is kept at `1` for video continuity. Frame segments run sequentially so each segment can continue from the previous frames.
- `INTERPOLATE=true` uses FFmpeg motion interpolation when the output FPS is higher than the source FPS.

The worker also understands prompt text like `24帧/秒` or `0.3秒8张图` and converts that into a source frame density. Source frame requests are capped at 240 frames per job to avoid runaway local runs.

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

## ComfyUI workflow parameter isolation

For `life` jobs with `mediaProvider: comfyui`, the local worker treats the
selected ComfyUI workflow file as the source of truth for generation settings.
Job metadata such as `aspect`, `fps`, `frames`, `steps`, `size`, and
`negativePrompt` is left visible in `life` for audit/debugging, but is not used
to overwrite graph values before submitting to ComfyUI. An explicitly requested
duration such as "6 seconds" or "6s" is the exception: the worker keeps the
workflow's fps/frame-rate settings and only adjusts the workflow video latent
frame count to `durationSeconds * workflowFps`.

The worker only injects runtime values required to connect the job to the
workflow: the positive prompt, optional explicit-duration frame count, output
filename prefix, and an uploaded input image for image-to-video workflows. Each
submitted ComfyUI prompt graph is saved as `comfyui-prompt.json` in the local
job output directory so the exact payload can be inspected after a run. Restart
`codex-media-worker` after code changes; already-running Node worker processes
keep the old logic in memory.

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
