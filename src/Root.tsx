import { Composition } from "remotion";
import { ChatReel } from "./ChatReel";
import { defaultMessages, computeTimeline, FPS } from "./messages";

// Reel format: 1080x1920 (9:16 vertical)
export const Root: React.FC = () => {
  return (
    <Composition
      id="ChatReel"
      component={ChatReel}
      durationInFrames={1} // overridden by calculateMetadata
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{
        messages: defaultMessages,
        contactName: "Thinking Partner",
        contactSubtitle: "TrueU.ai",
        // Background video: drop your file in /public and reference it here.
        // Set to null for a solid black background instead.
        backgroundVideo: "background.mp4" as string | null,
        // Length of the background video in frames (used for looping when the
        // reel is longer than the video). 30fps × 25s = 750.
        backgroundVideoDurationInFrames: 750,
        // Dim the background. 0 = full video, 1 = pure black overlay.
        // Default 0 — text-shadow halos handle readability without grey panels.
        // Bump to 0.2-0.3 only if your video is so busy text gets lost.
        backgroundDim: 0,
        // Toggle red/green safe-zone overlay while iterating in the studio.
        // ALWAYS set to false before rendering the final MP4.
        showSafeZones: false,
        // Logo image filename in /public. SVG, PNG, or JPG all work.
        // Set to null to show "[logo]" placeholder text instead.
        logoImage: "logo.svg" as string | null,
        // Audio: set to false to render a silent reel
        enableAudio: true,
      }}
      calculateMetadata={({ props }) => {
        const { totalFrames } = computeTimeline(props.messages);
        return {
          durationInFrames: totalFrames,
          props,
        };
      }}
    />
  );
};
