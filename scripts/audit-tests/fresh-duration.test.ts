/**
 * Proof for script-aware Fresh AI preset availability.
 */
import {
  freshDurationError,
  getFreshDurationOptions,
  normalizeFreshAiPresetMinutes,
} from "../../src/lib/fresh-duration.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(" ");

console.log("Test 1 - short scripts disable impossible presets:");
{
  const options = getFreshDurationOptions(words(160));
  const byMinute = new Map(options.map((o) => [o.minutes, o]));
  check("1 min is available", byMinute.get(1)?.supported === true);
  check("3 min is disabled", byMinute.get(3)?.supported === false);
  check("5 min is disabled", byMinute.get(5)?.supported === false);
  check("10 min is disabled", byMinute.get(10)?.supported === false);
}

console.log("Test 2 - server/client error copy blocks impossible runs:");
{
  const error = freshDurationError(words(120), 3);
  check("3 min run is blocked", typeof error === "string" && error.includes("3 minute"));
  check("1 min run is allowed", freshDurationError(words(150), 1) === null);
}

console.log("Test 3 - legacy values normalize to supported presets:");
{
  check("2 min resolves to the conservative preset", normalizeFreshAiPresetMinutes(2) === 1);
  check("9 min resolves to 10", normalizeFreshAiPresetMinutes(9) === 10);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
