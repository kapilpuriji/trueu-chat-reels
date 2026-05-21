import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
  OffthreadVideo,
  Loop,
  staticFile,
  Audio,
  Sequence,
  Img,
} from "remotion";
import {
  Message,
  TimelineEntry,
  computeTimeline,
  pseudoRandom,
  INTRO_DURATION_FRAMES,
  OUTRO_DURATION_FRAMES,
} from "./messages";

// ============================================================================
// COLOR THEME
// - Bone (#E6E6E0) replaces the iMessage blue for "you" bubbles
// - Charcoal (#272420) replaces black for all body text
// ============================================================================
const theme = {
  bg: "#F2F3F5", // matches the brand orb + app interface video backgrounds
  // Text
  textPrimary: "#272420", // Charcoal — body text
  textSecondary: "#6B6863", // muted grey for "Thinking Partner..."
  textPlaceholder: "#9E9B95", // light grey for "Write something" placeholder
  // Input box
  inputBoxBg: "#FFFFFF",
  inputBoxBorder: "#D5D2CB",
  micIconBg: "#E5E2DA",
  micIconColor: "#272420", // Charcoal
  // "You" sent bubble — Bone (replaces iMessage blue)
  youBubble: "#E6E6E0", // Bone
  youBubbleText: "#272420", // Charcoal text on Bone
  youBubbleBorder: "#D5D2CB", // subtle border so the bubble reads against cream bg
  // Cursor
  cursor: "#272420", // Charcoal
  // iPhone status bar icons
  iconColor: "#272420", // Charcoal
  // Brand orb colors
  orbMain: "#ffb59c",
  orbMainHighlight: "#ffe4d4",
  orbAccent: "#b59ae0",
  orbAccentHighlight: "#e8d4ff",
};

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif';

// ============================================================================
// LAYOUT CONSTANTS
// ============================================================================
const STATUS_BAR_HEIGHT = 80; // iPhone-style status bar at the very top
const HEADER_TOP = STATUS_BAR_HEIGHT + 60; // logo + orb sit just below status bar

// Safe zones — see README
const SAFE_ZONE = {
  top: 280,
  bottom: 400,
  right: 130,
  left: 50,
};

// ============================================================================
// PROPS
// ============================================================================
type ChatReelProps = {
  messages: Message[];
  contactName: string;
  contactSubtitle: string;
  backgroundVideo: string | null;
  backgroundVideoDurationInFrames: number;
  backgroundDim: number;
  showSafeZones: boolean;
  /** Logo image filename in /public, or null to fall back to the text placeholder */
  logoImage: string | null;
  /** Toggle on/off audio (typing clicks, send, receive sounds) */
  enableAudio: boolean;
};

// ============================================================================
// MAIN COMPOSITION
// ============================================================================
export const ChatReel: React.FC<ChatReelProps> = ({
  messages,
  backgroundVideo,
  backgroundVideoDurationInFrames,
  backgroundDim,
  showSafeZones,
  logoImage,
  enableAudio,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { entries } = computeTimeline(messages);

  const activeEntry = entries.find(
    (e) => frame >= e.startFrame && frame < e.endFrame,
  );

  const settledEntries = entries.filter(
    (e) => frame >= e.bubbleAppearFrame,
  );

  // Outro begins OUTRO_DURATION_FRAMES from the end of the composition
  const outroStartFrame = durationInFrames - OUTRO_DURATION_FRAMES;
  const outroFrame = frame - outroStartFrame; // negative before outro begins
  const isOutro = frame >= outroStartFrame;

  // Intro plays during the first INTRO_DURATION_FRAMES of the composition
  const isIntro = frame < INTRO_DURATION_FRAMES;
  const introFrame = frame; // 0 .. INTRO_DURATION_FRAMES while intro plays

  // First "you" message text — shown in the intro as a hook
  const firstYouText =
    messages.find((m) => m.from === "you")?.text ?? "";

  // Chat opacity: invisible during intro, fades in at end of intro,
  // visible during chat, fades out at start of outro.
  const chatOpacity = (() => {
    if (isOutro) {
      return interpolate(outroFrame, [0, 15], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    }
    if (isIntro) {
      // Cross-fade with intro during the last 15 frames of the intro
      return interpolate(
        frame,
        [INTRO_DURATION_FRAMES - 15, INTRO_DURATION_FRAMES],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
    }
    return 1;
  })();

  // Intro opacity: visible during intro, fades out at the end
  const introOpacity = isIntro
    ? interpolate(
        frame,
        [INTRO_DURATION_FRAMES - 15, INTRO_DURATION_FRAMES],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      )
    : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: FONT_STACK }}>
      {/* Background video, masked at top and bottom */}
      {backgroundVideo && (
        <AbsoluteFill>
          <Loop durationInFrames={backgroundVideoDurationInFrames}>
            <OffthreadVideo
              src={staticFile(backgroundVideo)}
              muted
              style={{
                width: "100%",
                height: "100%",
                objectFit: "fill",
              }}
            />
          </Loop>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 380,
              background: `linear-gradient(to bottom, ${theme.bg} 70%, transparent)`,
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 480,
              background: `linear-gradient(to top, ${theme.bg} 75%, transparent)`,
            }}
          />
        </AbsoluteFill>
      )}

      {backgroundDim > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(0,0,0,${backgroundDim})`,
            pointerEvents: "none",
          }}
        />
      )}

      {/* Chat UI — wrapped so it fades out together as the outro begins */}
      <AbsoluteFill style={{ opacity: chatOpacity }}>
        <IPhoneStatusBar />
        <BrandHeader logoImage={logoImage} frame={frame} fps={fps} />
        <MessageList
          entries={settledEntries}
          activeEntry={activeEntry}
          frame={frame}
          fps={fps}
        />
        <WriteSomethingBox activeEntry={activeEntry} frame={frame} fps={fps} />
      </AbsoluteFill>

      {/* Branded intro scene — orb + first chat message as a hook */}
      {isIntro && (
        <IntroScreen
          introFrame={introFrame}
          fps={fps}
          text={firstYouText}
          opacity={introOpacity}
        />
      )}

      {/* Branded outro */}
      {isOutro && (
        <OutroScreen
          outroFrame={outroFrame}
          parentFrame={frame}
          fps={fps}
          logoImage={logoImage}
        />
      )}

      {/* Audio — only during the chat phase (silent during outro) */}
      {enableAudio && !isOutro && <AudioLayer entries={entries} fps={fps} />}

      {showSafeZones && <SafeZoneOverlay />}
    </AbsoluteFill>
  );
};

// ============================================================================
// INTRO SCREEN — branded opening hook
//   Big animated orb + the first chat message text, centered.
//   Plays for ~5 seconds before the chat scene fades in.
// ============================================================================
const IntroScreen: React.FC<{
  introFrame: number; // 0..INTRO_DURATION_FRAMES
  fps: number;
  text: string;
  opacity: number; // fades out at the end as chat fades in
}> = ({ introFrame, fps, text, opacity }) => {
  // Orb scales + fades in over frames 0-30
  const orbSpring = spring({
    frame: introFrame,
    fps,
    config: { damping: 18, stiffness: 180, mass: 0.7 },
    durationInFrames: 30,
  });
  const orbScale = interpolate(orbSpring, [0, 1], [0.7, 1]);
  const orbOpacity = interpolate(orbSpring, [0, 1], [0, 1]);

  // Hook text fades + rises in over frames 25-55
  const textOpacity = interpolate(introFrame, [25, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const textY = interpolate(introFrame, [25, 55], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 56,
        padding: `${SAFE_ZONE.top}px 80px ${SAFE_ZONE.bottom}px 80px`,
      }}
    >
      {/* Animated brand orb */}
      <div
        style={{
          opacity: orbOpacity,
          transform: `scale(${orbScale})`,
        }}
      >
        <AnimatedOrb size={280} />
      </div>

      {/* Hook text — pulled from the first "you" message so it stays in sync */}
      <div
        style={{
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
          fontSize: 56,
          fontWeight: 500,
          color: theme.textPrimary,
          textAlign: "center",
          letterSpacing: "-0.015em",
          lineHeight: 1.25,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

// ============================================================================
// OUTRO SCREEN — branded closing moment
//   "If you want clarity for life..." → TrueU.ai logo
// Stages out over ~5 seconds with staggered orb + text + dots + logo entrances.
// ============================================================================
const OutroScreen: React.FC<{
  outroFrame: number; // frames since outro started
  parentFrame: number; // global frame (drives orb video loop)
  fps: number;
  logoImage: string | null;
}> = ({ outroFrame, parentFrame, fps, logoImage }) => {
  // ----- Big centered orb: scales + fades in over frames 15-50 -----
  const orbSpring = spring({
    frame: outroFrame - 15,
    fps,
    config: { damping: 18, stiffness: 180, mass: 0.7 },
    durationInFrames: 35,
  });
  const orbScale = interpolate(orbSpring, [0, 1], [0.7, 1]);
  const orbOpacity = interpolate(orbSpring, [0, 1], [0, 1]);

  // ----- Tagline (without dots) fades + rises in over frames 35-60 -----
  const taglineOpacity = interpolate(outroFrame, [35, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const taglineY = interpolate(outroFrame, [35, 60], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ----- Three dots animate in one at a time at frames 75 / 85 / 95 -----
  let dotsToShow = 0;
  if (outroFrame >= 95) dotsToShow = 3;
  else if (outroFrame >= 85) dotsToShow = 2;
  else if (outroFrame >= 75) dotsToShow = 1;
  const dots = ".".repeat(dotsToShow);

  // ----- Logo fades + slight scale-up over frames 110-140 -----
  const logoSpring = spring({
    frame: outroFrame - 110,
    fps,
    config: { damping: 16, stiffness: 200, mass: 0.6 },
    durationInFrames: 30,
  });
  const logoScale = interpolate(logoSpring, [0, 1], [0.85, 1]);
  const logoOpacity = interpolate(logoSpring, [0, 1], [0, 1]);

  // ----- "... we'll see you there!" fades + rises in over frames 155-180 -----
  const closingOpacity = interpolate(outroFrame, [155, 180], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const closingY = interpolate(outroFrame, [155, 180], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 56,
        padding: `${SAFE_ZONE.top}px 80px ${SAFE_ZONE.bottom}px 80px`,
      }}
    >
      {/* Animated orb (uses the same brand video, just bigger) */}
      <div
        style={{
          opacity: orbOpacity,
          transform: `scale(${orbScale})`,
        }}
      >
        <AnimatedOrb frame={parentFrame} fps={fps} size={280} />
      </div>

      {/* Tagline + animated dots */}
      <div
        style={{
          opacity: taglineOpacity,
          transform: `translateY(${taglineY}px)`,
          fontSize: 56,
          fontWeight: 400,
          color: theme.textPrimary,
          textAlign: "center",
          letterSpacing: "-0.015em",
          lineHeight: 1.2,
        }}
      >
        If you want clarity for life
        <span style={{ display: "inline-block", minWidth: 36, textAlign: "left" }}>
          {dots}
        </span>
      </div>

      {/* TrueU.ai logo */}
      <div
        style={{
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
          marginTop: 12,
        }}
      >
        {logoImage ? (
          <img
            src={staticFile(logoImage)}
            alt="TrueU.ai"
            style={{ height: 160, width: "auto", objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              fontSize: 110,
              fontWeight: 700,
              color: theme.textPrimary,
              letterSpacing: "-0.03em",
            }}
          >
            TrueU.ai
          </div>
        )}
      </div>

      {/* Closing line — mirrors the tagline's "..." for visual continuity.
          Slightly smaller than the tagline so the logo stays the focal point. */}
      <div
        style={{
          opacity: closingOpacity,
          transform: `translateY(${closingY}px)`,
          fontSize: 46,
          fontWeight: 400,
          color: theme.textPrimary,
          textAlign: "center",
          letterSpacing: "-0.01em",
          lineHeight: 1.2,
          marginTop: -8,
        }}
      >
        ... we'll meet you there
      </div>
    </AbsoluteFill>
  );
};

// ============================================================================
// IPHONE STATUS BAR — time on the left, signal/wifi/battery on the right
// ============================================================================
const IPhoneStatusBar: React.FC = () => {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: STATUS_BAR_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 60px",
        color: theme.iconColor,
        fontWeight: 600,
        fontSize: 32,
        letterSpacing: "-0.01em",
        userSelect: "none",
      }}
    >
      <div>9:41</div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <SignalBarsIcon color={theme.iconColor} />
        <WifiIcon color={theme.iconColor} />
        <BatteryIcon color={theme.iconColor} />
      </div>
    </div>
  );
};

const SignalBarsIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width="32" height="22" viewBox="0 0 24 16" fill={color}>
    <rect x="0" y="11" width="3.5" height="5" rx="1" />
    <rect x="6" y="8" width="3.5" height="8" rx="1" />
    <rect x="12" y="4" width="3.5" height="12" rx="1" />
    <rect x="18" y="0" width="3.5" height="16" rx="1" />
  </svg>
);

const WifiIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width="32" height="22" viewBox="0 0 24 18" fill={color}>
    <path d="M12 18 L8 13 A5 5 0 0 1 16 13 Z" />
    <path
      d="M4 9 A11 11 0 0 1 20 9"
      fill="none"
      stroke={color}
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      d="M0 4.5 A17 17 0 0 1 24 4.5"
      fill="none"
      stroke={color}
      strokeWidth="2.4"
      strokeLinecap="round"
    />
  </svg>
);

const BatteryIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width="48" height="22" viewBox="0 0 36 16" fill="none">
    <rect
      x="0.5"
      y="0.5"
      width="32"
      height="15"
      rx="3.5"
      stroke={color}
      strokeWidth="1"
      opacity="0.4"
    />
    <rect x="2.5" y="2.5" width="26" height="11" rx="1.5" fill={color} />
    <rect x="33.5" y="5" width="2" height="6" rx="1" fill={color} opacity="0.6" />
  </svg>
);

// ============================================================================
// BRAND HEADER — Logo on the LEFT + animated orb on the RIGHT, centered as a group
// ============================================================================
const BrandHeader: React.FC<{
  logoImage: string | null;
  frame: number;
  fps: number;
}> = ({ logoImage, frame, fps }) => {
  return (
    <div
      style={{
        position: "absolute",
        top: HEADER_TOP,
        left: 0,
        right: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
      }}
    >
      {/* Logo (left of orb) */}
      <Logo image={logoImage} />

      {/* Animated orb */}
      <AnimatedOrb frame={frame} fps={fps} size={160} />
    </div>
  );
};

const Logo: React.FC<{ image: string | null }> = ({ image }) => {
  // If a logo image is provided, render it. Otherwise show a styled text placeholder.
  if (image) {
    return (
      <img
        src={staticFile(image)}
        alt="logo"
        style={{
          height: 90,
          width: "auto",
          objectFit: "contain",
        }}
      />
    );
  }
  return (
    <div
      style={{
        fontSize: 38,
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: theme.textPrimary,
        // Mark this clearly as a placeholder so user knows to replace
        opacity: 0.7,
      }}
    >
      [logo]
    </div>
  );
};

// ============================================================================
// ANIMATED ORB — plays the real TrueU brand orb as a sequence of transparent
// PNG frames. Bulletproof alpha rendering (Img always honors PNG transparency,
// unlike OffthreadVideo which flattens alpha during extraction).
// ============================================================================
const NUM_ORB_FRAMES = 75; // GIF source: 75 frames at 25fps over 3 seconds

const AnimatedOrb: React.FC<{
  /** Unused, kept for API compatibility with old callers */
  frame?: number;
  /** Unused, kept for API compatibility */
  fps?: number;
  size: number;
}> = ({ size }) => {
  const currentFrame = useCurrentFrame();
  // Map 30fps composition timeline to 25fps GIF source timeline
  const orbFrameIdx =
    Math.floor((currentFrame * 25) / 30) % NUM_ORB_FRAMES;
  const padded = String(orbFrameIdx + 1).padStart(3, "0");

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <Img
        src={staticFile(`orb-frames/orb-${padded}.png`)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
};

// ============================================================================
// MESSAGE LIST
// ============================================================================
const MessageList: React.FC<{
  entries: TimelineEntry[];
  activeEntry: TimelineEntry | undefined;
  frame: number;
  fps: number;
}> = ({ entries, activeEntry, frame, fps }) => {
  const showThinking =
    activeEntry &&
    activeEntry.message.from === "partner" &&
    frame >= activeEntry.thinkingStartFrame &&
    frame < activeEntry.thinkingEndFrame;

  return (
    <div
      style={{
        position: "absolute",
        top: SAFE_ZONE.top + 200,
        left: 0,
        right: 0,
        bottom: SAFE_ZONE.bottom + 240,
        padding: `40px ${SAFE_ZONE.right}px 20px ${SAFE_ZONE.left}px`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: 28,
        overflow: "hidden",
      }}
    >
      {entries.map((entry, i) => (
        <MessageBubble key={i} entry={entry} frame={frame} fps={fps} />
      ))}
      {showThinking && (
        <ThinkingIndicator
          frame={frame - activeEntry.thinkingStartFrame}
          fps={fps}
        />
      )}
    </div>
  );
};

const ThinkingIndicator: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const cycleFrame = Math.floor((frame % (fps * 0.6 * 3)) / (fps * 0.6));
  const dots = ".".repeat(cycleFrame + 1);
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 22,
        paddingLeft: 8,
        opacity,
      }}
    >
      <AnimatedOrb frame={frame} fps={fps} size={90} />
      <div
        style={{
          color: theme.textSecondary,
          fontSize: 38,
          fontWeight: 500,
          letterSpacing: "-0.01em",
        }}
      >
        Thinking Partner{dots}
      </div>
    </div>
  );
};

// ============================================================================
// MESSAGE BUBBLE
// ============================================================================
const MessageBubble: React.FC<{
  entry: TimelineEntry;
  frame: number;
  fps: number;
}> = ({ entry, frame, fps }) => {
  const { message, bubbleAppearFrame } = entry;
  const isYou = message.from === "you";

  const progress = spring({
    frame: frame - bubbleAppearFrame,
    fps,
    config: { damping: 16, stiffness: 220, mass: 0.6 },
    durationInFrames: 14,
  });

  const scale = interpolate(progress, [0, 1], [0.6, 1]);
  const translateY = interpolate(progress, [0, 1], [40, 0]);
  const opacity = interpolate(progress, [0, 1], [0, 1]);

  const fpw = message.framesPerWord ?? 5;
  // Partner messages used to stream word-by-word; now they appear all at once
  // when the bubble springs in. The variable `fpw` is unused for rendering but
  // still drives the post-bubble reading-time pause via computeTimeline.
  void fpw;
  const textNode = message.text;

  if (isYou) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          transform: `translateY(${translateY}px) scale(${scale})`,
          opacity,
          transformOrigin: "bottom right",
        }}
      >
        <div
          style={{
            maxWidth: "78%",
            padding: "22px 32px",
            borderRadius: 36,
            backgroundColor: theme.youBubble,
            border: `1px solid ${theme.youBubbleBorder}`,
            color: theme.youBubbleText,
            fontSize: 38,
            lineHeight: 1.3,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            borderBottomRightRadius: 12,
            boxShadow: "0 4px 14px rgba(39,36,32,0.08)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {textNode}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-start",
        transform: `translateY(${translateY}px) scale(${scale})`,
        opacity,
        transformOrigin: "bottom left",
      }}
    >
      <div
        style={{
          maxWidth: "92%",
          padding: "4px 8px",
          color: theme.textPrimary,
          fontSize: 40,
          lineHeight: 1.32,
          fontWeight: 500,
          letterSpacing: "-0.01em",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {textNode}
      </div>
    </div>
  );
};

// ============================================================================
// WRITE SOMETHING BOX
// ============================================================================
const WriteSomethingBox: React.FC<{
  activeEntry: TimelineEntry | undefined;
  frame: number;
  fps: number;
}> = ({ activeEntry, frame }) => {
  const isTyping =
    activeEntry &&
    activeEntry.message.from === "you" &&
    frame >= activeEntry.typingStartFrame &&
    frame < activeEntry.bubbleAppearFrame;

  let displayText = "";
  if (isTyping && activeEntry) {
    // Walk charFrames to find how many characters should be visible right now
    const { message, charFrames } = activeEntry;
    let charCount = 0;
    for (let i = 0; i < charFrames.length; i++) {
      if (charFrames[i] <= frame) {
        charCount = i + 1;
      } else {
        break;
      }
    }
    displayText = message.text.slice(0, charCount);
  }

  const cursorVisible = frame % 30 < 18;
  const showPlaceholder = displayText.length === 0;

  return (
    <div
      style={{
        position: "absolute",
        bottom: SAFE_ZONE.bottom - 30,
        left: SAFE_ZONE.left,
        right: SAFE_ZONE.left,
        minHeight: 170,
        backgroundColor: theme.inputBoxBg,
        border: `2px solid ${theme.inputBoxBorder}`,
        borderRadius: 28,
        padding: "30px 36px",
        display: "flex",
        alignItems: "center",
        boxShadow: "0 4px 18px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 40,
          fontWeight: 400,
          letterSpacing: "-0.01em",
          color: theme.textPrimary,
          display: "flex",
          alignItems: "center",
        }}
      >
        {showPlaceholder ? (
          <>
            {cursorVisible && (
              <span
                style={{
                  display: "inline-block",
                  width: 2,
                  height: 44,
                  backgroundColor: theme.cursor,
                  marginRight: 2,
                  flexShrink: 0,
                }}
              />
            )}
            <span style={{ color: theme.textPlaceholder }}>
              Write something
            </span>
          </>
        ) : (
          <>
            <span
              style={{
                color: theme.textPrimary,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {displayText}
            </span>
            {cursorVisible && (
              <span
                style={{
                  display: "inline-block",
                  width: 2,
                  height: 44,
                  backgroundColor: theme.cursor,
                  marginLeft: 2,
                  flexShrink: 0,
                  verticalAlign: "middle",
                }}
              />
            )}
          </>
        )}
      </div>

      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          backgroundColor: theme.micIconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginLeft: 16,
        }}
      >
        <MicIcon color={theme.micIconColor} size={30} />
      </div>
    </div>
  );
};

const MicIcon: React.FC<{ color: string; size: number }> = ({
  color,
  size,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="9" y="3" width="6" height="12" rx="3" fill={color} />
    <path
      d="M5 11C5 14.866 8.13401 18 12 18C15.866 18 19 14.866 19 11"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
    <line
      x1="12"
      y1="18"
      x2="12"
      y2="22"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

// ============================================================================
// AUDIO LAYER — typing clicks per character + send/receive sounds per message
// Sounds live in /public; replace with your own to change the feel.
// ============================================================================
const AudioLayer: React.FC<{ entries: TimelineEntry[]; fps: number }> = ({
  entries,
  fps,
}) => {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.message.from === "you") {
          // Click on every character — even spaces. iPhone keyboards play
          // a sound on the spacebar too. Uses the realistic per-char timings.
          const clicks: number[] = [];
          for (let c = 0; c < entry.charFrames.length; c++) {
            clicks.push(entry.charFrames[c]);
          }
          return (
            <React.Fragment key={`audio-${i}`}>
              {clicks.map((cf, ci) => {
                // Four-file rotation + deterministic pitch variation per click
                // breaks the phasing/harshness that comes from playing the
                // exact same sample repeatedly when typing fast.
                const clickFile = `type${(ci % 4) + 1}.mp3`;
                // Pitch (and speed) varies between 0.88x and 1.18x — subtle,
                // but enough that each click sounds slightly different.
                const playbackRate = 0.88 + pseudoRandom(cf * 31 + ci) * 0.30;
                return (
                  <Sequence
                    key={`type-${i}-${ci}`}
                    from={cf}
                    durationInFrames={6}
                  >
                    <Audio
                      src={staticFile(clickFile)}
                      volume={0.3}
                      playbackRate={playbackRate}
                    />
                  </Sequence>
                );
              })}
              <Sequence
                from={entry.bubbleAppearFrame}
                durationInFrames={45}
              >
                {/* Send notification — clearly audible event */}
                <Audio src={staticFile("send.mp3")} volume={0.7} />
              </Sequence>
            </React.Fragment>
          );
        }
        // Partner — receive sound when bubble appears
        return (
          <Sequence
            key={`recv-${i}`}
            from={entry.bubbleAppearFrame}
            durationInFrames={45} // 1.5s — full chime decay
          >
            <Audio src={staticFile("receive.mp3")} volume={0.7} />
          </Sequence>
        );
      })}
    </>
  );
};

// ============================================================================
// SAFE ZONE OVERLAY (debug)
// ============================================================================
const SafeZoneOverlay: React.FC = () => {
  const stripStyle: React.CSSProperties = {
    position: "absolute",
    backgroundColor: "rgba(255, 0, 80, 0.18)",
    borderTop: "2px dashed rgba(255,0,80,0.7)",
    borderBottom: "2px dashed rgba(255,0,80,0.7)",
    color: "#fff",
    fontSize: 22,
    fontWeight: 600,
    fontFamily: FONT_STACK,
    padding: "12px 20px",
    textShadow: "0 2px 6px rgba(0,0,0,0.9)",
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...stripStyle, top: 0, left: 0, right: 0, height: 250 }}>
        Top zone (~250px)
      </div>
      <div
        style={{ ...stripStyle, bottom: 0, left: 0, right: 0, height: 350 }}
      >
        Bottom zone (~350px)
      </div>
      <div
        style={{
          ...stripStyle,
          top: 250,
          bottom: 350,
          right: 0,
          width: 130,
          borderLeft: "2px dashed rgba(255,0,80,0.7)",
          borderTop: "none",
          borderBottom: "none",
          fontSize: 18,
          writingMode: "vertical-rl",
          textOrientation: "mixed",
        }}
      >
        Right action column
      </div>
      <div
        style={{
          position: "absolute",
          top: SAFE_ZONE.top,
          bottom: SAFE_ZONE.bottom,
          left: SAFE_ZONE.left,
          right: SAFE_ZONE.right,
          border: "3px solid rgba(0,180,90,0.95)",
        }}
      />
    </AbsoluteFill>
  );
};
