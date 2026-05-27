/**
 * Proof for the Stop-cancels-paid-jobs registry (Prompt 4).
 *
 *   node scripts/audit-tests/cancellation-registry.test.ts
 *
 * cancellation.ts only type-imports labs69 (erased at runtime), so it loads with
 * no DB/network. We assert the job registry the Stop endpoint relies on: register
 * on create, unregister on finish, snapshot for cancellation, per-run isolation.
 */
import {
  clearCancelled,
  getActiveJobs,
  isCancelled,
  markCancelled,
  registerJob,
  unregisterJob,
} from "../../src/lib/cancellation.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const RUN = "run-A";
const OTHER = "run-B";

console.log("Test 1 — register / snapshot / unregister:");
check("no jobs initially", getActiveJobs(RUN).length === 0);
registerJob(RUN, "tts", "job-tts-1");
registerJob(RUN, "videos", "job-vid-1");
registerJob(RUN, "videos", "job-vid-2");
check("three jobs tracked", getActiveJobs(RUN).length === 3);
check(
  "kinds are preserved for the Stop endpoint to pass to cancelJob",
  getActiveJobs(RUN).some((j) => j.kind === "tts" && j.jobId === "job-tts-1") &&
    getActiveJobs(RUN).some((j) => j.kind === "videos" && j.jobId === "job-vid-2")
);
unregisterJob(RUN, "job-vid-1");
check("unregister removes exactly one", getActiveJobs(RUN).length === 2);
check("the right one was removed", !getActiveJobs(RUN).some((j) => j.jobId === "job-vid-1"));

console.log("Test 2 — idempotency + blank guards:");
registerJob(RUN, "tts", "job-tts-1"); // duplicate registration
check("re-registering the same jobId does not duplicate", getActiveJobs(RUN).length === 2);
registerJob(RUN, "tts", ""); // blank jobId ignored
registerJob("", "tts", "x"); // blank runId ignored
check("blank ids are ignored", getActiveJobs(RUN).length === 2 && getActiveJobs("").length === 0);

console.log("Test 3 — per-run isolation:");
registerJob(OTHER, "tts", "job-other-1");
check("run-B has its own job", getActiveJobs(OTHER).length === 1);
check("run-A is unaffected by run-B", getActiveJobs(RUN).length === 2);

console.log("Test 4 — clearCancelled wipes flag + active jobs:");
markCancelled(RUN);
check("run-A is flagged cancelled", isCancelled(RUN) === true);
clearCancelled(RUN);
check("flag cleared", isCancelled(RUN) === false);
check("active jobs cleared for that run", getActiveJobs(RUN).length === 0);
check("other run still isolated after clear", getActiveJobs(OTHER).length === 1);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
