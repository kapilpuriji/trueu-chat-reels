// ============================================================================
// REMOTION RENDER SERVER — TrueU.ai Chat Reel Generator
// ============================================================================
// Run locally:  node server.mjs
// Deploy on:    Render.com or Railway
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
import { execSync } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.API_KEY || "changeme";

// ============================================================================
// FIND CHROMIUM — checks system paths + Remotion's download
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
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
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
    return res.status(400).json({ error: "Max 20 messages (video would be too long)" });
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

    // Clean em dashes silently
    messages[i].text = messages[i].text.replace(/—/g, " - ");
  }

  if (messages[0].from !== "you") {
    return res.status(400).json({
      error: 'First message must be from "you" (it becomes the intro hook text)',
    });
  }
  

  // ---- Check server is ready ----
  if (!bundleLocation) {
    return res.status(503).json({
      error: "Server is still starting up. Try again in 30 seconds.",
    });
  }

  // ---- Render ----
  const jobId = crypto.randomUUID().slice(0, 8);
  const outputPath = path.join("/tmp", `${jobId}.mp4`);
  const startTime = Date.now();

  console.log(`[${jobId}] Rendering ${messages.length} messages...`);

  try {
    // These props override defaultMessages in messages.ts
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

    // Calculate video duration from the messages
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "ChatReel",
      inputProps,
    });

    const durationSec = (composition.durationInFrames / composition.fps).toFixed(1);
    console.log(`[${jobId}] Video will be ${durationSec}s (${composition.durationInFrames} frames)`);

    // Render MP4
    // concurrency: 1 — keep memory low on Railway (1080x1920 + h264 is heavy).
    // gl: "swiftshader" — software GL; hardware GL is not available in the container.
    // enableMultiProcessOnLinux — needed when running Chromium as root in Docker.
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

    const renderSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Done in ${renderSec}s`);

    // Send MP4 file back
    const videoBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="reel-${jobId}.mp4"`);
    return res.send(videoBuffer);
  } catch (err) {
    console.error(`[${jobId}] FAILED:`, err.message);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return res.status(500).json({ error: "Render failed", detail: err.message });
  }
});

// ============================================================================
// GET /health — Check if server is ready
// ============================================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ready: !!bundleLocation,
    chromium: BROWSER_PATH || "remotion-managed",
  });
});

// ============================================================================
// GET / — Root route (needed for Railway/Render health checks)
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
    .catch((err) => console.error("Bundle failed:", err.message));
});
