/**
 * Proof for 69labs speed/retry policy.
 *
 *   node scripts/audit-tests/labs69-capacity.test.ts
 *
 * These helpers are pure: no DB, no network, no real paid API calls.
 */
import {
  effectiveProviderSlots,
  isProviderCapacityResponse,
  pollTimeoutMs,
  retryWaitMs,
} from "../../src/lib/services/labs69-capacity.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("Test 1 - concurrent 403 is retryable capacity, not a scene failure:");
{
  const body = "Concurrent image generation limit reached (7). Please wait for current jobs to complete.";
  check("403 concurrent limit is capacity", isProviderCapacityResponse(403, body));
  check("plain forbidden is not capacity", !isProviderCapacityResponse(403, "Invalid API key or model access denied"));
}

console.log("Test 2 - 429 Retry-After is respected:");
{
  check("Retry-After 12s wins", retryWaitMs("12", 1, { baseMs: 20_000, maxMs: 600_000 }) === 12_000);
  check("fallback backs off", retryWaitMs(null, 3, { baseMs: 20_000, maxMs: 600_000 }) === 60_000);
}

console.log("Test 3 - video polling timeout is model-aware:");
{
  check("Veo gets 25 minutes", pollTimeoutMs("videos", "veo-3.1-fast") === 25 * 60_000);
  check("Gemini video gets 25 minutes", pollTimeoutMs("videos", "gemini-omni") === 25 * 60_000);
  check("Grok gets 12 minutes", pollTimeoutMs("videos", "grok-imagine-video") === 12 * 60_000);
  check("images stay at 8 minutes", pollTimeoutMs("images", "nano-banana-pro") === 8 * 60_000);
}

console.log("Test 4 - effective concurrency clamps to provider limits:");
{
  check("uses discovered max when configured higher", effectiveProviderSlots("9", 5, 3) === 5);
  check("uses user lower cap when configured lower", effectiveProviderSlots("4", 5, 3) === 4);
  check("uses live provider when setting missing", effectiveProviderSlots("", 7, 5) === 7);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
