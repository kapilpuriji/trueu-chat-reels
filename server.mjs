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
//   CHUNK_SIZE     — Messages per chunk for long videos (default: 15)
//   CONCURRENCY    — Remotion render threads per chunk (default: 2, keep low on Railway)
// ============================================================================

import express from "express";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";

const TMP_DIR = process.platform === "win32" ? os.tmpdir() : "/tmp";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb" }));

const API_KEY = process.env.API_KEY || "changeme";
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "15", 10);

// Keep concurrency LOW on Railway (limited RAM). Each extra thread = ~150MB Chrome tab.
// Default 2 is safe on 512MB; bump to 4 only if you have 1GB+.
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "2", 10);

// OffthreadVideo cache — how much RAM to use for decoded video frames.
// 128MB is safe on Railway. Remotion default is 512MB which OOMs small containers.
const VIDEO_CACHE_MB = parseInt(process.env.VIDEO_CACHE_MB || "128", 10);

console.log(`concurrency=${CONCURRENCY} | videoCache=${VIDEO_CACHE_MB}MB | chunkSize=${CHUNK_SIZE}`);

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
// FFMPEG
// ============================================================================
function findFfmpeg() {
  if (process.platform !== "win32") {
    try {
      const r = execSync("which ffmpeg 2>/dev/null || echo ''", {
        encoding: "utf-8",
        shell: "/bin/sh",
      }).trim();
      if (r && fs.existsSync(r)) return r;
    } catch (_) {}
  }
  return "ffmpeg";
}

const FFMPEG = findFfmpeg();

// ============================================================================
// BUNDLE — use pre-built if present, otherwise build once at startup
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
  console.log("Bundling Remotion project...");
  bundleLocation = await bundle({
    entryPoint: path.resolve("./src/index.ts"),
    webpackOverride: (config) => config,
  });
  console.log("Bundle ready at", bundleLocation);
}

// ============================================================================
// RENDER ONE CHUNK
// ============================================================================
async function renderChunk(messages, jobId, chunkIndex, totalChunks) {
  const tag = totalChunks > 1 ? `${jobId}-c${chunkIndex}` : jobId;
  const outputPath = path.join(TMP_DIR, `${tag}.mp4`);

  // backgroundVideo is disabled on Railway: OffthreadVideo uses a Rust compositor
  // that gets SIGKILL'd on constrained containers. The solid theme background still
  // looks great. Re-enable locally with ENABLE_BG_VIDEO=1 if needed.
  const inputProps = {
    messages,
    contactName: "Thinking Partner",
    contactSubtitle: "TrueU.ai",
    backgroundVideo: process.env.ENABLE_BG_VIDEO === "1" ? "background.mp4" : null,
    backgroundVideoDurationInFrames: 750,
    backgroundDim: 0,
    showSafeZones: false,
    logoImage: "logo.svg",
    enableAudio: true,
  };

  // selectComposition must use the bundle's serveUrl so Remotion's internal
  // static-file server is used for background.mp4 — NOT the Express server port.
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "ChatReel",
    inputProps,
    timeoutInMilliseconds: 120_000,
  });

  const durationSec = (composition.durationInFrames / composition.fps).toFixed(1);
  console.log(
    `[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks}: ${messages.length} msgs, ` +
    `${composition.durationInFrames} frames (${durationSec}s)`
  );

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    // Give each frame up to 2 minutes to load assets (orb PNGs, fonts, video).
    // Default is 30s which is too short for Railway's cold filesystem on first render.
    timeoutInMilliseconds: 120_000,
    // Faster H.264: ultrafast preset cuts encode time 3-5x vs default "medium"
    x264Preset: "ultrafast",
    pixelFormat: "yuv420p",
    // Limit concurrent frame tabs — key for Railway RAM constraint
    concurrency: CONCURRENCY,
    // Cap OffthreadVideo frame cache to avoid OOM on Railway
    offthreadVideoCacheSizeInBytes: VIDEO_CACHE_MB * 1024 * 1024,
    chromiumOptions: {
      // Single-process Chrome uses much less RAM (~200MB vs ~400MB multi-process)
      enableMultiProcessOnLinux: false,
      gl: "swiftshader",
      disableWebSecurity: true,
    },
    ...(BROWSER_PATH ? { browserExecutable: BROWSER_PATH } : {}),
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      if (pct % 10 === 0) {
        process.stdout.write(`\r[${jobId}] chunk ${chunkIndex + 1}/${totalChunks}: ${pct}%  `);
      }
    },
  });

  process.stdout.write("\n");
  console.log(`[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks} done → ${outputPath}`);
  return outputPath;
}

// ============================================================================
// CONCAT MP4 FILES WITH FFMPEG (stream copy — no re-encode)
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

  fs.unlinkSync(listPath);

  if (result.status !== 0) {
    throw new Error(`ffmpeg concat failed:\n${result.stderr}`);
  }

  console.log(`[${jobId}] Concat done → ${outputPath}`);
}

// ============================================================================
// SPLIT messages into chunks (each chunk starts with a "you" message)
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
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON in request body" }); }
  }

  const { messages } = body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: "Missing 'messages' array in request body",
      example: { messages: [{ from: "you", text: "Hi" }, { from: "partner", text: "Hello" }] },
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
      return res.status(400).json({ error: `messages[${i}].text is missing or empty` });
    }
    messages[i].text = messages[i].text.replace(/—/g, " - ");
  }

  if (messages[0].from !== "you") {
    return res.status(400).json({
      error: 'First message must be from "you" (it becomes the intro hook text)',
    });
  }

  if (!bundleLocation) {
    return res.status(503).json({ error: "Server is still warming up. Retry in 30s." });
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  const finalOutput = path.join(TMP_DIR, `${jobId}-final.mp4`);
  let chunkPaths = [];

  console.log(`[${jobId}] ${messages.length} messages, chunkSize=${CHUNK_SIZE}, concurrency=${CONCURRENCY}`);

  try {
    const chunks = splitIntoChunks(messages, CHUNK_SIZE);
    console.log(`[${jobId}] ${chunks.length} chunk(s): [${chunks.map((c) => c.length).join(", ")}] messages`);

    // Render chunks sequentially to keep peak RAM predictable on Railway.
    // Parallel rendering is faster but risks OOM on constrained containers.
    for (let i = 0; i < chunks.length; i++) {
      chunkPaths.push(await renderChunk(chunks[i], jobId, i, chunks.length));
    }

    let videoPath;
    if (chunks.length === 1) {
      videoPath = chunkPaths[0];
    } else {
      concatVideos(chunkPaths, finalOutput, jobId);
      videoPath = finalOutput;
    }

    const renderSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Done in ${renderSec}s`);

    const videoBuffer = fs.readFileSync(videoPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="reel-${jobId}.mp4"`);
    return res.send(videoBuffer);
  } catch (err) {
    console.error(`[${jobId}] FAILED:`, err.message);
    return res.status(500).json({ error: "Render failed", detail: err.message });
  } finally {
    for (const p of [...chunkPaths, finalOutput]) {
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
    }
  }
});

// ============================================================================
// GET /health
// ============================================================================
app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    ready: !!bundleLocation,
    chromium: BROWSER_PATH || "remotion-managed",
    ffmpeg: FFMPEG,
    chunkSize: CHUNK_SIZE,
    concurrency: CONCURRENCY,
    videoCache: `${VIDEO_CACHE_MB}MB`,
    memoryUsedMB: Math.round(mem.rss / 1024 / 1024),
  });
});

// ============================================================================
// GET /
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    service: "TrueU Chat Reel Renderer",
    status: bundleLocation ? "ready" : "warming up",
    usage: { health: "GET /health", render: "POST /render with { messages: [...] }" },
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
