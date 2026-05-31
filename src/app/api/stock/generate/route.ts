import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { startStockGeneration, getStockGenStatus, cancelStockGeneration, updateStockClipReview } from "@/lib/services/stock-gen";

/** GET /api/stock/generate?folder=Pirates or ?jobId=stockgen-... - poll generation progress. */
export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const jobId = (url.searchParams.get("jobId") || "").trim();
  const folder = (url.searchParams.get("folder") || "Pirates").trim() || "Pirates";
  const status = getStockGenStatus(jobId || folder);
  if (status) return NextResponse.json(status);
  return NextResponse.json({
    running: false,
    phase: jobId ? "missing" : "finished",
    total: 0,
    requestedCount: 0,
    done: 0,
    failed: 0,
    folder,
    jobId: jobId || undefined,
    lastError: jobId ? "Generation job was not found. It may have been cleared before persistence was available." : undefined,
  });
}

/** POST /api/stock/generate { folder, theme, count, styleBrief?, exactPrompts?, channelId?, channelName? } - start a batch. */
export async function POST(req: Request) {
  ensureInit();
  let body: {
    folder?: string;
    theme?: string;
    count?: number;
    videoStyle?: string | null;
    styleBrief?: string | null;
    negativePrompt?: string | null;
    exactPrompts?: string[];
    channelId?: number | string | null;
    channelName?: string | null;
    promptMode?: "brief" | "exact" | "mixed";
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const folder = (body.folder || "Pirates").trim() || "Pirates";
  const theme = (body.theme || "").trim();
  const count = Math.max(1, Math.min(300, Number(body.count) || 10));
  if (!theme) return NextResponse.json({ error: "A theme (or channel name) is required" }, { status: 400 });

  const status = startStockGeneration({
    folder,
    theme,
    count,
    videoStyle: body.videoStyle ?? null,
    styleBrief: body.styleBrief ?? body.videoStyle ?? null,
    negativePrompt: body.negativePrompt ?? null,
    exactPrompts: Array.isArray(body.exactPrompts) ? body.exactPrompts : [],
    channelId: body.channelId ?? null,
    channelName: body.channelName ?? null,
    promptMode: body.promptMode,
  });
  return NextResponse.json(status);
}

/** PATCH /api/stock/generate { jobId, index, reviewStatus } - mark review state for a generated clip. */
export async function PATCH(req: Request) {
  ensureInit();
  let body: { jobId?: string; index?: number; reviewStatus?: "unreviewed" | "good" | "weak" | "needs_review" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const jobId = (body.jobId || "").trim();
  const index = Number(body.index);
  const reviewStatus = body.reviewStatus;
  if (!jobId || !Number.isFinite(index) || !reviewStatus) return NextResponse.json({ error: "jobId, index, and reviewStatus are required" }, { status: 400 });
  const status = updateStockClipReview(jobId, index, reviewStatus);
  return NextResponse.json(status ?? { error: "Job not found" }, { status: status ? 200 : 404 });
}

/** DELETE /api/stock/generate?folder=Pirates or ?jobId=stockgen-... - stop a running stock batch. */
export async function DELETE(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const jobId = (url.searchParams.get("jobId") || "").trim();
  const folder = (url.searchParams.get("folder") || "Pirates").trim() || "Pirates";
  const status = cancelStockGeneration(jobId || folder);
  return NextResponse.json(status ?? { running: false, phase: "missing", total: 0, requestedCount: 0, done: 0, failed: 0, folder, jobId: jobId || undefined });
}
