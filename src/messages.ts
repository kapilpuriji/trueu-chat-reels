// ============================================================
// EDIT THIS FILE TO CHANGE THE MESSAGES IN YOUR REEL
// ============================================================

export const FPS = 30;

/**
 * Two roles in the conversation:
 *
 * - "you"     = the chat user. Their text types out letter-by-letter in the
 *               input bar at the bottom, then snaps into a sent bubble (right side).
 *
 * - "partner" = the TrueU.ai Thinking Partner. After a brief pause, a
 *               "Thinking..." indicator (peach/lavender orb + animated dots)
 *               appears on the left. When thinking ends, the bubble appears
 *               and the message streams in WORD BY WORD — like ChatGPT.
 */
export type Message = {
  from: "you" | "partner";
  text: string;
  /** Optional per-message override for typing speed (only applies to "you") */
  framesPerChar?: number;
  /** Optional per-message override for word-stream speed (only applies to "partner") */
  framesPerWord?: number;
};

// ---- DEFAULT SCRIPT --------------------------------------------------------
export const defaultMessages: Message[] = [
  {
    from: "you",
    text: "Did you hear about the 20,000 AI related layoffs?",
  },
  {
    from: "partner",
    text: "We've talked about this from a few angles. In March you were excited that AI made you faster. Last month you said it kept you up at night. What's different now?",
  },
  { from: "you", text: "Sarah got let go yesterday" },
  {
    from: "partner",
    text: "Someone from your own team this time. That carries different weight than what's in the news.",
  },
  { from: "you", text: "It feels closer now" },
  {
    from: "partner",
    text: "You've told me your edge is the strategic judgment AI can't replicate. Does that still feel true — or are you starting to wonder?",
  },
];

/**
 * The intro scene that plays BEFORE the chat conversation starts.
 * Shows the brand orb + the first "you" message text as a hook.
 *   - BUILD: orb scales in → text fades in
 *   - HOLD: text holds on screen so viewers absorb it before chat begins
 *   - FADE: last 15 frames fade out as chat fades in
 */
export const INTRO_BUILD_FRAMES = 55; // ~1.8s of entrance animations
export const INTRO_HOLD_FRAMES = 75; // 2.5s of hold on the hook text
export const INTRO_DURATION_FRAMES =
  INTRO_BUILD_FRAMES + INTRO_HOLD_FRAMES + 15; // +15 cross-fade frames

/**
 * The branded outro that plays AFTER the chat conversation ends.
 * Split into two phases for easy tuning:
 *   - BUILD: chat fades out → orb → tagline → dots → logo (entrance animations)
 *   - HOLD: everything stays on screen so viewers can absorb the brand moment
 */
export const OUTRO_BUILD_FRAMES = 180; // ~6s of staggered entrance animations
export const OUTRO_HOLD_FRAMES = 150; // 5 seconds of hold on the final scene
export const OUTRO_DURATION_FRAMES = OUTRO_BUILD_FRAMES + OUTRO_HOLD_FRAMES;

// ---- TIMING CONSTANTS (tweak feel here) -----------------------------------
const TIMING = {
  /** Base time in frames to type one character ("you" messages). 30fps × 3.5 ≈ 8.5 chars/sec */
  framesPerChar: 3.5,
  /** Pause after "you" finishes typing before the message gets sent */
  pauseBeforeSend: 18, // 0.6s
  /** Bubble snap-in animation length */
  bubbleAppear: 10, // 0.33s
  /** Pause after a "you" bubble appears before the partner starts thinking */
  pauseAfterSend: 8, // 0.27s — short, partner reacts quickly
  /** Duration of the "Thinking..." indicator before the partner's bubble appears */
  partnerThinkingDuration: 38, // 1.27s
  /** Frames per word when streaming a partner's message (5 ≈ 6 words/sec) */
  framesPerWord: 5,
  /** Pause after a partner message FINISHES STREAMING before next action.
   *  Word streaming itself gives reading time; this is just a final beat. */
  pauseAfterPartner: 22, // 0.73s
  /** Beat between the last message and the start of the outro */
  endPadding: 90, // 3s — extended hold on the final partner message before outro
};

export type TimelineEntry = {
  message: Message;
  startFrame: number;
  // ---- "you" specific ----
  /** When per-char typing starts in the input bar */
  typingStartFrame: number;
  /** When the input bar finishes the full text */
  typingEndFrame: number;
  /**
   * Per-character frame timings. charFrames[i] = the frame at which character i
   * appears. Reflects realistic human typing rhythm with bursts, punctuation
   * pauses, and word-boundary slowdowns. Empty for "partner" messages.
   */
  charFrames: number[];
  // ---- "partner" specific ----
  /** When the "Thinking..." indicator appears */
  thinkingStartFrame: number;
  /** When the "Thinking..." indicator goes away */
  thinkingEndFrame: number;
  /** When word-by-word streaming begins inside the bubble */
  streamStartFrame: number;
  /** When the last word has been revealed */
  streamEndFrame: number;
  // ---- common ----
  /** When the bubble snap-in animation begins */
  bubbleAppearFrame: number;
  /** When this segment ends and the next can begin */
  endFrame: number;
};

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic pseudo-random in [0, 1) seeded by an integer. Same input
 * always returns the same value, so the typing rhythm is stable across
 * re-renders (otherwise each render would have different timings — chaos).
 */
export function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Compute per-character frame timings that mimic real human typing:
 *   - Base interval = baseFpc
 *   - ±30% jitter on every keystroke (so cadence isn't robotic)
 *   - Longer pause after sentence-ending punctuation (. ! ?)
 *   - Medium pause after comma / semicolon / colon
 *   - Slight pause at word boundaries (after spaces)
 *   - Occasional ~8% chance of a longer "thinking" pause mid-word
 *
 * The variation is deterministic — given the same text and start frame,
 * you always get identical timings.
 */
function computeCharFrames(
  text: string,
  startFrame: number,
  baseFpc: number,
): number[] {
  const frames: number[] = [];
  let cursor = startFrame;

  for (let i = 0; i < text.length; i++) {
    frames.push(Math.round(cursor));

    // Two independent deterministic 0..1 values for this position
    const r1 = pseudoRandom(startFrame + i);
    const r2 = pseudoRandom((startFrame + i) * 7 + 13);

    // Base interval with ±30% jitter (70%–130% of base)
    let interval = baseFpc * (0.7 + r1 * 0.6);

    // Pause AFTER specific characters (the next char comes later)
    const c = text[i];
    if (c === "." || c === "!" || c === "?") {
      // ~333–500ms beat after a sentence ends
      interval += 10 + r2 * 5;
    } else if (c === "," || c === ";" || c === ":") {
      // ~167–267ms after a clause break
      interval += 5 + r2 * 3;
    } else if (c === " ") {
      // ~33–100ms slight slowdown at word boundary
      interval += 1 + r2 * 2;
    }

    // ~8% chance of a longer thinking pause (267–533ms)
    if (r2 < 0.08) {
      interval += 8 + r1 * 8;
    }

    cursor += interval;
  }

  return frames;
}

export function computeTimeline(messages: Message[]): {
  entries: TimelineEntry[];
  totalFrames: number;
} {
  const entries: TimelineEntry[] = [];
  // Chat begins AFTER the intro scene finishes
  let cursor = INTRO_DURATION_FRAMES + 15;

  for (const message of messages) {
    const startFrame = cursor;

    if (message.from === "you") {
      const fpc = message.framesPerChar ?? TIMING.framesPerChar;
      const typingStartFrame = startFrame;
      // Realistic per-char timing — each character has its own frame
      const charFrames = computeCharFrames(message.text, startFrame, fpc);
      // Typing "ends" at the last keystroke
      const typingEndFrame = charFrames[charFrames.length - 1] ?? startFrame;
      const bubbleAppearFrame = typingEndFrame + TIMING.pauseBeforeSend;
      const endFrame =
        bubbleAppearFrame + TIMING.bubbleAppear + TIMING.pauseAfterSend;

      entries.push({
        message,
        startFrame,
        typingStartFrame,
        typingEndFrame,
        charFrames,
        thinkingStartFrame: bubbleAppearFrame, // unused for "you"
        thinkingEndFrame: bubbleAppearFrame,
        streamStartFrame: bubbleAppearFrame,
        streamEndFrame: bubbleAppearFrame,
        bubbleAppearFrame,
        endFrame,
      });
      cursor = endFrame;
    } else {
      // "partner" — Thinking indicator → bubble appears → words stream in
      const fpw = message.framesPerWord ?? TIMING.framesPerWord;
      const thinkingStartFrame = startFrame;
      const thinkingEndFrame = thinkingStartFrame + TIMING.partnerThinkingDuration;
      const bubbleAppearFrame = thinkingEndFrame;
      const streamStartFrame = bubbleAppearFrame;
      const numWords = countWords(message.text);
      const streamEndFrame = streamStartFrame + numWords * fpw;
      const endFrame = streamEndFrame + TIMING.pauseAfterPartner;

      entries.push({
        message,
        startFrame,
        typingStartFrame: bubbleAppearFrame, // unused for "partner"
        typingEndFrame: bubbleAppearFrame,
        charFrames: [], // unused for "partner"
        thinkingStartFrame,
        thinkingEndFrame,
        streamStartFrame,
        streamEndFrame,
        bubbleAppearFrame,
        endFrame,
      });
      cursor = endFrame;
    }
  }

  return {
    entries,
    totalFrames: cursor + TIMING.endPadding + OUTRO_DURATION_FRAMES,
  };
}
