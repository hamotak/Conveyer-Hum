import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { isRunWorkerActive, startRunPipeline } from "@/lib/pipeline";
import { sanitizeFolderName, pickAvailableFolderName, getRunDir } from "@/lib/run-paths";
import { getPromptPreset } from "@/lib/prompts";
import { resolveHybridFreshMinutes, resolveStockFolder } from "@/lib/channel-stock";
import { getSetting } from "@/lib/settings";
import { tryParseJson, isJsonObject } from "@/lib/json-body";
import { readRunExportState } from "@/lib/run-export-state";
import { freshDurationError } from "@/lib/fresh-duration";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, status, script, config_json) VALUES (?, ?, ?, 'pending', ?, ?)"
);
const setReuseMap = db.prepare(
  "UPDATE runs SET reuse_map_json = ? WHERE id = ?"
);
const setPresetSnapshot = db.prepare(
  "UPDATE runs SET preset_id = ?, preset_name = ?, preset_content = ?, preset_animation_motion = ?, preset_image_prompt = ?, preset_voice_id = ?, preset_video_style = ?, preset_voice_speed = ?, preset_scene_pause = ?, preset_voice_provider = ?, preset_style_preset_id = ?, preset_video_model = ?, preset_aspect_ratio = ?, preset_voice_stability = ?, preset_voice_similarity_boost = ?, preset_voice_style = ?, preset_stock_folder = ?, preset_hybrid_fresh_minutes = ? WHERE id = ?"
);
const listRuns = db.prepare(
  "SELECT id, title, folder_name, status, created_at, updated_at, output_path FROM runs ORDER BY created_at DESC LIMIT 50"
);

export async function GET() {
  ensureInit();
  const rows = listRuns.all() as Record<string, unknown>[];
  return NextResponse.json(
    rows.map((run) => {
      const id = String(run.id ?? "");
      const dbStatus = String(run.status ?? "");
      const workerActive =
        (dbStatus === "running" || dbStatus === "pending") && isRunWorkerActive(id);
      const status =
        (dbStatus === "running" || dbStatus === "pending") && !workerActive && !run.output_path
          ? "paused"
          : dbStatus;
      const needsRepair = readRunExportState(id, dbStatus).finalNeedsRepair;
      return {
        ...run,
        output_path: needsRepair ? null : run.output_path,
        db_status: dbStatus,
        status,
        worker_active: workerActive,
        needs_recovery: status === "paused" || needsRepair,
        needs_repair: needsRepair,
      };
    })
  );
}

interface CreateRunBody {
  title?: string;
  script?: string;
  /** Optional: scene_index → drive_file_id. Pipeline downloads those instead of generating. */
  reuseMap?: Record<string, string>;
  /** Optional: Prompt Preset id (from /prompts presets). Snapshot is stored on the run. */
  presetId?: number | null;
  /** Optional: true = pipeline auto-searches the library; false = manual reuseMap only. */
  autoReuse?: boolean;
  /** Generation mode: "full" (all fresh AI), "hybrid" (fresh start + stock tail), "stock" (all stock). */
  mode?: "full" | "hybrid" | "stock";
  /** Per-run override — fresh AI minutes at the start (Hybrid mode). */
  hybridFreshMinutes?: number;
  /** Per-run override — Drive stock folder for Hybrid / Stock Cut. */
  stockFolder?: string;
}

export async function POST(req: Request) {
  ensureInit();
  // Malformed JSON is a CLIENT error (400), not a server crash (500): parse the
  // raw text safely instead of letting `await req.json()` throw unhandled.
  const parsed = tryParseJson(await req.text());
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = parsed.value as CreateRunBody;
  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json({ error: "script is empty" }, { status: 400 });
  }
  if (typeof body.presetId !== "number" || body.presetId <= 0) {
    return NextResponse.json({ error: "A channel (presetId) is required" }, { status: 400 });
  }
  const preset = getPromptPreset(body.presetId);
  if (!preset) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }
  const mode = body.mode === "full" || body.mode === "hybrid" || body.mode === "stock" ? body.mode : undefined;
  const requestedHybridFresh =
    mode === "stock"
      ? 0
      : mode === "full"
        ? 9999
        : typeof body.hybridFreshMinutes === "number" && body.hybridFreshMinutes > 0
          ? body.hybridFreshMinutes
          : resolveHybridFreshMinutes(preset.hybrid_fresh_minutes, getSetting("HYBRID_FRESH_MINUTES"));
  if (mode === "hybrid") {
    const durationError = freshDurationError(script, requestedHybridFresh);
    if (durationError) {
      return NextResponse.json({ error: durationError }, { status: 400 });
    }
  }

  const id = randomUUID();
  const baseFolderName = sanitizeFolderName(body.title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolderName);

  // Per-run config. autoReuse: true = pipeline auto-searches the Drive library
  // for reusable clips; false = use only the manually-picked reuseMap below.
  const config: Record<string, unknown> = {};
  if (typeof body.autoReuse === "boolean") config.autoReuse = body.autoReuse;
  if (mode) config.mode = mode;
  insertRun.run(id, body.title ?? null, folderName, script, JSON.stringify(config));

  // Persist reuseMap so the pipeline can read it without callers passing options.
  // Keys are normalized to strings — they already are in JSON, but TS allowed
  // Record<number, string> in some call sites.
  if (body.reuseMap && typeof body.reuseMap === "object") {
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.reuseMap)) {
      if (typeof v === "string" && v.length > 0) normalized[String(k)] = v;
    }
    if (Object.keys(normalized).length > 0) {
      setReuseMap.run(JSON.stringify(normalized), id);
    }
  }

  // Snapshot the chosen channel profile onto the run row (with optional per-run overrides).
  const stockFolder = resolveStockFolder(
    preset.name,
    typeof body.stockFolder === "string" && body.stockFolder.trim()
      ? body.stockFolder.trim()
      : preset.stock_folder,
    getSetting("STOCK_LIBRARY_FOLDER")
  );
  setPresetSnapshot.run(
    preset.id,
    preset.name,
    preset.content,
    preset.animation_motion,
    preset.image_prompt,
    preset.voice_id,
    preset.video_style,
    preset.voice_speed,
    preset.scene_end_pause_seconds,
    preset.voice_provider,
    preset.style_preset_id,
    preset.video_model,
    preset.aspect_ratio,
    preset.voice_stability,
    preset.voice_similarity_boost,
    preset.voice_style,
    stockFolder,
    requestedHybridFresh,
    id
  );

  // Start the local worker in the background. The worker registry prevents
  // duplicate starts if the UI retries quickly.
  startRunPipeline(id, script);

  return NextResponse.json({ id, folderName });
}
