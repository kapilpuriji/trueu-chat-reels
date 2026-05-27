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
//   API_KEY   — Bearer token for auth (default: "changeme" for local testing)
//   PORT      — Server port (default: 3000)
//   CHUNK_SIZE — Messages per chunk for long videos (default: 8)
// ============================================================================

import express from "express";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";

const app = express();
// Increase body size limit — long chat transcripts can be large JSON
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb" }));

const API_KEY = process.env.API_KEY || "changeme";

// How many messages per chunk before we split into separate renders and concat.
// Each chunk gets its OWN intro + outro so every segment is self-contained.
// After rendering all chunks they are concatenated with ffmpeg (no re-encode).
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "8", 10);

// ============================================================================
// FIND CHROMIUM
// ============================================================================
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ];

  const systemPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];

  try {
    const result = execSync(
      "which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null || echo ''",
      { encoding: "utf-8" }
    ).trim();
    if (result) candidates.push(result);
  } catch (_) {}

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
// CHECK FFMPEG — needed for chunk concatenation
// ============================================================================
function findFfmpeg() {
  try {
    const r = execSync("which ffmpeg 2>/dev/null || echo ''", { encoding: "utf-8" }).trim();
    if (r && fs.existsSync(r)) {
      console.log("Found ffmpeg at:", r);
      return r;
    }
  } catch (_) {}
  console.warn("ffmpeg not found — chunked concat will fail for large chats");
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
// RENDER ONE CHUNK
// Returns the output file path.
// ============================================================================
async function renderChunk(messages, jobId, chunkIndex, totalChunks) {
  const tag = totalChunks > 1 ? `${jobId}-c${chunkIndex}` : jobId;
  const outputPath = path.join("/tmp", `${tag}.mp4`);

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
    `[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks}: ${messages.length} msgs, ${durationSec}s`
  );

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
  });

  console.log(`[${jobId}] Chunk ${chunkIndex + 1}/${totalChunks} done → ${outputPath}`);
  return outputPath;
}

// ============================================================================
// CONCAT MP4 FILES WITH FFMPEG (stream copy — no re-encode, very fast)
// ============================================================================
function concatVideos(chunkPaths, outputPath, jobId) {
  // Write a concat list file
  const listPath = path.join("/tmp", `${jobId}-list.txt`);
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
      "-c", "copy",        // stream copy — no re-encode
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
// We walk the array and cut a new chunk whenever:
//   a) we've hit CHUNK_SIZE messages in the current chunk AND
//   b) the NEXT message is from "you" (so the chunk boundary is clean).
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

  // Safety: if current still has items (e.g. trailing partner message), append
  if (current.length > 0) {
    // Merge into last chunk rather than having a chunk that starts with "partner"
    chunks[chunks.length - 1].push(...current);
  }

  return chunks;
}

// ============================================================================
// POST /render
// ============================================================================
app.post("/render", async (req, res) => {
  // ---- Auth ----
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ---- Parse body — accept both JSON and plain-text JSON ----
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON in request body" });
    }
  }

  const { messages } = body || {};

  // ---- Validate ----
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

  // NO upper limit — we chunk large conversations automatically.

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

    // Clean em dashes silently
    messages[i].text = messages[i].text.replace(/—/g, " - ");
  }

  if (messages[0].from !== "you") {
    return res.status(400).json({
      error: 'First message must be from "you" (it becomes the intro hook text)',
    });
  }

  // ---- Server ready? ----
  if (!bundleLocation) {
    return res.status(503).json({
      error: "Server is still starting up. Try again in 30 seconds.",
    });
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  const finalOutput = path.join("/tmp", `${jobId}-final.mp4`);
  const chunkPaths = [];

  console.log(
    `[${jobId}] Request: ${messages.length} messages, CHUNK_SIZE=${CHUNK_SIZE}`
  );

  try {
    const chunks = splitIntoChunks(messages, CHUNK_SIZE);
    console.log(
      `[${jobId}] Split into ${chunks.length} chunk(s): ${chunks.map((c) => c.length).join(", ")} messages`
    );

    // Render all chunks sequentially (keeps memory manageable)
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = await renderChunk(chunks[i], jobId, i, chunks.length);
      chunkPaths.push(chunkPath);
    }

    let videoPath;
    if (chunks.length === 1) {
      // Single chunk — just send it directly
      videoPath = chunkPaths[0];
    } else {
      // Multiple chunks — concatenate
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
    // Cleanup all temp files
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  warmBundle()
    .then(() => console.log("Ready for renders"))
    .catch((err) => console.error("Bundle failed:", err.message));
});
