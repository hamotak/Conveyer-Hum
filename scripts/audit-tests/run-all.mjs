/**
 * Tiny audit-test runner — runs every *.test.ts in this folder with Node's
 * native type stripping (Node ≥ 22) and reports a pass/fail summary. Exits
 * non-zero if any suite fails, so it works in `npm test` / CI.
 *
 *   node scripts/audit-tests/run-all.mjs
 *
 * These suites cover the riskiest audited flows without a heavyweight test
 * framework. Each imports only dependency-free modules (no DB, no network), so
 * they're fast and deterministic. The Playwright mobile check is separate
 * (mobile-screenshot.mjs) because it needs a running server + a browser.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (suites.length === 0) {
  console.error("No *.test.ts suites found.");
  process.exit(1);
}

console.log(`Running ${suites.length} audit suite(s)\n`);
let failed = 0;
for (const suite of suites) {
  console.log(`▶ ${suite}`);
  const res = spawnSync(process.execPath, [path.join(here, suite)], {
    stdio: "inherit",
  });
  if (res.status !== 0) failed++;
  console.log("");
}

const passed = suites.length - failed;
console.log("─".repeat(48));
console.log(`${passed}/${suites.length} suites passed`);
if (failed > 0) {
  console.error(`${failed} suite(s) FAILED`);
  process.exit(1);
}
console.log("All audit suites passed.");
