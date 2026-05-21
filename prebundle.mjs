// ============================================================================
// PREBUNDLE — runs at Docker build time so the container can start instantly
// on Railway instead of bundling Remotion on first request.
//
// Output: ./bundle (served as a static directory by server.mjs)
// ============================================================================
import { bundle } from "@remotion/bundler";
import path from "path";
import fs from "fs";

const outDir = path.resolve("./bundle");

if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log("Bundling Remotion project to", outDir);

await bundle({
  entryPoint: path.resolve("./src/index.ts"),
  outDir,
  webpackOverride: (config) => config,
  onProgress: (p) => {
    if (p % 10 === 0) console.log(`  bundling... ${p}%`);
  },
});

console.log("Bundle ready at", outDir);
