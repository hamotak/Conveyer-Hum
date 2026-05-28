import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript, type Scene } from "./services/scene-split";
import { synthesizeFullScript } from "./services/tts";
import { generateImage } from "./services/image-gen";
import { animateScene } from "./services/img2vid";
import {
  assembleContinuous,
  kenBurnsBufferFromClip,
  probeDurationSafe,
  type AssembleInput,
  type AssemblyClip,
} from "./services/video-assemble";
import { ensureVideoPoster } from "./services/video-poster";
import { getKeyCount } from "./services/labs69";
import { syncRunToDrive, channelFolderName } from "./services/run-upload";
import { downloadReusedClip } from "./services/reuse";
import { findSimilarClips } from "./services/library";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";
import { loadStylePreset } from "./style-presets";
import { isContinuityMode, lastFramePath, planContinuity, type ContinuityMode, type ContinuityStep } from "./continuity";
import { extractLastFrame } from "./services/frame-extract";

const getReuseMapStmt = db.prepare("SELECT reuse_map_json FROM runs WHERE id = ?");
const getPresetSnapshotStmt = db.prepare(
  "SELECT preset_animation_motion, preset_voice_id, preset_name, preset_video_style, preset_voice_speed, preset_voice_provider, preset_style_preset_id, preset_video_model, preset_aspect_ratio, preset_voice_stability, preset_voice_similarity_boost, preset_voice_style FROM runs WHERE id = ?"
);
const getRunRowStmt = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const getRunConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

/** scene index → padded video file path on disk. */
function videoPathFor(animDir: string, index: number): string {
  return path.join(animDir, `scene_${String(index).padStart(3, "0")}.mp4`);
}
/** True only if the file exists AND is non-empty (guards against broken/0-byte files). */
function fileReady(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
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
    };
  }

  return {
    scenePrompt: preset.sceneSplitPrompt,
    presetName: row?.preset_name ?? null,
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

/** Per-key × key-count concurrency limiters for TTS and video. */
function makeLimiters() {
  const keyCount = Math.max(1, getKeyCount());
  const imagePerKey = Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5"));
  const ttsPerKey = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3"));
  const animPerKey = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3"));
  return {
    keyCount,
    imagePerKey,
    ttsPerKey,
    animPerKey,
    limitImage: pLimit(imagePerKey * keyCount),
    limitTts: pLimit(ttsPerKey * keyCount),
    limitAnim: pLimit(animPerKey * keyCount),
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
  animDir: string
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
    log(runId, "info", "buffer clip (audio coverage)", { stage: "animate" });
    const bufPath = await animateScene(runId, bufferScene, null, animDir, videoOpts);
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
    await syncRunToDrive(runId, assets, runDir, finalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
  }

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
    const { keyCount, imagePerKey, ttsPerKey, animPerKey, limitImage, limitTts, limitAnim } = makeLimiters();
    log(
      runId,
      "info",
      `Generating: 1 continuous voiceover + ${scenes.length} image keyframes + ${scenes.length} image-to-video clips. Keys: ${keyCount} · Concurrency per key×keys: image=${imagePerKey}×${keyCount}, TTS=${ttsPerKey}×${keyCount}, video=${animPerKey}×${keyCount}. Provider: ${animProvider}`,
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

    const assemblyClips = await buildAssemblyClips(runId, sceneVideos, audio.durationSec, videoOpts, animDir);
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

    const { limitImage, limitTts, limitAnim } = makeLimiters();

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
          if (fileReady(vPath)) return { scene, videoPath: vPath };
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

    const assemblyClips = await buildAssemblyClips(runId, sceneVideos, audio.durationSec, videoOpts, animDir);
    await finishRunContinuous(runId, assemblyClips, sceneVideos, audio.filePath, audio.durationSec, runDir);
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
