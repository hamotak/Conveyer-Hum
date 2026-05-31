/**
 * Proof that old micro-chunk scene plans are detected before Resume reuses
 * mismatched assets.
 */
import { analyzeScenePlan } from "../../src/lib/scene-plan-health.ts";
import { normalizeNarrationScenes, type SceneChunkInput } from "../../src/lib/scene-chunking.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function scene(text: string, index: number): SceneChunkInput {
  return { index, text, visual_prompt: `shot ${index}`, duration_hint_sec: 3 };
}

console.log("Test 1 - Blackbeard-style micro chunks are unhealthy:");
{
  const raw = [
    "Before the smoke and the pistols and",
    "the name that made harbor masters sweat,",
    "there was just a man. A young one, probably from Bristol, England,",
    "though the records from that period are thin",
    "and the details blur at the edges.",
    "Bristol in the late sixteen hundreds is a port city.",
    "It smells like tar and fish and the",
    "river at low tide.",
  ].map(scene);
  const health = analyzeScenePlan(raw);
  check("old plan is rejected", health.ok === false);
  check("mid-thought cuts are counted", health.danglingScenes >= 2);
}

console.log("Test 2 - normalized chunks become healthy:");
{
  const raw = [
    "Before the smoke and the pistols and",
    "the name that made harbor masters sweat,",
    "there was just a man. A young one, probably from Bristol, England,",
    "though the records from that period are thin",
    "and the details blur at the edges.",
    "Bristol in the late sixteen hundreds is a port city.",
    "It smells like tar and fish and the",
    "river at low tide. Ships are everywhere.",
    "Boys grow up watching them come in,",
    "and sometimes they never stop watching.",
  ].map(scene);
  const repaired = normalizeNarrationScenes(raw);
  const health = analyzeScenePlan(repaired);
  check("repair produces fewer beats", repaired.length < raw.length);
  check("repaired plan is accepted", health.ok === true);
}

console.log("Test 3 - tiny repeated chunks or dangling chunks fail:");
{
  const tiny = analyzeScenePlan([
    scene("Then it vanished.", 0),
    scene("The room froze.", 1),
    scene("Nobody moved.", 2),
    scene("The bell rang.", 3),
  ]);
  const dangling = analyzeScenePlan([
    scene("The harbor fell silent while", 0),
    scene("the black flag appeared above the mast.", 1),
  ]);

  check("tiny repeated plan is rejected", tiny.ok === false);
  check("dangling two-scene plan is rejected", dangling.ok === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
