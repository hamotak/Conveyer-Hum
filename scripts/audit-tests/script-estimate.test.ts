/**
 * Proof for the long-script warning logic.
 *
 *   node scripts/audit-tests/script-estimate.test.ts
 *
 * estimateScript is pure: words → scenes/minutes + an `isLong` flag (≥40 scenes
 * OR ≥20 min) that triggers the confirm gate. Short scripts must never be flagged.
 */
import { estimateScript, LONG_MINUTES, LONG_SCENES } from "../../src/lib/script-estimate.ts";

const WPM = 150;
let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("Test 1 — empty + tiny scripts:");
{
  const e0 = estimateScript(0);
  check("0 words → 0 scenes, not long", e0.scenes === 0 && e0.isLong === false);
  const e = estimateScript(40); // ~16s → a handful of scenes
  check("40 words → short, not long, no warnings", e.isLong === false && e.warnings.length === 0);
  check("40 words → at least 1 scene", e.scenes >= 1);
}

console.log("Test 2 — a normal ~3 min script is NOT blocked:");
{
  const e = estimateScript(450); // 450/150 = 3 min
  check("~3 min not long", e.isLong === false);
  check("~3 min ≈ 36 scenes (< 40)", e.scenes < LONG_SCENES);
}

console.log("Test 3 — long by minutes (≥20 min):");
{
  const e = estimateScript(20 * 150); // exactly 20 min
  check("20 min → isLong", e.isLong === true);
  check("minutes ≈ 20", Math.round(e.minutes) === LONG_MINUTES);
  check("has practical warnings", e.warnings.length >= 2);
  check("warns to test smaller first", e.warnings.some((w) => /1-minute|5–10/.test(w)));
}

console.log("Test 4 — long by scene count crosses before 20 min:");
{
  // 40 scenes × 5s = 200s ≈ 3.3 min, but scene count alone should flag it.
  const wordsFor40Scenes = Math.ceil((LONG_SCENES * 5 * WPM) / 60);
  const e = estimateScript(wordsFor40Scenes);
  check("≥40 scenes → isLong even though under 20 min", e.isLong === true && e.minutes < LONG_MINUTES);
}

console.log("Test 5 — ~1 hour adds the chaptering warning:");
{
  const e = estimateScript(60 * 150);
  check("60 min → isLong", e.isLong === true);
  check("recommends chapters for ~1 hour", e.warnings.some((w) => /chapter/i.test(w)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
