import fs from "node:fs/promises";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

await loadEnvFile(path.join(projectRoot, ".env"));

const lifeBaseUrl = (process.env.LIFE_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const publicLifeBaseUrl = (process.env.CODEX_MEDIA_PUBLIC_LIFE_BASE_URL || lifeBaseUrl).replace(/\/$/, "");
const pollMs = Number(process.env.CODEX_MEDIA_POLL_MS || 10000);
const deletePollMs = Number(process.env.CODEX_MEDIA_DELETE_POLL_MS || 5000);
const workflowSyncMs = Math.max(5000, Number(process.env.CODEX_MEDIA_WORKFLOW_SYNC_MS || 60000));
const workflowSyncEnabled = String(process.env.CODEX_MEDIA_WORKFLOW_SYNC_ENABLED || "true").toLowerCase() !== "false";
const workflowSyncRepeatEnabled = String(process.env.CODEX_MEDIA_WORKFLOW_SYNC_REPEAT_ENABLED || "false").toLowerCase() === "true";
const codexImagesBaseUrl = (process.env.CODEX_IMAGES_BASE_URL || process.env.CODEX_MEDIA_LOCAL_BASE_URL || "http://127.0.0.1:3027").replace(/\/$/, "");
const once = process.argv.includes("--once");
const noDeleteSweeper = process.argv.includes("--no-delete-sweeper");
const codexCommand = process.env.CODEX_COMMAND || resolveCodexCommand();
const ffmpegCommand = process.env.FFMPEG_COMMAND || resolveFfmpegCommand();
const codexTimeoutMs = Number(process.env.CODEX_MEDIA_CODEX_TIMEOUT_MS || 20 * 60 * 1000);
const imageOutputRoot = process.env.CODEX_MEDIA_IMAGE_DIR || "E:\\lifeFiles\\images";
const videoOutputRoot = process.env.CODEX_MEDIA_VIDEO_DIR || "E:\\lifeFiles\\video";
const outputRoot = process.env.CODEX_MEDIA_OUTPUT_DIR || imageOutputRoot;
const publicOutputPrefix = process.env.CODEX_MEDIA_PUBLIC_PREFIX || "";
const uploadToLife = false;
const uploadThemeName = process.env.CODEX_MEDIA_UPLOAD_THEME || "CodexMedia";
const lifeAccessKey = (process.env.CODEX_MEDIA_ACCESS_KEY || "").trim();
let lifeAccessToken = (process.env.CODEX_MEDIA_SESSION_TOKEN || process.env.LIFE_ACCESS_TOKEN || "").trim();
const authRetryMs = Math.max(1000, numberEnv("CODEX_MEDIA_AUTH_RETRY_MS", 30000));
const workerToken = (process.env.CODEX_MEDIA_WORKER_TOKEN || process.env.CODEX_CHAT_WORKER_TOKEN || "").trim();
const workerId = (process.env.CODEX_MEDIA_WORKER_ID || process.env.COMPUTERNAME || process.env.HOSTNAME || "codexImages").trim();
const defaultAspectRatio = "9:16";
const defaultVideoSourceFps = numberEnv("CODEX_MEDIA_VIDEO_SOURCE_FPS", 24);
const defaultVideoOutputFps = numberEnv("CODEX_MEDIA_VIDEO_OUTPUT_FPS", 24);
const defaultVideoSegmentFrames = numberEnv("CODEX_MEDIA_VIDEO_SEGMENT_FRAMES", 12);
const defaultVideoConcurrency = numberEnv("CODEX_MEDIA_VIDEO_CONCURRENCY", 1);
const enableVideoInterpolation = String(process.env.CODEX_MEDIA_VIDEO_INTERPOLATE || "true").toLowerCase() !== "false";
const comfyBaseUrl = (process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const comfyRoot = process.env.COMFYUI_ROOT || "E:\\ComfyUI";
const defaultComfyImageWorkflow = process.env.COMFYUI_DEFAULT_IMAGE_WORKFLOW || "unsloth_qwen_image_2512";
const lmStudioBaseUrl = (process.env.LMSTUDIO_BASE_URL || process.env.LOCAL_MODEL_BASE_URL || "http://127.0.0.1:1234").replace(/\/$/, "");
const lmStudioApiToken = (process.env.LMSTUDIO_API_TOKEN || process.env.LM_API_TOKEN || "").trim();
const lmStudioUnloadTimeoutMs = numberEnv("LMSTUDIO_UNLOAD_TIMEOUT_MS", 15000);
const unloadLmStudioBeforeComfy = String(process.env.CODEX_MEDIA_UNLOAD_LMSTUDIO_BEFORE_COMFYUI || "true").toLowerCase() !== "false";
const requireLmStudioUnloadBeforeComfy = String(process.env.CODEX_MEDIA_REQUIRE_LMSTUDIO_UNLOAD || "false").toLowerCase() === "true";
const defaultComfyVideoWorkflow = process.env.COMFYUI_DEFAULT_VIDEO_WORKFLOW || "文生视频";
const defaultComfyImageToVideoWorkflow = process.env.COMFYUI_DEFAULT_IMAGE_TO_VIDEO_WORKFLOW || "图生视频";
const COMFY_CONTROL_AFTER_GENERATE_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const COMFY_SCHEDULERS = new Set([
  "simple",
  "sgm_uniform",
  "karras",
  "exponential",
  "ddim_uniform",
  "beta",
  "normal",
  "linear_quadratic",
  "kl_optimal"
]);
const COMFY_SAMPLERS = new Set([
  "euler",
  "euler_cfg_pp",
  "euler_ancestral",
  "euler_ancestral_cfg_pp",
  "heun",
  "heunpp2",
  "exp_heun_2_x0",
  "exp_heun_2_x0_sde",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_2s_ancestral_cfg_pp",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_cfg_pp",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_2m_sde_heun",
  "dpmpp_2m_sde_heun_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ipndm",
  "ipndm_v",
  "deis",
  "res_multistep",
  "res_multistep_cfg_pp",
  "res_multistep_ancestral",
  "res_multistep_ancestral_cfg_pp",
  "gradient_estimation",
  "gradient_estimation_cfg_pp",
  "er_sde",
  "seeds_2",
  "seeds_3",
  "sa_solver",
  "sa_solver_pece",
  "ddim",
  "uni_pc",
  "uni_pc_bh2"
]);
const SKIP_WORKFLOW_PARAM = Symbol("skip workflow param");

await fs.mkdir(imageOutputRoot, { recursive: true });
await fs.mkdir(videoOutputRoot, { recursive: true });
const releaseWorkerLock = once ? null : await acquireWorkerLock();
let workflowSyncBusy = false;
await ensureLifeAuth();
if (workflowSyncEnabled) {
  await syncComfyWorkflows().catch((error) => {
    log(`Workflow sync failed: ${errorMessage(error)}`);
  });
}

log(`Codex media worker started. life=${lifeBaseUrl} codex=${codexCommand}`);

let deleteSweepBusy = false;
if (!once && workflowSyncEnabled && workflowSyncRepeatEnabled) {
  setInterval(() => {
    syncComfyWorkflows().catch((error) => {
      log(`Workflow sync error: ${errorMessage(error)}`);
    });
  }, workflowSyncMs);
}

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

if (releaseWorkerLock) releaseWorkerLock();

async function acquireWorkerLock() {
  const lockDir = path.join(projectRoot, "logs");
  await fs.mkdir(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, "codex-media-worker.lock");
  try {
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }));
    closeSync(fd);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingPid = readWorkerLockPid(lockFile);
    if (existingPid && isWorkerProcessRunning(existingPid)) {
      log(`Another Codex media worker is already running (pid=${existingPid}). Exiting.`);
      process.exit(0);
    }
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore stale-lock cleanup races; the retry below will fail if another worker won.
    }
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      replacedStaleLock: true
    }));
    closeSync(fd);
  }

  const release = () => {
    try {
      const pid = readWorkerLockPid(lockFile);
      if (!pid || pid === process.pid) unlinkSync(lockFile);
    } catch {
      // Best-effort cleanup on process exit.
    }
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });
  return release;
}

function readWorkerLockPid(lockFile) {
  try {
    const raw = readFileSync(lockFile, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid || 0);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function isWorkerProcessRunning(pid) {
  if (pid === process.pid) return true;
  if (process.platform === "win32") {
    return isWindowsWorkerProcess(pid);
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").toLowerCase();
    return cmdline.includes("node") && cmdline.includes("codex-media-worker.js");
  } catch {
    return false;
  }
}

function isWindowsWorkerProcess(pid) {
  const scriptPath = path.join(projectRoot, "scripts", "codex-media-worker.js").toLowerCase();
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if (-not $p) { exit 1 }",
    "$name = [string]$p.Name",
    "$cmd = ([string]$p.CommandLine).ToLowerInvariant()",
    `$needle = '${scriptPath.replace(/'/g, "''")}'`,
    "if ($name -ieq 'node.exe' -and $cmd.Contains($needle)) { exit 0 }",
    "exit 1"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "ignore",
    windowsHide: true
  });
  return result.status === 0;
}

async function syncComfyWorkflows() {
  if (workflowSyncBusy) return false;
  workflowSyncBusy = true;
  try {
    const workflows = await readLocalComfyWorkflowCatalog();
    const result = await postJson(`${lifeBaseUrl}/api/codex-media/comfyui/workflows/sync`, {
      source: "codexImages",
      workerId,
      bridgeUrl: codexImagesBaseUrl,
      syncedAt: Date.now(),
      workflows
    });
    log(`Synced ${result.synced ?? workflows.length} ComfyUI workflow(s) to life.`);
    return true;
  } finally {
    workflowSyncBusy = false;
  }
}

async function readLocalComfyWorkflowCatalog() {
  const data = await getJsonWithoutAuth(`${codexImagesBaseUrl}/api/comfy/workflows`);
  return Array.isArray(data.workflows) ? data.workflows : [];
}

async function getJsonWithoutAuth(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false || data.ok === false) {
    throw new Error(data.error || data.msg || `GET failed: ${response.status}`);
  }
  return data;
}
async function takePendingJob() {
  const data = await getJson(`${lifeBaseUrl}/api/codex-media/jobs?status=pending&limit=1`);
  const job = data.jobs?.[0];
  if (!job) return null;
  await postJobProgress(job.request_id, {
    phase: "queued",
    progressText: "任务已领取，准备生成媒体。"
  }, { required: true });
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
  const options = parseJson(job.options_json);
  const jobOutputDir = path.join(resolveJobOutputRoot(job, options), safeSegment(requestId));
  await fs.mkdir(jobOutputDir, { recursive: true });
  log(`Processing ${requestId} -> ${jobOutputDir}`);

  if (isComfyProvider(options)) {
    await processComfyJob(job, jobOutputDir, options);
    return;
  }

  const promptFile = path.join(jobOutputDir, "codex-prompt.txt");
  const lastMessageFile = path.join(jobOutputDir, "codex-last-message.txt");
  await fs.writeFile(promptFile, buildCodexPrompt(job, jobOutputDir), "utf8");
  const settings = parseVideoSettings(job, options);
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

function resolveJobOutputRoot(job, options = {}) {
  const mode = String(job.mode || options.mode || "").toLowerCase();
  const workflowMode = String(options.workflowMode || options.mediaMode || "").toLowerCase();
  const provider = String(options.provider || options.mediaProvider || "").toLowerCase();
  if (isVideoMode(mode) || mode === "image-video" || workflowMode.includes("video")) {
    return videoOutputRoot;
  }
  if (provider === "comfyui") {
    const workflowName = String(options.workflowName || options.workflow || options.comfyWorkflow || "").toLowerCase();
    if (workflowName.includes("视频") || workflowName.includes("video")) return videoOutputRoot;
  }
  return imageOutputRoot || outputRoot;
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

async function processComfyJob(job, jobOutputDir, options = {}) {
  const mode = String(job.mode || "images").toLowerCase();
  const isImageVideo = mode === "image-video";
  const isVideo = isVideoMode(mode);
  const requestedOutputCount = isVideo ? 1 : clampInteger(job.image_count, 1, 48, 1);
  if (isImageVideo && !hasUsableInitImage(options.initImage)) {
    throw new Error("图生视频需要上传一张图片，且附件必须是图片文件。");
  }
  await unloadLmStudioModelsForComfy(job);
  await postJobProgress(job.request_id, {
    phase: "comfyui_starting",
    progressText: "ComfyUI task queued locally."
  });

  const workflowName = String(
    options.workflow
    || options.comfyWorkflow
    || options.comfyImageWorkflow
    || (isImageVideo ? defaultComfyImageToVideoWorkflow : (isVideo ? defaultComfyVideoWorkflow : defaultComfyImageWorkflow))
  ).trim();
  const initImageName = isImageVideo ? await writeComfyInputImage(job, options.initImage) : "";
  const workflow = await loadComfyWorkflow(workflowName);
  const independentImageRuns = !isVideo && requestedOutputCount > 1;
  const runCount = independentImageRuns ? requestedOutputCount : 1;
  const imagePrompts = normalizeImagePrompts(options.imagePrompts || options.workflowParams?.imagePrompts);
  const savedAssets = [];
  const promptIds = [];
  const comfySubmittedAt = Date.now();
  let comfyCompletedAt = comfySubmittedAt;
  let firstExecutionStartedAt = 0;
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runOutputCount = independentImageRuns ? 1 : requestedOutputCount;
    const runPrompt = independentImageRuns
      ? imagePromptForRun(imagePrompts[runIndex], job.prompt || "", options.negativePrompt || "", runIndex, requestedOutputCount)
      : { prompt: job.prompt || "", negativePrompt: options.negativePrompt || "" };
    const promptGraph = buildComfyPrompt(workflow, {
      ...options,
      prompt: runPrompt.prompt,
      negativePrompt: runPrompt.negativePrompt,
      filenamePrefix: `${comfyOutputSegment(job)}/output${independentImageRuns ? `-${String(runIndex + 1).padStart(4, "0")}` : ""}`,
      imageCount: runOutputCount,
      batchSize: runOutputCount,
      randomizeSeed: independentImageRuns,
      preserveWorkflowParams: true,
      isVideo,
      durationSeconds: resolveExplicitComfyDurationSeconds(job, options),
      initImageName
    });
    await fs.writeFile(
      path.join(jobOutputDir, independentImageRuns ? `comfyui-prompt-${String(runIndex + 1).padStart(4, "0")}.json` : "comfyui-prompt.json"),
      JSON.stringify(promptGraph, null, 2),
      "utf8"
    );
    if (independentImageRuns) {
      await postJobProgress(job.request_id, {
        phase: "comfyui_generating",
        progressLabel: "ComfyUI 生成中",
        progressText: `ComfyUI 正在生成第 ${runIndex + 1}/${requestedOutputCount} 张独立图片。`,
        progressPercent: Math.max(16, Math.round((runIndex / requestedOutputCount) * 80))
      });
    }
    const progressMonitor = createComfyProgressMonitor(job);
    const queued = await comfyFetch("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptGraph, client_id: progressMonitor.clientId })
    });
    const promptId = queued.prompt_id;
    if (!promptId) throw new Error("ComfyUI did not return a prompt_id.");
    promptIds.push(promptId);
    progressMonitor.setPromptId(promptId);
    log(`ComfyUI queued ${job.request_id}: ${promptId}${independentImageRuns ? ` (${runIndex + 1}/${requestedOutputCount})` : ""}`);
    let historyItem;
    try {
      historyItem = await waitForComfyHistory(promptId, job, progressMonitor);
    } finally {
      if (!firstExecutionStartedAt && progressMonitor.executionStartedAt) firstExecutionStartedAt = progressMonitor.executionStartedAt;
      progressMonitor.finish();
    }
    comfyCompletedAt = Date.now();
    const outputs = isVideo ? collectComfyVideos(historyItem) : collectComfyImages(historyItem);
    const nextAssets = outputs.length
      ? await saveComfyHistoryOutputs(job, jobOutputDir, outputs.slice(0, runOutputCount), isVideo, savedAssets.length)
      : await collectComfyOutputAssets(job, jobOutputDir, isVideo, runOutputCount, savedAssets.length);
    if (!nextAssets.length) throw new Error(`ComfyUI finished without ${isVideo ? "video" : "image"} outputs.`);
    savedAssets.push(...nextAssets.slice(0, runOutputCount));
  }
  if (!savedAssets.length) throw new Error(`ComfyUI finished without ${isVideo ? "video" : "image"} outputs.`);

  const assets = uploadToLife ? await uploadAssetsToLife(savedAssets) : savedAssets;
  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(job.request_id)}/complete`, {
    resultText: `ComfyUI completed with workflow: ${workflowName}`,
    notes: `ComfyUI completed in ${formatEta(Math.round((comfyCompletedAt - comfySubmittedAt) / 1000))}.`,
    assets,
    outputDir: jobOutputDir,
    provider: "comfyui",
    workflow: workflowName,
    comfyPromptId: promptIds[0] || "",
    comfyPromptIds: promptIds,
    comfyElapsedMs: comfyCompletedAt - comfySubmittedAt,
    comfyExecutionElapsedMs: firstExecutionStartedAt
      ? comfyCompletedAt - firstExecutionStartedAt
      : 0
  });
  log(`Completed ${job.request_id} with ComfyUI (${assets.length} asset).`);
}

function normalizeImagePrompts(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
}

function imagePromptForRun(promptInfo, basePrompt, baseNegativePrompt, index, total) {
  const positivePrompt = String(
    promptInfo?.positivePromptEn
    || promptInfo?.positive_en
    || promptInfo?.positivePrompt
    || promptInfo?.prompt
    || basePrompt
    || ""
  ).trim();
  const negativePrompt = String(
    promptInfo?.negativePromptEn
    || promptInfo?.negative_en
    || promptInfo?.negativePrompt
    || promptInfo?.negative
    || baseNegativePrompt
    || ""
  ).trim();
  return {
    prompt: singleStandaloneComfyPrompt(positivePrompt, index, total),
    negativePrompt
  };
}

function singleStandaloneComfyPrompt(prompt, index, total) {
  return [
    `Single standalone image ${index + 1} of ${total}. Generate exactly one complete image file for this run.`,
    "Use one complete composition, one scene, and one final variation for this run.",
    "If the original request asks for different scenes or styles, treat this run as one distinct standalone variation with its own scene/style.",
    "",
    prompt || ""
  ].join("\n").trim();
}

async function saveComfyHistoryOutputs(job, jobOutputDir, outputs, isVideo, startIndex = 0) {
  const savedAssets = [];
  for (const [index, output] of outputs.entries()) {
    const buffer = await downloadComfyFile(output);
    const fallbackExt = isVideo ? ".mp4" : ".png";
    const ext = path.extname(output.filename || output.name || "").toLowerCase() || fallbackExt;
    const assetIndex = startIndex + index + 1;
    const fileName = isVideo ? `clip-${String(assetIndex).padStart(4, "0")}${ext}` : `frame-${String(assetIndex).padStart(4, "0")}${ext}`;
    const filePath = path.join(jobOutputDir, fileName);
    await fs.writeFile(filePath, buffer);
    const stat = await fs.stat(filePath);
    savedAssets.push({
      fileName,
      path: filePath,
      size: stat.size,
      url: buildLocalAssetUrl(jobOutputDir, fileName),
      localUrl: buildLocalAssetUrl(jobOutputDir, fileName),
      comfy: output
    });
  }
  return savedAssets;
}

async function collectComfyOutputAssets(job, jobOutputDir, isVideo, limit = 1, startIndex = 0) {
  const requestId = safeSegment(job.request_id || "");
  const outputSegment = comfyOutputSegment(job);
  const outputDir = path.join(comfyRoot, "output");
  const scopedNames = Array.from(new Set([outputSegment, requestId].filter(Boolean)));
  const files = [];
  for (const scopedName of scopedNames) {
    const scopedDir = path.join(outputDir, scopedName);
    if (await pathExists(scopedDir)) {
      files.push(...await listFilesRecursive(scopedDir));
    }
  }
  if (!files.length && await pathExists(outputDir)) {
    const all = await listFilesRecursive(outputDir, 3);
    files.push(...all.filter(file => scopedNames.some(scopedName => file.includes(scopedName))));
  }
  const pattern = isVideo
    ? /\.(mp4|webm|mov|m4v|avi|mkv|gif|apng)$/i
    : /\.(png|jpe?g|webp|gif)$/i;
  const candidates = files.filter(file => pattern.test(file)).sort();
  if (!candidates.length) return [];
  const selected = candidates.slice(-Math.max(1, limit));
  const assets = [];
  for (const [index, source] of selected.entries()) {
    const ext = path.extname(source).toLowerCase() || (isVideo ? ".mp4" : ".png");
    const assetIndex = startIndex + index + 1;
    const fileName = isVideo ? `clip-${String(assetIndex).padStart(4, "0")}${ext}` : `frame-${String(assetIndex).padStart(4, "0")}${ext}`;
    const targetPath = path.join(jobOutputDir, fileName);
    await fs.copyFile(source, targetPath);
    const stat = await fs.stat(targetPath);
    assets.push({
      fileName,
      path: targetPath,
      size: stat.size,
      url: buildLocalAssetUrl(jobOutputDir, fileName),
      localUrl: buildLocalAssetUrl(jobOutputDir, fileName),
      comfyRecoveredFrom: source
    });
  }
  log(`Recovered ${assets.length} ComfyUI ${isVideo ? "video" : "image"} output(s).`);
  return assets;
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
      "--add-dir", imageOutputRoot,
      "--add-dir", videoOutputRoot,
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
    .filter(name => /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v|avi|mkv)$/i.test(name))
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

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(dir, maxDepth = 8) {
  if (maxDepth < 0) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, maxDepth - 1));
    }
  }
  return files;
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
      if (!downloadId) {
        throw new Error("upload succeeded but no downloadId was returned");
      }
      uploaded.push({
        ...asset,
        downloadId,
        uploaded: true,
        url: downloadId ? `${publicLifeBaseUrl}/download/to?id=${encodeURIComponent(downloadId)}` : asset.url,
        playUrl: downloadId ? `${publicLifeBaseUrl}/download/play?id=${encodeURIComponent(downloadId)}` : ""
      });
    } catch (error) {
      const message = `Upload to life failed for ${asset.fileName || asset.path || "asset"}: ${errorMessage(error)}`;
      log(message);
      throw new Error(message);
    }
  }
  return uploaded;
}

async function loadComfyWorkflow(nameOrPath) {
  const text = String(nameOrPath || "").trim();
  if (!text) throw new Error("ComfyUI workflow is required.");
  const candidates = path.isAbsolute(text)
    ? [text]
    : [
        path.join(comfyRoot, "user", "default", "workflows", text),
        path.join(comfyRoot, "user", "default", "workflows", `${text}.json`),
        path.join(comfyRoot, "blueprints", text),
        path.join(comfyRoot, "blueprints", `${text}.json`)
      ];
  const workflowPath = candidates.find(candidate => existsSync(candidate));
  if (!workflowPath) throw new Error(`ComfyUI workflow not found: ${text}`);
  return JSON.parse(await fs.readFile(workflowPath, "utf8"));
}

function buildComfyPrompt(workflow, options) {
  const apiPrompt = workflow.nodes ? convertComfyUiWorkflow(workflow, options) : structuredClone(workflow);
  patchComfyPrompt(apiPrompt, options);
  return apiPrompt;
}

function convertComfyUiWorkflow(workflow, options = {}) {
  const graph = {};
  const subgraphDefinitions = new Map((workflow.definitions?.subgraphs || []).map(definition => [String(definition.id), definition]));
  appendComfyUiGraph(graph, workflow, {
    idPrefix: "",
    subgraphDefinitions,
    expandedOutputs: new Map(),
    externalInputsByLinkId: new Map(),
    workflowParams: isPlainObject(options.workflowParams) ? options.workflowParams : {},
    stack: []
  });
  return graph;
}

function appendComfyUiGraph(graph, workflow, context) {
  const links = normalizeComfyUiLinkMap(workflow.links);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const subgraphInstances = [];
  const expandedOutputs = new Map(context.expandedOutputs || []);

  for (const node of nodes) {
    if (isSkippedComfyUiNode(node)) continue;
    const definition = context.subgraphDefinitions.get(String(node.type || node.class_type || ""));
    if (!definition || context.stack.includes(String(definition.id))) continue;
    const idPrefix = `${context.idPrefix}${node.id}_`;
    subgraphInstances.push({ node, definition, idPrefix });
    for (const [slot, ref] of collectComfySubgraphOutputRefs(definition, idPrefix)) {
      expandedOutputs.set(`${node.id}:${slot}`, ref);
    }
  }

  for (const instance of subgraphInstances) {
    const externalInputsByLinkId = buildComfySubgraphExternalInputs(instance.node, instance.definition, links, {
      ...context,
      expandedOutputs
    });
    appendComfyUiGraph(graph, instance.definition, {
      ...context,
      idPrefix: instance.idPrefix,
      expandedOutputs,
      externalInputsByLinkId,
      stack: [...context.stack, String(instance.definition.id)]
    });
  }

  for (const node of nodes) {
    if (isSkippedComfyUiNode(node)) continue;
    if (context.subgraphDefinitions.has(String(node.type || node.class_type || ""))) continue;
    appendComfyUiNode(graph, node, links, {
      ...context,
      expandedOutputs
    });
  }
}

function appendComfyUiNode(graph, node, links, context) {
  const nodeId = `${context.idPrefix}${node.id}`;
  const type = String(node.type || node.class_type || "");
  const inputs = {};
  const widgetValuesByInput = comfyUiWidgetValuesByInputIndex(node);
  for (const [inputIndex, input] of (node.inputs || []).entries()) {
    const inputName = String(input.name || input.localized_name || "");
    const widgetName = input.widget?.name;
    const fallbackValue = widgetValuesByInput.get(inputIndex);
    if (input.link != null) {
      const resolved = resolveComfyUiInputLink(input.link, links, context);
      if (resolved.type === "link") {
        inputs[inputName] = resolved.value;
        continue;
      }
      if (resolved.type === "value") {
        inputs[inputName || widgetName] = sanitizeConvertedComfyInputValue(type, inputName || widgetName, resolved.value, context.workflowParams);
        continue;
      }
    }
    if (widgetName && widgetValuesByInput.has(inputIndex)) {
      inputs[widgetName] = fallbackValue;
    }
  }
  graph[nodeId] = { class_type: type, inputs };
  if (node._meta?.title || node.title) {
    graph[nodeId]._meta = { title: node._meta?.title || node.title };
  }
}

function normalizeComfyUiLinkMap(rawLinks) {
  const links = new Map();
  for (const link of rawLinks || []) {
    const normalized = normalizeComfyUiLink(link);
    if (normalized) links.set(String(normalized.id), normalized);
  }
  return links;
}

function normalizeComfyUiLink(link) {
  if (Array.isArray(link)) {
    return {
      id: link[0],
      originId: link[1],
      originSlot: Number(link[2] || 0),
      targetId: link[3],
      targetSlot: Number(link[4] || 0),
      type: link[5]
    };
  }
  if (!link || typeof link !== "object") return null;
  return {
    id: link.id,
    originId: link.origin_id ?? link.originId ?? link.source_id ?? link.sourceId ?? link.from,
    originSlot: Number(link.origin_slot ?? link.originSlot ?? link.source_slot ?? link.sourceSlot ?? link.fromSlot ?? 0),
    targetId: link.target_id ?? link.targetId ?? link.destination_id ?? link.destinationId ?? link.to,
    targetSlot: Number(link.target_slot ?? link.targetSlot ?? link.destination_slot ?? link.destinationSlot ?? link.toSlot ?? 0),
    type: link.type
  };
}

function collectComfySubgraphOutputRefs(definition, idPrefix) {
  const outputRefs = new Map();
  const links = normalizeComfyUiLinkMap(definition.links);
  for (const [slot, output] of (definition.outputs || []).entries()) {
    const linkIds = Array.isArray(output.linkIds) ? output.linkIds : [];
    for (const linkId of linkIds) {
      const link = links.get(String(linkId));
      if (!link || !isComfySubgraphOutputTarget(link)) continue;
      outputRefs.set(slot, [`${idPrefix}${link.originId}`, link.originSlot]);
      break;
    }
  }
  return outputRefs;
}

function buildComfySubgraphExternalInputs(node, definition, parentLinks, context) {
  const recordsByDefinitionInput = new Map();
  const wrapperInputs = node.inputs || [];
  const widgetValuesByInput = comfyUiWidgetValuesByInputIndex(node);
  for (const [index, definitionInput] of (definition.inputs || []).entries()) {
    const wrapperInput = wrapperInputs[index] || wrapperInputs.find(input => input?.name === definitionInput.name);
    const explicitValue = explicitWorkflowParamForComfyInput(node.id, wrapperInput, context.workflowParams);
    if (explicitValue.found) {
      recordsByDefinitionInput.set(index, { type: "value", value: explicitValue.value });
    } else if (wrapperInput?.link != null) {
      const resolved = resolveComfyUiInputLink(wrapperInput.link, parentLinks, context);
      if (resolved.type === "link" || resolved.type === "value") recordsByDefinitionInput.set(index, resolved);
    } else {
      const wrapperIndex = wrapperInputs.indexOf(wrapperInput);
      if (wrapperIndex >= 0 && widgetValuesByInput.has(wrapperIndex)) {
        recordsByDefinitionInput.set(index, { type: "value", value: widgetValuesByInput.get(wrapperIndex) });
      }
    }
  }

  const recordsByLinkId = new Map();
  for (const [index, definitionInput] of (definition.inputs || []).entries()) {
    const record = recordsByDefinitionInput.get(index) || { type: "missing" };
    for (const linkId of definitionInput.linkIds || []) {
      recordsByLinkId.set(String(linkId), record);
    }
  }
  return recordsByLinkId;
}

function explicitWorkflowParamForComfyInput(nodeId, input, workflowParams = {}) {
  if (!input || !isPlainObject(workflowParams)) return { found: false };
  const names = [input.name, input.widget?.name].filter(Boolean);
  for (const name of names) {
    const key = `${nodeId}.${name}`;
    if (!Object.prototype.hasOwnProperty.call(workflowParams, key)) continue;
    const value = workflowParams[key];
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return { found: true, value };
  }
  return { found: false };
}

function resolveComfyUiInputLink(linkId, links, context) {
  const link = links.get(String(linkId));
  if (!link) return { type: "missing" };
  if (isComfySubgraphInputSource(link)) {
    return context.externalInputsByLinkId.get(String(link.id)) || { type: "missing" };
  }
  const expandedOutput = context.expandedOutputs.get(`${link.originId}:${link.originSlot}`);
  return {
    type: "link",
    value: expandedOutput || [`${context.idPrefix}${link.originId}`, link.originSlot]
  };
}

function comfyUiWidgetValuesByInputIndex(node) {
  const values = normalizedComfyUiWidgetValues(node);
  const result = new Map();
  let widgetIndex = 0;
  for (const [inputIndex, input] of (node.inputs || []).entries()) {
    if (!input.widget?.name) continue;
    if (widgetIndex < values.length) result.set(inputIndex, values[widgetIndex]);
    widgetIndex += 1;
  }
  return result;
}

function sanitizeConvertedComfyInputValue(classType, inputName, value, workflowParams) {
  const sanitized = sanitizeExplicitWorkflowParamValue({ class_type: classType, inputs: { [inputName]: value } }, inputName, value, workflowParams);
  return sanitized === SKIP_WORKFLOW_PARAM ? value : sanitized;
}

function isSkippedComfyUiNode(node) {
  if (!node || node.mode === 2) return true;
  const type = String(node.type || node.class_type || "");
  return type === "Note" || type === "MarkdownNote";
}

function isComfySubgraphInputSource(link) {
  return String(link.originId) === "-10";
}

function isComfySubgraphOutputTarget(link) {
  return String(link.targetId) === "-20";
}

function normalizedComfyUiWidgetValues(node) {
  const values = Array.isArray(node?.widgets_values) ? node.widgets_values.slice() : [];
  if (!isKSamplerNodeType(node?.type) || values.length < 2) return values;
  const widgetNames = (node.inputs || [])
    .filter(input => input?.widget?.name)
    .map(input => input.widget.name);
  const seedIndex = widgetNames.findIndex(name => name === "seed" || name === "noise_seed");
  if (
    seedIndex >= 0 &&
    widgetNames.includes("seed") &&
    widgetNames.includes("steps") &&
    !widgetNames.includes("control_after_generate") &&
    values.length > widgetNames.length &&
    isControlAfterGenerateValue(values[seedIndex + 1])
  ) {
    values.splice(seedIndex + 1, 1);
  } else if (
    seedIndex >= 0 &&
    widgetNames.includes("noise_seed") &&
    widgetNames.includes("steps") &&
    !widgetNames.includes("control_after_generate") &&
    values.length > widgetNames.length &&
    isControlAfterGenerateValue(values[seedIndex + 1])
  ) {
    values.splice(seedIndex + 1, 1);
  }
  return values;
}

function isKSamplerNodeType(type) {
  return type === "KSampler" || type === "KSamplerAdvanced";
}

function isControlAfterGenerateValue(value) {
  return typeof value === "string" && COMFY_CONTROL_AFTER_GENERATE_VALUES.has(value.trim().toLowerCase());
}

function patchComfyPrompt(apiPrompt, options) {
  const [width, height] = parseSize(options.size);
  const isVideo = Boolean(options.isVideo);
  const preserveWorkflowParams = Boolean(options.preserveWorkflowParams);
  const workflowParams = isPlainObject(options.workflowParams) ? options.workflowParams : {};
  const durationFrames = isVideo ? computeComfyDurationFrames(apiPrompt, options) : 0;
  const imageBatchSize = !isVideo ? clampInteger(options.imageCount || options.batchSize, 1, 48, 1) : 1;
  const randomizeSeed = Boolean(options.randomizeSeed);
  const textNodeIds = Object.entries(apiPrompt)
    .filter(([, node]) => node.class_type === "CLIPTextEncode" && "text" in node.inputs)
    .map(([nodeId]) => nodeId);
  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    const textRole = comfyClipTextRole(nodeId, node, textNodeIds);
    if (node.class_type === "CLIPTextEncode" && "text" in node.inputs) {
      if (textRole === "positive") node.inputs.text = options.prompt;
      if (!preserveWorkflowParams && textRole === "negative") node.inputs.text = options.negativePrompt || "";
    }
    if (!preserveWorkflowParams && ["EmptyLatentImage", "EmptySD3LatentImage", "EmptyLTXVLatentVideo"].includes(node.class_type)) {
      if ("width" in node.inputs) node.inputs.width = width;
      if ("height" in node.inputs) node.inputs.height = height;
      if ("batch_size" in node.inputs) node.inputs.batch_size = options.batchSize || 1;
      if (node.class_type === "EmptyLTXVLatentVideo" && "length" in node.inputs) node.inputs.length = options.frames || 73;
    }
    if (preserveWorkflowParams && imageBatchSize > 1 && ["EmptyLatentImage", "EmptySD3LatentImage"].includes(node.class_type) && "batch_size" in node.inputs) {
      node.inputs.batch_size = imageBatchSize;
    }
    if (!preserveWorkflowParams && node.class_type === "CreateVideo" && "fps" in node.inputs) node.inputs.fps = options.fps || 24;
    if (!preserveWorkflowParams && node.class_type === "LTXVConditioning" && "frame_rate" in node.inputs) node.inputs.frame_rate = options.fps || 24;
    if (!preserveWorkflowParams && isVideo && (node.class_type === "INTConstant" || node.class_type === "PrimitiveInt") && "value" in node.inputs) node.inputs.value = options.frames || node.inputs.value;
    if (!preserveWorkflowParams && isVideo && (node.class_type === "FloatConstant" || node.class_type === "PrimitiveFloat") && "value" in node.inputs) node.inputs.value = options.fps || node.inputs.value;
    if (durationFrames > 0 && isVideoFrameCountNode(node)) {
      for (const field of ["length", "frames", "num_frames", "frame_count", "video_length"]) {
        if (field in node.inputs) node.inputs[field] = durationFrames;
      }
    }
    applyExplicitWorkflowParams(nodeId, node, workflowParams);
    if (node.class_type === "LoadImage" && options.initImageName && "image" in node.inputs) {
      node.inputs.image = options.initImageName;
    }
    if (randomizeSeed && !isVideo && isPlainObject(node.inputs)) {
      if ("seed" in node.inputs) node.inputs.seed = randomSeed();
      if ("noise_seed" in node.inputs) node.inputs.noise_seed = randomSeed();
    }
    if (node.class_type === "CLIPTextEncode" && "text" in node.inputs && (options.prompt != null || options.negativePrompt != null)) {
      if (textRole === "positive") node.inputs.text = options.prompt || "";
      if (textRole === "negative") node.inputs.text = options.negativePrompt || "";
    }
    if (!preserveWorkflowParams && (node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced")) {
      if ("seed" in node.inputs) node.inputs.seed = options.seed;
      if ("steps" in node.inputs) node.inputs.steps = options.steps || node.inputs.steps;
    }
    if (!preserveWorkflowParams && node.class_type === "LTXVScheduler" && "steps" in node.inputs) node.inputs.steps = options.steps || node.inputs.steps;
    if (["SaveImage", "SaveAnimatedPNG", "VHS_VideoCombine", "SaveVideo"].includes(node.class_type)) {
      if ("filename_prefix" in node.inputs) node.inputs.filename_prefix = options.filenamePrefix;
    }
  }
}

function comfyClipTextRole(nodeId, node, textNodeIds) {
  const title = String(node?._meta?.title || node?.title || "").toLowerCase();
  if (nodeId === "6" || title.includes("positive") || title.includes("正向") || title.includes("正面")) return "positive";
  if (nodeId === "7" || title.includes("negative") || title.includes("负向") || title.includes("负面") || title.includes("反向")) return "negative";
  const index = textNodeIds.indexOf(nodeId);
  if (index === 0) return "positive";
  if (index === 1) return "negative";
  return "";
}

function applyExplicitWorkflowParams(nodeId, node, workflowParams) {
  if (!isPlainObject(workflowParams) || !node || !isPlainObject(node.inputs)) return;
  const prefix = `${nodeId}.`;
  for (const [key, value] of Object.entries(workflowParams)) {
    const text = String(key || "");
    if (!text.startsWith(prefix)) continue;
    const inputName = text.slice(prefix.length);
    if (!inputName || !(inputName in node.inputs) || value === undefined || value === null) continue;
    const sanitizedValue = sanitizeExplicitWorkflowParamValue(node, inputName, value, workflowParams);
    if (sanitizedValue === SKIP_WORKFLOW_PARAM) continue;
    node.inputs[inputName] = sanitizedValue;
  }
}

function sanitizeExplicitWorkflowParamValue(node, inputName, value, workflowParams = {}) {
  if (node.class_type === "CFGNorm" && inputName === "strength") {
    const strength = Number(value);
    const cfg = Number(workflowParams?.cfg);
    if (Number.isFinite(strength) && Number.isFinite(cfg) && strength === cfg && strength > 2) return SKIP_WORKFLOW_PARAM;
  }
  if (node.class_type !== "KSampler" && node.class_type !== "KSamplerAdvanced") return value;
  if (inputName === "seed" || inputName === "noise_seed") {
    const seed = Number(value);
    if (!Number.isFinite(seed)) return SKIP_WORKFLOW_PARAM;
    return seed < 0 ? randomSeed() : Math.floor(seed);
  }
  if (["steps", "start_at_step", "end_at_step"].includes(inputName)) {
    const number = Number(value);
    const min = inputName === "steps" ? 1 : 0;
    if (!Number.isFinite(number) || number < min) return SKIP_WORKFLOW_PARAM;
    return Math.floor(number);
  }
  if (inputName === "cfg" || inputName === "denoise") {
    const number = Number(value);
    if (!Number.isFinite(number)) return SKIP_WORKFLOW_PARAM;
    return number;
  }
  if (inputName === "sampler_name") {
    if (typeof value !== "string") return SKIP_WORKFLOW_PARAM;
    const sampler = value.trim();
    if (!sampler) return SKIP_WORKFLOW_PARAM;
    return COMFY_SCHEDULERS.has(sampler) && !COMFY_SAMPLERS.has(sampler) ? SKIP_WORKFLOW_PARAM : sampler;
  }
  if (inputName === "scheduler") {
    if (typeof value !== "string") return SKIP_WORKFLOW_PARAM;
    const scheduler = value.trim();
    return COMFY_SCHEDULERS.has(scheduler) ? scheduler : SKIP_WORKFLOW_PARAM;
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveExplicitComfyDurationSeconds(job, options = {}) {
  if (isTruthy(options.durationSpecified) && Number.isFinite(Number(options.durationSeconds))) {
    return clampComfyDurationSeconds(Number(options.durationSeconds));
  }
  const prompt = String(job?.prompt || "");
  const rangeMatch = prompt.match(/(\d+(?:\.\d+)?)\s*(?:~|-|\u5230|\u81f3|to)\s*(\d+(?:\.\d+)?)\s*(?:\u79d2|s|sec|second|seconds)?/i);
  if (rangeMatch) return clampComfyDurationSeconds(Number(rangeMatch[2]));
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*(?:\u79d2|s|sec|second|seconds)/i);
  return match ? clampComfyDurationSeconds(Number(match[1])) : 0;
}

function computeComfyDurationFrames(apiPrompt, options = {}) {
  const seconds = Number(options.durationSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const fps = findComfyWorkflowFps(apiPrompt);
  return clampInteger(seconds * fps, 1, 4096, 0);
}

function findComfyWorkflowFps(apiPrompt) {
  const nodes = Object.values(apiPrompt || {});
  for (const className of ["CreateVideo", "VHS_VideoCombine"]) {
    const found = firstNodeInputNumber(nodes, className, ["fps", "frame_rate"]);
    if (Number.isFinite(found)) return clampInteger(found, 1, 120, 24);
  }
  const conditioningFps = firstNodeInputNumber(nodes, "LTXVConditioning", ["frame_rate", "fps"]);
  if (Number.isFinite(conditioningFps)) return clampInteger(conditioningFps, 1, 120, 24);
  for (const node of nodes) {
    const generic = firstInputNumber(node, ["fps", "frame_rate"]);
    if (Number.isFinite(generic)) return clampInteger(generic, 1, 120, 24);
  }
  return 24;
}

function firstNodeInputNumber(nodes, className, fields) {
  const node = nodes.find(item => item?.class_type === className);
  return node ? firstInputNumber(node, fields) : NaN;
}

function firstInputNumber(node, fields) {
  for (const field of fields) {
    const value = Number(node?.inputs?.[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return NaN;
}

function isVideoFrameCountNode(node) {
  const className = String(node?.class_type || "");
  if (!/video/i.test(className) || !/latent/i.test(className)) return false;
  return ["length", "frames", "num_frames", "frame_count", "video_length"].some(field => field in (node.inputs || {}));
}

function clampComfyDurationSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.min(60, value));
}

function isTruthy(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

async function waitForComfyHistory(promptId, job, progressMonitor = null) {
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS || 30 * 60 * 1000);
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(2000);
    const history = await comfyFetch(`/history/${encodeURIComponent(promptId)}`);
    const item = history?.[promptId];
    if (item?.status?.status_str === "error") throw new Error(`ComfyUI failed prompt ${promptId}.`);
    if (item?.outputs) return item;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    await postJobProgress(job.request_id, {
      phase: "comfyui_running",
      progressLabel: "ComfyUI 生成中",
      progressText: progressMonitor?.lastProgressText || `ComfyUI is generating...\n已运行 ${formatEta(elapsedSeconds)}`,
      progressPercent: progressMonitor?.lastPercent || 16,
      comfyPromptId: promptId,
      comfyElapsedMs: Date.now() - startedAt
    });
  }
  throw new Error(`ComfyUI timed out waiting for ${promptId}.`);
}

function collectComfyImages(historyItem) {
  const images = [];
  for (const output of Object.values(historyItem.outputs || {})) {
    for (const image of output.images || []) images.push(image);
  }
  return images;
}

function collectComfyVideos(historyItem) {
  const videos = [];
  for (const output of Object.values(historyItem.outputs || {})) {
    for (const value of Object.values(output || {})) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (isComfyVideoOutput(item)) videos.push(item);
      }
    }
  }
  return videos;
}

function isComfyVideoOutput(item) {
  if (!item || typeof item !== "object") return false;
  const filename = String(item.filename || item.name || "");
  const mediaType = String(item.type || item.format || item.mime || item.contentType || "");
  return /\.(mp4|webm|mov|m4v|avi|mkv|gif|apng)$/i.test(filename) || /video|animated/i.test(mediaType);
}

async function downloadComfyFile(file) {
  const filename = file.filename || file.name || "";
  if (!filename) throw new Error("ComfyUI output did not include a filename.");
  const params = new URLSearchParams({
    filename,
    subfolder: file.subfolder || "",
    type: file.type || "output"
  });
  const response = await fetch(`${comfyBaseUrl}/view?${params}`);
  if (!response.ok) throw new Error(`ComfyUI file download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function comfyFetch(endpoint, options = {}) {
  const response = await fetch(`${comfyBaseUrl}${endpoint}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(data.error?.message || data.raw || `ComfyUI request failed: ${response.status}`);
  return data;
}

function createComfyProgressMonitor(job) {
  const clientId = `life-${crypto.randomUUID()}`;
  const state = {
    clientId,
    promptId: "",
    submittedAt: Date.now(),
    executionStartedAt: 0,
    lastPostedAt: 0,
    lastPercent: 0,
    lastProgressText: "",
    ws: null,
    setPromptId(promptId) {
      state.promptId = promptId || "";
    },
    finish() {
      try {
        state.ws?.close();
      } catch {
        // Best effort.
      }
    }
  };
  if (typeof WebSocket === "undefined") {
    return state;
  }
  try {
    const ws = new WebSocket(comfyWebSocketUrl(clientId));
    state.ws = ws;
    ws.addEventListener("message", (event) => {
      handleComfySocketMessage(state, job, event.data).catch((error) => {
        log(`ComfyUI progress message failed for ${job.request_id}: ${errorMessage(error)}`);
      });
    });
    ws.addEventListener("error", () => {
      // Polling progress remains available if the socket is unavailable.
    });
  } catch (error) {
    log(`ComfyUI progress socket unavailable for ${job.request_id}: ${errorMessage(error)}`);
  }
  return state;
}

function comfyWebSocketUrl(clientId) {
  const base = new URL(comfyBaseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  base.search = `?clientId=${encodeURIComponent(clientId)}`;
  return base.toString();
}

async function handleComfySocketMessage(state, job, raw) {
  let dataText = "";
  if (typeof raw === "string") {
    dataText = raw;
  } else if (raw instanceof ArrayBuffer) {
    dataText = Buffer.from(raw).toString("utf8");
  } else if (ArrayBuffer.isView(raw)) {
    dataText = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  } else if (raw?.arrayBuffer) {
    dataText = Buffer.from(await raw.arrayBuffer()).toString("utf8");
  } else {
    return;
  }
  const event = JSON.parse(dataText);
  const type = String(event?.type || "");
  const data = event?.data || {};
  const promptId = String(data.prompt_id || data.promptId || "");
  if (promptId && state.promptId && promptId !== state.promptId) return;

  if (type === "execution_start") {
    state.executionStartedAt = Date.now();
    await postComfySocketProgress(state, job, {
      percent: 8,
      text: "ComfyUI 已开始执行工作流。"
    }, true);
    return;
  }

  if (type === "progress") {
    const value = Number(data.value || 0);
    const max = Number(data.max || 0);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
    const elapsedSeconds = Math.max(0, (Date.now() - (state.executionStartedAt || state.submittedAt)) / 1000);
    const secondsPerStep = value > 0 ? elapsedSeconds / value : 0;
    const remainingSeconds = value > 0 ? Math.max(0, secondsPerStep * (max - value)) : 0;
    const percent = Math.max(8, Math.min(98, Math.round((value / max) * 100)));
    const stepRate = secondsPerStep > 0 ? `，${secondsPerStep.toFixed(2)}s/it` : "";
    const text = [
      `ComfyUI 采样进度：${value} / ${max}`,
      `已运行 ${formatEta(Math.round(elapsedSeconds))}，约剩余 ${formatEta(Math.round(remainingSeconds))}${stepRate}`
    ].join("\n");
    await postComfySocketProgress(state, job, {
      percent,
      text,
      value,
      max,
      elapsedSeconds,
      remainingSeconds,
      secondsPerStep
    });
    return;
  }

  if (type === "executing" && data.node === null) {
    await postComfySocketProgress(state, job, {
      percent: 98,
      text: "ComfyUI 已完成执行，正在收集输出文件。"
    }, true);
  }
}

async function postComfySocketProgress(state, job, progress, force = false) {
  const now = Date.now();
  if (!force && now - state.lastPostedAt < 1500) return;
  state.lastPostedAt = now;
  state.lastPercent = progress.percent || state.lastPercent || 0;
  state.lastProgressText = progress.text || state.lastProgressText || "";
  await postJobProgress(job.request_id, {
    phase: "comfyui_running",
    progressLabel: "ComfyUI 生成中",
    progressText: state.lastProgressText,
    progressPercent: state.lastPercent,
    comfyPromptId: state.promptId,
    comfyElapsedMs: now - state.submittedAt,
    comfyExecutionElapsedMs: state.executionStartedAt ? now - state.executionStartedAt : 0,
    comfyProgress: {
      value: progress.value || 0,
      max: progress.max || 0,
      elapsedSeconds: progress.elapsedSeconds || 0,
      remainingSeconds: progress.remainingSeconds || 0,
      secondsPerStep: progress.secondsPerStep || 0
    }
  });
}

async function unloadLmStudioModelsForComfy(job) {
  if (!unloadLmStudioBeforeComfy) return [];
  try {
    const loadedInstances = await listLmStudioLoadedInstances();
    if (!loadedInstances.length) {
      log(`LM Studio unload skipped before ComfyUI ${job.request_id}: no loaded model instances.`);
      return [];
    }
    await postJobProgress(job.request_id, {
      phase: "lmstudio_unloading",
      progressText: `Unloading ${loadedInstances.length} local LM Studio model instance(s) before ComfyUI.`
    });
    const unloaded = [];
    for (const instance of loadedInstances) {
      await unloadLmStudioInstance(instance.id);
      unloaded.push(instance);
    }
    log(`LM Studio unloaded before ComfyUI ${job.request_id}: ${unloaded.map(item => item.id).join(", ")}`);
    await postJobProgress(job.request_id, {
      phase: "lmstudio_unloaded",
      progressText: `Unloaded ${unloaded.length} local LM Studio model instance(s) before ComfyUI.`
    });
    return unloaded;
  } catch (error) {
    const message = `LM Studio unload before ComfyUI failed: ${errorMessage(error)}`;
    log(`${message} request=${job.request_id}`);
    if (requireLmStudioUnloadBeforeComfy) throw new Error(message);
    await postJobProgress(job.request_id, {
      phase: "lmstudio_unload_skipped",
      progressText: `${message}. Continuing because CODEX_MEDIA_REQUIRE_LMSTUDIO_UNLOAD is not true.`
    });
    return [];
  }
}

async function listLmStudioLoadedInstances() {
  const data = await lmStudioFetch("/api/v1/models");
  const models = Array.isArray(data.models) ? data.models : [];
  const instances = [];
  for (const model of models) {
    const loaded = Array.isArray(model?.loaded_instances) ? model.loaded_instances : [];
    for (const instance of loaded) {
      const id = String(instance?.id || "").trim();
      if (!id) continue;
      instances.push({
        id,
        modelKey: String(model?.key || "").trim(),
        type: String(model?.type || "").trim()
      });
    }
  }
  return instances;
}

async function unloadLmStudioInstance(instanceId) {
  return lmStudioFetch("/api/v1/models/unload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_id: instanceId })
  });
}

async function lmStudioFetch(endpoint, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), lmStudioUnloadTimeoutMs);
  try {
    const headers = { ...(options.headers || {}) };
    if (lmStudioApiToken) headers.Authorization = `Bearer ${lmStudioApiToken}`;
    const response = await fetch(`${lmStudioBaseUrl}${endpoint}`, {
      ...options,
      headers,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(data.error?.message || data.raw || `LM Studio request failed: ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeComfyInputImage(job, initImage) {
  const input = await readInitImageBuffer(initImage);
  const fileName = `input-${comfyOutputSegment(job)}${input.ext}`;
  const targetDir = path.join(comfyRoot, "input");
  const targetPath = path.join(targetDir, fileName);
  if (!targetPath.startsWith(targetDir)) throw new Error("Invalid ComfyUI input path.");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, input.buffer);
  return fileName;
}

async function readInitImageBuffer(initImage) {
  if (!hasUsableInitImage(initImage)) {
    throw new Error("图生视频需要上传一张图片，且附件必须是图片文件。");
  }
  if (isValidDataImage(initImage?.dataUrl)) {
    const match = String(initImage.dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
    const mime = String(match?.[1] || "image/png").toLowerCase();
    return {
      buffer: Buffer.from(match?.[2] || "", "base64"),
      ext: imageExtensionFromMime(mime)
    };
  }

  const imagePath = String(initImage?.filePath || initImage?.path || initImage?.localPath || "").trim();
  if (imagePath) {
    const ext = imageExtensionFromName(imagePath, initImage?.type);
    return {
      buffer: await fs.readFile(path.resolve(imagePath)),
      ext
    };
  }

  throw new Error("图生视频需要上传一张图片，且附件必须是图片文件。");
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
    targets.add(path.resolve(imageOutputRoot, requestId));
    targets.add(path.resolve(videoOutputRoot, requestId));
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
  const roots = [imageOutputRoot, videoOutputRoot, outputRoot].filter(Boolean).map(root => path.resolve(root));
  const resolved = path.resolve(target || "");
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
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

async function postJobProgress(requestId, progress, options = {}) {
  if (!requestId) return;
  const payload = {
    ...progress,
    resultText: progress.progressText || progress.resultText || ""
  };
  await postJson(`${lifeBaseUrl}/api/codex-media/jobs/${encodeURIComponent(requestId)}/running`, payload).catch((error) => {
    log(`Progress update failed for ${requestId}: ${errorMessage(error)}`);
    if (options.required) throw error;
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
  while (!lifeAccessToken) {
    try {
      const response = await fetch(`${lifeBaseUrl}/api/access/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: lifeAccessKey })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        const error = new Error(data.error || `access verify failed: ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      lifeAccessToken = String(data.auth?.accessToken || "").trim();
      if (!lifeAccessToken) {
        throw new Error("access verify succeeded but no session token was returned.");
      }
    } catch (error) {
      if (error?.retryable === false) throw error;
      log(`Life auth unavailable: ${errorMessage(error)}. Retrying in ${Math.round(authRetryMs / 1000)}s.`);
      await sleep(authRetryMs);
    }
  }
}

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const raw = await fs.readFile(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
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
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
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
  return value === "video" || value === "both" || value === "image-video";
}

function isComfyProvider(options = {}) {
  return String(options.provider || options.mediaProvider || "").toLowerCase() === "comfyui";
}

function comfyOutputSegment(job) {
  const requestId = safeSegment(job?.request_id || "");
  if (!requestId) return "comfyui-media-job";
  if (/^comfyui-/i.test(requestId)) return requestId;
  if (/^codex-media-/i.test(requestId)) return requestId.replace(/^codex-media-/i, "comfyui-media-");
  return `comfyui-${requestId}`;
}

function isValidDataImage(dataUrl) {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(String(dataUrl || ""));
}

function hasUsableInitImage(initImage) {
  if (isValidDataImage(initImage?.dataUrl)) return true;
  const imagePath = String(initImage?.filePath || initImage?.path || initImage?.localPath || "").trim();
  if (!imagePath) return false;
  return isImageExtension(path.extname(imagePath)) || isImageMime(initImage?.type);
}

function imageExtensionFromName(fileName, mime = "") {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (isImageExtension(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  return imageExtensionFromMime(mime);
}

function imageExtensionFromMime(mime) {
  const value = String(mime || "").toLowerCase();
  if (value.includes("jpeg") || value.includes("jpg")) return ".jpg";
  if (value.includes("webp")) return ".webp";
  if (value.includes("gif")) return ".gif";
  return ".png";
}

function isImageExtension(ext) {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(String(ext || ""));
}

function isImageMime(mime) {
  return /^image\/(?:png|jpe?g|webp|gif)$/i.test(String(mime || ""));
}

function normalizeComfySize(value) {
  const text = String(value || "").trim();
  return /^\d{2,4}x\d{2,4}$/i.test(text) ? text.toLowerCase() : "1024x1024";
}

function parseSize(size) {
  const match = String(size || "").match(/^(\d+)x(\d+)$/);
  if (!match) return [1024, 1024];
  return [Number(match[1]), Number(match[2])];
}

function randomSeed() {
  return Math.floor(Math.random() * 1000000000000000);
}

function sizeFromAspect(aspect) {
  const value = String(aspect || "").replace("：", ":").trim();
  if (value === "16:9") return "1280x720";
  if (value === "9:16") return "720x1280";
  return "1024x1024";
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

