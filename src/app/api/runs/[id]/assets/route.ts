import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunDir } from "@/lib/run-paths";
import { isRunWorkerActive } from "@/lib/pipeline";
import { countTextChunks } from "@/lib/text-chunking";
import { analyzeScenePlan } from "@/lib/scene-plan-health";
import { getSetting } from "@/lib/settings";
import { buildExportQualityReport } from "@/lib/export-quality";
import { readRunExportState } from "@/lib/run-export-state";

const getRun = db.prepare(
  "SELECT id, status, config_json, preset_hybrid_fresh_minutes FROM runs WHERE id = ?"
);

export type SceneStage = "pending" | "audio" | "image" | "video" | "rendered";

interface SceneAsset {
  index: number;
  text?: string;
  visual_prompt?: string;
  duration_hint_sec?: number;
  source_kind?: "fresh" | "stock";
  stage: SceneStage;
  audio?: { name: string; size: number };
  image?: { name: string; size: number };
  animation?: { name: string; size: number };
  clip?: { name: string; size: number };
}

function countContinuousChunks(text: string, maxChars = 9000): number {
  return countTextChunks(text, { maxChars });
}

function sceneStage(a: Omit<SceneAsset, "stage">): SceneStage {
  if (a.clip) return "rendered";
  if (a.animation) return "video";
  if (a.image) return "image";
  if (a.audio) return "audio";
  return "pending";
}

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id) as
    | { id: string; status: string; config_json: string | null; preset_hybrid_fresh_minutes: number | null }
    | undefined;
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  let mode = "hybrid";
  if (run.config_json) {
    try {
      const cfg = JSON.parse(run.config_json) as { mode?: string };
      if (cfg.mode === "full" || cfg.mode === "hybrid" || cfg.mode === "stock") mode = cfg.mode;
    } catch {
      /* ignore */
    }
  }

  const runDir = getRunDir(id);
  if (!fs.existsSync(runDir)) {
    return NextResponse.json({
      runDir,
      scenes: [],
      finalExists: false,
      finalSize: 0,
      mode,
      progress: { total: 0, rendered: 0, withVideo: 0, withAudio: 0 },
      syncReport: null,
    });
  }

  // Scene plan from pipeline (text + visual prompts).
  let plan: { index: number; text?: string; visual_prompt?: string; duration_hint_sec?: number; source_kind?: "fresh" | "stock" }[] = [];
  const scenesPath = path.join(runDir, "scenes.json");
  if (fs.existsSync(scenesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as typeof plan;
      if (Array.isArray(parsed)) plan = parsed;
    } catch {
      /* corrupt scenes.json — fall back to disk scan only */
    }
  }

  const scenes = new Map<number, SceneAsset>();
  function take(rel: string): { name: string; size: number } | undefined {
    const full = path.join(runDir, rel);
    if (!fs.existsSync(full)) return undefined;
    return { name: path.basename(rel), size: fs.statSync(full).size };
  }
  function ensureScene(i: number) {
    if (!scenes.has(i)) scenes.set(i, { index: i, stage: "pending" });
    return scenes.get(i)!;
  }
  function scanDir(sub: string, key: "audio" | "image" | "animation" | "clip", pattern: RegExp) {
    const dir = path.join(runDir, sub);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(pattern);
      if (!m) continue;
      const idx = Number(m[1]);
      const asset = take(path.join(sub, f));
      if (asset) ensureScene(idx)[key] = asset;
    }
  }
  scanDir("audio", "audio", /^scene_(\d+)\.mp3$/i);
  scanDir("images", "image", /^scene_(\d+)\.(?:png|jpe?g|webp)$/i);
  scanDir("animations", "animation", /^scene_(\d+)\.mp4$/i);
  scanDir("clips", "clip", /^clip_(\d+)\.mp4$/i);

  // Merge plan metadata onto disk assets; include planned scenes not yet on disk.
  for (const p of plan) {
    if (!Number.isInteger(p.index) || p.index < 0) continue;
    const s = ensureScene(p.index);
    if (p.text) s.text = p.text;
    if (p.visual_prompt) s.visual_prompt = p.visual_prompt;
    if (p.duration_hint_sec != null) s.duration_hint_sec = p.duration_hint_sec;
    if (p.source_kind === "fresh" || p.source_kind === "stock") s.source_kind = p.source_kind;
  }

  const list = [...scenes.values()]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ ...s, stage: sceneStage(s) }));

  const exportState = readRunExportState(id, run.status);
  const scenePlanHealth = plan.length > 0 ? analyzeScenePlan(plan) : exportState.scenePlanHealth;
  const finalOnDisk = exportState.finalOnDisk;
  const finalNeedsRepair = exportState.finalNeedsRepair;
  const finalReady = exportState.finalReady;

  let syncReport: Record<string, unknown> | null = null;
  const syncPath = path.join(runDir, "sync-report.json");
  if (fs.existsSync(syncPath)) {
    try {
      syncReport = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as Record<string, unknown>;
    } catch {
      syncReport = null;
    }
  }
  let watermarkReport: Record<string, unknown> | null = null;
  const watermarkPath = path.join(runDir, "watermark-cleanup-report.json");
  if (fs.existsSync(watermarkPath)) {
    try {
      watermarkReport = JSON.parse(fs.readFileSync(watermarkPath, "utf-8")) as Record<string, unknown>;
    } catch {
      watermarkReport = null;
    }
  }

  const freshCutoff =
    mode === "hybrid" && run.preset_hybrid_fresh_minutes != null
      ? run.preset_hybrid_fresh_minutes * 60
      : null;
  const explicitFreshCount = plan.filter((p) => p.source_kind === "fresh").length;
  let freshSceneCount = mode === "stock" ? 0 : list.length;
  if ((mode === "hybrid" || mode === "full") && explicitFreshCount > 0) {
    freshSceneCount = explicitFreshCount;
  } else if (mode === "hybrid" && freshCutoff != null && plan.length > 0) {
    let acc = 0;
    freshSceneCount = 0;
    for (const p of plan) {
      if (acc >= freshCutoff) break;
      freshSceneCount++;
      acc += p.duration_hint_sec ?? 6;
    }
  }

  const freshList = list.filter((s) => s.index < freshSceneCount);
  const stockSceneCount = Math.max(0, plan.length - freshSceneCount);
  const tailVoicePath = path.join(runDir, "audio", "tail_voiceover.mp3");
  const tailSegPath = path.join(runDir, "tail.mp4");
  const audioDir = path.join(runDir, "audio");
  const tailVoicePartCount = fs.existsSync(audioDir)
    ? fs.readdirSync(audioDir).filter((f) => /^tail_voiceover_part\d+\.mp3$/i.test(f)).length
    : 0;
  const tailClipsDir = path.join(runDir, "tail-clips");
  const tailRenderedClipCount = fs.existsSync(tailClipsDir)
    ? fs.readdirSync(tailClipsDir).filter((f) => /^t_\d+\.mp4$/i.test(f)).length
    : 0;

  const isHybridLike = mode === "hybrid" || mode === "stock";
  const freshWithVideo = freshList.filter((s) => s.animation || s.clip).length;
  const freshWithAudio = freshList.filter((s) => s.audio).length;
  const freshRendered = freshList.filter((s) => s.stage === "rendered").length;
  const workerActive = (run.status === "running" || run.status === "pending") && isRunWorkerActive(id);
  const runtimeStatus =
    (run.status === "running" || run.status === "pending") && !workerActive && !finalReady ? "paused" : run.status;
  const tailPlanText = plan
    .filter((s) => s.index >= freshSceneCount)
    .map((s) => s.text ?? "")
    .join(" ");
  const expectedTailVoiceChunks = countContinuousChunks(tailPlanText);
  const tailVoiceReady =
    fs.existsSync(tailVoicePath) ||
    (expectedTailVoiceChunks > 0 && tailVoicePartCount >= expectedTailVoiceChunks);

  return NextResponse.json({
    runDir,
    /** For hybrid/stock: only opening scenes (no 1k+ stock beats). For full: all scenes. */
    scenes: isHybridLike ? freshList : list,
    freshScenes: freshList,
    planSceneCount: plan.length,
    stockSceneCount: isHybridLike ? stockSceneCount : 0,
    finalExists: finalReady,
    finalSize: finalReady ? exportState.finalSize : 0,
    finalOnDisk,
    finalNeedsRepair,
    canRepairPlan: exportState.canRepairPlan,
    oldFinalSize: finalNeedsRepair ? exportState.finalSize : 0,
    exportQuality: buildExportQualityReport({
      finalReady,
      finalOnDisk,
      finalNeedsRepair,
      finalSize: finalReady ? exportState.finalSize : 0,
      scenePlanHealth,
      syncReport,
      watermarkCleanupEnabled: getSetting("CLEAN_PROVIDER_WATERMARK") !== "0",
      watermarkReport,
    }),
    mode,
    runtimeStatus,
    workerActive,
    freshSceneCount: isHybridLike ? freshSceneCount : list.length,
    scenePlanHealth,
    tail: {
      voiceoverReady: tailVoiceReady,
      voiceoverFileReady: fs.existsSync(tailVoicePath),
      voiceoverPartCount: tailVoicePartCount,
      expectedVoiceoverPartCount: expectedTailVoiceChunks,
      segmentReady: fs.existsSync(tailSegPath),
      renderedClipCount: tailRenderedClipCount,
    },
    recovery: {
      paused: runtimeStatus === "paused",
      canResume: (runtimeStatus === "paused" || exportState.canRepairPlan) && plan.length > 0 && !workerActive,
      canRepairPlan: exportState.canRepairPlan,
      openingReady: freshSceneCount > 0 && freshWithAudio >= freshSceneCount && freshWithVideo >= freshSceneCount,
      tailVoiceReady,
      tailSegmentReady: fs.existsSync(tailSegPath),
      finalReady,
      nextAction: finalReady
        ? "download"
        : finalNeedsRepair
          ? "repair"
          : runtimeStatus === "paused"
            ? "resume"
            : workerActive
              ? "wait"
              : "inspect",
    },
    progress: isHybridLike
      ? {
          total: freshSceneCount,
          rendered: freshRendered,
          withVideo: freshWithVideo,
          withAudio: freshWithAudio,
        }
      : {
          total: list.length,
          rendered: list.filter((s) => s.stage === "rendered").length,
          withVideo: list.filter((s) => s.animation || s.clip).length,
          withAudio: list.filter((s) => s.audio).length,
        },
    hybridProgress: isHybridLike
      ? {
          freshTotal: freshSceneCount,
          freshWithVideo,
          freshRendered,
          stockSceneCount,
        }
      : null,
    syncReport,
  });
}
