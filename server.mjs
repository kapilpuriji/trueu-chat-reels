// ============================================================================
// REMOTION RENDER SERVER — TrueU.ai Chat Reel Generator
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
// FIND CHROMIUM
// ============================================================================
function findChromium() {
  const paths = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];

  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      console.log("Found Chromium at:", p);
      return p;
    }
  }

  try {
    const result = execSync("which chromium || which chromium-browser || echo ''", { encoding: "utf-8" }).trim();
    if (result && fs.existsSync(result)) {
      console.log("Found Chromium via which:", result);
      return result;
    }
  } catch (_) {}

  console.log("No system Chromium — Remotion will use its own");
  return null;
}

const BROWSER_PATH = findChromium();

// ============================================================================
// BUNDLE — use pre-built if available, otherwise bundle at runtime
// ============================================================================
const PREBUILT_BUNDLE = path.resolve("./bundle");
let bundleLocation = null;

// Check for pre-built bundle (created during Docker build by prebundle.mjs)
if (fs.existsSync(path.join(PREBUILT_BUNDLE, "index.html"))) {
  bundleLocation = PREBUILT_BUNDLE;
  console.log("Using pre-built bundle at", bundleLocation);
} else {
  console.log("No pre-built bundle found — will bundle at runtime");
}

async function warmBundle() {
  if (bundleLocation) return; // already have pre-built bundle
  console.log("Bundling Remotion project...");
  bundleLocation = await bundle({
    entryPoint: path.resolve("./src/index.ts"),
    webpackOverride: (config) => config,
  });
  console.log("Bundle ready at", bundleLocation);
}

// ============================================================================
// POST /render
// ============================================================================
app.post("/render", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: "Missing 'messages' array",
      example: { messages: [{ from: "you", text: "Hello" }, { from: "partner", text: "Hi there" }] },
    });
  }
  if (messages.length < 2) return res.status(400).json({ error: "Need at least 2 messages" });
  if (messages.length > 20) return res.status(400).json({ error: "Max 20 messages" });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.from || !["you", "partner"].includes(msg.from)) {
      return res.status(400).json({ error: `messages[${i}].from must be "you" or "partner"` });
    }
    if (!msg.text || typeof msg.text !== "string" || msg.text.trim() === "") {
      return res.status(400).json({ error: `messages[${i}].text is missing or empty` });
    }
    messages[i].text = messages[i].text.replace(/—/g, " - ");
  }
  if (messages[0].from !== "you") {
    return res.status(400).json({ error: "First message must be from 'you'" });
  }

  if (!bundleLocation) {
    return res.status(503).json({ error: "Server is still starting up. Try again in 30 seconds." });
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const outputPath = path.join("/tmp", `${jobId}.mp4`);
  const startTime = Date.now();
  console.log(`[${jobId}] Rendering ${messages.length} messages...`);

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

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "ChatReel",
      inputProps,
    });

    console.log(`[${jobId}] Duration: ${(composition.durationInFrames / composition.fps).toFixed(1)}s`);

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      chromiumOptions: {
        enableMultiProcessOnLinux: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      },
      ...(BROWSER_PATH ? { browserExecutable: BROWSER_PATH } : {}),
    });

    const renderSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Done in ${renderSec}s`);

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
// GET /health
// ============================================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ready: !!bundleLocation,
    chromium: BROWSER_PATH || "remotion-managed",
    bundlePath: bundleLocation || "not ready",
  });
});

// ============================================================================
// GET /
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    service: "TrueU Chat Reel Renderer",
    status: bundleLocation ? "ready" : "warming up",
    endpoints: { health: "GET /health", render: "POST /render" },
  });
});

// ============================================================================
// START — listen FIRST, then bundle (so Railway health checks pass)
// ============================================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);

  warmBundle()
    .then(() => console.log("Ready for renders"))
    .catch((err) => console.error("Bundle failed:", err.message));
});
