/**
 * Proof that the UI/default model name matches the fast video model the app
 * should use for new generated clips.
 */
import { videoModelLabel } from "../../src/lib/video-model.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("Test 1 - fast Veo model is the default label:");
check("empty model reads as Veo 3.1 Fast", videoModelLabel("") === "Veo 3.1 Fast");
check("explicit fast id reads as Veo 3.1 Fast", videoModelLabel("veo-3.1-fast") === "Veo 3.1 Fast");

console.log("Test 2 - old model ids stay readable:");
check("legacy Veo id still has a friendly name", videoModelLabel("veo-video") === "Veo 3.1");
check("unknown ids are not hidden", videoModelLabel("custom-model") === "custom-model");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
