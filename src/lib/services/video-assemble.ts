import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { log } from "../logger";
import { pLimit } from "../plimit";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

export interface AssembleInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
}

/**
 * Builds the final video using random Ken-Burns clips + xfade transitions.
 *
 * Steps:
 *  1. For each scene render a clip whose duration matches its audio (measured via ffprobe).
 *     - Ken-Burns: random zoom-in (1.0→1.18) or zoom-out (1.18→1.0)
 *     - If videoPath (img2vid) is provided, that clip is used as the base instead
 *  2. Concat all clips with xfade on the boundaries (smooth crossfade).
 *     - If TRANSITION_DURATION = 0 → simple concat without transitions.
 */
export async function assembleVideo(
  runId: string,
  scenes: AssembleInput[],
  outDir: string,
  /** Per-channel scene-end pause (seconds). null/undefined → global SCENE_TAIL_SILENCE. */
  pauseOverride?: number | null
): Promise<string> {
  ensureFfmpegPaths();

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const transitionSec = Number(getSetting("TRANSITION_DURATION") || "0.5");
  const tailSilence = Math.max(
    0,
    pauseOverride != null ? pauseOverride : Number(getSetting("SCENE_TAIL_SILENCE") || "0.4")
  );
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(runId, "info", `Assembling ${scenes.length} clips (${resolution} @${fps}fps, ${assembleConcurrency} in parallel)`, {
    stage: "assemble",
  });

  // 1. Render individual clips in PARALLEL (was sequential before).
  //    Preserve ordering by index — Promise.all does not guarantee completion order.
  const limitClip = pLimit(assembleConcurrency);
  const indexed: ({ path: string; durationSec: number; index: number })[] = await Promise.all(
    scenes.map((item) =>
      limitClip(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        const audioDuration = await probeDuration(item.audio.filePath);
        // Total clip duration = audio + silence padding at the end so consecutive
        // scenes get a natural breath between them after concat.
        const clipDuration = audioDuration + tailSilence;
        if (item.videoPath) {
          await renderAnimatedClip(item.videoPath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence);
        } else {
          const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
          await renderKenBurnsClip(item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, zoomDirection, tailSilence);
        }
        log(
          runId,
          "info",
          `Clip #${item.scene.index} (${audioDuration.toFixed(1)}s audio + ${tailSilence}s silence = ${clipDuration.toFixed(1)}s, ${item.videoPath ? "img2vid" : "ken-burns"}) done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec: clipDuration, index: item.scene.index };
      })
    )
  );
  indexed.sort((a, b) => a.index - b.index);
  const clipInfos = indexed.map((c) => ({ path: c.path, durationSec: c.durationSec }));

  // 2. Concat
  const finalPath = path.join(outDir, "final.mp4");
  if (transitionSec > 0 && clipInfos.length >= 2) {
    // For large clip counts, split into N chunks and crossfade each chunk
    // in parallel before doing one final crossfade across the chunks.
    // FFmpeg's chained xfade graph is serial (each xfade depends on the
    // previous output), so a single 100-clip xfade can't use multiple cores.
    // Running 4 chunk xfades in parallel saturates a modern CPU.
    const xfadeChunks = Math.max(1, Number(getSetting("ASSEMBLE_XFADE_CHUNKS") || "4"));
    if (xfadeChunks > 1 && clipInfos.length >= xfadeChunks * 3) {
      await concatWithCrossfadeChunked(runId, clipInfos, clipsDir, finalPath, transitionSec, fps, xfadeChunks);
    } else {
      await concatWithCrossfade(clipInfos, finalPath, transitionSec, fps);
      log(runId, "info", `Crossfade ${transitionSec}s across ${clipInfos.length} scenes`, { stage: "assemble" });
    }
  } else {
    await concatSimple(clipInfos.map((c) => c.path), clipsDir, finalPath);
  }

  await cleanFinalCornerMark(runId, finalPath, w, h, scenes.map((s) => s.videoPath).filter(Boolean) as string[]);
  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

/** Points fluent-ffmpeg at the ffmpeg/ffprobe binaries from the FFMPEG_PATH setting. */
function ensureFfmpegPaths(): void {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (!ffmpegPath) return;
  ffmpeg.setFfmpegPath(ffmpegPath);
  // ffprobe lives next to ffmpeg in the same bin/ folder
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
}

/** Reads the exact audio duration via ffprobe. */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const d = data.format?.duration;
      if (typeof d !== "number" || !isFinite(d)) {
        // Fallback: estimate from file size
        const stat = fs.statSync(filePath);
        return resolve(Math.max(1, stat.size / 16000));
      }
      resolve(d);
    });
  });
}

/**
 * Best-effort media duration in seconds — safe to call from any pipeline stage.
 *
 * Unlike probeDuration(), this sets the ffmpeg/ffprobe paths first, so it works
 * standalone (e.g. from tts.ts right after a file is written, long before
 * assembleVideo runs). On ANY ffprobe failure it falls back to a rough
 * file-size estimate and never throws.
 */
export async function probeDurationSafe(filePath: string): Promise<number> {
  try {
    ensureFfmpegPaths();
    return await probeDuration(filePath);
  } catch {
    try {
      return Math.max(1, fs.statSync(filePath).size / 16000);
    } catch {
      return 1;
    }
  }
}

/**
 * Ken-Burns clip: still image with a slow zoom plus optional gentle pan.
 * direction = 'in' → 1.0 → 1.18, 'out' → 1.18 → 1.0.
 */
function renderKenBurnsClip(
  imagePath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out",
  tailSilenceSec: number = 0
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;

  // zoom expression — linear interpolation through `on` (output frame index)
  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;

  // Slight random pan: choose one of 5 trajectories
  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`; // center
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1: // top-left → bottom-right drift
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2: // top-right → bottom-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3: // bottom-left → top-right
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4: // bottom-right → top-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    // case 0 — center, no pan
  }

  // Upscale the input ×2 so the zoom doesn't blur
  const filter = `scale=${w * 2}:${h * 2}:flags=lanczos,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .videoFilters(filter);
    // Pad audio with silence at the end so consecutive scenes get a breath.
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** img2vid clip: render the Veo clip with its length matched to the TTS audio.
 *
 *  Veo always produces a fixed-length clip (4/6/8 s — capped at 8 s). When the
 *  TTS narration for a scene runs LONGER than the Veo clip we used to loop the
 *  Veo input with `-stream_loop -1` and rely on `-t` to cut. That made the clip
 *  visibly restart from frame 1 around the 7-8 s mark — the "scene replays"
 *  glitch users noticed on long sentences.
 *
 *  New strategy (no more abrupt loop):
 *    1. If audio ≤ video: just cut with `-t` (no transform).
 *    2. If audio overruns up to 1.5×: time-stretch the Veo clip with `setpts`
 *       (subtle slow-motion that documentary viewers won't notice).
 *    3. If audio overruns more: stretch to 1.5× then freeze the LAST frame
 *       via `tpad=stop_mode=clone` for the remaining time. Better than a
 *       jarring restart, and feels like the camera "settling".
 *
 *  Audio comes ONLY from the TTS mp3 (input 1) — Veo's own audio (input 0) is
 *  dropped via explicit -map.
 */
async function renderAnimatedClip(
  videoPath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0
): Promise<void> {
  const videoDur = await probeDuration(videoPath);

  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    // Drop MAX_STRETCH from 1.5 to 1.15. Past ~1.15 the effective motion FPS
    // drops below ~21 (24 / 1.15) and the image looks juddery — that's the
    // "low FPS / picture jumps" symptom users have complained about.
    // We'd rather freeze the last frame than stretch into ugly slow-mo.
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      // CRITICAL: setpts alone makes ffmpeg space the SAME frames over a
      // longer timeline → effective motion FPS = source_fps / stretchFactor.
      // Pair it with `fps=N` so ffmpeg duplicates frames at the target rate
      // and the playback timing stays uniform. (Real motion interpolation
      // would need `minterpolate`, but that's too slow for batch.)
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoFilters(videoFilter);
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        // Explicit stream mapping — drops Veo's audio even if `mute` didn't work
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Simple stream-copy concat (no transitions). */
function ffconcatLine(filePath: string): string {
  // FFmpeg concat files use single-quoted paths. Escape apostrophes so folders
  // like "Queen Anne's Revenge" do not break recovery assembly.
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function fileReady(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function concatSimple(clipPaths: string[], clipsDir: string, finalPath: string): Promise<void> {
  const listFile = path.join(clipsDir, `concat_${randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(listFile, clipPaths.map(ffconcatLine).join("\n"), "utf-8");
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

/**
 * Chunked parallel concat-with-crossfade.
 *
 * Splits clips into N groups, runs one FFmpeg per group in parallel to xfade
 * each group into an intermediate file, then xfades the intermediates into
 * the final output. This parallelizes what is otherwise a serial xfade chain
 * (FFmpeg's xfade filter is single-threaded per pair, and consecutive xfades
 * in one filter_complex are sequentially dependent).
 *
 * On an 8-core CPU, 4 chunks of ~25 clips each gives roughly a 3-4× speedup
 * on the assembly stage versus a monolithic 100-clip xfade chain.
 */
async function concatWithCrossfadeChunked(
  runId: string,
  clips: { path: string; durationSec: number }[],
  clipsDir: string,
  finalPath: string,
  fadeDur: number,
  fps: number,
  chunkCount: number
): Promise<void> {
  // Distribute clips evenly across chunks (no chunk smaller than ~floor(N/chunks))
  const total = clips.length;
  const chunks: { path: string; durationSec: number }[][] = [];
  const baseSize = Math.floor(total / chunkCount);
  const extra = total % chunkCount;
  let cursor = 0;
  for (let i = 0; i < chunkCount; i++) {
    const size = baseSize + (i < extra ? 1 : 0);
    if (size === 0) continue;
    chunks.push(clips.slice(cursor, cursor + size));
    cursor += size;
  }

  log(
    runId,
    "info",
    `Chunked xfade: ${chunks.length} chunks × ~${baseSize}+ clips, running in parallel`,
    { stage: "assemble" }
  );

  // Build each chunk in parallel
  const chunkOutputs: { path: string; durationSec: number }[] = await Promise.all(
    chunks.map(async (chunkClips, idx) => {
      const chunkPath = path.join(clipsDir, `chunk_${String(idx).padStart(2, "0")}.mp4`);
      await concatWithCrossfade(chunkClips, chunkPath, fadeDur, fps);
      // Total duration of a chunk = sum(clip durations) - (N-1) × fadeDur (each xfade overlaps)
      const chunkDuration =
        chunkClips.reduce((s, c) => s + c.durationSec, 0) - (chunkClips.length - 1) * fadeDur;
      log(
        runId,
        "info",
        `Chunk #${idx}: ${chunkClips.length} clips → ${chunkPath} (${chunkDuration.toFixed(1)}s)`,
        { stage: "assemble" }
      );
      return { path: chunkPath, durationSec: chunkDuration };
    })
  );

  log(runId, "info", `Final pass: xfade across ${chunkOutputs.length} chunks`, { stage: "assemble" });

  // Final xfade pass across chunk outputs
  await concatWithCrossfade(chunkOutputs, finalPath, fadeDur, fps);

  // Cleanup intermediate chunk files
  for (const c of chunkOutputs) {
    try {
      fs.unlinkSync(c.path);
    } catch {}
  }
}

/**
 * Concat with xfade transitions between clips.
 * fadeDur — transition length in seconds (e.g. 0.5).
 * On each boundary, the last fadeDur seconds of clip N overlap the first fadeDur of clip N+1.
 */
function concatWithCrossfade(
  clips: { path: string; durationSec: number }[],
  finalPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);

  // Build filter_complex: chained xfade for video + acrossfade for audio.
  let videoChain = "";
  let audioChain = "";
  let lastV = "0:v";
  let lastA = "0:a";

  // Accumulated offset for xfade: sum of (prevDuration - fadeDur)
  let cumOffset = 0;
  for (let i = 1; i < clips.length; i++) {
    cumOffset += clips[i - 1].durationSec - fadeDur;
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    audioChain += `[${lastA}][${i}:a]acrossfade=d=${fadeDur}[${aOut}];`;
    lastV = vOut;
    lastA = aOut;
  }
  // Strip trailing ;
  const filterComplex = (videoChain + audioChain).replace(/;$/, "");

  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        `-map [${lastA}]`,
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Continuous voiceover assembly (Prompt 7 + 8)
//
// One TTS call produces the entire narration (no inter-scene seams). Each scene
// clip plays at its NATIVE Veo length — no slot-fitting, no freeze frames. The
// pipeline guarantees the clips together cover the audio (it generates a buffer
// clip when they're short), so after crossfade-concat + audio overlay we simply
// trim the output to the audio length. Any video overhang is cut silently; the
// only frame manipulation is the 0.5s edge fades. NO `tpad=stop_mode=clone`.
// ───────────────────────────────────────────────────────────────────────────

const CONTINUOUS_CROSSFADE = 0.3;
const EDGE_FADE = 0.5;
const MIN_CLIP_SEC = 2.0;

/** One clip to assemble. `targetSec` = the scene's narrated window to TRIM the
 *  clip to (Prompt 10); null = keep native length (used for the buffer clip). */
export interface AssemblyClip {
  path: string;
  targetSec: number | null;
}

export async function assembleContinuous(
  runId: string,
  clips: AssemblyClip[],
  audioPath: string,
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  const audioDur = await probeDuration(audioPath);
  log(runId, "info", `Continuous assembly: ${clips.length} clips over ${audioDur.toFixed(1)}s of audio`, {
    stage: "assemble",
  });

  // 1. Render each clip to the output resolution, TRIMMED to its narrated window
  //    (so every scene's visual plays during its own narration — no discard).
  const limitClip = pLimit(assembleConcurrency);
  const clipInfos = await Promise.all(
    clips.map((clip, i) =>
      limitClip(async () => {
        const clipPath = path.join(clipsDir, `clip_${String(i).padStart(3, "0")}.mp4`);
        const durationSec = await renderClip(runId, i, clip, clipPath, w, h, fps);
        return { path: clipPath, durationSec };
      })
    )
  );

  // 2. Crossfade the silent clips into one video stream.
  const silentPath = path.join(outDir, "silent.mp4");
  if (clipInfos.length >= 2) {
    await concatVideoCrossfade(clipInfos, silentPath, CONTINUOUS_CROSSFADE, fps);
  } else {
    fs.copyFileSync(clipInfos[0].path, silentPath);
  }

  // 3. Lay the continuous audio over it, trim to the audio length, add edge fades.
  const finalPath = path.join(outDir, "final.mp4");
  await muxAudioWithFades(silentPath, audioPath, finalPath, audioDur, fps);
  await cleanFinalCornerMark(runId, finalPath, w, h, clips.map((clip) => clip.path));
  try {
    fs.unlinkSync(silentPath);
  } catch {}

  log(runId, "success", `Final video: ${finalPath} (${audioDur.toFixed(1)}s)`, { stage: "assemble" });
  return finalPath;
}

/**
 * Re-encode a clip to the output resolution (silent), TRIMMED to its scene's
 * narrated window when `targetSec` is set. Pure tail-cut via `-t` — no pad, no
 * freeze. `targetSec` null → keep native length (buffer clip). Returns the
 * rendered duration.
 */
async function renderClip(
  runId: string,
  index: number,
  clip: AssemblyClip,
  outPath: string,
  w: number,
  h: number,
  fps: number
): Promise<number> {
  const native = await probeDuration(clip.path);
  // Never request more than we have; floor at MIN_CLIP_SEC so a clip is watchable.
  const target =
    clip.targetSec != null ? Math.min(native, Math.max(MIN_CLIP_SEC, clip.targetSec)) : native;
  if (clip.targetSec != null) {
    log(
      runId,
      "debug",
      `trim scene_${index} from ${native.toFixed(1)}s to ${target.toFixed(1)}s`,
      { stage: "assemble" }
    );
  }
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
      .input(clip.path)
      .videoFilters(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);
    const opts = ["-an", `-r ${fps}`, "-c:v libx264", "-preset veryfast", "-crf 23", "-pix_fmt yuv420p", "-movflags +faststart"];
    if (clip.targetSec != null) opts.unshift(`-t ${target.toFixed(3)}`);
    cmd
      .outputOptions(opts)
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  return target;
}

/**
 * Buffer-clip fallback (Prompt 8): when a fresh Veo buffer clip can't be made,
 * build a slow Ken-Burns clip from the LAST scene clip's final frame. Motion
 * (gentle zoom), never a frozen hold. Returns the path written.
 */
export async function kenBurnsBufferFromClip(
  clipPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number
): Promise<string> {
  ensureFfmpegPaths();
  const framePath = outPath.replace(/\.mp4$/i, "_frame.png");
  // Grab a frame from very near the end of the source clip.
  await new Promise<void>((resolve, reject) => {
    ffmpeg(clipPath)
      .inputOptions(["-sseof", "-0.2"])
      .outputOptions(["-frames:v", "1", "-q:v", "2"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(framePath);
  });
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const zoomExpr = `min(1.0+0.12*on/${totalFrames - 1},1.12)`;
  const filter = `scale=${w * 2}:${h * 2}:flags=lanczos,zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions(["-loop 1"])
      .videoFilters(filter)
      .outputOptions([
        "-an",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  try {
    fs.unlinkSync(framePath);
  } catch {}
  return outPath;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-scene hybrid assembly (Mission 1 + 3)
//
// Each scene has its OWN narration mp3. Each scene's video clip is rendered to
// EXACTLY that scene's audio length (padded with a held final frame if needed,
// trimmed if longer) with the narration muxed in. Then all per-scene clips are
// concatenated. Because every clip == its scene's audio, the picture can NEVER
// drift from the voice — final duration == sum of scene-audio durations.
//
// This is the sync-correct path: no word-count guessing, no continuous-audio
// re-allocation. Fresh AI clips and stock B-roll clips are treated identically.
// ───────────────────────────────────────────────────────────────────────────

export interface SceneAVItem {
  /** Ordered scene index (for clip filenames + logs). */
  index: number;
  /** The video clip (fresh AI or stock B-roll). */
  videoPath: string;
  /** This scene's narration mp3. */
  audioPath: string;
  /** Label for logs: "fresh" | "stock". */
  kind?: string;
}

/**
 * Render one scene clip to its narration length and mux the narration in.
 * Fresh AI scenes should already be split to fit the provider clip length.
 * If an older scene is still slightly longer, hold the final frame instead of
 * visibly looping the same generated motion.
 */
async function renderSceneAV(
  runId: string,
  item: SceneAVItem,
  outPath: string,
  w: number,
  h: number,
  fps: number
): Promise<number> {
  const audioDur = await probeDuration(item.audioPath);
  const videoDur = await probeDuration(item.videoPath).catch(() => 0);
  const padSec = videoDur > 0 && audioDur > videoDur + 0.05 ? audioDur - videoDur + 0.1 : 0;
  const fadeSec = item.kind === "fresh" ? Math.min(0.75, Math.max(0.25, audioDur * 0.18)) : 0;
  const freshUsableVideoEnd =
    item.kind === "fresh" && videoDur > 1.25
      ? Math.max(0.5, videoDur - Math.min(0.35, videoDur * 0.12))
      : videoDur;
  const visualEndSec = item.kind === "fresh" ? Math.max(0.5, Math.min(audioDur, freshUsableVideoEnd)) : audioDur;
  const blackHoldSec = item.kind === "fresh" ? Math.max(0, audioDur - visualEndSec) : 0;
  if (item.kind === "fresh" && blackHoldSec > 0.75) {
    log(runId, "warn", `Fresh clip #${item.index + 1} is ${blackHoldSec.toFixed(1)}s shorter than narration; fading to black instead of freezing the final frame.`, {
      stage: "assemble",
    });
  }
  const filters = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    padSec > 0 ? `tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}` : null,
    fadeSec > 0 ? `fade=t=in:st=0:d=${fadeSec.toFixed(3)}` : null,
    fadeSec > 0 ? `fade=t=out:st=${Math.max(0, visualEndSec - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}` : null,
    blackHoldSec > 0.05 ? `tpad=stop_mode=add:stop_duration=${blackHoldSec.toFixed(3)}:color=black` : null,
  ].filter(Boolean).join(",");

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg();
    cmd.input(item.videoPath);
    cmd.input(item.audioPath);
    cmd
      .videoFilters(filters)
      .outputOptions([
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-t ${audioDur.toFixed(3)}`,
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
        "-shortest",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  return audioDur;
}

export interface PerSceneAssemblyResult {
  finalPath: string;
  totalSec: number;
  /** Max |clipSec - audioSec| across scenes — should be ~0 (proof of sync). */
  maxDriftSec: number;
}

/**
 * Assemble the final video from per-scene (video + narration) pairs.
 * Returns the final path plus a sync report (max drift, total duration).
 */
export async function assemblePerScene(
  runId: string,
  items: SceneAVItem[],
  outDir: string
): Promise<PerSceneAssemblyResult> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const concurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  const ordered = [...items].sort((a, b) => a.index - b.index);
  log(runId, "info", `Per-scene assembly: ${ordered.length} scenes (each clip fit to its own narration)`, {
    stage: "assemble",
  });

  const limit = pLimit(concurrency);
  let maxDrift = 0;
  const rendered = await Promise.all(
    ordered.map((item) =>
      limit(async () => {
        const clipPath = path.join(clipsDir, `clip_${String(item.index).padStart(3, "0")}.mp4`);
        const audioDur = await renderSceneAV(runId, item, clipPath, w, h, fps);
        const clipDur = await probeDuration(clipPath).catch(() => audioDur);
        const drift = Math.abs(clipDur - audioDur);
        if (drift > maxDrift) maxDrift = drift;
        return { path: clipPath, index: item.index, dur: clipDur };
      })
    )
  );
  rendered.sort((a, b) => a.index - b.index);

  const finalPath = path.join(outDir, "final.mp4");
  await concatSimple(rendered.map((r) => r.path), clipsDir, finalPath);
  await cleanFinalCornerMark(runId, finalPath, w, h, items.map((item) => item.videoPath));

  const totalSec = await probeDuration(finalPath).catch(() => rendered.reduce((s, r) => s + r.dur, 0));
  log(
    runId,
    "success",
    `Final video: ${finalPath} · ${(totalSec / 60).toFixed(1)} min · sync drift ≤ ${maxDrift.toFixed(3)}s`,
    { stage: "assemble" }
  );
  return { finalPath, totalSec, maxDriftSec: maxDrift };
}

/** Concatenate multiple audio files into one mp3 (re-encode for clean joins). */
export async function concatAudioFiles(inputs: string[], outPath: string): Promise<void> {
  ensureFfmpegPaths();
  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], outPath);
    return;
  }
  const listFile = outPath.replace(/\.mp3$/i, `_alist_${randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(listFile, inputs.map(ffconcatLine).join("\n"), "utf-8");
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c:a libmp3lame", "-b:a 192k"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  try { fs.unlinkSync(listFile); } catch {}
}

// ───────────────────────────────────────────────────────────────────────────
// Continuous-tail assembly (Mission 3, refined)
//
// The hybrid run's TAIL (everything after the fresh opening) is built here:
//   - ONE continuous voiceover (no per-scene editing) is laid over
//   - selected stock clips at their full native length, each fading through
//     black at the seams, looped until the narration ends, then trimmed to the
//     exact audio length.
// Returns a single tail.mp4 (video + audio) the caller concatenates after the
// fresh per-scene section.
// ───────────────────────────────────────────────────────────────────────────

const TAIL_BLACK_FADE = 0.75; // seconds of fade-in/out to black per clip seam
const TAIL_END_TRIM = 0.35; // avoid provider/library clips' static final frames

/** Render one stock clip to WxH, silent, with a short fade-in/out through black. */
async function renderTailClip(
  src: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  maxDurationSec?: number
): Promise<number> {
  try {
    if (fs.statSync(outPath).size > 0) {
      return probeDuration(outPath).catch(() => maxDurationSec ?? 8);
    }
  } catch {
    /* render below */
  }
  const srcDur = await probeDuration(src).catch(() => 8);
  const usableSrcDur = srcDur > 1.25 ? Math.max(0.5, srcDur - Math.min(TAIL_END_TRIM, srcDur * 0.12)) : srcDur;
  const dur = Math.max(0.5, Math.min(usableSrcDur, maxDurationSec ?? usableSrcDur));
  const fade = Math.min(TAIL_BLACK_FADE, dur / 3);
  const outStart = Math.max(0, dur - fade);
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fade=t=in:st=0:d=${fade.toFixed(
    3
  )},fade=t=out:st=${outStart.toFixed(3)}:d=${fade.toFixed(3)}`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(src)
      .videoFilters(vf)
      .outputOptions([
        "-an",
        `-r ${fps}`,
        `-t ${dur.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  return dur;
}

/**
 * Build the tail segment: selected stock clips (fade-through-black) under a
 * continuous voiceover, trimmed to the audio length. `pickClip` yields local
 * clip paths in the caller's chosen order; Hybrid uses narration-matched stock.
 */
export async function assembleTail(
  runId: string,
  audioPath: string,
  pickClip: () => string,
  outDir: string,
  outName = "tail.mp4"
): Promise<{ path: string; durationSec: number }> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const concurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const tailDir = path.join(outDir, "tail-clips");
  if (!fs.existsSync(tailDir)) fs.mkdirSync(tailDir, { recursive: true });

  const audioDur = await probeDuration(audioPath);
  log(runId, "info", `Tail: continuous voice ${(audioDur / 60).toFixed(1)} min over selected stock clips`, {
    stage: "assemble",
  });

  // Pick enough selected clips to cover the audio using real clip durations.
  // This matters for 1-2 hour videos: an 8-second guess can render hundreds of
  // unnecessary clips when the stock library contains longer B-roll.
  const picks: { src: string; sourceDurationSec: number; renderDurationSec: number }[] = [];
  let covered = 0;
  const targetCoverage = audioDur + 1;
  while (covered < targetCoverage) {
    const src = pickClip();
    const sourceDurationSec = Math.max(0.5, await probeDuration(src).catch(() => 8));
    const renderDurationSec = Math.min(sourceDurationSec, Math.max(0.5, targetCoverage - covered));
    picks.push({ src, sourceDurationSec, renderDurationSec });
    covered += renderDurationSec;
    if (picks.length > 10000) {
      throw new Error("Tail assembly picked too many stock clips — check the source clip durations.");
    }
  }
  log(runId, "info", `Tail render plan: ${picks.length} stock clips cover ${(covered / 60).toFixed(1)} min`, {
    stage: "assemble",
  });

  // Render the picked clips (faded) in parallel, preserving order.
  const limit = pLimit(concurrency);
  const rendered: { path: string; index: number; dur: number }[] = await Promise.all(
    picks.map((pick, i) =>
      limit(async () => {
        const out = path.join(tailDir, `t_${String(i).padStart(4, "0")}.mp4`);
        const dur = await renderTailClip(pick.src, out, w, h, fps, pick.renderDurationSec);
        return { path: out, index: i, dur };
      })
    )
  );
  rendered.sort((a, b) => a.index - b.index);

  // Concat the silent faded clips, then mux the continuous audio + trim to audio.
  const silentPath = path.join(outDir, "tail-silent.mp4");
  if (fileReady(silentPath)) {
    log(runId, "info", "Tail silent video already exists — reusing it", { stage: "assemble" });
  } else {
    await concatSimple(rendered.map((r) => r.path), tailDir, silentPath);
  }

  const outPath = path.join(outDir, outName);
  try {
    fs.rmSync(outPath, { force: true });
  } catch {
    /* remove partial output from interrupted mux */
  }
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(silentPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-t ${audioDur.toFixed(3)}`,
        "-c:v copy",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
        "-shortest",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  try { fs.unlinkSync(silentPath); } catch {}
  try { fs.rmSync(tailDir, { recursive: true, force: true }); } catch {}

  const durationSec = await probeDuration(outPath).catch(() => audioDur);
  log(runId, "success", `Tail segment: ${(durationSec / 60).toFixed(1)} min (${rendered.length} stock clips)`, {
    stage: "assemble",
  });
  return { path: outPath, durationSec };
}

/**
 * Render the fresh per-scene clips AND (optionally) append a continuous tail
 * segment, concatenating everything into the final video. Fresh scenes stay
 * frame-synced (clip == its narration); the tail is one continuous-voice block.
 */
export async function assembleHybrid(
  runId: string,
  freshItems: SceneAVItem[],
  tail: { path: string } | null,
  outDir: string
): Promise<PerSceneAssemblyResult> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const concurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  const ordered = [...freshItems].sort((a, b) => a.index - b.index);
  const limit = pLimit(concurrency);
  let maxDrift = 0;
  const rendered = await Promise.all(
    ordered.map((item) =>
      limit(async () => {
        const clipPath = path.join(clipsDir, `clip_${String(item.index).padStart(3, "0")}.mp4`);
        const audioDur = await renderSceneAV(runId, item, clipPath, w, h, fps);
        const clipDur = await probeDuration(clipPath).catch(() => audioDur);
        const drift = Math.abs(clipDur - audioDur);
        if (drift > maxDrift) maxDrift = drift;
        return { path: clipPath, index: item.index };
      })
    )
  );
  rendered.sort((a, b) => a.index - b.index);

  const parts = rendered.map((r) => r.path);
  if (tail) parts.push(tail.path);

  const finalPath = path.join(outDir, "final.mp4");
  await concatSimple(parts, clipsDir, finalPath);
  await cleanFinalCornerMark(runId, finalPath, w, h, freshItems.map((item) => item.videoPath));
  const totalSec = await probeDuration(finalPath).catch(() => 0);
  log(
    runId,
    "success",
    `Final video: ${(totalSec / 60).toFixed(1)} min · fresh sync drift ≤ ${maxDrift.toFixed(3)}s${tail ? " · + continuous tail" : ""}`,
    { stage: "assemble" }
  );
  return { finalPath, totalSec, maxDriftSec: maxDrift };
}

async function cleanFinalCornerMark(
  runId: string,
  finalPath: string,
  w: number,
  h: number,
  sourceVideoPaths: string[] = []
): Promise<void> {
  if (!fs.existsSync(finalPath)) return;

  if (getSetting("CLEAN_PROVIDER_WATERMARK") === "0") {
    writeWatermarkCleanupReport(finalPath, { status: "disabled", message: "CLEAN_PROVIDER_WATERMARK=0" });
    return;
  }

  if (!shouldCleanFinalCornerMark(sourceVideoPaths)) {
    writeWatermarkCleanupReport(finalPath, {
      status: "not_applicable",
      message: "No uncleaned generated provider clips were detected in this final.",
    });
    return;
  }

  const tmp = finalPath.replace(/\.mp4$/i, ".corner-cleaned.mp4");
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(finalPath)
        .videoFilters(`crop=trunc(iw*0.90/2)*2:trunc(ih*0.90/2)*2:0:0,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`)
        .outputOptions([
          "-map 0:v:0",
          "-map 0:a?",
          "-c:v libx264",
          "-preset veryfast",
          "-crf 20",
          "-pix_fmt yuv420p",
          "-c:a copy",
          "-movflags +faststart",
        ])
        .on("error", reject)
        .on("end", () => resolve())
        .save(tmp);
    });
    fs.renameSync(tmp, finalPath);
    try {
      fs.rmSync(path.join(path.dirname(finalPath), "final-poster.jpg"), { force: true });
    } catch {}
    writeWatermarkCleanupReport(finalPath, {
      status: "cleaned",
      method: "crop-top-left-90-percent-then-rescale",
      cropPercent: 90,
      outputWidth: w,
      outputHeight: h,
    });
    log(runId, "debug", "Cleaned final video corner mark", { stage: "assemble" });
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    writeWatermarkCleanupReport(finalPath, { status: "failed", message: msg.slice(0, 500) });
    log(runId, "warn", `Final corner-mark cleanup skipped: ${msg.slice(0, 240)}`, { stage: "assemble" });
  }
}

function shouldCleanFinalCornerMark(sourceVideoPaths: string[]): boolean {
  for (const videoPath of sourceVideoPaths) {
    const manifestPath = videoPath.replace(/\.mp4$/i, ".manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        sourceMode?: string;
        provider?: string;
        cleanup?: { status?: string };
      };
      if (manifest.provider !== "69labs" || manifest.sourceMode !== "image-to-video") continue;
      const cleanupStatus = manifest.cleanup?.status;
      if (cleanupStatus === "failed" || cleanupStatus === "missing") return true;
    } catch {
      continue;
    }
  }
  return false;
}

function writeWatermarkCleanupReport(finalPath: string, report: Record<string, unknown>): void {
  try {
    const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null;
    fs.writeFileSync(
      path.join(path.dirname(finalPath), "watermark-cleanup-report.json"),
      JSON.stringify(
        {
          enabled: getSetting("CLEAN_PROVIDER_WATERMARK") !== "0",
          createdAt: new Date().toISOString(),
          target: path.basename(finalPath),
          fileSize: stat?.size ?? null,
          fileMtimeMs: stat?.mtimeMs ?? null,
          ...report,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    /* best-effort quality evidence */
  }
}

/** Video-only crossfade chain (silent clips). */
function concatVideoCrossfade(
  clips: { path: string; durationSec: number }[],
  outPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);
  let videoChain = "";
  let lastV = "0:v";
  let cumOffset = 0;
  for (let i = 1; i < clips.length; i++) {
    cumOffset += clips[i - 1].durationSec - fadeDur;
    const vOut = `v${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    lastV = vOut;
  }
  const filterComplex = videoChain.replace(/;$/, "");
  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        "-an",
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Overlay the continuous audio onto the silent video, TRIM to the audio length,
 * add 0.5s edge fades. The pipeline guarantees video ≥ audio, so trimming the
 * overhang leaves no black/freeze — no padding/clone here.
 */
async function muxAudioWithFades(
  videoPath: string,
  audioPath: string,
  outPath: string,
  audioDur: number,
  fps: number
): Promise<void> {
  const fade = Math.min(EDGE_FADE, audioDur / 2);
  const outStart = Math.max(0, audioDur - fade);

  const vchain = `fade=t=in:st=0:d=${fade.toFixed(3)},fade=t=out:st=${outStart.toFixed(3)}:d=${fade.toFixed(3)}`;
  const achain = `afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${outStart.toFixed(3)}:d=${fade.toFixed(3)}`;
  const filterComplex = `[0:v]${vchain}[v];[1:a]${achain}[a]`;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .complexFilter(filterComplex)
      .outputOptions([
        "-map [v]",
        "-map [a]",
        `-r ${fps}`,
        `-t ${audioDur.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}
