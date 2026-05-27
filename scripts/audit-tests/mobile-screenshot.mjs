/**
 * Prompt 8 #6 — mobile layout smoke check with Playwright.
 *
 *   BASE_URL=http://localhost:3001 node scripts/audit-tests/mobile-screenshot.mjs
 *
 * Loads the home page at 390×844 (iPhone-ish) and 1280×800 (desktop), asserts
 * the mobile hamburger is visible only on mobile, opens the drawer, and saves
 * screenshots to audit-screenshots/. Playwright isn't a project dependency, so
 * if it isn't installed this SKIPS cleanly (exit 0) with install instructions —
 * the responsive layout was verified interactively during the audit and the
 * captured screenshots live in audit-screenshots/.
 */
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const OUT = "audit-screenshots";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIP: 'playwright' is not installed.");
  console.log("  Install with:  npm i -D playwright && npx playwright install chromium");
  console.log("  Then re-run:   BASE_URL=" + BASE_URL + " node scripts/audit-tests/mobile-screenshot.mjs");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
try {
  // ── Mobile ──
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mobile.newPage();
  await mp.goto(BASE_URL, { waitUntil: "networkidle" });
  const hamburger = mp.getByRole("button", { name: "Open menu" });
  check("mobile: hamburger is visible", await hamburger.isVisible());
  await mp.screenshot({ path: `${OUT}/mobile-390-home.png` });
  await hamburger.click();
  check("mobile: drawer nav opens (Settings link visible)", await mp.getByRole("link", { name: "Settings" }).isVisible());
  await mp.screenshot({ path: `${OUT}/mobile-390-drawer.png` });
  await mobile.close();

  // ── Desktop ──
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dp = await desktop.newPage();
  await dp.goto(BASE_URL, { waitUntil: "networkidle" });
  check("desktop: hamburger is hidden", !(await dp.getByRole("button", { name: "Open menu" }).isVisible()));
  await dp.screenshot({ path: `${OUT}/desktop-1280-home.png` });
  await desktop.close();
} finally {
  await browser.close();
}

console.log(`\nScreenshots saved to ${OUT}/`);
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("Mobile layout checks passed.");
