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

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3027);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const defaultImageModel = process.env.DEFAULT_IMAGE_MODEL || "gpt-image-1.5";
const defaultVideoModel = process.env.DEFAULT_VIDEO_MODEL || "sora-2";

const jobs = new Map();
const running = new Map();

await ensureStore();
await loadJobs();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);
    if (url.pathname.startsWith("/api/")) {
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
      publicBaseUrl
    });
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
  const imageCount = clampNumber(payload.imageCount, 1, 96, 6);
  const mode = ["images", "video", "both"].includes(payload.mode) ? payload.mode : "images";
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
    size: normalizeSize(payload.size),
    quality: normalizeQuality(payload.quality),
    seconds: normalizeSeconds(payload.seconds),
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
    if (!job.stopRequested && (job.mode === "video" || job.mode === "both")) {
      await generateSoraVideo(job);
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

async function loadJobs() {
  const raw = await fs.readFile(jobsFile, "utf8");
  const parsed = JSON.parse(raw || "[]");
  parsed.forEach(job => jobs.set(job.id, job));
}

async function saveJobs() {
  await fs.writeFile(jobsFile, JSON.stringify(Array.from(jobs.values()), null, 2));
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
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
  return ["1024x1024", "1024x1536", "1536x1024", "720x1280", "1280x720", "1024x1792", "1792x1024"].includes(text)
    ? text
    : "720x1280";
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
