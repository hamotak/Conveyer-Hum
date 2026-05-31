import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listStockGenerationHistory } from "@/lib/services/stock-gen";

/** GET /api/stock/generate/history?channelId=...&folder=... - persisted B-roll jobs. */
export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const channelId = (url.searchParams.get("channelId") || "").trim() || undefined;
  const folder = (url.searchParams.get("folder") || "").trim() || undefined;
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
  return NextResponse.json({ jobs: listStockGenerationHistory({ channelId, folder, limit }) });
}
