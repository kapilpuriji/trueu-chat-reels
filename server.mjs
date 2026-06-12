// ============================================================================
// REMOTION RENDER SERVER — TrueU.ai Chat Reel Generator
// ============================================================================
// Run locally:  node server.mjs
// Deploy on:    Railway
//
// Test:         GET  http://localhost:3000/health
// Render:       POST http://localhost:3000/render
//
// Environment variables:
//   API_KEY        — Bearer token for auth (default: "changeme" for local testing)
//   PORT           — Server port (default: 3000)
//   CHUNK_SIZE     — Messages per chunk for long videos (default: 20)
//   CONCURRENCY    — Remotion render threads per chunk (default: auto = half CPU cores)
//   MAX_PARALLEL   — Max chunks rendered in parallel (default: 2)
// ============================================================================

import express from "express";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";

// Cross-platform temp directory (/tmp on Linux, os.tmpdir() on Windows)
const TMP_DIR = process.platform === "win32" ? os.tmpdir() : "/tmp";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb" }));

const API_KEY = process.env.API_KEY || "changeme";

// Larger chunks = fewer browser launches = faster overall for long chats
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "20", 10);

// Render threads: each thread handles one frame. Default = half of available cores,
// capped at 8 to avoid memory pressure. Override with CONCURRENCY env var.
const CPU_CORES = os.cpus().length;
const CONCURRENCY = parseInt(
  process.env.CONCURRENCY || String(Math.min(Math.max(Math.floor(CPU_CORES / 2), 1), 8)),
  10
);

// How many chunks to render in parallel. Each parallel chunk opens its own browser,
// so don't set this too high on low-RAM machines.
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || "2", 10);

console.log(`CPU cores: ${CPU_CORES} | render concurrency: ${CONCURRENCY} | parallel chunks: ${MAX_PARALLEL}`);

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
// BROWSER POOL — reuse browser instances across renders to avoid cold-start cost
// ============================================================================
const BROWSER_POOL_SIZE = Math.min(MAX_PARALLEL, 3);
let browserPool = [];

async function initBrowserPool() {
  console.log(`Warming ${BROWSER_POOL_SIZE} browser instance(s)...`);
  const opts = {
    shouldDumpIo: false,
    chromiumOptions: {
      enableMultiProcessOnLinux: true,
      gl: "swiftshader",
      disableWebSecurity: true,
    },
    ...(BROWSER_PATH ? { browserExecutable: BROWSER_PATH } : {}),
  };
  browserPool = await Promise.all(
    Array.from({ length: BROWSER_POOL_SIZE }, () => openBrowser("chrome", opts))
  );
  console.log(`Browser pool ready (${BROWSER_POOL_SIZE} instance(s))`);
}

function acquireBrowser() {
  return browserPool.shift() ?? null;
}

function releaseBrowser(browser) {
  if (browser) browserPool.push(browser);
}

// ============================================================================
// FFMPEG
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
  console.warn("ffmpeg not found on explicit path — relying on PATH");
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

// Cache the composition object so selectComposition isn't called per-chunk
let cachedCompositionConfig = null;

async function warmBundle() {
  if (bundleLocation) {
    await warmCompositionCache();
    return;
  }
  console.log("No pre-built bundle found — bundling Remotion project...");
  bundleLocation = await bundle({
    entryPoint: path.resolve("./src/index.ts"),
    webpackOverride: (config) => config,
  });
  console.log("Bundle ready");
  await warmCompositionCache();
}

// Pre-resolve the static composition config (fps, width, height, codec hints).
// durationInFrames is per-render so we can't cache that part, but everything
// else (fps, width, height) is stable and avoids a round-trip to the browser.
async function warmCompositionCache() {
  if (cachedCompositionConfig) return;
  try {
    const probe = await selectComposition({
      serveUrl: bundleLocation,
      id: "ChatReel",
      inputProps: {
        messages: [
          { from: "you", text: "Hello" },
          { from: "partner", text: "Hi there" },
        ],
        contactName: "Thinking Partner",
        contactSubtitle: "TrueU.ai",
        backgroundVideo: "background.mp4",
        backgroundVideoDurationInFrames: 750,
        backgroundDim: 0,
        showSafeZones: false,
        logoImage: "logo.svg",
        enableAudio: true,
      },
    });
    cachedCompositionConfig = { fps: probe.fps, width: probe.width, height: probe.height };
    console.log(`Composition cached: ${probe.width}x${probe.height} @ ${probe.fps}fps`);
  } catch (e) {
    console.warn("Could not pre-cache composition config:", e.message);
  }
}

// ============================================================================
// RENDER ONE CHUNK
// ============================================================================
async function renderChunk(messages, jobId, chunkIndex, totalChunks) {
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
  console.log(
    `[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks}: ${messages.length} msgs, ${durationSec}s, ${composition.durationInFrames} frames`
  );

  const browser = acquireBrowser();

  try {
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      concurrency: CONCURRENCY,
      // Faster H.264 preset — "ultrafast" cuts encode time by 3-5x vs default "medium"
      x264Preset: "ultrafast",
      // Hardware-friendly pixel format
      pixelFormat: "yuv420p",
      chromiumOptions: {
        enableMultiProcessOnLinux: true,
        gl: "swiftshader",
        disableWebSecurity: true,
      },
      ...(BROWSER_PATH ? { browserExecutable: BROWSER_PATH } : {}),
      ...(browser ? { puppeteerInstance: browser } : {}),
      // Log progress every 10% instead of every frame
      onProgress: ({ progress }) => {
        const pct = Math.round(progress * 100);
        if (pct % 10 === 0) {
          process.stdout.write(`\r[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks}: ${pct}%   `);
        }
      },
    });
  } finally {
    releaseBrowser(browser);
  }

  process.stdout.write("\n");
  console.log(`[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks} done → ${outputPath}`);
  return outputPath;
}

// ============================================================================
// RENDER CHUNKS IN PARALLEL (up to MAX_PARALLEL at a time)
// ============================================================================
async function renderChunksParallel(chunks, jobId) {
  const results = new Array(chunks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < chunks.length) {
      const i = nextIdx++;
      results[i] = await renderChunk(chunks[i], jobId, i, chunks.length);
    }
  }

  const workers = Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ============================================================================
// CONCAT MP4 FILES WITH FFMPEG (stream copy — no re-encode, very fast)
// ============================================================================
function concatVideos(chunkPaths, outputPath, jobId) {
  const listPath = path.join(TMP_DIR, `${jobId}-list.txt`);
  const listContent = chunkPaths.map((p) => `file '${p}'`).join("\n");
  fs.writeFileSync(listPath, listContent);

  console.log(`[${jobId}] Concatenating ${chunkPaths.length} chunks...`);

  const result = spawnSync(
    FFMPEG,
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      outputPath,
    ],
    { encoding: "utf-8", stdio: "pipe" }
  );

  fs.unlinkSync(listPath);

  if (result.status !== 0) {
    throw new Error(`ffmpeg concat failed:\n${result.stderr}`);
  }

  console.log(`[${jobId}] Concat done → ${outputPath}`);
  return outputPath;
}

// ============================================================================
// SPLIT messages into chunks
// Each chunk must start with a "you" message (required by ChatReel).
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
// POST /render
// ============================================================================
app.post("/render", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON in request body" });
    }
  }

  const { messages } = body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: "Missing 'messages' array in request body",
      example: {
        messages: [
          { from: "you", text: "Your message" },
          { from: "partner", text: "Partner reply" },
        ],
      },
    });
  }

  if (messages.length < 2) {
    return res.status(400).json({ error: "Need at least 2 messages" });
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (!msg.from || !["you", "partner"].includes(msg.from)) {
      return res.status(400).json({
        error: `messages[${i}].from must be "you" or "partner", got "${msg.from}"`,
      });
    }

    if (!msg.text || typeof msg.text !== "string" || msg.text.trim() === "") {
      return res.status(400).json({
        error: `messages[${i}].text is missing or empty`,
      });
    }

    messages[i].text = messages[i].text.replace(/—/g, " - ");
  }

  if (messages[0].from !== "you") {
    return res.status(400).json({
      error: 'First message must be from "you" (it becomes the intro hook text)',
    });
  }

  if (!bundleLocation) {
    return res.status(503).json({
      error: "Server is still starting up. Try again in 30 seconds.",
    });
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  const finalOutput = path.join(TMP_DIR, `${jobId}-final.mp4`);
  let chunkPaths = [];

  console.log(
    `[${jobId}] Request: ${messages.length} messages, CHUNK_SIZE=${CHUNK_SIZE}, concurrency=${CONCURRENCY}, parallel=${MAX_PARALLEL}`
  );

  try {
    const chunks = splitIntoChunks(messages, CHUNK_SIZE);
    console.log(
      `[${jobId}] Split into ${chunks.length} chunk(s): ${chunks.map((c) => c.length).join(", ")} messages`
    );

    // Render chunks — parallel when there are multiple
    chunkPaths = await renderChunksParallel(chunks, jobId);

    let videoPath;
    if (chunks.length === 1) {
      videoPath = chunkPaths[0];
    } else {
      concatVideos(chunkPaths, finalOutput, jobId);
      videoPath = finalOutput;
    }

    const renderSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Total done in ${renderSec}s`);

    const videoBuffer = fs.readFileSync(videoPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="reel-${jobId}.mp4"`
    );
    return res.send(videoBuffer);
  } catch (err) {
    console.error(`[${jobId}] FAILED:`, err.message);
    return res.status(500).json({ error: "Render failed", detail: err.message });
  } finally {
    for (const p of [...chunkPaths, finalOutput]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
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
    concurrency: CONCURRENCY,
    maxParallelChunks: MAX_PARALLEL,
    browserPoolSize: browserPool.length,
  });
});

// ============================================================================
// GET /
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    service: "TrueU Chat Reel Renderer",
    status: bundleLocation ? "ready" : "warming up",
    chunkSize: CHUNK_SIZE,
    concurrency: CONCURRENCY,
    maxParallelChunks: MAX_PARALLEL,
    usage: {
      health: "GET /health",
      render: "POST /render with { messages: [...] }  — no message limit",
    },
  });
});

// ============================================================================
// START
// ============================================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  try {
    await warmBundle();
    await initBrowserPool();
    console.log("Ready for renders");
  } catch (err) {
    console.error("Startup failed:", err.message);
  }
});
