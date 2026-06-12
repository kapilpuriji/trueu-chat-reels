// ============================================================================
// REMOTION RENDER SERVER — TrueU.ai Chat Reel Generator
// ============================================================================
// Run locally:  node server.mjs
// Deploy on:    Railway
//
// Async flow (solves n8n / proxy timeout problems):
//   1. POST /render          → returns { jobId } immediately (202)
//   2. GET  /status/:jobId   → returns { status, progress } — poll until done
//   3. GET  /result/:jobId   → streams the MP4 when status === "done"
//
// Sync flow (for direct Postman testing):
//   POST /render-sync        → waits and returns the MP4 directly (may timeout on slow clients)
//
// Other endpoints:
//   GET  /health             → liveness check
//   GET  /                   → usage info
//
// Environment variables:
//   API_KEY    — Bearer token for auth (default: "changeme" for local testing)
//   PORT       — Server port (default: 3000)
//   CHUNK_SIZE — Messages per chunk for long videos (default: 8)
//   RESULT_TTL — Seconds to keep result files after completion (default: 3600)
// ============================================================================

import express from "express";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";

// Cross-platform temp directory
const TMP_DIR = process.platform === "win32" ? os.tmpdir() : "/tmp";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb" }));

const API_KEY = process.env.API_KEY || "changeme";
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "8", 10);
const RESULT_TTL = parseInt(process.env.RESULT_TTL || "3600", 10) * 1000; // ms

// ============================================================================
// IN-MEMORY JOB STORE
// { [jobId]: { status, progress, outputPath, error, createdAt } }
// ============================================================================
const jobs = new Map();

// Clean up finished jobs + their files after TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if ((job.status === "done" || job.status === "failed") &&
        now - job.createdAt > RESULT_TTL) {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try { fs.unlinkSync(job.outputPath); } catch (_) {}
      }
      jobs.delete(id);
    }
  }
}, 60_000);

// ============================================================================
// FIND CHROMIUM
// ============================================================================
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ];

  const isWindows = process.platform === "win32";

  const systemPaths = isWindows
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        process.env.LOCALAPPDATA
          ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
          : null,
      ].filter(Boolean)
    : [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
      ];

  if (!isWindows) {
    try {
      const result = execSync(
        "which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null || echo ''",
        { encoding: "utf-8", shell: "/bin/sh" }
      ).trim();
      if (result) candidates.push(result);
    } catch (_) {}
  }

  for (const p of [...candidates, ...systemPaths]) {
    if (p && fs.existsSync(p)) {
      console.log("Found Chromium at:", p);
      return p;
    }
  }

  console.log("No system Chromium found — Remotion will use its own");
  return null;
}

const BROWSER_PATH = findChromium();

// ============================================================================
// FIND FFMPEG
// ============================================================================
function findFfmpeg() {
  const isWindows = process.platform === "win32";
  if (!isWindows) {
    try {
      const r = execSync("which ffmpeg 2>/dev/null || echo ''", {
        encoding: "utf-8",
        shell: "/bin/sh",
      }).trim();
      if (r && fs.existsSync(r)) {
        console.log("Found ffmpeg at:", r);
        return r;
      }
    } catch (_) {}
  }
  return "ffmpeg";
}

const FFMPEG = findFfmpeg();

// ============================================================================
// BUNDLE
// ============================================================================
const PREBUILT_BUNDLE = path.resolve("./bundle");
let bundleLocation = fs.existsSync(path.join(PREBUILT_BUNDLE, "index.html"))
  ? PREBUILT_BUNDLE
  : null;

if (bundleLocation) {
  console.log("Using pre-built bundle at", bundleLocation);
}

async function warmBundle() {
  if (bundleLocation) return;
  console.log("No pre-built bundle found — bundling Remotion project...");
  bundleLocation = await bundle({
    entryPoint: path.resolve("./src/index.ts"),
    webpackOverride: (config) => config,
  });
  console.log("Bundle ready");
}

// ============================================================================
// VALIDATE + NORMALIZE MESSAGES (shared by both endpoints)
// Returns { messages } or throws { status, error }
// ============================================================================
function validateMessages(body) {
  let parsed = body;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch {
      throw { status: 400, error: "Invalid JSON in request body" };
    }
  }

  const { messages } = parsed || {};

  if (!messages || !Array.isArray(messages)) {
    throw {
      status: 400,
      error: "Missing 'messages' array in request body",
      example: {
        messages: [
          { from: "you", text: "Your message" },
          { from: "partner", text: "Partner reply" },
        ],
      },
    };
  }

  if (messages.length < 2) {
    throw { status: 400, error: "Need at least 2 messages" };
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.from || !["you", "partner"].includes(msg.from)) {
      throw { status: 400, error: `messages[${i}].from must be "you" or "partner", got "${msg.from}"` };
    }
    if (!msg.text || typeof msg.text !== "string" || msg.text.trim() === "") {
      throw { status: 400, error: `messages[${i}].text is missing or empty` };
    }
    messages[i].text = messages[i].text.replace(/—/g, " - ");
  }

  if (messages[0].from !== "you") {
    throw { status: 400, error: 'First message must be from "you" (it becomes the intro hook text)' };
  }

  return messages;
}

// ============================================================================
// RENDER ONE CHUNK
// ============================================================================
async function renderChunk(messages, jobId, chunkIndex, totalChunks, onProgress) {
  const tag = totalChunks > 1 ? `${jobId}-c${chunkIndex}` : jobId;
  const outputPath = path.join(TMP_DIR, `${tag}.mp4`);

  const inputProps = {
    messages,
    contactName: "Thinking Partner",
    contactSubtitle: "TrueU.ai",
    backgroundVideo: "background.mp4",
    backgroundVideoDurationInFrames: 750,
    backgroundDim: 0,
    showSafeZones: false,
    logoImage: "logo.svg",
    enableAudio: true,
  };

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "ChatReel",
    inputProps,
  });

  const durationSec = (composition.durationInFrames / composition.fps).toFixed(1);
  console.log(`[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks}: ${messages.length} msgs, ${durationSec}s`);

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    concurrency: 1,
    chromiumOptions: {
      enableMultiProcessOnLinux: true,
      gl: "swiftshader",
      disableWebSecurity: true,
    },
    ...(BROWSER_PATH ? { browserExecutable: BROWSER_PATH } : {}),
    onProgress: ({ progress }) => {
      if (onProgress) {
        // overall progress = chunk offset + this chunk's share
        const chunkShare = 1 / totalChunks;
        const overall = (chunkIndex * chunkShare) + (progress * chunkShare);
        onProgress(Math.round(overall * 100));
      }
    },
  });

  console.log(`[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks} done → ${outputPath}`);
  return outputPath;
}

// ============================================================================
// CONCAT MP4 FILES WITH FFMPEG
// ============================================================================
function concatVideos(chunkPaths, outputPath, jobId) {
  const listPath = path.join(TMP_DIR, `${jobId}-list.txt`);
  fs.writeFileSync(listPath, chunkPaths.map((p) => `file '${p}'`).join("\n"));

  console.log(`[${jobId}] Concatenating ${chunkPaths.length} chunks...`);

  const result = spawnSync(
    FFMPEG,
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath],
    { encoding: "utf-8", stdio: "pipe" }
  );

  try { fs.unlinkSync(listPath); } catch (_) {}

  if (result.status !== 0) {
    throw new Error(`ffmpeg concat failed:\n${result.stderr}`);
  }

  console.log(`[${jobId}] Concat done → ${outputPath}`);
  return outputPath;
}

// ============================================================================
// SPLIT INTO CHUNKS
// ============================================================================
function splitIntoChunks(messages, chunkSize) {
  if (messages.length <= chunkSize) return [messages];

  const chunks = [];
  let current = [];

  for (let i = 0; i < messages.length; i++) {
    current.push(messages[i]);

    const reachedSize = current.length >= chunkSize;
    const nextIsYou = i + 1 < messages.length && messages[i + 1].from === "you";
    const isLast = i === messages.length - 1;

    if (isLast || (reachedSize && nextIsYou)) {
      chunks.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    chunks[chunks.length - 1].push(...current);
  }

  return chunks;
}

// ============================================================================
// CORE RENDER PIPELINE — used by both async and sync endpoints
// ============================================================================
async function runRender(jobId, messages, onProgress) {
  const finalOutput = path.join(TMP_DIR, `${jobId}-final.mp4`);
  const chunkPaths = [];

  try {
    const chunks = splitIntoChunks(messages, CHUNK_SIZE);
    console.log(`[${jobId}] Split into ${chunks.length} chunk(s): ${chunks.map((c) => c.length).join(", ")} messages`);

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = await renderChunk(chunks[i], jobId, i, chunks.length, onProgress);
      chunkPaths.push(chunkPath);
    }

    let videoPath;
    if (chunks.length === 1) {
      videoPath = chunkPaths[0];
    } else {
      concatVideos(chunkPaths, finalOutput, jobId);
      // clean up individual chunks now that they're merged
      for (const p of chunkPaths) {
        if (p !== finalOutput && fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (_) {}
        }
      }
      videoPath = finalOutput;
    }

    return videoPath;
  } catch (err) {
    // Clean up any partial files
    for (const p of [...chunkPaths, finalOutput]) {
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
    }
    throw err;
  }
}

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ============================================================================
// POST /render  — ASYNC (returns job ID immediately, no timeout risk)
// n8n workflow:
//   1. HTTP Request → POST /render  → save jobId
//   2. Wait node (30s)
//   3. Loop: HTTP Request → GET /status/:jobId → if not done, wait + retry
//   4. HTTP Request → GET /result/:jobId  → binary MP4
// ============================================================================
app.post("/render", requireAuth, (req, res) => {
  let messages;
  try {
    messages = validateMessages(req.body);
  } catch (e) {
    return res.status(e.status).json({ error: e.error, example: e.example });
  }

  if (!bundleLocation) {
    return res.status(503).json({ error: "Server is still starting up. Try again in 30 seconds." });
  }

  const jobId = crypto.randomUUID().slice(0, 8);

  jobs.set(jobId, {
    status: "rendering",
    progress: 0,
    outputPath: null,
    error: null,
    createdAt: Date.now(),
  });

  console.log(`[${jobId}] Job queued: ${messages.length} messages`);

  // Fire and forget — render runs in background
  runRender(jobId, messages, (pct) => {
    const job = jobs.get(jobId);
    if (job) job.progress = pct;
  })
    .then((outputPath) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.progress = 100;
        job.outputPath = outputPath;
        console.log(`[${jobId}] Done → ${outputPath}`);
      }
    })
    .catch((err) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.error = err.message;
        console.error(`[${jobId}] FAILED:`, err.message);
      }
    });

  return res.status(202).json({
    jobId,
    status: "rendering",
    statusUrl: `/status/${jobId}`,
    resultUrl: `/result/${jobId}`,
    message: "Render started. Poll /status/:jobId every 15s, then GET /result/:jobId when done.",
  });
});

// ============================================================================
// GET /status/:jobId — poll this every 15-30 seconds from n8n
// ============================================================================
app.get("/status/:jobId", requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found. It may have expired." });
  }

  return res.json({
    jobId: req.params.jobId,
    status: job.status,       // "rendering" | "done" | "failed"
    progress: job.progress,   // 0-100
    ...(job.error ? { error: job.error } : {}),
    ...(job.status === "done" ? { resultUrl: `/result/${req.params.jobId}` } : {}),
  });
});

// ============================================================================
// GET /result/:jobId — download the MP4 once status === "done"
// ============================================================================
app.get("/result/:jobId", requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found. It may have expired." });
  }
  if (job.status === "rendering") {
    return res.status(202).json({ error: "Still rendering.", progress: job.progress });
  }
  if (job.status === "failed") {
    return res.status(500).json({ error: "Render failed.", detail: job.error });
  }
  if (!job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(410).json({ error: "Result file has expired or was deleted." });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="reel-${req.params.jobId}.mp4"`);
  res.setHeader("Content-Length", fs.statSync(job.outputPath).size);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
  stream.on("error", (err) => {
    console.error(`[${req.params.jobId}] Stream error:`, err.message);
    res.end();
  });
});

// ============================================================================
// POST /render-sync — SYNCHRONOUS (original behavior, for Postman testing)
// WARNING: will timeout if render takes > client timeout (usually 5 min)
// ============================================================================
app.post("/render-sync", requireAuth, async (req, res) => {
  let messages;
  try {
    messages = validateMessages(req.body);
  } catch (e) {
    return res.status(e.status).json({ error: e.error, example: e.example });
  }

  if (!bundleLocation) {
    return res.status(503).json({ error: "Server is still starting up. Try again in 30 seconds." });
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  console.log(`[${jobId}] Sync render: ${messages.length} messages`);

  try {
    const videoPath = await runRender(jobId, messages, null);
    const renderSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Sync done in ${renderSec}s`);

    const stat = fs.statSync(videoPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="reel-${jobId}.mp4"`);
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(videoPath);
    stream.pipe(res);
    stream.on("finish", () => {
      try { fs.unlinkSync(videoPath); } catch (_) {}
    });
    stream.on("error", (err) => {
      console.error(`[${jobId}] Stream error:`, err.message);
      try { fs.unlinkSync(videoPath); } catch (_) {}
      res.end();
    });
  } catch (err) {
    console.error(`[${jobId}] Sync FAILED:`, err.message);
    return res.status(500).json({ error: "Render failed", detail: err.message });
  }
});

// ============================================================================
// GET /health
// ============================================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ready: !!bundleLocation,
    chromium: BROWSER_PATH || "remotion-managed",
    ffmpeg: FFMPEG,
    chunkSize: CHUNK_SIZE,
    activeJobs: [...jobs.values()].filter((j) => j.status === "rendering").length,
    totalJobs: jobs.size,
  });
});

// ============================================================================
// GET /
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    service: "TrueU Chat Reel Renderer",
    status: bundleLocation ? "ready" : "warming up",
    usage: {
      asyncFlow: {
        step1: "POST /render  → { jobId }",
        step2: "GET  /status/:jobId  → poll every 15s until status=done",
        step3: "GET  /result/:jobId  → download MP4",
      },
      syncFlow: "POST /render-sync  → MP4 directly (may timeout for long renders)",
      health: "GET /health",
    },
  });
});

// ============================================================================
// START
// ============================================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  warmBundle()
    .then(() => console.log("Ready for renders"))
    .catch((err) => console.error("Bundle failed:", err.message));
});
