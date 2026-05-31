/**
 * Proof for Clips page counting: when Drive is connected but local cache has
 * extra usable clips, the app should show both without duplicating cached
 * copies of Drive files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeDriveAndLocalStockClips } from "../../src/lib/stock-merge.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conveyer-stock-"));
try {
  const duplicateDrivePath = path.join(tmp, "drive123__old-cache-copy.mp4");
  const localOnlyPath = path.join(tmp, "local-extra.mp4");
  fs.writeFileSync(duplicateDrivePath, "cached drive clip");
  fs.writeFileSync(localOnlyPath, "local only clip");

  const merged = mergeDriveAndLocalStockClips(
    [{ driveFileId: "drive123", name: "drive.mp4" }],
    [
      {
        clip: { driveFileId: "local:duplicate", name: "old-cache-copy.mp4", source: "local" },
        localPath: duplicateDrivePath,
      },
      {
        clip: { driveFileId: "local:extra", name: "local-extra.mp4", source: "local" },
        localPath: localOnlyPath,
      },
    ]
  );

  console.log("Test 1 - Drive plus local extras:");
  check("keeps the Drive clip", merged.some((c) => c.driveFileId === "drive123" && c.source === "drive"));
  check("Drive clip gets local preview id", merged.some((c) => c.driveFileId === "drive123" && c.previewFileId === "local:duplicate"));
  check("skips duplicate cached copy", !merged.some((c) => c.driveFileId === "local:duplicate"));
  check("keeps local-only clip", merged.some((c) => c.driveFileId === "local:extra" && c.source === "local"));
  check("final count is 2", merged.length === 2);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
