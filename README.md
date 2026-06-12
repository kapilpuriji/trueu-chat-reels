# Chat Typing Reel — TrueU.ai Thinking Partner Template

Generate vertical (9:16, 1080×1920) reels of a chat conversation between a user and the TrueU.ai Thinking Partner. Built with [Remotion](https://www.remotion.dev/).

## What it does

- Renders a chat reel that **looks like the actual TrueU.ai app**: cream background, iPhone-style status bar at the top, your logo + animated brand orb centered below it, ambient floating shapes in the middle, "Write something" input box at the bottom.
- **"you"** messages: text types out **letter-by-letter in Charcoal** inside the "Write something" box. The placeholder disappears as the first character types in. When typing finishes, the message moves up to the chat area as a Bone-colored bubble on the right.
- **"partner"** messages (TrueU.ai Thinking Partner):
  1. Animated brand orb appears with "Thinking Partner..." in muted grey
  2. After a beat, the response streams in **word-by-word** as Charcoal text on the left
- **Audio:** keyboard click on each character typed, send sound when "you" bubbles appear, receive chime when partner bubbles appear. Sounds live in `/public` — replace with your own to change the feel.

## Quick start

```bash
npm install
npm run dev          # live preview (Remotion Studio at localhost:3000)
npm run build        # render the default reel to out/video.mp4
npm run build:batch  # render all reels in render-batch.mjs
```

## Customizing

### The script (per-video text)

Edit `src/messages.ts` (default) or `render-batch.mjs` (batch). Each message:

```ts
{ from: "you" | "partner", text: "..." }
```

### Logo

Drop a logo image into `/public` (PNG/SVG/JPG, ~80px tall renders cleanly), then set in `src/Root.tsx`:

```ts
logoImage: "logo.png"
```

When `null`, a `[logo]` placeholder shows so you can see positioning.

### Background video

Replace `/public/background.mp4` with your own. Update `backgroundVideoDurationInFrames` in `Root.tsx` to match (`seconds × 30`).

### Audio

Three sounds, all in `/public`:

- `type.mp3` — keyboard click, played on each non-space character
- `send.mp3` — plays when a "you" bubble appears
- `receive.mp3` — plays when a "partner" bubble appears

The bundled files are placeholder synthesized tones. For better feel, download royalty-free alternatives from [Pixabay](https://pixabay.com/sound-effects/) or [freesound.org](https://freesound.org) and replace them. Apple's official iMessage sounds are copyrighted and shouldn't be used.

To render silent: set `enableAudio: false` in `Root.tsx`.

### Colors

Edit the `theme` object at the top of `src/ChatReel.tsx`:

| Key | Default | What |
|---|---|---|
| `bg` | `#EFEDE6` | Cream app background |
| `youBubble` | `#E6E6E0` | Bone — your sent message bubble |
| `youBubbleText` | `#272420` | Charcoal text inside Bone bubble |
| `textPrimary` | `#272420` | Charcoal — partner messages, typed text |

### Timing

Edit `TIMING` in `src/messages.ts`:

| Key | What |
|---|---|
| `framesPerChar` | User typing speed |
| `framesPerWord` | Partner streaming speed |
| `partnerThinkingDuration` | How long "Thinking Partner..." shows |
| `pauseAfterPartner` | Beat after partner finishes |
| `endPadding` | Tail freeze |

## Platform sizing

Outputs at **1080×1920 (9:16) at 30fps** — universal short-form spec. Same MP4 works on Reels, TikTok, YouTube Shorts, and Facebook Reels.

Safe zones (top 280px / bottom 400px / right 130px) are baked in so platform UI overlays don't cover the chat. To preview them, set `showSafeZones: true` in `Root.tsx` — **always set back to false before final render.**

## Project layout

```
public/
├── background.mp4   ambient background video
├── type.mp3         keyboard click
├── send.mp3         message sent sound
└── receive.mp3      message received sound
src/
├── index.ts         entry point
├── Root.tsx         registers composition + default props
├── ChatReel.tsx     all visual components + audio layer
└── messages.ts      script + timing       ← you edit this
remotion.config.ts   render settings
render-batch.mjs     batch-render multiple videos
```
