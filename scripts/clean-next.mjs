// Clean-start guard for `npm run dev`.
//
// Next 16's Turbopack dev cache (`.next/`) periodically goes stale — most often
// after the machine sleeps — and then every page 500s with
// `ENOENT … build-manifest.json` / `routes-manifest.json`. This script makes
// every `dev` start from a fresh `.next`.
//
// It RENAMES `.next` aside (instant, even when the folder is corrupted with
// huge/duplicated dirs that `rm -rf` chokes on) and deletes old trash in a
// detached background process, so startup is never blocked.

import { existsSync, renameSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const dotNext = join(root, ".next");

if (existsSync(dotNext)) {
  const trash = join(root, `.next_trash_${Date.now()}`);
  try {
    renameSync(dotNext, trash);
    console.log(`[clean-next] moved stale .next aside → ${trash}`);
  } catch (e) {
    console.warn(`[clean-next] could not move .next aside: ${e.message}`);
  }
}

// Best-effort background cleanup of any accumulated .next_trash_* dirs.
// Detached + unref so it never holds up the dev server.
try {
  const trashDirs = readdirSync(root).filter((n) => n.startsWith(".next_trash"));
  if (trashDirs.length > 0) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const{rmSync}=require('fs');const{join}=require('path');for(const d of ${JSON.stringify(
          trashDirs
        )}){try{rmSync(join(${JSON.stringify(
          root
        )},d),{recursive:true,force:true})}catch(e){}}`,
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  }
} catch {
  // ignore — cleanup is purely best-effort
}
