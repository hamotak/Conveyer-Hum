/**
 * Proof that repairing old micro-chunks cannot accidentally reuse old
 * scene_000.mp3 / scene_000.mp4 files for the newly repaired beat #0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveMediaForScenePlanChange } from "../../src/lib/repair-archive.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function touch(filePath: string, text = "x"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function exists(rel: string, root: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

function staleCount(dir: string, prefix: string, root: string): number {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return 0;
  return fs.readdirSync(full).filter((name) => name.startsWith(prefix) && name.includes(".stale-")).length;
}

console.log("Scene repair archive:");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "conveyer-repair-"));
try {
  touch(path.join(root, "audio", "scene_000.mp3"));
  touch(path.join(root, "audio", "tail_voiceover.mp3"));
  touch(path.join(root, "audio", "tail_voiceover_part001.mp3"));
  touch(path.join(root, "images", "scene_000.png"));
  touch(path.join(root, "animations", "scene_000.mp4"));
  touch(path.join(root, "clips", "clip_000.mp4"));
  touch(path.join(root, "tail-clips", "t_000.mp4"));
  touch(path.join(root, "final.mp4"));
  touch(path.join(root, "final-poster.jpg"));
  touch(path.join(root, "sync-report.json"), "{}");
  touch(path.join(root, "audio", "notes.txt"));

  archiveMediaForScenePlanChange(root);

  check("old scene audio is no longer at the reusable path", !exists("audio/scene_000.mp3", root));
  check("old scene video is no longer at the reusable path", !exists("animations/scene_000.mp4", root));
  check("old rendered clip is no longer at the reusable path", !exists("clips/clip_000.mp4", root));
  check("tail files are archived before repair rebuild", !exists("tail.mp4", root) && !exists("audio/tail_voiceover.mp3", root));
  check("final video is archived before repair rebuild", !exists("final.mp4", root));
  check("archive files were created", staleCount("audio", "scene_000", root) === 1 && staleCount("animations", "scene_000", root) === 1);
  check("unrelated files are left alone", exists("audio/notes.txt", root));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
