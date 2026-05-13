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
const deletePollMs = Number(process.env.CODEX_MEDIA_DELETE_POLL_MS || 5000);
const once = process.argv.includes("--once");
const noDeleteSweeper = process.argv.includes("--no-delete-sweeper");
const codexCommand = process.env.CODEX_COMMAND || resolveCodexCommand();
const ffmpegCommand = process.env.FFMPEG_COMMAND || resolveFfmpegCommand();
const codexTimeoutMs = Number(process.env.CODEX_MEDIA_CODEX_TIMEOUT_MS || 20 * 60 * 1000);
const outputRoot = process.env.CODEX_MEDIA_OUTPUT_DIR ||
  path.join(projectRoot, "generated", "codex-media");
const publicOutputPrefix = process.env.CODEX_MEDIA_PUBLIC_PREFIX || "";
const uploadToLife = String(process.env.CODEX_MEDIA_UPLOAD_TO_LIFE || "true").toLowerCase() !== "false";
const uploadThemeName = process.env.CODEX_MEDIA_UPLOAD_THEME || "CodexMedia";
const lifeAccessKey = (process.env.CODEX_MEDIA_ACCESS_KEY || "").trim();
let lifeAccessToken = (process.env.CODEX_MEDIA_SESSION_TOKEN || process.env.LIFE_ACCESS_TOKEN || "").trim();
const workerToken = (process.env.CODEX_MEDIA_WORKER_TOKEN || process.env.CODEX_CHAT_WORKER_TOKEN || "").trim();
const defaultAspectRatio = "9:16";
const defaultVideoSourceFps = numberEnv("CODEX_MEDIA_VIDEO_SOURCE_FPS", 24);
const defaultVideoOutputFps = numberEnv("CODEX_MEDIA_VIDEO_OUTPUT_FPS", 24);
const defaultVideoSegmentFrames = numberEnv("CODEX_MEDIA_VIDEO_SEGMENT_FRAMES", 12);
const defaultVideoConcurrency = numberEnv("CODEX_MEDIA_VIDEO_CONCURRENCY", 1);
const enableVideoInterpolation = String(process.env.CODEX_MEDIA_VIDEO_INTERPOLATE || "true").toLowerCase() !== "false";

await fs.mkdir(outputRoot, { recursive: true });
await ensureLifeAuth();

log(`Codex media worker started. life=${lifeBaseUrl} codex=${codexCommand}`);

let deleteSweepBusy = false;
if (!once && !noDeleteSweeper) {
  setInterval(() => {
    sweepDeleteRequestedJob().catch((error) => {
      log(`Delete sweeper error: ${errorMessage(error)}`);
    });
  }, deletePollMs);
}

do {
  try {
    if (await sweepDeleteRequestedJob()) {
      continue;
    }
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
  await postJobProgress(job.request_id, {
    phase: "queued",
    progressText: "任务已领取，准备生成媒体。"
  });
  return job;
}

async function takeDeleteRequestedJob() {
  const data = await getJson(`${lifeBaseUrl}/api/codex-media/jobs?status=delete_requested&limit=1`);
  return data.jobs?.[0] || null;
}

async function sweepDeleteRequestedJob() {
  if (deleteSweepBusy) return false;
  deleteSweepBusy = true;
  try {
    const deleteJob = await takeDeleteRequestedJob();
    if (!deleteJob) return false;
    await processDeleteJob(deleteJob);
    return true;
  } finally {
    deleteSweepBusy = false;
  }
}

async function processDeleteJob(job) {
  const requestId = job.request_id;
  const targets = resolveDeleteTargets(job);
  for (const target of targets) {
    await removeLocalOutputDir(target);
  }
  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/deleted`, {
    deletedLocalPaths: targets
  });
  log(`Deleted local files for ${requestId}: ${targets.join(", ") || "none"}`);
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
  if (looksLikeMojibake(job.prompt)) {
    throw new Error("任务提示词疑似编码损坏，已拒绝生成。请修复 life 请求/数据库编码后重新提交原始中文提示词。");
  }
  const jobOutputDir = path.join(outputRoot, safeSegment(requestId));
  await fs.mkdir(jobOutputDir, { recursive: true });
  log(`Processing ${requestId}`);

  const promptFile = path.join(jobOutputDir, "codex-prompt.txt");
  const lastMessageFile = path.join(jobOutputDir, "codex-last-message.txt");
  await fs.writeFile(promptFile, buildCodexPrompt(job, jobOutputDir), "utf8");
  const settings = parseVideoSettings(job, parseJson(job.options_json));
  if (settings.wantsVideo) {
    const segments = buildFrameSegments(settings.frameCount, settings.segmentFrames);
    await postVideoProgress(job, settings, {
      phase: "starting",
      completedFrames: 0,
      completedSegments: 0,
      totalSegments: segments.length,
      startedAt: Date.now(),
      extraText: "准备生成连续帧。"
    });
  }

  const result = await runCodexForJob(job, jobOutputDir, promptFile, lastMessageFile);
  if (result.controlStatus === "paused") {
    await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/paused`, {
      reason: "Paused by user"
    }).catch(() => {});
    log(`Paused ${requestId}`);
    return;
  }
  if (result.controlStatus === "canceled") {
    await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/canceled`, {
      reason: "Canceled by user"
    }).catch(() => {});
    log(`Canceled ${requestId}`);
    return;
  }
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

  assets = filterFinalAssetsForJob(job, assets);

  if (uploadToLife) {
    if (settings.wantsVideo) {
      await postVideoProgress(job, settings, {
        phase: "uploading",
        completedFrames: settings.frameCount,
        completedSegments: buildFrameSegments(settings.frameCount, settings.segmentFrames).length,
        totalSegments: buildFrameSegments(settings.frameCount, settings.segmentFrames).length,
        extraText: "视频已合成，正在上传。"
      });
    }
    assets = await uploadAssetsToLife(assets);
  }

  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/complete`, {
    resultText: trimText(lastMessage, 4000),
    assets,
    outputDir: jobOutputDir
  });
  log(`Completed ${requestId} with ${assets.length} asset(s).`);
}

async function runCodexForJob(job, jobOutputDir, promptFile, lastMessageFile) {
  const settings = parseVideoSettings(job, parseJson(job.options_json));
  if (!settings.wantsVideo || settings.frameCount <= settings.segmentFrames) {
    return runCodex(promptFile, lastMessageFile, job);
  }

  const segmentDir = path.join(jobOutputDir, "codex-segments");
  await fs.mkdir(segmentDir, { recursive: true });
  const segments = buildFrameSegments(settings.frameCount, settings.segmentFrames);
  log(`Video ${job.request_id}: generating ${settings.frameCount} source frames in ${segments.length} sequential segment(s), concurrency=${settings.concurrency}.`);
  const startedAt = Date.now();
  let completedSegments = 0;
  let completedFrames = 0;
  await postVideoProgress(job, settings, {
    phase: "generating_frames",
    completedFrames,
    completedSegments,
    totalSegments: segments.length,
    startedAt,
    extraText: `开始分段生成：共 ${segments.length} 段，并发 ${settings.concurrency}。`
  });

  const results = await runLimited(segments, 1, async (segment, index) => {
    const segmentPromptFile = path.join(segmentDir, `segment-${String(index + 1).padStart(3, "0")}-prompt.txt`);
    const segmentMessageFile = path.join(segmentDir, `segment-${String(index + 1).padStart(3, "0")}-last-message.txt`);
    await fs.writeFile(segmentPromptFile, buildCodexPrompt(job, jobOutputDir, segment, settings), "utf8");
    await postVideoProgress(job, settings, {
      phase: "generating_frames",
      completedFrames,
      completedSegments,
      totalSegments: segments.length,
      activeSegment: index + 1,
      activeRange: `${segment.start}-${segment.end}`,
      startedAt,
      extraText: `正在生成第 ${index + 1} 段：帧 ${segment.start}-${segment.end}。`
    });
    const result = await runCodex(segmentPromptFile, segmentMessageFile, job);
    if (result.code === 0 && !result.controlStatus) {
      completedSegments += 1;
      completedFrames += segment.end - segment.start + 1;
      await postVideoProgress(job, settings, {
        phase: "generating_frames",
        completedFrames,
        completedSegments,
        totalSegments: segments.length,
        startedAt,
        extraText: `已完成第 ${index + 1} 段：帧 ${segment.start}-${segment.end}。`
      });
    }
    return result;
  });

  const failed = results.find(result => result.code !== 0 || result.controlStatus);
  const combinedStdout = results.map(result => result.stdout || "").filter(Boolean).join("\n");
  const combinedStderr = results.map(result => result.stderr || "").filter(Boolean).join("\n");
  if (failed) {
    return {
      code: failed.code,
      stdout: combinedStdout,
      stderr: combinedStderr || failed.stderr,
      controlStatus: failed.controlStatus
    };
  }

  const summary = {
    assets: [],
    notes: `Generated ${settings.frameCount} source frames in ${segments.length} sequential segment(s).`
  };
  await fs.writeFile(lastMessageFile, JSON.stringify(summary, null, 2), "utf8");
  return { code: 0, stdout: combinedStdout, stderr: combinedStderr };
}

function buildCodexPrompt(job, outputDir, frameSegment = null, videoSettings = null) {
  const options = parseJson(job.options_json);
  const aspectRatio = String(options.aspect || "").trim() || defaultAspectRatio;
  const settings = videoSettings || parseVideoSettings(job, options);
  const wantsVideo = settings.wantsVideo;
  const videoSeconds = settings.seconds;
  const videoFrameCount = wantsVideo ? settings.frameCount : Number(job.image_count || 1);
  const frameRange = frameSegment
    ? `Frames for this Codex run: ${frameSegment.start}-${frameSegment.end} of ${settings.frameCount}. Save only these frame numbers.`
    : "";
  const previousFrameGuidance = frameSegment && frameSegment.start > 1
    ? `Before generating this segment, inspect the existing previous frames in the output directory, especially frame-${String(frameSegment.start - 1).padStart(4, "0")}.png, and continue the same shot from that exact visual state.`
    : "";
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
    wantsVideo ? "7. Every frame filename must match its global frame number exactly, even when this is a segmented run. Example: frame-0013.png for global frame 13." : "",
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
    wantsVideo ? `Source frame rate: ${settings.sourceFps} fps` : "",
    wantsVideo ? `Output video frame rate: ${settings.outputFps} fps` : "",
    frameRange,
    previousFrameGuidance,
    wantsVideo ? "Frame sequence guidance: create small, gradual motion changes between neighboring frames; avoid sudden changes in identity, pose, clothing, background, or lighting." : "",
    wantsVideo ? "Motion planning: treat the whole clip as one continuous shot. Use each frame's global index to advance the action by a tiny amount; keep lens, subject identity, clothing, background layout, and lighting locked unless the user requested a change." : "",
    `Aspect ratio: ${aspectRatio}`,
    `Style: ${options.style || ""}`,
    `Continuity requirements: ${options.continuity || ""}`,
    "",
    "User prompt:",
    job.prompt || ""
  ].join("\n");
}

async function maybeComposeVideo(job, jobOutputDir, assets) {
  if (!isVideoMode(job.mode)) return assets;
  if (assets.some(asset => /\.mp4$/i.test(asset.fileName))) return filterFinalAssetsForJob(job, assets);
  const imageAssets = assets.filter(asset => /\.(png|jpe?g|webp)$/i.test(asset.fileName));
  if (imageAssets.length < 2) {
    throw new Error("视频模式至少需要 2 张连续帧图片，但当前只生成了 " + imageAssets.length + " 张。");
  }
  if (!ffmpegCommand) {
    throw new Error("已生成连续帧，但这台机器没有可用的 ffmpeg，无法合成 mp4。请安装 ffmpeg 或设置 FFMPEG_COMMAND。连续帧目录：" + jobOutputDir);
  }

  const options = parseJson(job.options_json);
  const settings = parseVideoSettings(job, options);
  const seconds = settings.seconds;
  const sourceFps = Math.max(1, Math.round(imageAssets.length / seconds));
  const outputFps = settings.outputFps;
  const orderedFrames = imageAssets.slice().sort((a, b) => a.fileName.localeCompare(b.fileName));
  const frameListFile = path.join(jobOutputDir, "ffmpeg-frames.txt");
  const clipName = "clip-0001.mp4";
  const clipPath = path.join(jobOutputDir, clipName);
  const frameDuration = 1 / sourceFps;
  const frameList = orderedFrames.flatMap((asset, index) => {
    const escapedPath = asset.path.replace(/'/g, "'\\''");
    const lines = [`file '${escapedPath}'`];
    if (index < orderedFrames.length - 1) {
      lines.push(`duration ${frameDuration.toFixed(6)}`);
    }
    return lines;
  }).join("\n");
  await fs.writeFile(frameListFile, frameList + "\n", "utf8");
  await postVideoProgress(job, settings, {
    phase: "composing",
    completedFrames: orderedFrames.length,
    completedSegments: buildFrameSegments(settings.frameCount, settings.segmentFrames).length,
    totalSegments: buildFrameSegments(settings.frameCount, settings.segmentFrames).length,
    extraText: `连续帧已生成：${orderedFrames.length} / ${settings.frameCount}，正在合成 MP4。`
  });
  const filters = [
    enableVideoInterpolation && outputFps > sourceFps
      ? `minterpolate=fps=${outputFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
      : `fps=${outputFps}`,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "format=yuv420p"
  ];

  const result = await runProcess(ffmpegCommand, [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", frameListFile,
    "-vf", filters.join(","),
    "-r", String(outputFps),
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
    sourceFps,
    fps: outputFps,
    interpolated: enableVideoInterpolation && outputFps > sourceFps
  };

  return filterFinalAssetsForJob(job, [...assets, clipAsset]);
}

function filterFinalAssetsForJob(job, assets) {
  if (isVideoMode(job.mode)) {
    const videos = assets.filter(asset => /\.mp4$/i.test(asset.fileName || ""));
    return videos.length > 0 ? videos : assets;
  }
  return assets;
}

async function runCodex(promptFile, lastMessageFile, job) {
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

    const finish = (code, extraStderr = "", controlStatus = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(controlPoll);
      resolve({ code, stdout, stderr: stderr + extraStderr, controlStatus });
    };
    const timeout = setTimeout(() => {
      const message = `codex exec timed out after ${Math.round(codexTimeoutMs / 1000)} seconds`;
      terminateProcessTree(child);
      finish(1, message);
    }, codexTimeoutMs);
    const controlPoll = setInterval(async () => {
      if (!job?.request_id || settled) return;
      try {
        const data = await getJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(job.request_id)}`);
        const status = String(data.job?.status || "").toLowerCase();
        if (status === "pause_requested") {
          terminateProcessTree(child);
          finish(130, "codex exec paused by user", "paused");
        } else if (status === "cancel_requested") {
          terminateProcessTree(child);
          finish(130, "codex exec canceled by user", "canceled");
        }
      } catch {}
    }, 5000);

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
      const response = await fetch(uploadUrl, { method: "POST", headers: authHeaders(), body: formData });
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

function resolveDeleteTargets(job) {
  const requestId = safeSegment(job?.request_id || "");
  const targets = new Set();
  const result = parseJson(job?.result_json);
  const outputDir = result.outputDir || result.output_dir || "";
  if (outputDir) {
    targets.add(path.resolve(outputDir));
  }
  if (requestId) {
    targets.add(path.resolve(outputRoot, requestId));
  }
  if (Array.isArray(result.assets)) {
    for (const asset of result.assets) {
      const assetPath = asset?.path ? path.resolve(String(asset.path)) : "";
      if (assetPath && isWithinOutputRoot(assetPath)) {
        targets.add(path.dirname(assetPath));
      }
    }
  }
  return Array.from(targets).filter(isWithinOutputRoot);
}

async function removeLocalOutputDir(target) {
  if (!target || !isWithinOutputRoot(target)) {
    throw new Error("Refusing to delete path outside output root: " + target);
  }
  await fs.rm(target, { recursive: true, force: true });
}

function isWithinOutputRoot(target) {
  const root = path.resolve(outputRoot);
  const resolved = path.resolve(target || "");
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function getJson(url) {
  const response = await fetch(url, { headers: authHeaders() });
  const data = await response.json();
  if (!response.ok || data.success === false || data.ok === false) {
    throw new Error(data.error || data.msg || `GET failed: ${response.status}`);
  }
  return data;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload || {})
  });
  const data = await response.json();
  if (!response.ok || data.success === false || data.ok === false) {
    throw new Error(data.error || data.msg || `POST failed: ${response.status}`);
  }
  return data;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (lifeAccessToken) {
    headers["X-Life-Access-Token"] = lifeAccessToken;
  }
  if (workerToken) {
    headers["X-Codex-Chat-Token"] = workerToken;
  }
  return headers;
}

async function postJobProgress(requestId, progress) {
  if (!requestId) return;
  const payload = {
    ...progress,
    resultText: progress.progressText || progress.resultText || ""
  };
  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/running`, payload).catch((error) => {
    log(`Progress update failed for ${requestId}: ${errorMessage(error)}`);
  });
}

async function postVideoProgress(job, settings, progress) {
  const completedFrames = Math.max(0, Math.min(settings.frameCount, Number(progress.completedFrames || 0)));
  const totalFrames = settings.frameCount;
  const completedSegments = Math.max(0, Number(progress.completedSegments || 0));
  const totalSegments = Math.max(1, Number(progress.totalSegments || buildFrameSegments(totalFrames, settings.segmentFrames).length));
  const percent = totalFrames > 0 ? Math.round((completedFrames / totalFrames) * 100) : 0;
  const etaSeconds = estimateRemainingSeconds(progress.startedAt, completedFrames, totalFrames);
  const etaText = formatEta(etaSeconds);
  const segmentText = progress.activeSegment
    ? `当前分段：第 ${progress.activeSegment} 段，共 ${totalSegments} 段${progress.activeRange ? `（帧 ${progress.activeRange}）` : ""}`
    : `当前分段：已完成 ${completedSegments} 段，共 ${totalSegments} 段`;
  const etaLine = etaText ? `预计剩余：${etaText}` : "预计剩余：计算中";
  const progressText = [
    `视频帧生成中：${completedFrames} / ${totalFrames}`,
    segmentText,
    etaLine,
    progress.extraText || ""
  ].filter(Boolean).join("\n");

  await postJobProgress(job.request_id, {
    phase: progress.phase || "generating_frames",
    progress,
    progressPercent: percent,
    progressText,
    completedFrames,
    totalFrames,
    completedSegments,
    totalSegments,
    etaSeconds,
    sourceFps: settings.sourceFps,
    outputFps: settings.outputFps,
    durationSeconds: settings.seconds
  });
}

function estimateRemainingSeconds(startedAt, completed, total) {
  if (!startedAt || completed <= 0 || total <= completed) return null;
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  return Math.max(0, Math.round((elapsedSeconds / completed) * (total - completed)));
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `约 ${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `约 ${hours} 小时${restMinutes ? ` ${restMinutes} 分钟` : ""}`;
}

async function ensureLifeAuth() {
  if (lifeAccessToken || !lifeAccessKey) return;
  const response = await fetch(`${lifeBaseUrl}/api/access/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: lifeAccessKey })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `access verify failed: ${response.status}`);
  }
  lifeAccessToken = String(data.auth?.accessToken || "").trim();
  if (!lifeAccessToken) {
    throw new Error("access verify succeeded but no session token was returned.");
  }
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function looksLikeMojibake(text) {
  const value = String(text || "");
  if (value.length < 12) return false;
  const suspicious = value.match(/[�]|涓|鎴|鐨|绋|濂|锛|銆|€|鏃|闀|鍦|浣|姘|璧|犳|勭|熸|彉|皑/g) || [];
  return suspicious.length >= 4 || suspicious.length / Math.max(1, value.length) > 0.06;
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

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

function isVideoMode(mode) {
  const value = String(mode || "").toLowerCase();
  return value === "video" || value === "both";
}

function parseVideoSettings(job, options = {}) {
  const wantsVideo = isVideoMode(job.mode);
  const seconds = parseVideoSeconds(job, options);
  const promptFrameDensity = parsePromptFrameDensityZh(job.prompt);
  const sourceFps = clampInteger(firstFiniteNumber([
    options.sourceFps,
    options.videoSourceFps,
    options.frameFps,
    promptFrameDensity,
    options.fps,
    parsePromptNumber(job.prompt, /(?:source\s*)?fps\s*[:=]?\s*(\d+(?:\.\d+)?)/i),
    parsePromptNumber(job.prompt, /(\d+(?:\.\d+)?)\s*(?:帧|張|张)\s*(?:\/|每)?\s*(?:秒|s|sec|second)/i),
    parsePromptFrameDensity(job.prompt),
    defaultVideoSourceFps
  ]), 1, 30, 8);
  const outputFps = clampInteger(firstFiniteNumber([
    options.outputFps,
    options.videoOutputFps,
    options.renderFps,
    parsePromptOutputFps(job.prompt),
    parsePromptNumber(job.prompt, /(?:output|render)\s*fps\s*[:=]?\s*(\d+(?:\.\d+)?)/i),
    defaultVideoOutputFps
  ]), 1, 60, 24);
  const requestedFrames = Number(job.image_count || 0);
  const frameCount = wantsVideo
    ? clampInteger(Math.max(requestedFrames || 0, Math.ceil(seconds * sourceFps)), 2, 240, Math.ceil(seconds * sourceFps))
    : Math.max(1, requestedFrames || 1);
  const segmentFrames = clampInteger(firstFiniteNumber([
    options.segmentFrames,
    options.videoSegmentFrames,
    defaultVideoSegmentFrames
  ]), 1, 60, 12);
  const concurrency = clampInteger(firstFiniteNumber([
    options.concurrency,
    options.videoConcurrency,
    defaultVideoConcurrency
  ]), 1, 1, 1);
  return {
    wantsVideo,
    seconds,
    sourceFps,
    outputFps,
    frameCount,
    segmentFrames,
    concurrency
  };
}

function buildFrameSegments(frameCount, segmentFrames) {
  const segments = [];
  for (let start = 1; start <= frameCount; start += segmentFrames) {
    segments.push({
      start,
      end: Math.min(frameCount, start + segmentFrames - 1)
    });
  }
  return segments;
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function parseVideoSeconds(job, options = {}) {
  const candidates = [
    options.duration,
    options.durationSeconds,
    options.seconds,
    job.prompt
  ].map(value => String(value || ""));
  for (const value of candidates) {
    const zhRangeMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:~|-|到|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|s|sec|second)?/i);
    if (zhRangeMatch) {
      return clampSeconds(Number(zhRangeMatch[2]));
    }
    const zhMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec|second)/i);
    if (zhMatch) {
      return clampSeconds(Number(zhMatch[1]));
    }
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

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function parsePromptNumber(prompt, pattern) {
  const match = String(prompt || "").match(pattern);
  return match ? Number(match[1]) : NaN;
}

function parsePromptFrameDensityZh(prompt) {
  const value = String(prompt || "");
  const match = value.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec|second)\s*(?:内|里|中)?\s*(\d+(?:\.\d+)?)\s*(?:帧|幀|张|張|图|圖|images?|frames?)/i);
  if (!match) return NaN;
  const seconds = Number(match[1]);
  const frames = Number(match[2]);
  if (!Number.isFinite(seconds) || !Number.isFinite(frames) || seconds <= 0) return NaN;
  return frames / seconds;
}

function parsePromptOutputFps(prompt) {
  const value = String(prompt || "");
  const patterns = [
    /(?:output|render)\s*fps\s*[:=]\s*(\d+(?:\.\d+)?)/i,
    /输出\s*(?:帧率)?\s*[:=：]?\s*(\d+(?:\.\d+)?)\s*(?:帧|幀|fps)?/i,
    /最终\s*(?:帧率)?\s*[:=：]?\s*(\d+(?:\.\d+)?)\s*(?:帧|幀|fps)?/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Number(match[1]);
  }
  return NaN;
}

function parsePromptFrameDensity(prompt) {
  const value = String(prompt || "");
  const match = value.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec|second)\s*(\d+(?:\.\d+)?)\s*(?:帧|張|张|images?|frames?)/i);
  if (!match) return NaN;
  const seconds = Number(match[1]);
  const frames = Number(match[2]);
  if (!Number.isFinite(seconds) || !Number.isFinite(frames) || seconds <= 0) return NaN;
  return frames / seconds;
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
