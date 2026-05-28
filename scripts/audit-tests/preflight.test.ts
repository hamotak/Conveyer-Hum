/**
 * Proof for the preflight gating logic.
 *
 *   node scripts/audit-tests/preflight.test.ts
 *
 * buildPreflight is pure (facts → checks + ready). Required checks (Google key,
 * 69labs key, FFmpeg, output folder) gate the run; Drive is informational and
 * never blocks. No DB / filesystem here.
 */
import { buildPreflight, type PreflightFacts } from "../../src/lib/preflight-eval.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const allGood: PreflightFacts = {
  googleKey: true,
  labs69KeyCount: 2,
  ffmpeg: true,
  outputWritable: true,
  voiceConfigured: true,
  driveConnected: true,
  driveSyncEnabled: true,
};

console.log("Test 1 — fully configured machine is ready:");
{
  const r = buildPreflight(allGood);
  check("ready === true", r.ready === true);
  check("six checks present (incl. voice)", r.checks.length === 6);
  check("voice check present + ok", r.checks.find((c) => c.id === "voice")?.status === "ok");
  check("no required check failed", r.checks.every((c) => !c.required || c.status === "ok"));
}

console.log("Test 2 — each missing required input blocks the run:");
for (const k of ["googleKey", "ffmpeg", "outputWritable", "voiceConfigured"] as const) {
  const r = buildPreflight({ ...allGood, [k]: false });
  check(`${k} missing → not ready`, r.ready === false);
}
{
  const r = buildPreflight({ ...allGood, labs69KeyCount: 0 });
  check("no 69labs key → not ready", r.ready === false);
  check("69labs check is a fail", r.checks.find((c) => c.id === "labs69_key")?.status === "fail");
}

console.log("Test 3 — Drive is informational, never blocks:");
{
  // Sync ON but not connected → warn, but the run is still allowed.
  const r = buildPreflight({ ...allGood, driveConnected: false, driveSyncEnabled: true });
  check("drive disconnected+sync-on → warn", r.checks.find((c) => c.id === "drive")?.status === "warn");
  check("still ready (drive doesn't gate)", r.ready === true);
}
{
  // Sync OFF → ok/info, ready.
  const r = buildPreflight({ ...allGood, driveSyncEnabled: false, driveConnected: false });
  check("sync off → drive ok", r.checks.find((c) => c.id === "drive")?.status === "ok");
  check("ready with drive off", r.ready === true);
}

console.log("Test 4 — labs69 key count is reflected, never the key itself:");
{
  const r = buildPreflight({ ...allGood, labs69KeyCount: 3 });
  const d = r.checks.find((c) => c.id === "labs69_key")?.detail ?? "";
  check("detail mentions the count", d.includes("3 keys"));
  check("detail never contains a vk_ secret", !d.includes("vk_"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
