import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { retryStockGenerationClip } from "@/lib/services/stock-gen";

export async function POST(req: Request) {
  ensureInit();
  let body: { jobId?: string; index?: number; mode?: "image" | "video" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const jobId = (body.jobId || "").trim();
  const index = Number(body.index);
  const mode = body.mode === "image" ? "image" : "video";
  if (!jobId || !Number.isFinite(index)) return NextResponse.json({ error: "jobId and index are required" }, { status: 400 });
  const status = retryStockGenerationClip(jobId, index, mode);
  return NextResponse.json(status ?? { error: "Job or clip not found" }, { status: status ? 200 : 404 });
}
