/**
 * Export-quality proof.
 *
 * Ensures the run page can distinguish a truly usable final export from an
 * old/broken file that merely exists on disk.
 */
import { buildExportQualityReport } from "../../src/lib/export-quality.ts";
import type { ScenePlanHealth } from "../../src/lib/scene-plan-health.ts";

function check(name: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
}

const healthy: ScenePlanHealth = {
  ok: true,
  issue: null,
  sceneCount: 4,
  avgWords: 42,
  shortScenes: 0,
  danglingScenes: 0,
};

const unhealthy: ScenePlanHealth = {
  ok: false,
  issue: "Old micro-chunk scene plan detected.",
  sceneCount: 48,
  avgWords: 9,
  shortScenes: 48,
  danglingScenes: 5,
};

console.log("Test 1 - clean export is ready:");
{
  const report = buildExportQualityReport({
    finalReady: true,
    finalOnDisk: true,
    finalNeedsRepair: false,
    finalSize: 50 * 1024 * 1024,
    scenePlanHealth: healthy,
    syncReport: { totalSec: 120, freshMaxDriftSec: 0.08, continuousTail: true },
    watermarkCleanupEnabled: true,
    watermarkReport: { status: "cleaned" },
  });
  check("overall ready", report.overall === "ready");
  check("all checks pass", report.checks.every((c) => c.status === "pass"));
}

console.log("Test 2 - old micro-chunk export is blocked:");
{
  const report = buildExportQualityReport({
    finalReady: false,
    finalOnDisk: true,
    finalNeedsRepair: true,
    finalSize: 1024,
    scenePlanHealth: unhealthy,
    syncReport: null,
    watermarkCleanupEnabled: true,
    watermarkReport: null,
  });
  check("overall blocked", report.overall === "blocked");
  check("chunking fails", report.checks.find((c) => c.id === "chunking")?.status === "fail");
  check("old file is not considered export-ready", report.checks.find((c) => c.id === "duration")?.status === "fail");
}

console.log("Test 3 - older export without sync proof is not perfect:");
{
  const report = buildExportQualityReport({
    finalReady: true,
    finalOnDisk: true,
    finalNeedsRepair: false,
    finalSize: 42,
    scenePlanHealth: healthy,
    syncReport: null,
    watermarkCleanupEnabled: true,
    watermarkReport: { status: "cleaned" },
  });
  check("overall needs work", report.overall === "needs_work");
  check("sync warning", report.checks.find((c) => c.id === "sync")?.status === "warn");
}

console.log("Test 4 - final without cleanup proof is not perfect:");
{
  const report = buildExportQualityReport({
    finalReady: true,
    finalOnDisk: true,
    finalNeedsRepair: false,
    finalSize: 42,
    scenePlanHealth: healthy,
    syncReport: { totalSec: 120, freshMaxDriftSec: 0.08, continuousTail: true },
    watermarkCleanupEnabled: true,
    watermarkReport: null,
  });
  check("overall needs work", report.overall === "needs_work");
  check("watermark warning", report.checks.find((c) => c.id === "watermark")?.status === "warn");
}

console.log("Test 5 - failed cleanup blocks export quality:");
{
  const report = buildExportQualityReport({
    finalReady: true,
    finalOnDisk: true,
    finalNeedsRepair: false,
    finalSize: 42,
    scenePlanHealth: healthy,
    syncReport: { totalSec: 120, freshMaxDriftSec: 0.08, continuousTail: true },
    watermarkCleanupEnabled: true,
    watermarkReport: { status: "failed", message: "ffmpeg failed" },
  });
  check("overall blocked", report.overall === "blocked");
  check("watermark fails", report.checks.find((c) => c.id === "watermark")?.status === "fail");
}

console.log("\nAll checks passed.");
