import { NextResponse } from "next/server";
import fs from "node:fs";
import db from "@/lib/db";
import { getLogs } from "@/lib/logger";
import { ensureInit } from "@/lib/init";
import { getRunDir } from "@/lib/run-paths";
import { isRunWorkerActive } from "@/lib/pipeline";

const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");
const deleteRunStmt = db.prepare("DELETE FROM runs WHERE id = ?");
const deleteLogsStmt = db.prepare("DELETE FROM run_logs WHERE run_id = ?");

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id) as Record<string, unknown> | undefined;
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dbStatus = String(run.status ?? "");
  const workerActive = (dbStatus === "running" || dbStatus === "pending") && isRunWorkerActive(id);
  const runtimeStatus =
    (dbStatus === "running" || dbStatus === "pending") && !workerActive && !run.output_path ? "paused" : dbStatus;
  return NextResponse.json({
    run: {
      ...run,
      db_status: dbStatus,
      status: runtimeStatus,
      worker_active: workerActive,
      needs_recovery: runtimeStatus === "paused",
    },
    logs: getLogs(id),
  });
}

/** Delete a run: its DB row, its logs, and its output folder on disk. */
export async function DELETE(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id) as { status?: string; output_path?: string | null } | undefined;
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dbStatus = String(run.status ?? "");
  const active = (dbStatus === "running" || dbStatus === "pending") && isRunWorkerActive(id);
  if (active) {
    return NextResponse.json({ error: "Stop the run before deleting it." }, { status: 409 });
  }
  // Remove the output folder (best-effort) before clearing the DB row that maps to it.
  try {
    const dir = getRunDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* folder may already be gone */
  }
  try {
    deleteLogsStmt.run(id);
  } catch {
    /* logs table may be empty */
  }
  deleteRunStmt.run(id);
  return NextResponse.json({ deleted: true });
}
