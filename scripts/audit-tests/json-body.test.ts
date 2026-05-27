/**
 * Proof for the /api/runs malformed-JSON fix (Prompt 8 #1).
 *
 *   node scripts/audit-tests/json-body.test.ts
 *
 * /api/runs POST used `await req.json()` with no guard, so a malformed body threw
 * and surfaced as HTTP 500. It now parses with tryParseJson and returns 400 on
 * `ok: false` (or a non-object value). This tests that exact guard.
 */
import { isJsonObject, tryParseJson } from "../../src/lib/json-body.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

/** Mirror the route guard: malformed OR non-object ⇒ 400. */
function wouldReturn400(rawBody: string): boolean {
  const parsed = tryParseJson(rawBody);
  return !parsed.ok || !isJsonObject(parsed.value);
}

console.log("Test 1 — malformed JSON is a 400, not a 500:");
check("truncated object → 400", wouldReturn400('{"script":"hi'));
check("garbage → 400", wouldReturn400("not json at all"));
check("empty body → 400", wouldReturn400(""));
check("trailing comma → 400", wouldReturn400('{"script":"hi",}'));

console.log("Test 2 — non-object JSON is also rejected (would crash body.script access):");
check("null → 400", wouldReturn400("null"));
check("array → 400", wouldReturn400('["script"]'));
check("bare string → 400", wouldReturn400('"hello"'));
check("number → 400", wouldReturn400("42"));

console.log("Test 3 — valid object bodies pass the guard:");
check("valid run body → not 400", !wouldReturn400('{"script":"Once upon a time","title":"Test"}'));
check("empty object → not 400 (falls through to 'script is empty')", !wouldReturn400("{}"));
const ok = tryParseJson<{ script?: string }>('{"script":"hi"}');
check("parsed value is usable", ok.ok && ok.value.script === "hi");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
