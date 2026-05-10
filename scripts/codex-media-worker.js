import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const lifeBaseUrl = (process.env.LIFE_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const publicLifeBaseUrl = (process.env.CODEX_MEDIA_PUBLIC_LIFE_BASE_URL || lifeBaseUrl).replace(/\/$/, "");
const pollMs = Number(process.env.CODEX_MEDIA_POLL_MS || 10000);
const once = process.argv.includes("--once");
const codexCommand = process.env.CODEX_COMMAND || resolveCodexCommand();
const ffmpegCommand = process.env.FFMPEG_COMMAND || resolveFfmpegCommand();
const codexTimeoutMs = Number(process.env.CODEX_MEDIA_CODEX_TIMEOUT_MS || 20 * 60 * 1000);
const outputRoot = process.env.CODEX_MEDIA_OUTPUT_DIR ||
  path.join(projectRoot, "generated", "codex-media");
const publicOutputPrefix = process.env.CODEX_MEDIA_PUBLIC_PREFIX || "";
const uploadToLife = String(process.env.CODEX_MEDIA_UPLOAD_TO_LIFE || "true").toLowerCase() !== "false";
const uploadThemeName = process.env.CODEX_MEDIA_UPLOAD_THEME || "CodexMedia";

await fs.mkdir(outputRoot, { recursive: true });

log(`Codex media worker started. life=${lifeBaseUrl} codex=${codexCommand}`);

do {
  try {
    const job = await takePendingJob();
    if (job) {
      await processJob(job);
    } else if (once) {
      log("No pending job.");
    }
  } catch (error) {
    log(`Worker error: ${errorMessage(error)}`);
  }
  if (!once) {
    await sleep(pollMs);
  }
} while (!once);

async function takePendingJob() {
  const data = await getJson(`${lifeBaseUrl}/api/codex-media/jobs?status=pending&limit=1`);
  const job = data.jobs?.[0];
  if (!job) return null;
  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(job.request_id)}/running`, {});
  return job;
}

async function processJob(job) {
  const requestId = job.request_id;
  try {
    await processJobInner(job);
  } catch (error) {
    await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/error`, {
      error: trimText(errorMessage(error), 4000)
    }).catch(() => {});
    throw error;
  }
}

async function processJobInner(job) {
  const requestId = job.request_id;
  const jobOutputDir = path.join(outputRoot, safeSegment(requestId));
  await fs.mkdir(jobOutputDir, { recursive: true });
  log(`Processing ${requestId}`);

  const promptFile = path.join(jobOutputDir, "codex-prompt.txt");
  const lastMessageFile = path.join(jobOutputDir, "codex-last-message.txt");
  await fs.writeFile(promptFile, buildCodexPrompt(job, jobOutputDir), "utf8");

  const result = await runCodex(promptFile, lastMessageFile);
  let assets = await collectAssets(jobOutputDir);
  const lastMessage = existsSync(lastMessageFile)
    ? await fs.readFile(lastMessageFile, "utf8")
    : result.stdout.trim();

  if (result.code !== 0) {
    await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/error`, {
      error: trimText(result.stderr || result.stdout || "codex exec failed", 4000)
    });
    return;
  }

  if (assets.length === 0) {
    await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/error`, {
      error: "codex exec completed but no image/video file was written to " + jobOutputDir + "\n\n" + trimText(lastMessage, 2000)
    });
    return;
  }

  assets = await maybeComposeVideo(job, jobOutputDir, assets);

  if (uploadToLife) {
    assets = await uploadAssetsToLife(assets);
  }

  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/complete`, {
    resultText: trimText(lastMessage, 4000),
    assets,
    outputDir: jobOutputDir
  });
  log(`Completed ${requestId} with ${assets.length} asset(s).`);
}

function buildCodexPrompt(job, outputDir) {
  const options = parseJson(job.options_json);
  const wantsVideo = isVideoMode(job.mode);
  const videoSeconds = parseVideoSeconds(job, options);
  const videoFrameCount = wantsVideo
    ? Math.max(Number(job.image_count || 1), Math.round(videoSeconds * 8))
    : Number(job.image_count || 1);
  return [
    "You are a local automated media generation worker for the life project.",
    "Generate the requested image or video assets, then save the final files into the exact output directory below.",
    "",
    "Hard requirements:",
    "1. Use the available image generation tool when possible.",
    "2. Save final assets in the output directory using names like frame-0001.png, frame-0002.png, or clip-0001.mp4.",
    "3. Do not claim success if no file was written. Explain the reason clearly instead.",
    "4. For continuous images, keep subject identity, scene language, camera language, and color logic consistent while changing motion, light, or composition gradually.",
    "5. Your final message must be a short JSON summary with assets and notes.",
    wantsVideo ? "6. For video mode, generate an ordered image sequence suitable for a short motion clip. Save frames as frame-0001.png, frame-0002.png, and so on. The worker will compose the MP4 after you finish." : "",
    "",
    "Prompt handling:",
    "1. Preserve the user's visual intent as faithfully as possible. Do not add new character traits, camera angles, clothing, props, or story elements unless required for safety or basic coherence.",
    "2. If the user prompt is in Chinese, understand it directly or translate it faithfully before generating. Do not generate from mojibake or corrupted text.",
    "3. Prioritize natural anatomy, stable body proportions, believable joints, correct hands and feet, balanced pose, and physically plausible fabric.",
    "4. For portrait or full-body character images, keep the face, shoulders, torso, waist, legs, and feet coherent before adding decorative background detail.",
    "5. If the prompt is suggestive, keep the result non-explicit and tasteful instead of exaggerating exposure or body emphasis.",
    "",
    `Output directory: ${outputDir}`,
    `Task ID: ${job.request_id}`,
    `Mode: ${job.mode || "images"}`,
    `Image count: ${videoFrameCount}`,
    wantsVideo ? `Target video duration: ${videoSeconds} seconds` : "",
    wantsVideo ? "Frame sequence guidance: create small, gradual motion changes between neighboring frames; avoid sudden changes in identity, pose, clothing, background, or lighting." : "",
    `Aspect ratio: ${options.aspect || ""}`,
    `Style: ${options.style || ""}`,
    `Continuity requirements: ${options.continuity || ""}`,
    "",
    "User prompt:",
    job.prompt || ""
  ].join("\n");
}

async function maybeComposeVideo(job, jobOutputDir, assets) {
  if (!isVideoMode(job.mode)) return assets;
  if (assets.some(asset => /\.mp4$/i.test(asset.fileName))) return assets;
  const imageAssets = assets.filter(asset => /\.(png|jpe?g|webp)$/i.test(asset.fileName));
  if (imageAssets.length < 2) {
    throw new Error("视频模式至少需要 2 张连续帧图片，但当前只生成了 " + imageAssets.length + " 张。");
  }
  if (!ffmpegCommand) {
    throw new Error("已生成连续帧，但这台机器没有可用的 ffmpeg，无法合成 mp4。请安装 ffmpeg 或设置 FFMPEG_COMMAND。连续帧目录：" + jobOutputDir);
  }

  const options = parseJson(job.options_json);
  const seconds = parseVideoSeconds(job, options);
  const fps = Math.max(1, Math.min(24, Math.round(imageAssets.length / seconds)));
  const orderedFrames = imageAssets.slice().sort((a, b) => a.fileName.localeCompare(b.fileName));
  const frameListFile = path.join(jobOutputDir, "ffmpeg-frames.txt");
  const clipName = "clip-0001.mp4";
  const clipPath = path.join(jobOutputDir, clipName);
  const frameList = orderedFrames.map(asset => `file '${asset.path.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(frameListFile, frameList + "\n", "utf8");

  const result = await runProcess(ffmpegCommand, [
    "-y",
    "-r", String(fps),
    "-f", "concat",
    "-safe", "0",
    "-i", frameListFile,
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-movflags", "+faststart",
    "-t", String(seconds),
    clipPath
  ], { cwd: jobOutputDir, timeoutMs: Number(process.env.CODEX_MEDIA_FFMPEG_TIMEOUT_MS || 5 * 60 * 1000) });

  if (result.code !== 0 || !existsSync(clipPath)) {
    throw new Error("ffmpeg 合成视频失败：" + trimText(result.stderr || result.stdout, 2000));
  }

  const stat = await fs.stat(clipPath);
  const clipAsset = {
    fileName: clipName,
    path: clipPath,
    size: stat.size,
    url: buildLocalAssetUrl(jobOutputDir, clipName),
    localUrl: buildLocalAssetUrl(jobOutputDir, clipName),
    generatedFromFrames: orderedFrames.length,
    durationSeconds: seconds,
    fps
  };

  if (String(job.mode || "").toLowerCase() === "video") {
    return [clipAsset];
  }
  return [...assets, clipAsset];
}

async function runCodex(promptFile, lastMessageFile) {
  return new Promise((resolve) => {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C", projectRoot,
      "-s", "workspace-write",
      "--add-dir", outputRoot,
      "--output-last-message", lastMessageFile,
      "-"
    ];
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(codexCommand, args, {
        cwd: projectRoot,
        windowsHide: true,
        shell: /\.cmd$/i.test(codexCommand),
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ code: 1, stdout, stderr: errorMessage(error) });
      return;
    }

    const finish = (code, extraStderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr: stderr + extraStderr });
    };
    const timeout = setTimeout(() => {
      const message = `codex exec timed out after ${Math.round(codexTimeoutMs / 1000)} seconds`;
      try {
        child.kill();
      } catch {}
      finish(1, message);
    }, codexTimeoutMs);

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => finish(1, errorMessage(error)));
    child.on("close", code => finish(code));
    fs.readFile(promptFile, "utf8")
      .then(text => {
        child.stdin.write(text);
        child.stdin.end();
      })
      .catch(error => {
        child.stdin.write("Failed to read prompt: " + errorMessage(error));
        child.stdin.end();
      });
  });
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || projectRoot,
        windowsHide: true,
        shell: /\.cmd$/i.test(command),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ code: 1, stdout, stderr: errorMessage(error) });
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(1, `process timed out after ${Math.round((options.timeoutMs || 60000) / 1000)} seconds`);
    }, options.timeoutMs || 60000);
    const finish = (code, extraStderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr: stderr + extraStderr });
    };
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => finish(1, errorMessage(error)));
    child.on("close", code => finish(code));
  });
}

async function collectAssets(dir) {
  const files = await fs.readdir(dir, { withFileTypes: true });
  const assetNames = files
    .filter(file => file.isFile())
    .map(file => file.name)
    .filter(name => /\.(png|jpe?g|webp|gif|mp4)$/i.test(name))
    .sort();
  const assets = [];
  for (const name of assetNames) {
    const assetPath = path.join(dir, name);
    const stat = await fs.stat(assetPath).catch(() => null);
    assets.push({
      fileName: name,
      path: assetPath,
      size: stat?.size || 0,
      url: buildLocalAssetUrl(dir, name),
      localUrl: buildLocalAssetUrl(dir, name)
    });
  }
  return assets;
}

async function uploadAssetsToLife(assets) {
  const uploaded = [];
  for (const asset of assets) {
    try {
      const buffer = await fs.readFile(asset.path);
      const formData = new FormData();
      formData.append("file", new Blob([buffer], { type: contentType(asset.fileName) }), asset.fileName);
      const uploadUrl = `${lifeBaseUrl}/upload/to?themeName=${encodeURIComponent(uploadThemeName)}`;
      const response = await fetch(uploadUrl, { method: "POST", body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || Number(data.status) !== 200) {
        throw new Error(data.message || `upload failed: ${response.status}`);
      }
      const downloadId = data.data?.downloadId || "";
      uploaded.push({
        ...asset,
        downloadId,
        uploaded: true,
        url: downloadId ? `${publicLifeBaseUrl}/download/to?id=${encodeURIComponent(downloadId)}` : asset.url,
        playUrl: downloadId ? `${publicLifeBaseUrl}/download/play?id=${encodeURIComponent(downloadId)}` : ""
      });
    } catch (error) {
      uploaded.push({
        ...asset,
        uploaded: false,
        uploadError: errorMessage(error)
      });
    }
  }
  return uploaded;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.success === false || data.ok === false) {
    throw new Error(data.error || data.msg || `GET failed: ${response.status}`);
  }
  return data;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json();
  if (!response.ok || data.success === false || data.ok === false) {
    throw new Error(data.error || data.msg || `POST failed: ${response.status}`);
  }
  return data;
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function safeSegment(value) {
  return String(value || "job").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function trimText(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : value.slice(0, max) + "\n...";
}

function contentType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function isVideoMode(mode) {
  const value = String(mode || "").toLowerCase();
  return value === "video" || value === "both";
}

function parseVideoSeconds(job, options = {}) {
  const candidates = [
    options.duration,
    options.durationSeconds,
    options.seconds,
    job.prompt
  ].map(value => String(value || ""));
  for (const value of candidates) {
    const rangeMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:~|-|到|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|s|sec|second)?/i);
    if (rangeMatch) {
      return clampSeconds(Number(rangeMatch[2]));
    }
    const match = value.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec|second)/i);
    if (match) {
      return clampSeconds(Number(match[1]));
    }
  }
  return 3;
}

function clampSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) return 3;
  return Math.max(1, Math.min(6, value));
}

function buildLocalAssetUrl(dir, fileName) {
  if (!publicOutputPrefix) {
    return "";
  }
  return `${publicOutputPrefix.replace(/\/$/, "")}/${safeSegment(path.basename(dir))}/${encodeURIComponent(fileName)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function errorMessage(error) {
  return error?.message || String(error || "unknown error");
}

function resolveCodexCommand() {
  const candidates = [
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "codex.cmd") : "",
    "E:\\nvm4w\\nodejs\\codex.cmd",
    "C:\\Program Files\\nodejs\\codex.cmd",
    "codex"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "codex" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

function resolveFfmpegCommand() {
  const candidates = [
    "ffmpeg",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "E:\\ffmpeg\\bin\\ffmpeg.exe"
  ];
  for (const candidate of candidates) {
    if (candidate === "ffmpeg" && spawnSync(candidate, ["-version"], { windowsHide: true }).status === 0) {
      return candidate;
    }
    if (candidate !== "ffmpeg" && existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}
