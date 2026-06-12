// ============================================================================
// REMOTION RENDER SERVER — TrueU.ai Chat Reel Generator
// ============================================================================
// Run locally:  node server.mjs
// Deploy on:    Railway (Dockerfile)
//
// Test:         GET  http://localhost:3000/health
// Render:       POST http://localhost:3000/render
//
// Environment variables:
//   API_KEY   — Bearer token for auth (default: "changeme" for local testing)
//   PORT      — Server port (default: 3000)
// ============================================================================

import express from "express";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.API_KEY || "changeme";

// ============================================================================
// FIND CHROMIUM — checks env vars then known system paths
// ============================================================================
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];

  for (const p of candidates) {
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
// BUNDLE REMOTION PROJECT
// Prefer the pre-built bundle (produced at Docker build time by prebundle.mjs).
// Fall back to bundling at runtime for local `node server.mjs` use.
// ============================================================================
const PREBUILT_BUNDLE = path.resolve("./bundle");
let bundleLocation = fs.existsSync(path.join(PREBUILT_BUNDLE, "index.html"))
  ? PREBUILT_BUNDLE
  : null;

if (bundleLocation) {
  console.log("Using pre-built bundle at", bundleLocation);
}

// Only one render at a time — swiftshader at 1080x1920 uses ~600MB per Chrome
// tab; stacking renders causes "Page crashed" OOM even on 8GB containers.
let activeRenders = 0;
const MAX_CONCURRENT_RENDERS = 1;

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
// POST /render — Send messages JSON, get MP4 video back
//
// Headers:
//   Authorization: Bearer changeme
//   Content-Type: application/json
//
// Body:
// {
//   "messages": [
//     { "from": "you", "text": "Your message here" },
//     { "from": "partner", "text": "Partner reply here" }
//   ]
// }
//
// Response: MP4 video file (binary)
// ============================================================================
app.post("/render", async (req, res) => {
  // ---- Auth ----
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ---- Check server is ready ----
  if (!bundleLocation) {
    return res.status(503).json({
      error: "Server is still starting up. Try again in 30 seconds.",
    });
  }

  // ---- Reject if too many renders running ----
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    return res.status(429).json({
      error: "Server busy — too many renders in progress. Try again shortly.",
    });
  }

  // ---- Get messages from request body ----
  const { messages } = req.body;

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

  if (messages.length > 20) {
    return res.status(400).json({
      error: "Max 20 messages (video would be too long)",
    });
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

    // Sanitize: replace em dashes (break font rendering) and trim whitespace
    messages[i].text = messages[i].text.replace(/—/g, " - ").trim();

    // Cap very long messages so render stays fast.
    // "you" messages: long text = many typing frames. Cap at 200 chars.
    // "partner" messages: long text = long word-stream. Cap at 400 chars.
    const charLimit = msg.from === "you" ? 200 : 400;
    if (messages[i].text.length > charLimit) {
      messages[i].text = messages[i].text.slice(0, charLimit).trimEnd() + "...";
    }
  }

  if (messages[0].from !== "you") {
    return res.status(400).json({
      error: 'First message must be from "you" (it becomes the intro hook text)',
    });
  }

  // ---- Render ----
  const jobId = crypto.randomUUID().slice(0, 8);
  const outputPath = path.join("/tmp", `${jobId}.mp4`);
  const startTime = Date.now();

  activeRenders++;
  console.log(
    `[${jobId}] START — ${messages.length} messages | activeRenders=${activeRenders}`
  );

  try {
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

    // selectComposition calculates exact video duration from the messages
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "ChatReel",
      inputProps,
      timeoutInMilliseconds: 30000,
    });

    const durationSec = (composition.durationInFrames / composition.fps).toFixed(1);
    console.log(
      `[${jobId}] ${durationSec}s video (${composition.durationInFrames} frames @ ${composition.fps}fps)`
    );

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,

      // concurrency:1 — one Chrome tab at a time prevents "Page crashed" OOM.
      // swiftshader uses ~600MB per tab at 1080x1920; even 2 tabs can exceed 8GB
      // when combined with ffmpeg + Node heap during the stitch phase.
      concurrency: 1,
      jpegQuality: 60,               // lower = smaller per-frame buffer = less RAM
      x264Preset: "veryfast",        // fast encode, no visible quality diff for reels
      timeoutInMilliseconds: 600000, // 10-minute ceiling per render

      chromiumOptions: {
        enableMultiProcessOnLinux: true, // required when running as root in Docker
        gl: "swiftshader",               // software GL — no GPU in Railway containers
        disableWebSecurity: true,
        ignoreCertificateErrors: true,
      },

      ...(BROWSER_PATH ? { browserExecutable: BROWSER_PATH } : {}),

      onProgress: ({ progress }) => {
        const pct = Math.round(progress * 100);
        if (pct % 20 === 0) {
          console.log(`[${jobId}] ${pct}%`);
        }
      },
    });

    const renderSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const stat = fs.statSync(outputPath);
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`[${jobId}] DONE in ${renderSec}s — ${sizeMb}MB`);

    // Stream MP4 back directly — avoids loading whole file into memory
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="reel-${jobId}.mp4"`
    );

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on("end", () => {
      fs.unlink(outputPath, () => {}); // cleanup after send
    });
    readStream.on("error", (streamErr) => {
      console.error(`[${jobId}] Stream error:`, streamErr.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream video" });
      }
    });

    return; // response handled by stream
  } catch (err) {
    console.error(`[${jobId}] FAILED in ${((Date.now() - startTime) / 1000).toFixed(1)}s:`, err.message);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Render failed", detail: err.message });
    }
  } finally {
    activeRenders--;
    console.log(`[${jobId}] END — activeRenders=${activeRenders}`);
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
    activeRenders,
    chromium: BROWSER_PATH || "remotion-managed",
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

// ============================================================================
// GET / — Root route (Railway health check)
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    service: "TrueU Chat Reel Renderer",
    status: bundleLocation ? "ready" : "warming up",
    usage: {
      health: "GET /health",
      render: "POST /render with { messages: [...] }",
    },
  });
});

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  warmBundle()
    .then(() => console.log("Ready for renders"))
    .catch((err) => {
      console.error("Bundle failed:", err.message);
      process.exit(1); // crash fast so Railway restarts with a clean state
    });
});
