import fs from "node:fs";
import path from "node:path";
import { getRunDir } from "./run-paths";
import { analyzeScenePlan, type ScenePlanHealth } from "./scene-plan-health";

export interface RunExportState {
  runDir: string;
  finalPath: string;
  finalFileExists: boolean;
  finalOnDisk: boolean;
  finalSize: number;
  scenePlanPresent: boolean;
  scenePlanParsed: boolean;
  scenePlanHealth: ScenePlanHealth;
  finalNeedsRepair: boolean;
  finalReady: boolean;
  canRepairPlan: boolean;
}

function unknownHealth(issue: string): ScenePlanHealth {
  return {
    ok: true,
    issue,
    sceneCount: 0,
    avgWords: 0,
    shortScenes: 0,
    danglingScenes: 0,
  };
}

export function readRunExportState(runId: string, status?: string | null): RunExportState {
  const runDir = getRunDir(runId);
  const finalPath = path.join(runDir, "final.mp4");
  const finalFileExists = fs.existsSync(finalPath) && fs.statSync(finalPath).isFile();
  const finalOnDisk = finalFileExists && (!status || status === "done");
  const finalSize = finalFileExists ? fs.statSync(finalPath).size : 0;

  let scenePlanPresent = false;
  let scenePlanParsed = false;
  let scenePlanHealth = unknownHealth("Scene plan is unavailable for this older run.");
  const scenesPath = path.join(runDir, "scenes.json");
  if (fs.existsSync(scenesPath)) {
    scenePlanPresent = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as { text?: unknown }[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        scenePlanParsed = true;
        scenePlanHealth = analyzeScenePlan(parsed);
      }
    } catch {
      scenePlanHealth = unknownHealth("Scene plan is corrupt, so chunking quality cannot be verified.");
    }
  }

  const finalNeedsRepair = finalOnDisk && scenePlanParsed && !scenePlanHealth.ok;
  const finalReady = finalOnDisk && !finalNeedsRepair;

  return {
    runDir,
    finalPath,
    finalFileExists,
    finalOnDisk,
    finalSize,
    scenePlanPresent,
    scenePlanParsed,
    scenePlanHealth,
    finalNeedsRepair,
    finalReady,
    canRepairPlan: finalNeedsRepair && scenePlanParsed,
  };
}
