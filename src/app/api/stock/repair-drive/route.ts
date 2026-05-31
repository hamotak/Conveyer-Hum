import { NextResponse } from "next/server";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import {
  findOrCreateFolder,
  listFolderChildren,
  listFoldersByName,
  moveFileBetweenFolders,
  trashFile,
} from "@/lib/services/gdrive";

function folderAliases(channelName: string, targetFolder: string): string[] {
  const compact = channelName.trim();
  const dashed = compact.replace(/\s+/g, "-");
  return [...new Set([compact, dashed, "Sleepy Pirate History", "Sleepy-Pirate-History"].filter((x) => x && x !== targetFolder))];
}

/** POST /api/stock/repair-drive - consolidate duplicate channel folders into canonical target folder. */
export async function POST(req: Request) {
  ensureInit();
  let body: { channelId?: unknown; channelName?: unknown; targetFolder?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const channelId = Number(body.channelId);
  const channelName = typeof body.channelName === "string" ? body.channelName.trim() : "";
  const targetFolder = typeof body.targetFolder === "string" ? body.targetFolder.trim() : "";
  if (!Number.isFinite(channelId) || !channelName || !targetFolder) {
    return NextResponse.json({ error: "channelId, channelName, and targetFolder are required" }, { status: 400 });
  }

  const errors: string[] = [];
  let moved = 0;
  let skipped = 0;
  let trashedFolders = 0;

  try {
    const root = await findOrCreateFolder("Conveyer Hum");
    const lib = await findOrCreateFolder("Clips Library", root);
    const targetId = await findOrCreateFolder(targetFolder, lib);
    const targetChildren = await listFolderChildren(targetId);
    const targetNames = new Set(targetChildren.map((f) => f.name));

    for (const alias of folderAliases(channelName, targetFolder)) {
      const folders = await listFoldersByName(alias, lib);
      for (const folder of folders) {
        if (folder.id === targetId) continue;
        const children = await listFolderChildren(folder.id);
        for (const child of children) {
          try {
            if (child.mimeType === "application/vnd.google-apps.folder") {
              skipped++;
              continue;
            }
            if (targetNames.has(child.name)) {
              skipped++;
              continue;
            }
            await moveFileBetweenFolders(child.id, folder.id, targetId);
            targetNames.add(child.name);
            moved++;
          } catch (e) {
            errors.push(`${child.name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 180));
          }
        }
        const remaining = await listFolderChildren(folder.id);
        if (remaining.length === 0) {
          await trashFile(folder.id);
          trashedFolders++;
        }
      }
    }

    db.prepare("UPDATE prompt_presets SET stock_folder = ?, updated_at = datetime('now') WHERE id = ?").run(targetFolder, channelId);
    return NextResponse.json({ moved, skipped, trashedFolders, failed: errors.length, errors, targetFolder });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), moved, skipped, trashedFolders, failed: errors.length, errors }, { status: 400 });
  }
}
