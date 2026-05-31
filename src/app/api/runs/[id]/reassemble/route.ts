import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { startResumeRun, canResumeRun } from "@/lib/pipeline";

/**
 * Resume a failed / partial run.
 *
 * Reads the run's saved scenes.json, keeps every scene whose audio + video
 * are already on disk, and regenerates ONLY the missing ones — then
 * re-assembles the final video and re-uploads to Drive. The work runs in the
 * background; the run page streams its logs like a normal run.
 *
 * (URL is `/reassemble` for legacy reasons — the user-facing action is "Resume".)
 */
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;

  if (!canResumeRun(id)) {
    return NextResponse.json(
      {
        error:
          "This run can't be resumed — there's no saved scene plan (scenes.json) on disk, " +
          "which usually means it failed before scene-splitting finished. Start a fresh run instead.",
      },
      { status: 400 }
    );
  }

  const worker = startResumeRun(id);

  return NextResponse.json({
    ok: true,
    started: worker.started,
    alreadyRunning: !worker.started && worker.active,
  });
}
