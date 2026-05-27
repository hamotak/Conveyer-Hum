/**
 * Proof for the voice-picker duplicate-key fix (Prompt 3 / Prompt 8 #5).
 *
 *   node scripts/audit-tests/voice-key.test.ts
 *
 * Two saved voices can share the same voiceId (e.g. duplicates from an older DB).
 * The picker keyed cards by `source:voiceId`, which collided and threw React's
 * "two children with the same key" warning (observed: saved:G17SuINrv2H9FC6nvetn).
 * voiceUid now keys saved voices off their unique DB id, so keys never collide.
 */
import { voiceUid } from "../../src/lib/voice-key.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// Two saved rows with the SAME voiceId (the bug scenario) + a library voice that
// happens to reuse one of those ids.
const voices = [
  { source: "saved", voiceId: "G17SuINrv2H9FC6nvetn", savedId: "row-1" },
  { source: "saved", voiceId: "G17SuINrv2H9FC6nvetn", savedId: "row-2" },
  { source: "saved", voiceId: "OtherVoiceId", savedId: "row-3" },
  { source: "library", voiceId: "G17SuINrv2H9FC6nvetn" },
  { source: "library", voiceId: "clone-abc" },
];

const keys = voices.map(voiceUid);
console.log("  keys:", keys.join(", "));

console.log("Voice key uniqueness:");
check("duplicate saved voiceIds get distinct keys", keys[0] !== keys[1]);
check("saved keys use the DB id", keys[0] === "saved:row-1" && keys[1] === "saved:row-2");
check("library voice keeps source:voiceId", keys[3] === "library:G17SuINrv2H9FC6nvetn");
check("all keys are unique", new Set(keys).size === keys.length);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
