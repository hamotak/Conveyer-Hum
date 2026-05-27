/**
 * Standalone proof for the Google Drive continuous-run upload fix.
 *
 *   node scripts/test-drive-rebuild.ts
 *
 * Node 24 strips the TS types natively, and scene-assets-disk.ts has no runtime
 * deps (only fs/path + type-only imports), so this runs with zero setup — no DB,
 * no FFmpeg, no test framework.
 *
 * Proves:
 *  1. A continuous run folder (scenes.json + voiceover_full.mp3 +
 *     animations/scene_000.mp4) reconstructs exactly 1 scene asset, with the
 *     video pointing at the animation and the audio at the shared voiceover.
 *  2. The cleanup gate refuses to delete raw clips on an empty or partial
 *     upload, and the empty-manifest guard fires when content exists on disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countRawClipsOnDisk,
  rebuildSceneAssetsFromDisk,
  shouldCleanupRawClips,
} from "../../src/lib/services/scene-assets-disk.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

/** Build a throwaway continuous-run folder and return its path. */
function makeContinuousRun(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conveyer-rebuild-"));
  const scenes = [
    {
      index: 0,
      text: "The lighthouse cut through the storm.",
      visual_prompt: "A lone lighthouse on a cliff in a raging storm, cinematic.",
      duration_hint_sec: 6,
    },
  ];
  fs.writeFileSync(path.join(dir, "scenes.json"), JSON.stringify(scenes, null, 2));
  fs.writeFileSync(path.join(dir, "voiceover_full.mp3"), "fake-mp3-bytes");
  fs.mkdirSync(path.join(dir, "animations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "animations", "scene_000.mp4"), "fake-mp4-bytes");
  return dir;
}

console.log("Test 1 — continuous run reconstructs 1 asset:");
const runDir = makeContinuousRun();
try {
  const assets = rebuildSceneAssetsFromDisk(runDir);
  check("produces exactly 1 asset", assets.length === 1);
  const a = assets[0];
  check("video points at animations/scene_000.mp4", !!a?.videoPath?.endsWith(path.join("animations", "scene_000.mp4")));
  check("audio points at the shared voiceover_full.mp3", a?.audio.filePath.endsWith("voiceover_full.mp3") === true);
  check("audio duration estimated from the scene hint (6s)", a?.audio.durationSec === 6);
  check("countRawClipsOnDisk sees 1 raw clip", countRawClipsOnDisk(runDir) === 1);

  // A synthetic buffer clip must NOT inflate the raw-clip count.
  fs.writeFileSync(path.join(runDir, "animations", "buffer_kenburns.mp4"), "fake");
  check("buffer_kenburns.mp4 is not counted as a raw scene clip", countRawClipsOnDisk(runDir) === 1);
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("Test 2 — cleanup gate refuses empty / partial uploads:");
check("empty upload (0 of 1) → do NOT clean", shouldCleanupRawClips(0, 1) === false);
check("partial upload (1 of 2) → do NOT clean", shouldCleanupRawClips(1, 2) === false);
check("degenerate (0 of 0) → do NOT clean", shouldCleanupRawClips(0, 0) === false);
check("complete upload (2 of 2) → clean", shouldCleanupRawClips(2, 2) === true);

console.log("Test 3 — empty-manifest guard fires when content exists but no video:");
{
  // scenes.json + raw clips on disk, but rebuild yields 0 assets because the
  // scene's video file is missing → the sync guard must refuse + keep clips.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conveyer-guard-"));
  try {
    fs.writeFileSync(
      path.join(dir, "scenes.json"),
      JSON.stringify([{ index: 0, text: "x", visual_prompt: "y", duration_hint_sec: 6 }])
    );
    fs.mkdirSync(path.join(dir, "animations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "animations", "scene_005.mp4"), "orphan clip"); // index mismatch

    const assets = rebuildSceneAssetsFromDisk(dir);
    const scenesJsonExists = fs.existsSync(path.join(dir, "scenes.json"));
    const rawClipCount = countRawClipsOnDisk(dir);
    const guardWouldThrow = assets.length === 0 && scenesJsonExists && rawClipCount > 0;
    check("rebuild yields 0 assets (no matching video)", assets.length === 0);
    check("raw clips still present on disk", rawClipCount === 1);
    check("empty-manifest guard condition is TRUE (would refuse + keep clips)", guardWouldThrow);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
