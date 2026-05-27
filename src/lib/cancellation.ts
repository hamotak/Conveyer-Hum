import type { JobKind } from "./services/labs69";

/**
 * In-memory cancellation registry.
 *
 * When the user clicks Stop, the API adds the runId here. The pipeline checks
 * this set between stages and throws CancelledError when it sees its id.
 *
 * Lives in the dev server process memory — clears on restart, which is fine
 * for our use case (any cancelled run will already be marked `cancelled` in DB).
 *
 * It also tracks the 69labs jobs currently in flight per run, so the Stop
 * endpoint can actively cancel the PAID jobs (TTS / video) — not just flip the
 * DB status and let them keep running and billing.
 *
 * The `import type` above is erased at runtime, so this module stays
 * dependency-free (no DB / network) and unit-testable in isolation.
 */
const cancelled = new Set<string>();

export function markCancelled(runId: string) {
  cancelled.add(runId);
}

export function isCancelled(runId: string): boolean {
  return cancelled.has(runId);
}

export function clearCancelled(runId: string) {
  cancelled.delete(runId);
  activeJobs.delete(runId); // stale entries from a prior attempt with this id
}

// ── Active 69labs job registry (runId → in-flight paid jobs) ─────────────────

export interface ActiveJob {
  kind: JobKind;
  jobId: string;
}

/** runId → (jobId → ActiveJob). Inner map keys by jobId so re-registering is idempotent. */
const activeJobs = new Map<string, Map<string, ActiveJob>>();

/** Record a 69labs job as in-flight for a run. No-op for blank ids. */
export function registerJob(runId: string, kind: JobKind, jobId: string): void {
  if (!runId || !jobId) return;
  let m = activeJobs.get(runId);
  if (!m) {
    m = new Map();
    activeJobs.set(runId, m);
  }
  m.set(jobId, { kind, jobId });
}

/** Mark a job no longer in flight (completed, downloaded, failed, or cancelled). */
export function unregisterJob(runId: string, jobId: string): void {
  const m = activeJobs.get(runId);
  if (!m) return;
  m.delete(jobId);
  if (m.size === 0) activeJobs.delete(runId);
}

/** Snapshot of the jobs currently in flight for a run — what Stop must cancel. */
export function getActiveJobs(runId: string): ActiveJob[] {
  const m = activeJobs.get(runId);
  return m ? [...m.values()] : [];
}

/** Throws CancelledError if the run has been flagged for cancellation. */
export function checkCancelled(runId: string): void {
  if (cancelled.has(runId)) {
    throw new CancelledError(`Run ${runId} cancelled by user`);
  }
}

export class CancelledError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CancelledError";
  }
}
