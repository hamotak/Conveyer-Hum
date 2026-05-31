/**
 * Product-polish guard: failures and confirmations should render in the app,
 * not as browser alert()/confirm() popups.
 */
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

console.log("Browser popup audit:");
const appDir = path.join(process.cwd(), "src", "app");
const offenders = listFiles(appDir).filter((file) => /\balert\s*\(|(?<!function\s)\b(?:window\.)?confirm\s*\(/.test(fs.readFileSync(file, "utf-8")));
check("no app code calls alert() or confirm()", offenders.length === 0);
if (offenders.length > 0) {
  for (const file of offenders) console.error(`    ${path.relative(process.cwd(), file)}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
