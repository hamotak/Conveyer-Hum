import { NextResponse } from "next/server";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getActiveJobs, markCancelled } from "@/lib/cancellation";
import { cancelJob } from "@/lib/services/labs69";
import { log } from "@/lib/logger";

const getRun = db.prepare("SELECT id, status FROM runs WHERE id = ?");
const updateStatus = db.prepare(
  "UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?"
);

export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const row = getRun.get(id) as { id: string; status: string } | undefined;
  if (!row) return NextResponse.json({ error: "run not found" }, { status: 404 });

  if (row.status === "running" || row.status === "pending") {
    // Flag the run so the pipeline bails at its next checkpoint…
    markCancelled(id);
    updateStatus.run("cancelled", id);

    // …and actively cancel the PAID 69labs jobs already in flight, so Stop
    // actually stops billing instead of letting TTS/video finish in the
    // background. Best-effort + parallel; failures are logged, never thrown.
    const jobs = getActiveJobs(id);
    if (jobs.length > 0) {
      log(id, "warn", `Cancelling ${jobs.length} active 69labs job(s)…`, { stage: "pipeline" });
      await Promise.all(
        jobs.map(async (j) => {
          try {
            const ok = await cancelJob(j.kind, j.jobId);
            log(id, "info", `Cancel ${j.kind} ${j.jobId.slice(0, 8)} → ${ok ? "ok" : "skipped"}`, {
              stage: "pipeline",
            });
          } catch (e) {
            log(id, "warn", `Cancel ${j.kind} ${j.jobId.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)}`, {
              stage: "pipeline",
            });
          }
        })
      );
    }
    log(id, "warn", "Cancelled by user", { stage: "pipeline" });
  }
  return NextResponse.json({ ok: true, previousStatus: row.status });
}
