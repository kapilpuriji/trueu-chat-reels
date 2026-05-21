// ============================================================================
// BATCH RENDER SCRIPT
// ----------------------------------------------------------------------------
// Renders a separate MP4 for each entry in `videos` below.
// Run with: npm run build:batch
// ============================================================================

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "out";
mkdirSync(OUT_DIR, { recursive: true });

// Each entry can optionally override:
//   backgroundVideo: filename in /public, or null for solid black
//   backgroundVideoDurationInFrames: video length in frames (30fps × seconds)
//   backgroundDim: 0..1, how much to darken the bg (0 = blend, 0.3+ = panel feel)
//   logoImage: filename in /public, or null for "[logo]" text placeholder
//   enableAudio: true for typing/send/receive sounds, false for silent
const videos = [
  {
    name: "reel_01_career",
    contactName: "Thinking Partner",
    contactSubtitle: "TrueU.ai",
    backgroundVideo: "background.mp4",
    backgroundVideoDurationInFrames: 750,
    backgroundDim: 0,
    logoImage: null,
    enableAudio: true,
    messages: [
      { from: "you", text: "I'm thinking about leaving my job" },
      { from: "partner", text: "What's pulling you toward leaving?" },
      { from: "you", text: "Honestly I don't know" },
      {
        from: "partner",
        text: "Let's start there. What does a good week at work look like?",
      },
    ],
  },
  {
    name: "reel_02_decision",
    contactName: "Thinking Partner",
    contactSubtitle: "TrueU.ai",
    backgroundVideo: "background.mp4",
    backgroundVideoDurationInFrames: 750,
    backgroundDim: 0,
    logoImage: null,
    enableAudio: true,
    messages: [
      { from: "you", text: "I can't decide between the two offers" },
      {
        from: "partner",
        text: "What would you regret more — saying no to A, or saying no to B?",
      },
      { from: "you", text: "...B" },
      { from: "partner", text: "Interesting. Say more about that." },
    ],
  },
  {
    name: "reel_03_stuck",
    contactName: "Thinking Partner",
    contactSubtitle: "TrueU.ai",
    backgroundVideo: "background.mp4",
    backgroundVideoDurationInFrames: 750,
    backgroundDim: 0,
    logoImage: null,
    enableAudio: true,
    messages: [
      { from: "you", text: "I've been stuck on this for weeks" },
      { from: "partner", text: "What does 'unstuck' look like to you?" },
      { from: "you", text: "I haven't really thought about it" },
      {
        from: "partner",
        text: "Let's start there. Close your eyes for a second.",
      },
    ],
  },
];

for (const video of videos) {
  console.log(`\n→ Rendering ${video.name}...`);

  const propsPath = join(OUT_DIR, `${video.name}.props.json`);
  writeFileSync(
    propsPath,
    JSON.stringify({
      contactName: video.contactName,
      contactSubtitle: video.contactSubtitle,
      messages: video.messages,
      backgroundVideo: video.backgroundVideo ?? null,
      backgroundVideoDurationInFrames:
        video.backgroundVideoDurationInFrames ?? 750,
      backgroundDim: video.backgroundDim ?? 0,
      showSafeZones: false,
      logoImage: video.logoImage ?? null,
      enableAudio: video.enableAudio ?? true,
    }),
  );

  const outPath = join(OUT_DIR, `${video.name}.mp4`);
  execSync(
    `npx remotion render ChatReel ${outPath} --props=${propsPath}`,
    { stdio: "inherit" },
  );
  console.log(`✓ ${outPath}`);
}

console.log(`\nAll done. ${videos.length} video(s) rendered to ./${OUT_DIR}/`);
