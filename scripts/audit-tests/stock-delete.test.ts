/**
 * Proof that deleting a Drive stock clip also deletes its local preview/cache
 * copy, so it does not come back as a local-only clip after refresh.
 */
import { stockDeleteIdsForSelection } from "../../src/lib/stock-delete.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("Test 1 - selected Drive clip includes local preview id:");
{
  const ids = stockDeleteIdsForSelection(
    [
      { driveFileId: "drive-1", previewFileId: "local:preview-1" },
      { driveFileId: "drive-2" },
      { driveFileId: "local:extra" },
    ],
    new Set(["drive-1"])
  );
  check("includes Drive id", ids.includes("drive-1"));
  check("includes attached local preview", ids.includes("local:preview-1"));
  check("does not delete unselected clips", !ids.includes("drive-2") && !ids.includes("local:extra"));
}

console.log("Test 2 - duplicates are removed:");
{
  const ids = stockDeleteIdsForSelection(
    [{ driveFileId: "local:only", previewFileId: "local:only" }],
    new Set(["local:only"])
  );
  check("one id only", ids.length === 1 && ids[0] === "local:only");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
