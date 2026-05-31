import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { resolveHybridFreshMinutes } from "./channel-stock";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitHybridScript, splitScript, type Scene } from "./services/scene-split";
import { synthesizeFullScript, synthesizeScene, synthesizeContinuous } from "./services/tts";
import { generateImage } from "./services/image-gen";
import { animateScene } from "./services/img2vid";
import {
  assembleContinuous,
  assembleHybrid,
  assembleTail,
  kenBurnsBufferFromClip,
  probeDurationSafe,
  type AssembleInput,
  type AssemblyClip,
  type SceneAVItem,
} from "./services/video-assemble";
import { cacheStockLibrary } from "./services/stock-library";
import { createShuffledStockDeckPicker } from "./stock-relevance";
import { ensureVideoPoster } from "./services/video-poster";
import { discoverLabs69Runtime } from "./services/labs69";
import { effectiveProviderSlots } from "./services/labs69-capacity";
import { syncRunToDrive, channelFolderName } from "./services/run-upload";
import { downloadReusedClip } from "./services/reuse";
import { findSimilarClips } from "./services/library";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";
import { loadStylePreset } from "./style-presets";
import { normalizeNarrationScenes } from "./scene-chunking";
import { analyzeScenePlan } from "./scene-plan-health";
import { archiveMediaForScenePlanChange } from "./repair-archive";
import { isContinuityMode, lastFramePath, planContinuity, type ContinuityMode, type ContinuityStep } from "./continuity";
import { extractLastFrame } from "./services/frame-extract";

const getReuseMapStmt = db.prepare("SELECT reuse_map_json FROM runs WHERE id = ?");
const getPresetSnapshotStmt = db.prepare(
  "SELECT preset_animation_motion, preset_voice_id, preset_name, preset_video_style, preset_voice_speed, preset_voice_provider, preset_style_preset_id, preset_video_model, preset_aspect_ratio, preset_voice_stability, preset_voice_similarity_boost, preset_voice_style, preset_stock_folder, preset_hybrid_fresh_minutes FROM runs WHERE id = ?"
);
const getRunRowStmt = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const getRunConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);
const getRunStatusStmt = db.prepare("SELECT status FROM runs WHERE id = ?");

const activeRunWorkers = new Set<string>();
const WORKER_STALE_MS = 2 * 60 * 1000;

function workerHeartbeatPath(runId: string): string {
  return path.join(getRunDir(runId), ".worker-active.json");
}

function touchWorkerHeartbeat(runId: string) {
  try {
    const runDir = getRunDir(runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(workerHeartbeatPath(runId), JSON.stringify({ runId, ts: Date.now() }), "utf-8");
  } catch {
    /* heartbeat is best-effort; the worker still owns the actual run */
  }
}

function removeWorkerHeartbeat(runId: string) {
  try {
    fs.rmSync(workerHeartbeatPath(runId), { force: true });
  } catch {
    /* ignore */
  }
}

function hasFreshWorkerHeartbeat(runId: string): boolean {
  try {
    return Date.now() - fs.statSync(workerHeartbeatPath(runId)).mtimeMs < WORKER_STALE_MS;
  } catch {
    return false;
  }
}

function hasRecentRunFiles(runId: string): boolean {
  const runDir = getRunDir(runId);
  const cutoff = Date.now() - WORKER_STALE_MS;
  const dirs = [runDir, path.join(runDir, "audio"), path.join(runDir, "clips"), path.join(runDir, "tail-clips")];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
      if (fs.statSync(dir).mtimeMs >= cutoff) return true;
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        if (fs.statSync(path.join(dir, entry)).mtimeMs >= cutoff) return true;
      } catch {
        /* file may disappear between readdir/stat */
      }
    }
  }
  return false;
}

export function isRunWorkerActive(runId: string): boolean {
  return activeRunWorkers.has(runId) || hasFreshWorkerHeartbeat(runId) || hasRecentRunFiles(runId);
}

function startRunWorker(runId: string, work: () => Promise<void>): { started: boolean; active: boolean } {
  const statusRow = getRunStatusStmt.get(runId) as { status?: string } | undefined;
  const status = statusRow?.status;
  if (
    activeRunWorkers.has(runId) ||
    hasFreshWorkerHeartbeat(runId) ||
    ((status === "running" || status === "pending") && hasRecentRunFiles(runId))
  ) {
    return { started: false, active: true };
  }
  activeRunWorkers.add(runId);
  touchWorkerHeartbeat(runId);
  const heartbeat = setInterval(() => touchWorkerHeartbeat(runId), 5000);
  work()
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Background worker crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    })
    .finally(() => {
      clearInterval(heartbeat);
      activeRunWorkers.delete(runId);
      removeWorkerHeartbeat(runId);
    });
  return { started: true, active: true };
}

export function startRunPipeline(runId: string, script: string): { started: boolean; active: boolean } {
  return startRunWorker(runId, () => runPipeline(runId, script));
}

export function startResumeRun(runId: string): { started: boolean; active: boolean } {
  return startRunWorker(runId, () => resumeRun(runId));
}

/** scene index → padded video file path on disk. */
function videoPathFor(animDir: string, index: number): string {
  return path.join(animDir, `scene_${String(index).padStart(3, "0")}.mp4`);
}

function videoManifestPath(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, ".manifest.json");
}

/** True only if the file exists AND is non-empty (guards against broken/0-byte files). */
function fileReady(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function generatedVideoReady(videoPath: string): boolean {
  if (!fileReady(videoPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(videoManifestPath(videoPath), "utf-8")) as Record<string, unknown>;
    const cleanup = manifest.cleanup as Record<string, unknown> | undefined;
    const cleanupStatus = typeof cleanup?.status === "string" ? cleanup.status : "";
    return (
      manifest.sourceMode === "image-to-video" &&
      manifest.target === path.basename(videoPath) &&
      cleanupStatus !== "failed" &&
      cleanupStatus !== "missing"
    );
  } catch {
    return false;
  }
}

/**
 * Resolve everything a run needs from its snapshot + the style preset (Prompt 9).
 *
 *  - The scene-split prompt ALWAYS comes from the style preset (channel's
 *    `preset_style_preset_id`, else the global `STYLE_PRESET_ID`).
 *  - For a CHANNEL run, voice/video overrides = channel column ?? preset default
 *    (the channel "owns" its creative settings; the preset fills any blanks).
 *  - For a NO-CHANNEL run, overrides are null → the per-scene services read the
 *    global settings (which the inline card manages from the chosen preset).
 */
function readPresetSnapshot(runId: string): {
  scenePrompt: string;
  presetName: string | null;
  styleOverride: string | null;
  voiceOverride: string | null;
  voiceProviderOverride: string | null;
  speedOverride: number | null;
  stabilityOverride: number | null;
  similarityOverride: number | null;
  voiceStyleOverride: number | null;
  modelOverride: string | null;
  aspectOverride: string | null;
  stockFolderOverride: string | null;
  freshMinutesOverride: number | null;
} {
  const row = getPresetSnapshotStmt.get(runId) as
    | {
        preset_animation_motion: string | null;
        preset_voice_id: string | null;
        preset_name: string | null;
        preset_video_style: string | null;
        preset_voice_speed: number | null;
        preset_voice_provider: string | null;
        preset_style_preset_id: string | null;
        preset_video_model: string | null;
        preset_aspect_ratio: string | null;
        preset_voice_stability: number | null;
        preset_voice_similarity_boost: number | null;
        preset_voice_style: number | null;
        preset_stock_folder: string | null;
        preset_hybrid_fresh_minutes: number | null;
      }
    | undefined;

  const stylePresetId = (row?.preset_style_preset_id ?? getSetting("STYLE_PRESET_ID")) || undefined;
  const preset = loadStylePreset(stylePresetId);
  const isChannelRun = row?.preset_name != null || row?.preset_style_preset_id != null;

  if (!isChannelRun) {
    // No channel — the run uses global settings; only the scene-split prompt is
    // driven by the (global) style preset.
    return {
      scenePrompt: preset.sceneSplitPrompt,
      presetName: null,
      styleOverride: null,
      voiceOverride: null,
      voiceProviderOverride: null,
      speedOverride: null,
      stabilityOverride: null,
      similarityOverride: null,
      voiceStyleOverride: null,
      modelOverride: null,
      aspectOverride: null,
      stockFolderOverride: null,
      freshMinutesOverride: null,
    };
  }

  return {
    scenePrompt: preset.sceneSplitPrompt,
    presetName: row?.preset_name ?? null,
    stockFolderOverride: row?.preset_stock_folder ?? null,
    freshMinutesOverride: row?.preset_hybrid_fresh_minutes ?? null,
    // video_style supersedes the legacy animation_motion snapshot; preset fills blanks.
    styleOverride: row?.preset_video_style ?? row?.preset_animation_motion ?? preset.defaults.videoStyle,
    voiceOverride: row?.preset_voice_id ?? null,
    voiceProviderOverride: row?.preset_voice_provider ?? null,
    speedOverride: row?.preset_voice_speed ?? preset.defaults.ttsSpeed,
    stabilityOverride: row?.preset_voice_stability ?? preset.defaults.ttsStability,
    similarityOverride: row?.preset_voice_similarity_boost ?? preset.defaults.ttsSimilarityBoost,
    voiceStyleOverride: row?.preset_voice_style ?? preset.defaults.ttsStyle,
    modelOverride: row?.preset_video_model ?? null,
    aspectOverride: row?.preset_aspect_ratio ?? null,
  };
}

/** Read the reuse map (scene index → Drive file id) the user picked on New Run. */
function readReuseMap(runId: string): Record<string, string> {
  const row = getReuseMapStmt.get(runId) as { reuse_map_json: string | null } | undefined;
  return row?.reuse_map_json ? (JSON.parse(row.reuse_map_json) as Record<string, string>) : {};
}

/**
 * Whether this run should auto-search the library for reusable clips.
 * Per-run choice from the New Run page (config_json.autoReuse); falls back to
 * the global AUTO_REUSE_ENABLED setting for runs created without it.
 */
function isAutoReuseRun(runId: string): boolean {
  const row = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
  if (row?.config_json) {
    try {
      const cfg = JSON.parse(row.config_json) as { autoReuse?: unknown };
      if (typeof cfg.autoReuse === "boolean") return cfg.autoReuse;
    } catch {}
  }
  return getSetting("AUTO_REUSE_ENABLED") === "1";
}

/**
 * When AUTO_REUSE_ENABLED is on, the pipeline searches the Drive library
 * itself and folds high-confidence matches into the reuse map — no Preview
 * step, no manual approval clicking. Mutates `reuseMap` in place.
 * Best-effort: a search failure just logs and the run proceeds with full
 * generation. Scenes the user already picked manually are left untouched.
 */
async function applyAutoReuse(
  runId: string,
  scenes: Scene[],
  reuseMap: Record<string, string>,
  channel: string
): Promise<void> {
  const threshold = Math.max(
    0,
    Math.min(100, Number(getSetting("AUTO_REUSE_THRESHOLD") || "80"))
  );
  try {
    log(
      runId,
      "info",
      `Auto-reuse on — searching the "${channel}" library for clips matching at >=${threshold}%`,
      { stage: "reuse" }
    );
    // Auto-reuse stays within the run's own channel so a channel never pulls
    // off-brand clips from a different channel.
    const matches = await findSimilarClips(scenes, { minScore: threshold, channel });
    const bestByScene = new Map<number, { id: string; score: number }>();
    for (const m of matches) {
      const cur = bestByScene.get(m.new_scene_index);
      if (!cur || m.score > cur.score) {
        bestByScene.set(m.new_scene_index, { id: m.drive_file_id, score: m.score });
      }
    }
    let picked = 0;
    for (const [sceneIdx, best] of bestByScene) {
      if (best.score >= threshold && !reuseMap[String(sceneIdx)]) {
        reuseMap[String(sceneIdx)] = best.id;
        picked++;
      }
    }
    log(
      runId,
      "success",
      `Auto-reuse: ${picked}/${scenes.length} scene${picked === 1 ? "" : "s"} matched the library — Grok generation skipped for them (~${picked} video credit${picked === 1 ? "" : "s"} saved)`,
      { stage: "reuse" }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Auto-reuse search failed — continuing with full generation: ${msg.slice(0, 150)}`, {
      stage: "reuse",
    });
  }
}

/** Provider-aware concurrency limiters for TTS, images, and video. */
async function makeLimiters(runId: string) {
  const caps = await discoverLabs69Runtime();
  const keyCount = Math.max(1, caps.keyCount);
  const imagePerKey = effectiveProviderSlots(getSetting("IMAGE_CONCURRENCY"), caps.imagePerKey, 7);
  const ttsPerKey = effectiveProviderSlots(getSetting("TTS_CONCURRENCY"), caps.ttsPerKey, 3);
  const animPerKey = effectiveProviderSlots(getSetting("ANIMATION_CONCURRENCY"), caps.videoPerKey, 5);
  const imageSlots = Math.max(20, imagePerKey * keyCount);
  const ttsSlots = ttsPerKey * keyCount;
  const animSlots = Math.max(5, animPerKey * keyCount);
  log(
    runId,
    "info",
    `69labs capacity: ${keyCount} key${keyCount === 1 ? "" : "s"} · image ${imageSlots} slots · video ${animSlots} slots · TTS ${ttsSlots} slots (${caps.source})`,
    {
      stage: "pipeline",
      data: {
        keyCount,
        imageSlots,
        videoSlots: animSlots,
        ttsSlots,
        imageRemainingMonthly: caps.imageRemainingMonthly,
        videoRemainingMonthly: caps.videoRemainingMonthly,
      },
    }
  );
  return {
    keyCount,
    imagePerKey,
    ttsPerKey,
    animPerKey,
    imageSlots,
    ttsSlots,
    animSlots,
    limitImage: pLimit(imageSlots),
    limitTts: pLimit(ttsSlots),
    limitAnim: pLimit(animSlots),
  };
}

/**
 * Logs the failure tally and throws if the failure rate is over the
 * user-configured threshold. Shared by runPipeline and resumeRun.
 */
function enforceFailureThreshold(runId: string, totalScenes: number, succeeded: number): void {
  const failedCount = totalScenes - succeeded;
  if (failedCount <= 0) return;
  const failedPct = (failedCount / totalScenes) * 100;
  const threshold = Math.max(
    0,
    Math.min(100, Number(getSetting("FAILURE_THRESHOLD_PERCENT") || "25"))
  );
  const over = failedPct > threshold;
  log(
    runId,
    over ? "error" : "warn",
    `${failedCount}/${totalScenes} scenes failed (${failedPct.toFixed(0)}%) · abort threshold ${threshold}%`,
    { stage: "pipeline" }
  );
  if (over) {
    throw new Error(
      `Too many scenes failed: ${failedCount}/${totalScenes} (${failedPct.toFixed(0)}% over the ${threshold}% threshold). The partial assets are kept — use Resume on the run page to regenerate only the missing scenes.`
    );
  }
}

const CONTINUOUS_CROSSFADE = 0.3;

/**
 * Build the ordered clip list for assembly (Prompt 10). Each scene clip is
 * TRIMMED to its narrated window so every scene's visual plays during its own
 * narration (no more discarding the back half). The target is each scene's
 * proportional share of the audio — `words[i]/totalWords × (audio + crossfades)`
 * — so after crossfade overlaps the trimmed clips sum to exactly the audio and
 * nothing is lost.
 *
 * If the trimmed clips still fall short (rare), the Prompt 8 buffer clip fills
 * the gap at NATIVE length (targetSec=null) — a fresh Veo clip, or a slow
 * Ken-Burns clip from the last frame. No freeze frames anywhere.
 */
interface VideoOpts {
  styleOverride: string | null;
  modelOverride: string | null;
  aspectOverride: string | null;
}

interface MediaLimiters {
  limitImage: ReturnType<typeof pLimit>;
  limitAnim: ReturnType<typeof pLimit>;
}

async function generateSceneVideoFromImage(
  runId: string,
  scene: Scene,
  imageDir: string,
  animDir: string,
  videoOpts: VideoOpts,
  limiters: MediaLimiters,
  continuityStep: ContinuityStep | null
): Promise<string | null> {
  const image = await limiters.limitImage(() =>
    generateImage(runId, scene, imageDir, {
      styleOverride: videoOpts.styleOverride,
      aspectOverride: videoOpts.aspectOverride,
      continuitySuffix: continuityStep?.promptSuffix ?? null,
    })
  );
  return limiters.limitAnim(() =>
    animateScene(runId, scene, image.filePath, animDir, {
      providerJobId: image.providerJobId,
      imageProvider: image.provider,
      ...videoOpts,
    })
  );
}

/**
 * Resolve VISUAL_CONTINUITY_MODE from settings (safe default = "prompt").
 * Logs a clear note that "keyframe" mode is recognised but not active yet
 * because true last-frame chaining requires the provider to fetch a public
 * URL — the current 69labs client has no upload endpoint.
 */
function resolveContinuityMode(runId: string): ContinuityMode {
  const raw = (getSetting("VISUAL_CONTINUITY_MODE") || "prompt").toLowerCase();
  const mode: ContinuityMode = isContinuityMode(raw) ? raw : "prompt";
  if (mode === "keyframe") {
    log(
      runId,
      "warn",
      "VISUAL_CONTINUITY_MODE=keyframe — the 69labs client has no upload endpoint and no public URL host is configured, so the pipeline falls back to prompt mode for this run. Last-frame JPGs are still extracted for future use.",
      { stage: "pipeline" }
    );
    return "prompt";
  }
  return mode;
}

/** Best-effort: write the last frame of a clip to runDir/continuity/scene_NNN_last.jpg.
 *  Never fails the run — logs a warning and continues. */
async function recordLastFrame(
  runId: string,
  scene: Scene,
  videoPath: string,
  runDir: string
): Promise<void> {
  try {
    await extractLastFrame(videoPath, lastFramePath(runDir, scene.index));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Last-frame extract failed for scene ${scene.index + 1}: ${msg.slice(0, 200)}`, {
      stage: "pipeline",
    });
  }
}

async function buildAssemblyClips(
  runId: string,
  sceneVideos: { scene: Scene; videoPath: string }[],
  audioDuration: number,
  videoOpts: VideoOpts,
  imageDir: string,
  animDir: string,
  limiters: MediaLimiters
): Promise<AssemblyClip[]> {
  const ordered = [...sceneVideos].sort((a, b) => a.scene.index - b.scene.index);
  const wc = (t: string) => t.trim().split(/\s+/).filter(Boolean).length || 1;
  const totalWords = ordered.reduce((s, v) => s + wc(v.scene.text), 0) || 1;
  // Allocate the audio PLUS the crossfade budget across scenes by word share, so
  // that after (N-1) crossfade overlaps the trimmed video sums back to the audio.
  const budget = audioDuration + Math.max(0, ordered.length - 1) * CONTINUOUS_CROSSFADE;
  const clips: AssemblyClip[] = ordered.map((v) => ({
    path: v.videoPath,
    targetSec: (wc(v.scene.text) / totalWords) * budget,
  }));

  // Coverage from the trimmed targets (clamped ≥2s in the renderer). A buffer
  // clip is only needed if the trimmed clips can't reach the audio length.
  const trimmedSum = clips.reduce((s, c) => s + Math.max(2, c.targetSec ?? 0), 0);
  const coverage = trimmedSum - Math.max(0, clips.length - 1) * CONTINUOUS_CROSSFADE;
  if (coverage >= audioDuration - 0.1) return clips;

  const gap = audioDuration - coverage;
  const last = ordered[ordered.length - 1];
  log(
    runId,
    "info",
    `Trimmed clips cover ${coverage.toFixed(1)}s of ${audioDuration.toFixed(1)}s audio — covering the ${gap.toFixed(1)}s gap`,
    { stage: "animate" }
  );

  const bufferScene: Scene = {
    index: ordered.length + 100,
    text: "",
    visual_prompt: last.scene.visual_prompt,
    duration_hint_sec: 8,
  };
  try {
    log(runId, "info", "buffer clip (image-to-video audio coverage)", { stage: "animate" });
    const bufPath = await generateSceneVideoFromImage(
      runId,
      bufferScene,
      imageDir,
      animDir,
      videoOpts,
      limiters,
      null
    );
    if (!bufPath) throw new Error("buffer clip returned no path");
    clips.push({ path: bufPath, targetSec: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Buffer clip failed (${msg.slice(0, 160)}) — using a slow Ken-Burns clip from the last frame`, {
      stage: "animate",
    });
    const [w, h] = (getSetting("VIDEO_RESOLUTION") || "1920x1080").split("x").map(Number);
    const fps = Number(getSetting("VIDEO_FPS") || "30");
    const fbPath = path.join(animDir, "buffer_kenburns.mp4");
    await kenBurnsBufferFromClip(last.videoPath, fbPath, w, h, fps, gap + 0.6);
    clips.push({ path: fbPath, targetSec: null });
  }
  return clips;
}

/**
 * Final assembly (continuous voiceover) + Drive sync + mark the run done.
 * `assemblyClips` carry each scene's narrated-window trim target.
 * Shared by the full run and resume flows.
 */
async function finishRunContinuous(
  runId: string,
  assemblyClips: AssemblyClip[],
  sceneVideos: { scene: Scene; videoPath: string }[],
  audioPath: string,
  audioDuration: number,
  runDir: string
): Promise<void> {
  checkCancelled(runId);
  const finalPath = await assembleContinuous(runId, assemblyClips, audioPath, runDir);
  try {
    const finalSec = await probeDurationSafe(finalPath);
    fs.writeFileSync(
      path.join(runDir, "sync-report.json"),
      JSON.stringify(
        {
          mode: "continuous",
          sceneCount: sceneVideos.length,
          totalSec: finalSec,
          voiceoverSec: audioDuration,
          totalDriftSec: Math.abs(finalSec - audioDuration),
          continuousVoiceover: true,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {}
  try {
    await ensureVideoPoster(finalPath, path.join(runDir, "final-poster.jpg"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Poster preview failed (video is still usable): ${msg.slice(0, 160)}`, {
      stage: "assemble",
    });
  }

  // Drive sync is best-effort, and covers the real scene clips only (not the
  // synthetic buffer clip). Each asset points at the shared continuous audio.
  const ordered = [...sceneVideos].sort((a, b) => a.scene.index - b.scene.index);
  const perClip = ordered.length > 0 ? audioDuration / ordered.length : 0;
  const assets: AssembleInput[] = ordered.map((v) => ({
    scene: v.scene,
    imagePath: v.videoPath,
    videoPath: v.videoPath,
    audio: { filePath: audioPath, durationSec: perClip },
  }));
  try {
    checkCancelled(runId);
    await syncRunToDrive(runId, assets, runDir, finalPath);
    checkCancelled(runId);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
  }

  checkCancelled(runId);
  updateRun.run("done", finalPath, runId);
  log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
}

/** Translate a thrown error into the right run status + log. Shared catch. */
function handlePipelineError(runId: string, e: unknown): void {
  if (e instanceof CancelledError) {
    log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    // status 'cancelled' was already set by the cancel endpoint
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
    updateRun.run("error", null, runId);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Full run
// ───────────────────────────────────────────────────────────────────────────

export async function runPipeline(runId: string, script: string) {
  // Per-run mode (full | hybrid | stock) routes through the sync-correct hybrid
  // pipeline. Legacy: the global HYBRID_MODE toggle still works for old runs.
  const cfgRow = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
  let runMode: string | undefined;
  if (cfgRow?.config_json) {
    try {
      runMode = (JSON.parse(cfgRow.config_json) as { mode?: string }).mode;
    } catch {}
  }
  if (runMode === "full" || runMode === "hybrid" || runMode === "stock" || (getSetting("HYBRID_MODE") || "") === "1") {
    return runHybridPipeline(runId, script);
  }

  const runDir = getRunDir(runId);
  const imageDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  // Continuous voiceover writes ONE voiceover_full.mp3 in runDir — no per-scene audio dir.
  for (const d of [runDir, imageDir, animDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", `Pipeline started · folder: ${path.basename(runDir)}`, { stage: "pipeline" });

    // 1. Split script into scenes — channel profile snapshot drives the prompt,
    //    voice and motion overrides.
    const {
      scenePrompt,
      styleOverride,
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
      modelOverride,
      aspectOverride,
      presetName,
    } = readPresetSnapshot(runId);
    const ttsOpts = {
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
    };
    const videoOpts: VideoOpts = { styleOverride, modelOverride, aspectOverride };
    const scenes = await splitScript(runId, script, scenePrompt);
    checkCancelled(runId);
    fs.writeFileSync(path.join(runDir, "scenes.json"), JSON.stringify(scenes, null, 2), "utf-8");

    const reuseMap = readReuseMap(runId);

    // Auto-reuse — when the run is in Auto mode, the pipeline searches the
    // library itself and folds matches into the reuse map (no Preview step).
    if (isAutoReuseRun(runId)) {
      await applyAutoReuse(runId, scenes, reuseMap, channelFolderName(presetName));
      checkCancelled(runId);
    }

    const reuseCount = Object.keys(reuseMap).length;
    if (reuseCount > 0) {
      log(
        runId,
        "info",
        `${reuseCount} scene${reuseCount === 1 ? "" : "s"} will reuse an existing clip — those skip Grok generation`,
        { stage: "reuse", data: { reuseMap } }
      );
    }

    // 2. Guard: Conveyer Hum is video-only, the animation provider must be set.
    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    if (animProvider === "off") {
      throw new Error(
        "Conveyer Hum is video-only: ANIMATION_PROVIDER cannot be 'off'. Set it to '69labs' in /settings."
      );
    }

    // 3. Continuous voiceover: ONE TTS call for the whole script, plus one video
    //    per scene — generated in parallel. One audio call = one consistent voice
    //    and no inter-scene seams.
    const { keyCount, imagePerKey, ttsPerKey, animPerKey, imageSlots, ttsSlots, animSlots, limitImage, limitTts, limitAnim } = await makeLimiters(runId);
    log(
      runId,
      "info",
      `Generating: 1 continuous voiceover + ${scenes.length} image keyframes + ${scenes.length} image-to-video clips. Keys: ${keyCount} · image=${imageSlots} (${imagePerKey}/key), TTS=${ttsSlots} (${ttsPerKey}/key), video=${animSlots} (${animPerKey}/key). Provider: ${animProvider}`,
      { stage: "pipeline" }
    );

    const fullScript = scenes.map((s) => s.text).join(" ");
    const audioPath = path.join(runDir, "voiceover_full.mp3");

    // ONE TTS call (auto-retry once on transient failure). Runs alongside video.
    const audioPromise = limitTts(() => synthesizeFullScript(runId, fullScript, audioPath, ttsOpts)).catch(
      async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(runId, "warn", `Voiceover failed, retrying once: ${msg.slice(0, 300)}`, { stage: "tts" });
        return limitTts(() => synthesizeFullScript(runId, fullScript, audioPath, ttsOpts));
      }
    );

    // Continuity plan — computed once from scenes.json. Pure; stays parallel.
    const continuityMode = resolveContinuityMode(runId);
    const continuityPlan = new Map<number, ContinuityStep>();
    for (const step of planContinuity(scenes, continuityMode)) continuityPlan.set(step.index, step);
    if (continuityMode !== "off") {
      const anchored = [...continuityPlan.values()].filter((s) => s.anchorIndex !== null).length;
      log(runId, "info", `Visual continuity: ${continuityMode} · ${anchored}/${scenes.length} scenes anchored to a predecessor`, { stage: "pipeline" });
    }

    const videoSettled = await Promise.all(
      scenes.map(async (scene) => {
        try {
          checkCancelled(runId);
          const reuseFileId = reuseMap[String(scene.index)];
          const videoPath = reuseFileId
            ? await downloadReusedClip(runId, scene, reuseFileId, animDir)
            : await generateSceneVideoFromImage(runId, scene, imageDir, animDir, videoOpts, {
                limitImage,
                limitAnim,
              }, continuityPlan.get(scene.index) ?? null);
          if (!videoPath) throw new Error(`Scene #${scene.index} produced no video clip`);
          // Best-effort: write the clip's last frame for future keyframe chaining
          // and per-scene debugging. Never blocks the success path.
          if (continuityMode !== "off") void recordLastFrame(runId, scene, videoPath, runDir);
          return { scene, videoPath };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 1500)}`, { stage: "pipeline" });
          return null;
        }
      })
    );

    // One TTS failure (after the retry) fails the whole run — no per-scene recovery.
    const audio = await audioPromise;

    const sceneVideos = videoSettled.filter((x): x is { scene: Scene; videoPath: string } => x !== null);
    enforceFailureThreshold(runId, scenes.length, sceneVideos.length);
    if (sceneVideos.length === 0) throw new Error("No scenes succeeded");

    const assemblyClips = await buildAssemblyClips(runId, sceneVideos, audio.durationSec, videoOpts, imageDir, animDir, {
      limitImage,
      limitAnim,
    });
    await finishRunContinuous(runId, assemblyClips, sceneVideos, audio.filePath, audio.durationSec, runDir);
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Resume — regenerate only the missing scenes of a failed/partial run
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resumes a run that failed or was cancelled partway through. Reads the saved
 * scenes.json, keeps every scene whose audio + video are already on disk, and
 * regenerates ONLY the missing ones — then re-assembles and re-uploads.
 *
 * This is what makes runs failure-proof: a provider glitch / rate-cap night
 * no longer throws away clips already paid for.
 */
export async function resumeRun(runId: string) {
  const row = getRunRowStmt.get(runId) as { id: string; script: string } | undefined;
  if (!row) throw new Error("Run not found");
  const cfgRow = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
  let mode: string | undefined;
  if (cfgRow?.config_json) {
    try {
      mode = (JSON.parse(cfgRow.config_json) as { mode?: string }).mode;
    } catch {}
  }
  // Hybrid / stock / full (modern path) — resume without re-splitting scenes.
  if (mode === "hybrid" || mode === "stock" || mode === "full") {
    return runHybridPipeline(runId, row.script, { reuseScenes: true });
  }

  const runDir = getRunDir(runId);
  const imageDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  for (const d of [runDir, imageDir, animDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", "Resume started — keeping finished scenes, regenerating the rest", {
      stage: "pipeline",
    });

    // The saved scene plan is required — without it there's nothing to resume.
    const scenesPath = path.join(runDir, "scenes.json");
    if (!fileReady(scenesPath)) {
      throw new Error(
        "scenes.json not found for this run — there's no saved scene plan to resume from. Start a fresh run instead."
      );
    }
    const scenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("scenes.json is empty or invalid — start a fresh run instead.");
    }
    checkCancelled(runId);

    const {
      styleOverride,
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
      modelOverride,
      aspectOverride,
    } = readPresetSnapshot(runId);
    const ttsOpts = {
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
    };
    const videoOpts: VideoOpts = { styleOverride, modelOverride, aspectOverride };
    const reuseMap = readReuseMap(runId);

    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    if (animProvider === "off") {
      throw new Error(
        "Conveyer Hum is video-only: ANIMATION_PROVIDER cannot be 'off'. Set it to '69labs' in /settings."
      );
    }

    const audioPath = path.join(runDir, "voiceover_full.mp3");
    const haveAudio = fileReady(audioPath);
    const alreadyVideos = scenes.filter((s) => fileReady(videoPathFor(animDir, s.index))).length;
    log(
      runId,
      "info",
      `${alreadyVideos}/${scenes.length} scene videos on disk — regenerating the rest${haveAudio ? "" : " + the voiceover"}`,
      { stage: "pipeline" }
    );

    const { limitImage, limitTts, limitAnim } = await makeLimiters(runId);

    // Audio: reuse the continuous track if present, else synthesize it once (retry once).
    const fullScript = scenes.map((s) => s.text).join(" ");
    const audioPromise: Promise<{ filePath: string; durationSec: number }> = haveAudio
      ? probeDurationSafe(audioPath).then((d) => ({ filePath: audioPath, durationSec: d }))
      : limitTts(() => synthesizeFullScript(runId, fullScript, audioPath, ttsOpts)).catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "warn", `Voiceover failed, retrying once: ${msg.slice(0, 300)}`, { stage: "tts" });
          return limitTts(() => synthesizeFullScript(runId, fullScript, audioPath, ttsOpts));
        });

    // Continuity plan, same as the full-run path. Resume regenerates only the
    // missing scenes; the plan is still computed against the full scene list so
    // an anchor's hint is available even when the anchor is already on disk.
    const continuityMode = resolveContinuityMode(runId);
    const continuityPlan = new Map<number, ContinuityStep>();
    for (const step of planContinuity(scenes, continuityMode)) continuityPlan.set(step.index, step);

    const videoSettled = await Promise.all(
      scenes.map(async (scene) => {
        try {
          checkCancelled(runId);
          const vPath = videoPathFor(animDir, scene.index);
          if (generatedVideoReady(vPath)) return { scene, videoPath: vPath };
          const reuseFileId = reuseMap[String(scene.index)];
          const generated = reuseFileId
            ? await downloadReusedClip(runId, scene, reuseFileId, animDir)
            : await generateSceneVideoFromImage(runId, scene, imageDir, animDir, videoOpts, {
                limitImage,
                limitAnim,
              }, continuityPlan.get(scene.index) ?? null);
          if (!generated) throw new Error(`Scene #${scene.index} produced no video clip`);
          if (continuityMode !== "off") void recordLastFrame(runId, scene, generated, runDir);
          return { scene, videoPath: generated };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 1500)}`, { stage: "pipeline" });
          return null;
        }
      })
    );

    const audio = await audioPromise;
    const sceneVideos = videoSettled.filter((x): x is { scene: Scene; videoPath: string } => x !== null);
    enforceFailureThreshold(runId, scenes.length, sceneVideos.length);
    if (sceneVideos.length === 0) throw new Error("No scenes succeeded");

    const assemblyClips = await buildAssemblyClips(runId, sceneVideos, audio.durationSec, videoOpts, imageDir, animDir, {
      limitImage,
      limitAnim,
    });
    await finishRunContinuous(runId, assemblyClips, sceneVideos, audio.filePath, audio.durationSec, runDir);
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Hybrid run — fresh AI opening + narration-aware stock-library tail, per-scene audio
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hybrid pipeline for long sleep videos:
 *  - Every scene gets its OWN narration mp3 (per-scene audio = perfect sync).
 *  - The first HYBRID_FRESH_MINUTES of narration get freshly generated AI clips
 *    (image → video), the topical, synced opening.
 *  - Every later scene is filled from the Drive stock library
 *    (STOCK_LIBRARY_FOLDER, e.g. "Pirates"), ordered against the narration when
 *    local clip names contain useful hints — no generation, no extra tokens.
 *  - Assembly fits each clip to its scene's narration → zero audio/video drift.
 */
export async function runHybridPipeline(runId: string, script: string, opts?: { reuseScenes?: boolean }) {
  const runDir = getRunDir(runId);
  const imageDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  const audioDir = path.join(runDir, "audio");
  for (const d of [runDir, imageDir, animDir, audioDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);

    const {
      scenePrompt,
      styleOverride,
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
      modelOverride,
      aspectOverride,
      stockFolderOverride,
      freshMinutesOverride,
    } = readPresetSnapshot(runId);

    // Mode (full | hybrid | stock) from the run config; stock folder + fresh
    // minutes come from the channel (overrides) before the global default.
    const cfgRow = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
    let mode: "full" | "hybrid" | "stock" = "hybrid";
    if (cfgRow?.config_json) {
      try {
        const m = (JSON.parse(cfgRow.config_json) as { mode?: string }).mode;
        if (m === "full" || m === "stock") mode = m;
      } catch {}
    }
    const stockFolder = (stockFolderOverride || getSetting("STOCK_LIBRARY_FOLDER") || "Pirates").trim() || "Pirates";
    const freshMinutes =
      mode === "full"
        ? 1e9
        : mode === "stock"
          ? 0
          : Math.max(1, freshMinutesOverride ?? resolveHybridFreshMinutes(null, getSetting("HYBRID_FRESH_MINUTES")));
    log(
      runId,
      "info",
      `${mode} run · ${mode === "hybrid" ? `${freshMinutes} min fresh + ` : mode === "full" ? "all fresh, " : "all "}stock "${stockFolder}" · folder: ${path.basename(runDir)}`,
      { stage: "pipeline" }
    );
    const ttsOpts = {
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
    };
    const videoOpts: VideoOpts = { styleOverride, modelOverride, aspectOverride };

    // 1. Split the script — or reuse scenes.json on resume (skip expensive re-split).
    const scenesPath = path.join(runDir, "scenes.json");
    let scenes: Scene[];
    let reuseSavedAssets = !!opts?.reuseScenes;
    if (opts?.reuseScenes && fileReady(scenesPath)) {
      const savedScenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];
      if (!Array.isArray(savedScenes) || savedScenes.length === 0) {
        throw new Error("scenes.json is empty — start a fresh run instead.");
      }
      const health = analyzeScenePlan(savedScenes);
      if (health.ok) {
        scenes = savedScenes;
        log(runId, "info", `Resume: reusing saved scene plan (${scenes.length} scenes)`, { stage: "scene_split" });
      } else {
        reuseSavedAssets = false;
        if (mode === "hybrid" || mode === "stock") {
          scenes = (await splitHybridScript(runId, script, mode === "stock" ? 0 : freshMinutes * 60, scenePrompt)).scenes;
        } else {
          const repaired = normalizeNarrationScenes(savedScenes);
          const repairedHealth = analyzeScenePlan(repaired);
          scenes = repairedHealth.ok ? repaired : await splitScript(runId, script, scenePrompt);
        }
        try {
          fs.copyFileSync(scenesPath, path.join(runDir, `scenes.microchunks.${Date.now()}.json`));
        } catch {}
        fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2), "utf-8");
        archiveMediaForScenePlanChange(runDir);
        log(
          runId,
          "warn",
          `${health.issue} Rebuilt it into ${scenes.length} sentence-safe beats. Old media was archived so this resume cannot reuse broken scene files.`,
          { stage: "scene_split", data: { before: health, after: analyzeScenePlan(scenes) } }
        );
      }
    } else {
      reuseSavedAssets = false;
      scenes = mode === "hybrid" || mode === "stock"
        ? (await splitHybridScript(runId, script, mode === "stock" ? 0 : freshMinutes * 60, scenePrompt)).scenes
        : await splitScript(runId, script, scenePrompt);
      checkCancelled(runId);
      fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2), "utf-8");
    }
    checkCancelled(runId);

    // 2. Decide the fresh/stock cut-over by cumulative estimated narration.
    const hasSourceMarkers = scenes.some((s) => s.source_kind === "fresh" || s.source_kind === "stock");
    const freshCutoffSec = freshMinutes * 60;
    let cum = 0;
    let freshCount = hasSourceMarkers ? scenes.filter((s) => s.source_kind === "fresh").length : 0;
    if (!hasSourceMarkers) {
      for (const s of scenes) {
        if (cum >= freshCutoffSec) break;
        cum += Math.max(1, s.duration_hint_sec || 5);
        freshCount++;
      }
    }
    // If the whole script fits in the fresh window, there's no stock tail.
    const stockCount = scenes.length - freshCount;
    const splitSummary =
      mode === "full"
        ? `${scenes.length} scenes · all fresh AI clips`
        : mode === "stock"
          ? `${scenes.length} scenes · all stock B-roll`
          : `${scenes.length} scenes · first ${freshCount} fresh (≈${freshMinutes} min), ${stockCount} from stock library`;
    log(runId, "info", splitSummary, { stage: "pipeline" });

    const freshScenes = scenes.filter((s) => s.index < freshCount);
    const tailScenes = scenes.filter((s) => s.index >= freshCount);

    // 3. Cache the stock library locally (only if we need a tail).
    let pickStockPath: (() => string) | null = null;
    if (stockCount > 0) {
      const cached = await cacheStockLibrary(runId, stockFolder);
      checkCancelled(runId);
      if (cached.length === 0) {
        throw new Error(`Stock library "${stockFolder}" produced no usable clips — add clips to Drive or lower HYBRID_FRESH_MINUTES.`);
      }
      const plan = createShuffledStockDeckPicker(cached, runId);
      pickStockPath = plan.pick;
      log(
        runId,
        "info",
        `Stock deck shuffled: ${plan.deckSize ?? cached.length} clips · one full pass before repeats · seed ${runId.slice(0, 8)}`,
        { stage: "reuse", data: { mode: plan.mode, deckSize: plan.deckSize, stockBeatCount: tailScenes.length } }
      );
    }

    const { keyCount, imagePerKey, ttsPerKey, animPerKey, imageSlots, ttsSlots, animSlots, limitImage, limitTts, limitAnim } = await makeLimiters(runId);
    log(
      runId,
      "info",
      `${freshScenes.length} fresh synced scenes + continuous-voice tail over ${tailScenes.length} scenes. Keys: ${keyCount} · image=${imageSlots} (${imagePerKey}/key), TTS=${ttsSlots} (${ttsPerKey}/key), video=${animSlots} (${animPerKey}/key)`,
      { stage: "pipeline" }
    );
    log(runId, "info", "Fresh opening starts voice and visuals together.", { stage: "pipeline" });

    const tailPromise: Promise<{ path: string } | null> = (async () => {
      if (tailScenes.length === 0 || !pickStockPath) return null;
      checkCancelled(runId);
      const tailPath = path.join(runDir, "tail.mp4");
      const tailText = tailScenes.map((s) => s.text).join(" ");
      const tailAudioPath = path.join(audioDir, "tail_voiceover.mp3");
      const tailAudio = await limitTts(() => synthesizeContinuous(runId, tailText, tailAudioPath, ttsOpts));
      checkCancelled(runId);
      if (reuseSavedAssets && fileReady(tailPath)) {
        const tailDuration = await probeDurationSafe(tailPath);
        if (tailDuration >= Math.max(1, tailAudio.durationSec - 1)) {
          log(runId, "info", "Tail segment already exists — reusing it", { stage: "assemble" });
          return { path: tailPath };
        }
        log(runId, "warn", "Tail segment was incomplete — rebuilding from saved B-roll clips", { stage: "assemble" });
      }
      checkCancelled(runId);
      return assembleTail(runId, tailAudio.filePath, pickStockPath, runDir);
    })().catch((e) => {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Tail failed: ${msg.slice(0, 600)}`, { stage: "pipeline" });
      throw e;
    });

    // 4a. Fresh opening — per-scene voiceover + fresh AI clip, frame-synced.
    const settledFresh = await Promise.all(
      freshScenes.map(async (scene): Promise<SceneAVItem | null> => {
        try {
          checkCancelled(runId);
          const audioPath = path.join(audioDir, `scene_${String(scene.index).padStart(3, "0")}.mp3`);
          const vPath = videoPathFor(animDir, scene.index);
          const audioPromise = reuseSavedAssets && fileReady(audioPath)
            ? probeDurationSafe(audioPath).then((durationSec) => ({ filePath: audioPath, durationSec }))
            : limitTts(() => synthesizeScene(runId, scene, audioDir, ttsOpts));
          const videoPromise = reuseSavedAssets && generatedVideoReady(vPath)
            ? Promise.resolve(vPath)
            : generateSceneVideoFromImage(
              runId,
              scene,
              imageDir,
              animDir,
              videoOpts,
              { limitImage, limitAnim },
              null
            );
          const [audio, v] = await Promise.all([audioPromise, videoPromise]);
          if (!v) throw new Error(`Scene #${scene.index} produced no fresh clip`);
          return { index: scene.index, videoPath: v, audioPath: audio.filePath, kind: "fresh" };
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 600)}`, { stage: "pipeline" });
          return null;
        }
      })
    );
    const freshItems = settledFresh.filter((x): x is SceneAVItem => x !== null);

    // 4b. Tail — ONE continuous voiceover over selected stock clips (fade-to-black).
    const tail = await tailPromise;

    // Fail only if the fresh opening mostly failed (the tail is best-effort B-roll).
    enforceFailureThreshold(runId, freshScenes.length, freshItems.length);
    if (freshItems.length === 0 && !tail) throw new Error("No scenes succeeded");

    // 5. Assemble: fresh per-scene (synced) + continuous tail.
    checkCancelled(runId);
    const { finalPath, totalSec, maxDriftSec } = await assembleHybrid(runId, freshItems, tail, runDir);
    const items = freshItems;

    // Persist a sync report so the UI can prove alignment.
    try {
      fs.writeFileSync(
        path.join(runDir, "sync-report.json"),
        JSON.stringify(
          {
            mode,
            freshScenes: freshItems.length,
            continuousTail: !!tail,
            tailScenes: tail ? tailScenes.length : 0,
            totalSec,
            freshMaxDriftSec: maxDriftSec,
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch {}

    log(
      runId,
      "success",
      `Sync report: ${freshItems.length} fresh synced scenes${tail ? " + continuous tail" : ""} · ${(totalSec / 60).toFixed(1)} min · fresh max drift ${maxDriftSec.toFixed(3)}s`,
      { stage: "assemble" }
    );

    // 6. Poster + Drive sync (best-effort) + mark done.
    try {
      await ensureVideoPoster(finalPath, path.join(runDir, "final-poster.jpg"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Poster preview failed (video is still usable): ${msg.slice(0, 160)}`, { stage: "assemble" });
    }
    try {
      checkCancelled(runId);
      const assets: AssembleInput[] = items
        .filter((it) => it.kind === "fresh")
        .map((it) => {
          const scene = scenes.find((s) => s.index === it.index)!;
          return {
            scene,
            imagePath: it.videoPath,
            videoPath: it.videoPath,
            audio: { filePath: it.audioPath, durationSec: 0 },
          };
        });
      await syncRunToDrive(runId, assets, runDir, finalPath);
      checkCancelled(runId);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
    }

    checkCancelled(runId);
    updateRun.run("done", finalPath, runId);
    const label = mode === "stock" ? "Stock Cut" : mode === "full" ? "Full Render" : "Hybrid";
    log(runId, "success", `${label} pipeline complete`, { stage: "pipeline", data: { finalPath } });
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

/** Whether a run can be resumed — needs a row + a saved scenes.json on disk. */
export function canResumeRun(runId: string): boolean {
  const row = getRunRowStmt.get(runId) as { id: string } | undefined;
  if (!row) return false;
  return fileReady(path.join(getRunDir(runId), "scenes.json"));
}
