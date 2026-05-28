/**
 * Preflight: confirm the machine can actually finish a run before the user
 * spends time (and money) on one. Required checks (keys, FFmpeg, output folder)
 * gate the run; Drive is informational.
 *
 * `buildPreflight` is pure (facts → result) so the readiness logic is unit-tested
 * without touching the filesystem; `runPreflight` gathers the real facts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { getSetting } from "./settings";
import { getRunsRoot } from "./run-paths";
import { buildPreflight, type PreflightResult } from "./preflight-eval";

export { buildPreflight } from "./preflight-eval";
export type { CheckStatus, PreflightCheck, PreflightResult, PreflightFacts } from "./preflight-eval";

/** Count distinct 69labs keys (newline/comma/semicolon separated), without exposing them. */
function labs69KeyCount(): number {
  return getSetting("LABS69_API_KEY")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** Probe FFmpeg quickly (system `ffmpeg` or the configured FFMPEG_PATH). */
function ffmpegAvailable(): boolean {
  const cmd = getSetting("FFMPEG_PATH").trim() || "ffmpeg";
  try {
    const res = spawnSync(cmd, ["-version"], { timeout: 4000, stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Is the runs output directory present + writable? */
function outputWritable(): boolean {
  try {
    const root = getRunsRoot();
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Gather real facts and evaluate. Never returns secret values — only presence. */
export function runPreflight(): PreflightResult {
  return buildPreflight({
    googleKey: !!getSetting("GOOGLE_API_KEY").trim(),
    labs69KeyCount: labs69KeyCount(),
    ffmpeg: ffmpegAvailable(),
    outputWritable: outputWritable(),
    voiceConfigured: !!getSetting("TTS_VOICE_ID").trim(),
    driveConnected: !!getSetting("GDRIVE_REFRESH_TOKEN").trim(),
    driveSyncEnabled: getSetting("GDRIVE_SYNC_ENABLED") === "1",
  });
}
