const form = document.querySelector("#workflowForm");
const promptInput = document.querySelector("#promptInput");
const modeInput = document.querySelector("#modeInput");
const imageCountInput = document.querySelector("#imageCountInput");
const sizeInput = document.querySelector("#sizeInput");
const qualityInput = document.querySelector("#qualityInput");
const secondsInput = document.querySelector("#secondsInput");
const continuousInput = document.querySelector("#continuousInput");
const stitchVideoInput = document.querySelector("#stitchVideoInput");
const healthText = document.querySelector("#healthText");
const refreshButton = document.querySelector("#refreshButton");
const extendButton = document.querySelector("#extendButton");
const stopButton = document.querySelector("#stopButton");
const jobSelect = document.querySelector("#jobSelect");
const jobStatus = document.querySelector("#jobStatus");
const mediaGrid = document.querySelector("#mediaGrid");
const logs = document.querySelector("#logs");

let activeJobId = "";
let pollTimer = null;

await refreshHealth();
await loadJobs();
startPolling();

form.addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) {
    jobStatus.textContent = "Prompt is required.";
    return;
  }
  const response = await postJson("/api/workflows", {
    prompt,
    mode: modeInput.value,
    imageCount: Number(imageCountInput.value),
    size: sizeInput.value,
    quality: qualityInput.value,
    seconds: secondsInput.value,
    continuous: continuousInput.checked,
    stitchVideo: stitchVideoInput.checked
  });
  activeJobId = response.job.id;
  await loadJobs();
});

refreshButton.addEventListener("click", loadJobs);

jobSelect.addEventListener("change", async () => {
  activeJobId = jobSelect.value;
  await renderActiveJob();
});

extendButton.addEventListener("click", async () => {
  if (!activeJobId) return;
  await postJson(`/api/workflows/${activeJobId}/extend`, {
    imageCount: Number(imageCountInput.value) || 4
  });
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
    healthText.textContent = health.hasOpenAIKey ? "Ready" : "OPENAI_API_KEY missing";
  } catch (error) {
    healthText.textContent = error.message;
  }
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
    extendButton.disabled = true;
    stopButton.disabled = true;
    return;
  }
  const data = await getJson(`/api/workflows/${activeJobId}`);
  const job = data.job;
  const imageCount = job.images?.length || 0;
  const videoState = job.video ? ` · video ${job.video.status}` : "";
  jobStatus.textContent = `${job.status} · ${imageCount}/${job.targetImages} images${videoState}`;
  extendButton.disabled = job.mode === "video";
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
