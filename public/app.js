const form = document.querySelector("#workflowForm");
const promptInput = document.querySelector("#promptInput");
const providerInput = document.querySelector("#providerInput");
const comfyWorkflowSelect = document.querySelector("#comfyWorkflowSelect");
const modeInput = document.querySelector("#modeInput");
const sizeInput = document.querySelector("#sizeInput");
const qualityField = document.querySelector("#qualityField");
const qualityInput = document.querySelector("#qualityInput");
const secondsField = document.querySelector("#secondsField");
const secondsInput = document.querySelector("#secondsInput");
const videoFpsInput = document.querySelector("#videoFpsInput");
const videoFramesInput = document.querySelector("#videoFramesInput");
const stepsInput = document.querySelector("#stepsInput");
const fpsField = document.querySelector("#fpsField");
const framesField = document.querySelector("#framesField");
const initImageField = document.querySelector("#initImageField");
const initImageInput = document.querySelector("#initImageInput");
const healthText = document.querySelector("#healthText");
const refreshButton = document.querySelector("#refreshButton");
const stopButton = document.querySelector("#stopButton");
const jobSelect = document.querySelector("#jobSelect");
const jobStatus = document.querySelector("#jobStatus");
const mediaGrid = document.querySelector("#mediaGrid");
const logs = document.querySelector("#logs");

let activeJobId = "";
let pollTimer = null;
let comfyWorkflows = [];

await refreshHealth();
await loadComfyWorkflows();
await loadJobs();
startPolling();

form.addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) {
    jobStatus.textContent = "Prompt is required.";
    return;
  }
  const workflow = selectedWorkflow();
  const workflowName = workflow?.name || comfyWorkflowSelect.value;
  const response = await postJson("/api/workflows", {
    prompt,
    provider: providerInput.value,
    comfyImageWorkflow: workflowName,
    comfyVideoWorkflow: workflowName,
    comfyImageToVideoWorkflow: workflowName,
    mode: modeInput.value,
    imageCount: 1,
    size: sizeInput.value,
    quality: qualityInput.value,
    seconds: secondsInput.value,
    videoFps: Number(videoFpsInput.value),
    videoFrames: Number(videoFramesInput.value),
    steps: Number(stepsInput.value),
    initImage: await readInitImage(),
    continuous: false,
    stitchVideo: false
  });
  activeJobId = response.job.id;
  await loadJobs();
});

refreshButton.addEventListener("click", loadJobs);

comfyWorkflowSelect.addEventListener("change", applySelectedWorkflow);
providerInput.addEventListener("change", applySelectedWorkflow);

jobSelect.addEventListener("change", async () => {
  activeJobId = jobSelect.value;
  await renderActiveJob();
});

stopButton.addEventListener("click", async () => {
  if (!activeJobId) return;
  await postJson(`/api/workflows/${activeJobId}/stop`, {});
  await renderActiveJob();
});

async function refreshHealth() {
  try {
    const health = await getJson("/api/health");
    providerInput.value = health.mediaProvider || providerInput.value;
    healthText.textContent = health.mediaProvider === "comfyui"
      ? `ComfyUI ${health.comfyBaseUrl}`
      : (health.hasOpenAIKey ? "Ready" : "OPENAI_API_KEY missing");
  } catch (error) {
    healthText.textContent = error.message;
  }
}

async function loadComfyWorkflows() {
  const data = await getJson("/api/comfy/workflows");
  comfyWorkflows = data.workflows || [];
  comfyWorkflowSelect.innerHTML = "";
  comfyWorkflows.forEach(workflow => {
    const option = document.createElement("option");
    option.value = workflow.name;
    option.textContent = `${workflowLabel(workflow.kind)} · ${workflow.name}`;
    comfyWorkflowSelect.append(option);
  });
  const preferred = comfyWorkflows.find(workflow => workflow.name === "unsloth_qwen_image_2512")
    || comfyWorkflows.find(workflow => workflow.kind === "image")
    || comfyWorkflows[0];
  if (preferred) comfyWorkflowSelect.value = preferred.name;
  applySelectedWorkflow();
}

function selectedWorkflow() {
  return comfyWorkflows.find(workflow => workflow.name === comfyWorkflowSelect.value);
}

function applySelectedWorkflow() {
  const workflow = selectedWorkflow();
  if (!workflow) return;
  modeInput.value = workflow.kind === "image-video" ? "image-video" : workflow.kind === "video" ? "video" : "images";
  if (workflow.defaults?.size) sizeInput.value = workflow.defaults.size;
  if (workflow.defaults?.fps) videoFpsInput.value = workflow.defaults.fps;
  if (workflow.defaults?.frames) videoFramesInput.value = workflow.defaults.frames;
  if (workflow.defaults?.steps) stepsInput.value = workflow.defaults.steps;
  const isVideo = workflow.kind === "video" || workflow.kind === "image-video";
  const isOpenAI = providerInput.value === "openai";
  qualityField.hidden = !isOpenAI;
  secondsField.hidden = !isOpenAI;
  fpsField.hidden = !isVideo;
  framesField.hidden = !isVideo;
  initImageField.hidden = workflow.kind !== "image-video";
}

function workflowLabel(kind) {
  return {
    image: "文生图",
    video: "文生视频",
    "image-video": "图生视频",
    unknown: "未知"
  }[kind] || kind;
}

function readInitImage() {
  const file = initImageInput.files?.[0];
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
    reader.onerror = () => reject(reader.error || new Error("Image read failed."));
    reader.readAsDataURL(file);
  });
}

async function loadJobs() {
  const data = await getJson("/api/workflows");
  if (!activeJobId && data.jobs.length) activeJobId = data.jobs[0].id;
  jobSelect.innerHTML = "";
  data.jobs.forEach(job => {
    const option = document.createElement("option");
    option.value = job.id;
    option.textContent = `${job.status} · ${job.prompt.slice(0, 48)}`;
    option.selected = job.id === activeJobId;
    jobSelect.append(option);
  });
  await renderActiveJob();
}

async function renderActiveJob() {
  if (!activeJobId) {
    jobStatus.textContent = "No workflow selected.";
    mediaGrid.innerHTML = "";
    logs.innerHTML = "";
    stopButton.disabled = true;
    return;
  }
  const data = await getJson(`/api/workflows/${activeJobId}`);
  const job = data.job;
  const hasImage = (job.images?.length || 0) > 0;
  const videoState = job.video ? ` · video ${job.video.status}` : "";
  const outputState = hasImage ? "image ready" : "waiting for output";
  jobStatus.textContent = `${job.status} · ${job.provider || "openai"} · ${outputState}${videoState}`;
  stopButton.disabled = !["queued", "running"].includes(job.status);
  mediaGrid.innerHTML = "";
  (job.images || []).forEach(image => {
    mediaGrid.append(mediaItem("img", image.path, `Frame ${image.index}`));
  });
  if (job.video?.path) {
    mediaGrid.prepend(mediaItem("video", job.video.path, "Sora video"));
  }
  if (job.stitchedVideo) {
    mediaGrid.prepend(mediaItem("video", job.stitchedVideo, "Image sequence MP4"));
  }
  logs.innerHTML = (job.logs || [])
    .slice()
    .reverse()
    .map(item => `<div>${escapeHtml(item.at)} ${escapeHtml(item.message)}</div>`)
    .join("");
}

function mediaItem(type, src, caption) {
  const item = document.createElement("article");
  item.className = "media-item";
  const media = document.createElement(type);
  media.src = src;
  if (type === "video") {
    media.controls = true;
  } else {
    media.alt = caption;
    media.loading = "lazy";
  }
  const text = document.createElement("div");
  text.className = "media-caption";
  text.textContent = caption;
  item.append(media, text);
  return item;
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (activeJobId) await renderActiveJob();
  }, 3000);
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
