/**
 * Proof for the masked-secret persistence fix (Prompt 5 / Prompt 8 #2).
 *
 *   node scripts/audit-tests/secret-masking.test.ts
 *
 * The bug: the settings POST route's inline guard matched KEY/TOKEN but not
 * SECRET, so a masked "GOCS…XXXX" GDRIVE_CLIENT_SECRET POSTed back from the form
 * overwrote the real secret. The route AND the client form now use the SAME
 * shared guard `isSecretKey(k) && isMaskedValue(v)`. This replays that guard
 * over a representative POST body and asserts masked secrets are dropped while
 * real edits pass through.
 */
import { isMaskedValue, isSecretKey } from "../../src/lib/secret-keys.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("Test 1 — SECRET keys are recognized (the bug):");
check("GDRIVE_CLIENT_SECRET is a secret", isSecretKey("GDRIVE_CLIENT_SECRET") === true);
check("LABS69_API_KEY is a secret", isSecretKey("LABS69_API_KEY") === true);
check("GDRIVE_REFRESH_TOKEN is a secret", isSecretKey("GDRIVE_REFRESH_TOKEN") === true);
check("GDRIVE_CLIENT_ID is NOT a secret", isSecretKey("GDRIVE_CLIENT_ID") === false);
check("masked value detected via U+2026", isMaskedValue("GOCS…XXXX") === true);
check("plain value not masked", isMaskedValue("GOCSPX-real-secret-value") === false);

console.log("Test 2 — replay the POST guard the route + UI share:");
// What the form POSTs when the user edits the Client ID but leaves the masked
// secret untouched (the exact scenario that used to corrupt the secret).
const incoming: Record<string, string> = {
  GDRIVE_CLIENT_SECRET: "GOCS…XXXX", // masked — must be skipped
  LABS69_API_KEY: "vk_a…d12", // masked — must be skipped
  GDRIVE_CLIENT_ID: "new-client-id.apps.googleusercontent.com", // real edit — keep
  TTS_SPEED: "0.95", // non-secret — keep
};

// Identical predicate to src/app/api/settings/route.ts and settings/page.tsx.
const persisted: Record<string, string> = {};
for (const [k, v] of Object.entries(incoming)) {
  if (isSecretKey(k) && isMaskedValue(v)) continue;
  persisted[k] = v;
}

check("masked GDRIVE_CLIENT_SECRET is NOT persisted", !("GDRIVE_CLIENT_SECRET" in persisted));
check("masked LABS69_API_KEY is NOT persisted", !("LABS69_API_KEY" in persisted));
check("real GDRIVE_CLIENT_ID edit IS persisted", persisted.GDRIVE_CLIENT_ID === incoming.GDRIVE_CLIENT_ID);
check("non-secret TTS_SPEED IS persisted", persisted.TTS_SPEED === "0.95");

console.log("Test 3 — a genuinely new secret value still saves:");
const realSecret = "GOCSPX-brand-new-secret";
check(
  "non-masked GDRIVE_CLIENT_SECRET passes the guard",
  !(isSecretKey("GDRIVE_CLIENT_SECRET") && isMaskedValue(realSecret))
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
