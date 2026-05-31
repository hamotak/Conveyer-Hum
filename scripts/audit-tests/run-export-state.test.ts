/**
 * Run export readiness proof.
 *
 * Ensures direct export-state reads keep older/corrupt scene plans usable while
 * still blocking final.mp4 files built from old micro-chunk scene plans.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (mod, filename) => {
  const source = fs.readFileSync(filename, "utf-8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  mod._compile(outputText, filename);
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conveyer-export-state-"));
process.env.CONVEYER_HUM_DATA_DIR = dataDir;

const { readRunExportState } = require("../../src/lib/run-export-state.ts");

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function runDir(runId: string): string {
  const dir = path.join(dataDir, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFinal(dir: string): void {
  fs.writeFileSync(path.join(dir, "final.mp4"), "fake-final-mp4");
}

function writeScenes(dir: string, scenes: { text: string }[] | string): void {
  fs.writeFileSync(path.join(dir, "scenes.json"), typeof scenes === "string" ? scenes : JSON.stringify(scenes, null, 2));
}

console.log("Test 1 - final export with missing scenes.json stays ready:");
{
  const dir = runDir("missing-scenes");
  writeFinal(dir);

  const state = readRunExportState("missing-scenes", "done");

  check("scene plan is marked absent", state.scenePlanPresent === false);
  check("missing plan is not repair-needed", state.finalNeedsRepair === false);
  check("existing final is ready", state.finalReady === true);
  check("repair plan is unavailable", state.canRepairPlan === false);
}

console.log("Test 2 - final export with corrupt scenes.json stays ready:");
{
  const dir = runDir("corrupt-scenes");
  writeFinal(dir);
  writeScenes(dir, "{ definitely not json");

  const state = readRunExportState("corrupt-scenes", "done");

  check("scene plan is marked present", state.scenePlanPresent === true);
  check("corrupt plan is not parsed", state.scenePlanParsed === false);
  check("corrupt plan is not repair-needed", state.finalNeedsRepair === false);
  check("existing final is ready", state.finalReady === true);
  check("repair plan is unavailable", state.canRepairPlan === false);
}

console.log("Test 3 - old micro-chunk final requires repair:");
{
  const dir = runDir("micro-chunk-final");
  writeFinal(dir);
  writeScenes(dir, [
    { text: "Before the smoke and the pistols and" },
    { text: "the name that made harbor masters sweat," },
    { text: "there was just a man. A young one, probably from Bristol, England," },
    { text: "though the records from that period are thin" },
    { text: "and the details blur at the edges." },
    { text: "Bristol in the late sixteen hundreds is a port city." },
    { text: "It smells like tar and fish and the" },
    { text: "river at low tide." },
  ]);

  const state = readRunExportState("micro-chunk-final", "done");

  check("scene plan is parsed", state.scenePlanParsed === true);
  check("micro-chunk plan is unhealthy", state.scenePlanHealth.ok === false);
  check("existing final is not ready", state.finalReady === false);
  check("old final is repair-needed", state.finalNeedsRepair === true);
  check("repair plan is available", state.canRepairPlan === true);
}

console.log("Test 4 - direct export state exposes readiness fields:");
{
  const dir = runDir("direct-state");
  writeFinal(dir);

  const state = readRunExportState("direct-state", "done");

  check("finalReady is exposed as boolean", typeof state.finalReady === "boolean");
  check("finalNeedsRepair is exposed as boolean", typeof state.finalNeedsRepair === "boolean");
  check("canRepairPlan is exposed as boolean", typeof state.canRepairPlan === "boolean");
  check("final file metadata is exposed", state.finalFileExists === true && state.finalOnDisk === true && state.finalSize > 0);
}

const { default: db } = require("../../src/lib/db.ts");
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
