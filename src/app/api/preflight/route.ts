import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { runPreflight } from "@/lib/preflight";

/**
 * GET /api/preflight — readiness for a run: API keys present, FFmpeg available,
 * output folder writable, Drive status. Returns booleans + labels only, never
 * secret values.
 */
export async function GET() {
  ensureInit();
  return NextResponse.json(runPreflight());
}
