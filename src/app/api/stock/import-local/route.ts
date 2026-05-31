import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { ensureInit } from "@/lib/init";
import { findOrCreateFolder, uploadFile } from "@/lib/services/gdrive";
import { listLocalCachedClips, listStockClips } from "@/lib/services/stock-library";

function cachedDriveId(filePath: string): string | null {
  const base = path.basename(filePath);
  const marker = base.indexOf("__");
  if (marker <= 0) return null;
  return base.slice(0, marker);
}

function safeDriveName(localPath: string): string {
  const base = path.basename(localPath).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
}

function removeLocalClip(localPath: string): void {
  fs.rmSync(localPath, { force: true });
  const sidecar = localPath.replace(/\.mp4$/i, ".manifest.json");
  if (sidecar !== localPath) fs.rmSync(sidecar, { force: true });
}

async function resolveStockFolderId(folder: string): Promise<string> {
  const root = await findOrCreateFolder("Conveyer Hum");
  const lib = await findOrCreateFolder("Clips Library", root);
  return findOrCreateFolder(folder, lib);
}

/** POST /api/stock/import-local { folder } - move safe local-only cache into Drive and purge stale ghosts. */
export async function POST(req: Request) {
  ensureInit();
  let folder = "";
  try {
    const body = (await req.json()) as { folder?: unknown };
    folder = typeof body.folder === "string" ? body.folder.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!folder) return NextResponse.json({ error: "Folder is required" }, { status: 400 });

  const errors: string[] = [];
  let imported = 0;
  let purged = 0;
  let kept = 0;
  const uploaded: string[] = [];

  try {
    const [driveClips, folderId] = await Promise.all([listStockClips(folder), resolveStockFolderId(folder)]);
    const driveIds = new Set(driveClips.map((c) => c.driveFileId));
    const localRows = listLocalCachedClips(folder);

    for (const row of localRows) {
      const localPath = row.localPath;
      const driveId = cachedDriveId(localPath);
      try {
        if (driveId && driveIds.has(driveId)) {
          kept++;
          continue;
        }
        if (driveId && !driveIds.has(driveId)) {
          removeLocalClip(localPath);
          purged++;
          continue;
        }
        const newId = await uploadFile(localPath, folderId, { name: safeDriveName(localPath), mimeType: "video/mp4" });
        uploaded.push(newId);
        imported++;
        removeLocalClip(localPath);
      } catch (e) {
        errors.push(`${path.basename(localPath)}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 180));
      }
    }

    return NextResponse.json({ imported, purged, kept, uploaded, failed: errors.length, errors });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
