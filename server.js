import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const outputRoot = path.join(__dirname, "outputs");
const jobsFile = path.join(dataDir, "jobs.json");

await loadEnvFile(path.join(__dirname, ".env"));

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3027);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
const defaultCorsOrigins = [
  "https://liaoxianjun.com",
  "https://www.liaoxianjun.com",
  "http://liaoxianjun.com",
  "http://www.liaoxianjun.com",
  "http://127.0.0.1:8090",
  "http://localhost:8090"
];
const allowedCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...(process.env.CORS_ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean)
]);
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const defaultImageModel = process.env.DEFAULT_IMAGE_MODEL || "gpt-image-1.5";
const defaultVideoModel = process.env.DEFAULT_VIDEO_MODEL || "sora-2";
const mediaProvider = normalizeProvider(process.env.MEDIA_PROVIDER || "openai");
const comfyBaseUrl = (process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const comfyRoot = process.env.COMFYUI_ROOT || "E:\\ComfyUI";
const defaultComfyImageWorkflow = process.env.COMFYUI_DEFAULT_IMAGE_WORKFLOW || "unsloth_qwen_image_2512";
const defaultComfyVideoWorkflow = process.env.COMFYUI_DEFAULT_VIDEO_WORKFLOW || "\u6587\u751f\u89c6\u9891";
const defaultComfyImageToVideoWorkflow = process.env.COMFYUI_DEFAULT_IMAGE_TO_VIDEO_WORKFLOW || "\u56fe\u751f\u89c6\u9891";
const COMFY_CONTROL_AFTER_GENERATE_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);

const jobs = new Map();
const running = new Map();

await ensureStore();
await loadJobs();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);
    if (url.pathname.startsWith("/api/")) {
      applyCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        sendCorsOptions(res);
        return;
      }
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: errorMessage(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Codex media workflow running at http://${host}:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "codex-media-workflow",
      hasOpenAIKey: Boolean(openaiApiKey),
      mediaProvider,
      comfyBaseUrl,
      defaultComfyImageWorkflow,
      defaultComfyVideoWorkflow,
      defaultComfyImageToVideoWorkflow,
      publicBaseUrl
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/comfy/workflows") {
    const workflows = await listComfyWorkflows();
    sendJson(res, 200, { ok: true, workflows });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workflows") {
    const list = Array.from(jobs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicJob);
    sendJson(res, 200, { ok: true, jobs: list });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workflows") {
    const payload = await readJson(req);
    const job = createJob(payload);
    jobs.set(job.id, job);
    await saveJobs();
    runJob(job.id);
    sendJson(res, 202, { ok: true, job: publicJob(job) });
    return;
  }

  const match = url.pathname.match(/^\/api\/workflows\/([^/]+)(?:\/(extend|stop))?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) {
      sendJson(res, 404, { ok: false, error: "Workflow not found." });
      return;
    }
    if (req.method === "GET" && !match[2]) {
      sendJson(res, 200, { ok: true, job: publicJob(job) });
      return;
    }
    if (req.method === "POST" && match[2] === "extend") {
      const payload = await readJson(req);
      job.targetImages += clampNumber(payload.imageCount, 1, 48, 4);
      job.status = running.has(job.id) ? job.status : "queued";
      job.updatedAt = now();
      await saveJobs();
      runJob(job.id);
      sendJson(res, 202, { ok: true, job: publicJob(job) });
      return;
    }
    if (req.method === "POST" && match[2] === "stop") {
      job.stopRequested = true;
      job.continuous = false;
      job.updatedAt = now();
      await saveJobs();
      sendJson(res, 200, { ok: true, job: publicJob(job) });
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "Not found." });
}

function createJob(payload) {
  const id = "media-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const imageCount = 1;
  const mode = ["images", "video", "both", "image-video"].includes(payload.mode) ? payload.mode : "images";
  return {
    id,
    prompt: String(payload.prompt || "").trim(),
    mode,
    status: "queued",
    targetImages: imageCount,
    continuous: Boolean(payload.continuous),
    stopRequested: false,
    stitchVideo: Boolean(payload.stitchVideo),
    imageModel: String(payload.imageModel || defaultImageModel).trim(),
    videoModel: String(payload.videoModel || defaultVideoModel).trim(),
    provider: normalizeProvider(payload.provider || mediaProvider),
    comfyImageWorkflow: String(payload.comfyImageWorkflow || defaultComfyImageWorkflow).trim(),
    comfyVideoWorkflow: String(payload.comfyVideoWorkflow || defaultComfyVideoWorkflow).trim(),
    comfyImageToVideoWorkflow: String(payload.comfyImageToVideoWorkflow || defaultComfyImageToVideoWorkflow).trim(),
    initImage: normalizeUploadImage(payload.initImage),
    size: normalizeSize(payload.size),
    quality: normalizeQuality(payload.quality),
    seconds: normalizeSeconds(payload.seconds),
    videoFps: clampNumber(payload.videoFps, 1, 60, 24),
    videoFrames: clampNumber(payload.videoFrames, 1, 300, 73),
    steps: clampNumber(payload.steps, 1, 150, 20),
    intervalSeconds: clampNumber(payload.intervalSeconds, 0, 3600, 0),
    images: [],
    video: null,
    stitchedVideo: null,
    logs: [],
    createdAt: now(),
    updatedAt: now()
  };
}

async function runJob(jobId) {
  if (running.has(jobId)) return;
  const job = jobs.get(jobId);
  if (!job || !job.prompt) {
    if (job) failJob(job, "Prompt is required.");
    return;
  }
  running.set(jobId, true);
  try {
    job.status = "running";
    job.updatedAt = now();
    await saveJobs();
    await fs.mkdir(path.join(outputRoot, job.id), { recursive: true });

    if (job.mode === "images" || job.mode === "both") {
      await generateImageLoop(job);
    }
    if (!job.stopRequested && (job.mode === "video" || job.mode === "both" || job.mode === "image-video")) {
      if (job.provider === "comfyui") await generateComfyVideo(job);
      else await generateSoraVideo(job);
    }
    if (!job.stopRequested && job.stitchVideo && job.images.length > 1) {
      await stitchImages(job);
    }
    job.status = job.stopRequested ? "stopped" : "done";
    job.updatedAt = now();
    log(job, job.status === "done" ? "Workflow finished." : "Workflow stopped.");
    await saveJobs();
  } catch (error) {
    failJob(job, errorMessage(error));
    await saveJobs();
  } finally {
    running.delete(jobId);
  }
}

async function generateImageLoop(job) {
  while (!job.stopRequested && (job.images.length < job.targetImages || job.continuous)) {
    const frame = job.images.length + 1;
    log(job, `Generating image ${frame}.`);
    const prompt = framePrompt(job.prompt, frame, job.images.length);
    if (job.provider === "comfyui") {
      const images = await comfyImage(prompt, job, frame);
      job.images.push(...images);
    } else {
      const imageBuffer = await openaiImage(prompt, job);
      const fileName = `frame-${String(frame).padStart(4, "0")}.png`;
      const filePath = path.join(outputRoot, job.id, fileName);
      await fs.writeFile(filePath, imageBuffer);
      job.images.push({
        index: frame,
        prompt,
        path: `/outputs/${job.id}/${fileName}`,
        createdAt: now()
      });
    }
    job.updatedAt = now();
    await saveJobs();
    if (job.intervalSeconds > 0) {
      await sleep(job.intervalSeconds * 1000);
    }
  }
}

async function generateSoraVideo(job) {
  log(job, "Starting Sora video job.");
  const created = await openaiFetch("/v1/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: job.videoModel,
      prompt: job.prompt,
      size: soraSize(job.size),
      seconds: job.seconds
    })
  });
  let video = created;
  job.video = {
    id: video.id,
    status: video.status || "queued",
    progress: video.progress || 0,
    path: null
  };
  await saveJobs();

  while (video.status === "queued" || video.status === "in_progress") {
    await sleep(10000);
    video = await openaiFetch(`/v1/videos/${encodeURIComponent(video.id)}`);
    job.video.status = video.status;
    job.video.progress = video.progress || 0;
    job.updatedAt = now();
    await saveJobs();
  }

  if (video.status !== "completed") {
    throw new Error(video.error?.message || `Sora video failed with status ${video.status}.`);
  }

  const content = await openaiBinary(`/v1/videos/${encodeURIComponent(video.id)}/content?variant=video`);
  const fileName = "sora-video.mp4";
  await fs.writeFile(path.join(outputRoot, job.id, fileName), content);
  job.video = {
    id: video.id,
    status: "completed",
    progress: 100,
    path: `/outputs/${job.id}/${fileName}`
  };
  log(job, "Sora video downloaded.");
  await saveJobs();
}

async function generateComfyVideo(job) {
  const isImageVideo = job.mode === "image-video";
  const workflowName = isImageVideo ? job.comfyImageToVideoWorkflow : job.comfyVideoWorkflow;
  const initImageName = isImageVideo ? await writeComfyInputImage(job) : "";
  const workflow = await loadComfyWorkflow(workflowName);
  const promptGraph = buildComfyPrompt(workflow, {
    prompt: job.prompt,
    negativePrompt: "",
    size: job.size,
    seed: randomSeed(),
    batchSize: 1,
    filenamePrefix: `${job.id}/video`,
    isVideo: true,
    fps: job.videoFps,
    frames: job.videoFrames,
    steps: job.steps,
    initImageName
  });
  const clientId = `codex-media-${crypto.randomUUID()}`;
  const queued = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: promptGraph, client_id: clientId })
  });
  const promptId = queued.prompt_id;
  if (!promptId) throw new Error("ComfyUI did not return a prompt_id.");
  job.video = { id: promptId, status: "queued", progress: 0, path: null };
  log(job, `ComfyUI video queued ${promptId}.`);
  await saveJobs();

  const historyItem = await waitForComfyHistory(promptId, job);
  const videos = collectComfyVideos(historyItem);
  if (!videos.length) throw new Error("ComfyUI finished without video outputs.");
  const video = videos[0];
  const content = await downloadComfyFile(video);
  const ext = path.extname(video.filename || "").toLowerCase() || ".mp4";
  const fileName = `comfy-video${ext}`;
  await fs.writeFile(path.join(outputRoot, job.id, fileName), content);
  job.video = {
    id: promptId,
    status: "completed",
    progress: 100,
    path: `/outputs/${job.id}/${fileName}`,
    comfy: video
  };
  log(job, "ComfyUI video downloaded.");
  await saveJobs();
}

async function stitchImages(job) {
  const outPath = path.join(outputRoot, job.id, "image-sequence.mp4");
  const inputPattern = path.join(outputRoot, job.id, "frame-%04d.png");
  log(job, "Stitching image sequence with ffmpeg.");
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-framerate", "2",
      "-i", inputPattern,
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      outPath
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
  job.stitchedVideo = `/outputs/${job.id}/image-sequence.mp4`;
}

async function openaiImage(prompt, job) {
  const data = await openaiFetch("/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: job.imageModel,
      prompt,
      size: job.size,
      quality: job.quality,
      n: 1
    })
  });
  const item = data.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("Image response did not include image data.");
}

async function openaiFetch(endpoint, options = {}) {
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set.");
  const response = await fetch(`https://api.openai.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI request failed: ${response.status}`);
  }
  return data;
}

async function openaiBinary(endpoint) {
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set.");
  const response = await fetch(`https://api.openai.com${endpoint}`, {
    headers: { Authorization: `Bearer ${openaiApiKey}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `OpenAI download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function comfyImage(prompt, job, frame) {
  const workflow = await loadComfyWorkflow(job.comfyImageWorkflow);
  const promptGraph = buildComfyPrompt(workflow, {
    prompt,
    negativePrompt: "",
    size: job.size,
    seed: randomSeed(),
    batchSize: 1,
    filenamePrefix: `${job.id}/frame-${String(frame).padStart(4, "0")}`,
    steps: job.steps
  });
  const clientId = `codex-media-${crypto.randomUUID()}`;
  const queued = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: promptGraph, client_id: clientId })
  });
  const promptId = queued.prompt_id;
  if (!promptId) throw new Error("ComfyUI did not return a prompt_id.");
  log(job, `ComfyUI queued ${promptId}.`);
  const historyItem = await waitForComfyHistory(promptId, job);
  const outputs = collectComfyImages(historyItem);
  if (!outputs.length) throw new Error("ComfyUI finished without image outputs.");

  const saved = [];
  for (const output of outputs) {
    const imageBuffer = await downloadComfyImage(output);
    const suffix = saved.length ? `-${saved.length + 1}` : "";
    const fileName = `frame-${String(frame + saved.length).padStart(4, "0")}${suffix}.png`;
    await fs.writeFile(path.join(outputRoot, job.id, fileName), imageBuffer);
    saved.push({
      index: job.images.length + saved.length + 1,
      prompt,
      path: `/outputs/${job.id}/${fileName}`,
      comfy: output,
      createdAt: now()
    });
  }
  log(job, `ComfyUI returned ${saved.length} image(s).`);
  return saved;
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

async function listComfyWorkflows() {
  const workflowDir = path.join(comfyRoot, "user", "default", "workflows");
  const entries = await fs.readdir(workflowDir, { withFileTypes: true });
  const workflows = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    const workflowPath = path.join(workflowDir, entry.name);
    try {
      const workflow = JSON.parse(await fs.readFile(workflowPath, "utf8"));
      workflows.push({
        name: path.basename(entry.name, ".json"),
        fileName: entry.name,
        path: workflowPath,
        ...inspectComfyWorkflow(workflow)
      });
    } catch (error) {
      workflows.push({
        name: path.basename(entry.name, ".json"),
        fileName: entry.name,
        path: workflowPath,
        kind: "unknown",
        error: errorMessage(error)
      });
    }
  }
  return workflows.sort((a, b) => workflowKindRank(a.kind) - workflowKindRank(b.kind) || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function inspectComfyWorkflow(workflow) {
  const graphNodes = inspectComfyNodes(workflow);
  const edges = inspectComfyEdges(workflow, graphNodes);
  applyConditioningLabels(graphNodes, edges);
  const nodes = workflow.nodes || Object.entries(workflow).map(([id, node]) => ({
    id,
    type: node.class_type,
    inputs: node.inputs || {},
    _meta: node._meta || {}
  }));
  const types = new Set(nodes.map(node => node.type || node.class_type));
  const hasInputImage = types.has("LoadImage");
  const hasVideo = types.has("CreateVideo") || types.has("SaveVideo") || types.has("VHS_VideoCombine") || types.has("EmptyLTXVLatentVideo");
  const kind = hasInputImage && hasVideo ? "image-video" : hasVideo ? "video" : "image";
  const defaults = {};
  for (const node of nodes) {
    const nodeType = node.type || node.class_type;
    const inputs = Array.isArray(node.inputs) ? null : node.inputs;
    if (inputs) {
      if ((nodeType === "EmptyLTXVLatentVideo" || nodeType === "EmptyLatentImage" || nodeType === "EmptySD3LatentImage") && inputs.width && inputs.height) {
        defaults.size = `${inputs.width}x${inputs.height}`;
      }
      if (nodeType === "CreateVideo" && inputs.fps) defaults.fps = Number(inputs.fps);
      if (nodeType === "LTXVConditioning" && inputs.frame_rate) defaults.fps = Number(inputs.frame_rate);
      if (nodeType === "EmptyLTXVLatentVideo" && inputs.length) defaults.frames = Number(inputs.length);
      if ((nodeType === "KSampler" || nodeType === "KSamplerAdvanced" || nodeType === "LTXVScheduler") && inputs.steps) {
        defaults.steps = Number(inputs.steps);
      }
      continue;
    }
    const values = normalizedComfyUiWidgetValues(node);
    if (nodeType === "EmptyLTXVLatentVideo" || nodeType === "EmptyLatentImage" || nodeType === "EmptySD3LatentImage") {
      if (Number.isFinite(Number(values[0])) && Number.isFinite(Number(values[1]))) defaults.size = `${values[0]}x${values[1]}`;
      if (nodeType === "EmptyLTXVLatentVideo" && Number.isFinite(Number(values[2]))) defaults.frames = Number(values[2]);
    }
    if ((nodeType === "CreateVideo" || nodeType === "LTXVConditioning") && Number.isFinite(Number(values[0]))) {
      defaults.fps = Number(values[0]);
    }
    if (nodeType === "KSampler") {
      const maybeSteps = typeof values[1] === "string" ? values[2] : values[1];
      if (Number.isFinite(Number(maybeSteps))) defaults.steps = Number(maybeSteps);
    }
    if (nodeType === "LTXVScheduler") {
      const steps = inputs?.steps ?? values[0];
      if (Number.isFinite(Number(steps))) defaults.steps = Number(steps);
    }
  }
  return {
    kind,
    hasInputImage,
    defaults,
    nodes: graphNodes,
    edges,
    fields: inspectComfyFields(graphNodes)
  };
}

function inspectComfyNodes(workflow) {
  if (Array.isArray(workflow.nodes)) {
    return workflow.nodes
      .filter(node => node && node.mode !== 2 && node.type !== "Note")
      .map((node, index) => inspectComfyUiNode(node, index));
  }
  return Object.entries(workflow)
    .filter(([, node]) => node && typeof node === "object" && node.class_type)
    .map(([id, node], index) => inspectComfyApiNode(id, node, index));
}

function inspectComfyUiNode(node, index) {
  const id = String(node.id);
  const type = String(node.type || node.class_type || "Unknown");
  const inputs = summarizeComfyUiInputs(node);
  const outputs = (node.outputs || []).map((output, slot) => ({
    name: String(output.name || output.localized_name || `output_${slot}`),
    type: String(output.type || ""),
    slot,
    linked: Array.isArray(output.links) && output.links.length > 0
  }));
  let label = comfyNodeLabel(node, type, id);
  if (type === "CLIPTextEncode") label = inferClipTextLabel(inputs, index);
  return {
    id,
    label,
    type,
    summary: summarizeComfyNode(type, inputs, outputs),
    configurable: inputs.some(input => !input.linked && (input.widget || input.value !== undefined)),
    inputs,
    outputs,
    order: index
  };
}

function inspectComfyApiNode(id, node, index) {
  const type = String(node.class_type || node.type || "Unknown");
  const inputs = Object.entries(node.inputs || {}).map(([name, value], slot) => {
    const linked = Array.isArray(value) && value.length >= 2;
    return {
      name,
      type: linked ? "LINK" : typeof value,
      slot,
      linked,
      link: linked ? String(value[0]) : null,
      value: linked ? undefined : safeWorkflowValue(value)
    };
  });
  let label = String(node._meta?.title || node.title || type || id);
  if (type === "CLIPTextEncode") label = inferClipTextLabel(inputs, index);
  return {
    id: String(id),
    label,
    type,
    summary: summarizeComfyNode(type, inputs, []),
    configurable: inputs.some(input => !input.linked),
    inputs,
    outputs: [],
    order: index
  };
}

function summarizeComfyUiInputs(node) {
  const values = normalizedComfyUiWidgetValues(node);
  let widgetIndex = 0;
  return (node.inputs || []).map((input, slot) => {
    const widget = input.widget?.name || null;
    const linked = input.link != null;
    let value;
    if (!linked && widget) {
      value = safeWorkflowValue(values[widgetIndex]);
      widgetIndex += 1;
    }
    return {
      name: String(input.name || input.localized_name || `input_${slot}`),
      label: String(input.localized_name || input.name || `input_${slot}`),
      type: String(input.type || ""),
      slot,
      linked,
      link: linked ? String(input.link) : null,
      widget,
      value
    };
  });
}

function normalizedComfyUiWidgetValues(node) {
  const values = Array.isArray(node?.widgets_values) ? node.widgets_values.slice() : [];
  if (!isKSamplerNodeType(node?.type) || values.length < 2) return values;
  const widgetNames = (node.inputs || [])
    .filter(input => input?.link == null && input?.widget?.name)
    .map(input => input.widget.name);
  if (
    widgetNames.includes("seed") &&
    widgetNames.includes("steps") &&
    !widgetNames.includes("control_after_generate") &&
    isControlAfterGenerateValue(values[1])
  ) {
    values.splice(1, 1);
  }
  return values;
}

function isKSamplerNodeType(type) {
  return type === "KSampler" || type === "KSamplerAdvanced";
}

function isControlAfterGenerateValue(value) {
  return typeof value === "string" && COMFY_CONTROL_AFTER_GENERATE_VALUES.has(value.trim().toLowerCase());
}

function inspectComfyEdges(workflow, nodes) {
  const nodeIds = new Set(nodes.map(node => node.id));
  if (Array.isArray(workflow.links)) {
    return workflow.links
      .map(link => ({
        id: String(link[0]),
        from: String(link[1]),
        fromSlot: Number(link[2] || 0),
        to: String(link[3]),
        toSlot: Number(link[4] || 0),
        type: String(link[5] || "")
      }))
      .filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  }
  const edges = [];
  for (const [targetId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node?.inputs || {})) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const sourceId = String(value[0]);
      if (!nodeIds.has(sourceId) || !nodeIds.has(String(targetId))) continue;
      edges.push({
        id: `${sourceId}:${value[1]}->${targetId}:${inputName}`,
        from: sourceId,
        fromSlot: Number(value[1] || 0),
        to: String(targetId),
        toInput: inputName,
        type: inputName
      });
    }
  }
  return edges;
}

function applyConditioningLabels(nodes, edges) {
  const byId = new Map((nodes || []).map(node => [String(node.id), node]));
  for (const edge of edges || []) {
    const source = byId.get(String(edge.from || edge.source || ""));
    if (!source || source.type !== "CLIPTextEncode") continue;
    const target = byId.get(String(edge.to || edge.target || ""));
    const inputName = conditioningTargetInputName(target, edge);
    if (inputName === "positive") source.label = "Positive Prompt";
    if (inputName === "negative") source.label = "Negative Prompt";
  }
}

function conditioningTargetInputName(target, edge) {
  const explicit = String(edge?.toInput || edge?.targetInput || edge?.inputName || "").toLowerCase();
  if (explicit) return explicit;
  const slot = Number(edge?.toSlot);
  const input = (target?.inputs || []).find(item => Number(item?.slot) === slot);
  return String(input?.name || input?.inputName || input?.label || "").toLowerCase();
}
function inspectComfyFields(nodes) {
  const fields = [];
  for (const node of nodes) {
    for (const input of node.inputs || []) {
      if (input.linked || (!input.widget && input.value === undefined)) continue;
      fields.push({
        key: `${node.id}.${input.name}`,
        label: `${node.label} / ${input.label || input.name}`,
        type: comfyFieldType(input.type, input.value),
        nodeId: node.id,
        nodeType: node.type,
        inputName: input.name,
        default: input.value
      });
    }
  }
  return fields.slice(0, 160);
}

function comfyNodeLabel(node, type, id) {
  return String(node.title || node._meta?.title || node.label || type || id);
}

function inferClipTextLabel(inputs, index) {
  const text = String(inputs.find(input => input.name === "text")?.value || "").toLowerCase();
  if (/negative|low quality|blurry|watermark|bad|deformed|distorted/.test(text)) {
    return "Negative Prompt";
  }
  return index === 0 ? "Positive Prompt" : "Positive Prompt";
}
function summarizeComfyNode(type, inputs, outputs) {
  const inputValue = name => inputs.find(input => input.name === name)?.value;
  if (type === "CLIPTextEncode") {
    const text = String(inputValue("text") || "").trim().replace(/\s+/g, " ");
    return text ? `Prompt: ${text.slice(0, 52)}${text.length > 52 ? "..." : ""}` : "Prompt encoder";
  }
  if (type === "LoadImage") return `Input image: ${inputValue("image") || "pending"}`;
  if (type === "KSampler" || type === "KSamplerAdvanced") {
    return `steps ${inputValue("steps") ?? "-"} / cfg ${inputValue("cfg") ?? "-"} / seed ${inputValue("seed") ?? "-"}`;
  }
  if (type === "LTXVScheduler") return `steps ${inputValue("steps") ?? "-"}`;
  if (type === "EmptyLTXVLatentVideo") {
    return `${inputValue("width") ?? "?"}x${inputValue("height") ?? "?"} / ${inputValue("length") ?? "?"} frames`;
  }
  if (type === "EmptyLatentImage" || type === "EmptySD3LatentImage") {
    return `${inputValue("width") ?? "?"}x${inputValue("height") ?? "?"}`;
  }
  if (type === "CreateVideo" || type === "VHS_VideoCombine" || type === "SaveVideo") {
    return `Video output / ${inputValue("fps") ?? "?"} fps`;
  }
  if (type === "SaveImage" || type === "SaveAnimatedPNG") {
    return `Output prefix: ${inputValue("filename_prefix") || "ComfyUI"}`;
  }
  if (type.includes("Loader")) {
    const modelInputs = inputs.filter(input => !input.linked && input.value !== undefined).slice(0, 2).map(input => input.value);
    return modelInputs.length ? `Model: ${modelInputs.join(" / ")}` : "Load model";
  }
  const inputCount = inputs.length;
  const outputCount = outputs.length;
  return `${inputCount} inputs / ${outputCount} outputs`;
}

function comfyFieldType(type, value) {
  const text = String(type || "").toUpperCase();
  if (text.includes("INT") || Number.isInteger(value)) return "number";
  if (text.includes("FLOAT") || typeof value === "number") return "number";
  if (text.includes("BOOLEAN") || typeof value === "boolean") return "checkbox";
  if (text.includes("STRING") || text.includes("TEXT")) return "textarea";
  return "text";
}

function safeWorkflowValue(value) {
  if (value == null) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(safeWorkflowValue);
  return JSON.stringify(value).slice(0, 240);
}

function workflowKindRank(kind) {
  return { image: 0, video: 1, "image-video": 2, unknown: 3 }[kind] ?? 4;
}

function buildComfyPrompt(workflow, options) {
  const apiPrompt = workflow.nodes ? convertComfyUiWorkflow(workflow) : structuredClone(workflow);
  patchComfyPrompt(apiPrompt, options);
  return apiPrompt;
}

function convertComfyUiWorkflow(workflow) {
  const links = new Map((workflow.links || []).map(link => [link[0], link]));
  const graph = {};
  for (const node of workflow.nodes || []) {
    if (!node || node.mode === 2) continue;
    if (node.type === "Note") continue;
    const inputs = {};
    const widgetValues = normalizedComfyUiWidgetValues(node);
    let widgetIndex = 0;
    for (const input of node.inputs || []) {
      if (input.link != null) {
        const link = links.get(input.link);
        if (link) inputs[input.name] = [String(link[1]), link[2]];
      } else if (input.widget?.name) {
        inputs[input.widget.name] = widgetValues[widgetIndex];
        widgetIndex += 1;
      }
    }
    graph[String(node.id)] = {
      class_type: node.type,
      inputs
    };
    if (node._meta?.title || node.title) {
      graph[String(node.id)]._meta = { title: node._meta?.title || node.title };
    }
  }
  return graph;
}

function patchComfyPrompt(apiPrompt, options) {
  const [width, height] = parseSize(options.size);
  const isVideo = Boolean(options.isVideo);
  const textNodeIds = Object.entries(apiPrompt)
    .filter(([, node]) => node.class_type === "CLIPTextEncode" && "text" in node.inputs)
    .map(([nodeId]) => nodeId);
  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    const title = String(node._meta?.title || "").toLowerCase();
    if (node.class_type === "CLIPTextEncode" && "text" in node.inputs) {
      if (nodeId === "6" || title.includes("positive") || nodeId === textNodeIds[0]) {
        node.inputs.text = options.prompt;
      }
      if (nodeId === "7" || title.includes("negative") || nodeId === textNodeIds[1]) {
        node.inputs.text = options.negativePrompt || "";
      }
    }
    if (["EmptyLatentImage", "EmptySD3LatentImage"].includes(node.class_type)) {
      if ("width" in node.inputs) node.inputs.width = width;
      if ("height" in node.inputs) node.inputs.height = height;
      if ("batch_size" in node.inputs) node.inputs.batch_size = options.batchSize || 1;
    }
    if (node.class_type === "EmptyLTXVLatentVideo") {
      if ("width" in node.inputs) node.inputs.width = width;
      if ("height" in node.inputs) node.inputs.height = height;
      if ("length" in node.inputs) node.inputs.length = options.frames || 73;
      if ("batch_size" in node.inputs) node.inputs.batch_size = options.batchSize || 1;
    }
    if (node.class_type === "CreateVideo" && "fps" in node.inputs) {
      node.inputs.fps = options.fps || 24;
    }
    if (node.class_type === "LTXVConditioning" && "frame_rate" in node.inputs) {
      node.inputs.frame_rate = options.fps || 24;
    }
    if (isVideo && (node.class_type === "INTConstant" || node.class_type === "PrimitiveInt") && "value" in node.inputs) {
      node.inputs.value = options.frames || node.inputs.value;
    }
    if (isVideo && (node.class_type === "FloatConstant" || node.class_type === "PrimitiveFloat") && "value" in node.inputs) {
      node.inputs.value = options.fps || node.inputs.value;
    }
    if (node.class_type === "LoadImage" && options.initImageName && "image" in node.inputs) {
      node.inputs.image = options.initImageName;
    }
    if (node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced") {
      if ("seed" in node.inputs) node.inputs.seed = options.seed;
      if ("steps" in node.inputs) node.inputs.steps = options.steps || node.inputs.steps;
    }
    if (node.class_type === "LTXVScheduler" && "steps" in node.inputs) {
      node.inputs.steps = options.steps || node.inputs.steps;
    }
    if (["SaveImage", "SaveAnimatedPNG", "VHS_VideoCombine", "SaveVideo"].includes(node.class_type)) {
      if ("filename_prefix" in node.inputs) node.inputs.filename_prefix = options.filenamePrefix;
    }
  }
}

async function waitForComfyHistory(promptId, job) {
  const startedAt = Date.now();
  const timeoutMs = clampNumber(process.env.COMFYUI_TIMEOUT_MS, 30000, 7200000, 1800000);
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(2000);
    const history = await comfyFetch(`/history/${encodeURIComponent(promptId)}`);
    const item = history?.[promptId];
    if (item?.status?.status_str === "error") {
      throw new Error(`ComfyUI failed prompt ${promptId}.`);
    }
    if (item?.outputs) return item;
    if (job.stopRequested) throw new Error("Workflow stopped before ComfyUI finished.");
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

async function downloadComfyImage(image) {
  return downloadComfyFile(image);
}

function collectComfyVideos(historyItem) {
  const videos = [];
  for (const output of Object.values(historyItem.outputs || {})) {
    for (const video of output.videos || []) videos.push(video);
    for (const gif of output.gifs || []) videos.push(gif);
  }
  return videos;
}

async function downloadComfyFile(image) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output"
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
  if (!response.ok) {
    throw new Error(data.error?.message || data.raw || `ComfyUI request failed: ${response.status}`);
  }
  return data;
}

async function writeComfyInputImage(job) {
  if (!job.initImage?.dataUrl) throw new Error("Image-to-video requires an input image.");
  const match = job.initImage.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Input image must be a data URL.");
  const mime = match[1].toLowerCase();
  const ext = mime.includes("jpeg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";
  const fileName = `codex-${job.id}${ext}`;
  const targetDir = path.join(comfyRoot, "input");
  const targetPath = path.join(targetDir, fileName);
  if (!targetPath.startsWith(targetDir)) throw new Error("Invalid ComfyUI input path.");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(match[2], "base64"));
  job.initImage = { fileName, originalName: job.initImage.name || fileName };
  await saveJobs();
  return fileName;
}

function framePrompt(basePrompt, frame, previousCount) {
  return [
    basePrompt,
    "",
    `Frame ${frame} in a continuous visual sequence.`,
    previousCount > 0
      ? "Preserve the same subject identity, setting, color logic, camera style, and world details from the previous frame."
      : "Establish the subject, setting, color logic, camera style, and world details clearly.",
    "Add a small natural progression in action, light, camera movement, or atmosphere. Avoid sudden scene changes."
  ].join("\n");
}

async function serveStatic(req, res, url) {
  let filePath;
  if (url.pathname.startsWith("/outputs/")) {
    filePath = path.join(__dirname, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(outputRoot)) {
      sendText(res, 403, "Forbidden");
      return;
    }
  } else {
    const normalized = url.pathname === "/" ? "/index.html" : url.pathname;
    filePath = path.join(publicDir, decodeURIComponent(normalized));
    if (!filePath.startsWith(publicDir)) {
      sendText(res, 403, "Forbidden");
      return;
    }
  }
  if (!existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function publicJob(job) {
  return {
    ...job,
    outputUrl: `/outputs/${job.id}/`
  };
}

function log(job, message) {
  job.logs.push({ at: now(), message });
  if (job.logs.length > 200) job.logs.shift();
  job.updatedAt = now();
}

function failJob(job, message) {
  job.status = "error";
  job.error = message;
  log(job, message);
}

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  if (!existsSync(jobsFile)) await fs.writeFile(jobsFile, "[]\n");
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

async function loadJobs() {
  const raw = await fs.readFile(jobsFile, "utf8");
  const parsed = JSON.parse(raw || "[]");
  parsed.forEach(job => jobs.set(job.id, job));
}

async function saveJobs() {
  await fs.writeFile(jobsFile, JSON.stringify(Array.from(jobs.values()), null, 2));
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  if (!origin) return;
  if (!allowedCorsOrigins.has(origin) && !isLoopbackOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function isLoopbackOrigin(origin) {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function sendCorsOptions(res) {
  res.writeHead(204);
  res.end();
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4"
  }[ext] || "application/octet-stream";
}

function normalizeSize(value) {
  const text = String(value || "720x1280");
  const match = text.match(/^(\d+)x(\d+)$/);
  if (!match) return "720x1280";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64 || width > 4096 || height > 4096) {
    return "720x1280";
  }
  return `${Math.floor(width)}x${Math.floor(height)}`;
}

function soraSize(size) {
  if (["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(size)) return size;
  return size === "1536x1024" ? "1792x1024" : "1024x1792";
}

function normalizeQuality(value) {
  const text = String(value || "medium");
  return ["low", "medium", "high", "auto"].includes(text) ? text : "medium";
}

function normalizeSeconds(value) {
  const text = String(value || "4");
  return ["4", "8", "12"].includes(text) ? text : "4";
}

function normalizeProvider(value) {
  return String(value || "").toLowerCase() === "comfyui" ? "comfyui" : "openai";
}

function normalizeUploadImage(value) {
  if (!value || typeof value !== "object") return null;
  const dataUrl = String(value.dataUrl || "");
  if (!dataUrl.startsWith("data:image/")) return null;
  return {
    name: String(value.name || "input.png").replace(/[\\/:*?"<>|]/g, "_"),
    dataUrl
  };
}

function parseSize(size) {
  const match = String(size || "").match(/^(\d+)x(\d+)$/);
  if (!match) return [1024, 1024];
  return [Number(match[1]), Number(match[2])];
}

function randomSeed() {
  return Math.floor(Math.random() * 1000000000000000);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error?.message || String(error || "Unknown error");
}



