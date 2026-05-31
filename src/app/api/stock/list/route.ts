import { NextResponse } from "next/server";
import path from "node:path";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { findOrCreateFolder } from "@/lib/services/gdrive";
import {
  isDriveAuthError,
  listLocalCachedClips,
  listLocalStockFolders,
  listStockClips,
  mergeDriveAndLocalStockClips,
} from "@/lib/services/stock-library";

const DRIVE_TIMEOUT_MS = 15000;

function stockJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

function cachedDriveId(filePath: string): string | null {
  const base = path.basename(filePath);
  const marker = base.indexOf("__");
  if (marker <= 0) return null;
  return base.slice(0, marker);
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = DRIVE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s. Reconnect Drive or try again.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function resolveFolderLink(folder: string): Promise<{ id: string; link: string }> {
  const root = await findOrCreateFolder("Conveyer Hum");
  const lib = await findOrCreateFolder("Clips Library", root);
  const id = await findOrCreateFolder(folder, lib);
  return { id, link: `https://drive.google.com/drive/folders/${id}` };
}

/** GET /api/stock/list?folder=Pirates - list Drive clips in a channel's stock folder. */
export async function GET(req: Request) {
  ensureInit();
  const started = Date.now();
  const listedAt = new Date().toISOString();
  const folder = (new URL(req.url).searchParams.get("folder") || "Pirates").trim() || "Pirates";
  const localFolders = listLocalStockFolders();
  const connectedEmail = getSetting("GDRIVE_CONNECTED_EMAIL") || null;
  try {
    const [driveClips, folderInfo] = await withTimeout(
      "Drive clip list",
      Promise.all([listStockClips(folder), resolveFolderLink(folder)])
    );
    const localRows = listLocalCachedClips(folder);
    const driveIds = new Set(driveClips.map((c) => c.driveFileId));
    const localOnlyCount = localRows.filter((row) => !cachedDriveId(row.localPath)).length;
    const staleCacheCount = localRows.filter((row) => {
      const id = cachedDriveId(row.localPath);
      return !!id && !driveIds.has(id);
    }).length;
    const clips = mergeDriveAndLocalStockClips(driveClips, localRows).filter((clip) => clip.source !== "local");
    return stockJson({
      folder,
      count: clips.length,
      driveCount: driveClips.length,
      localOnlyCount,
      staleCacheCount,
      localFolders,
      driveFolderId: folderInfo.id,
      driveFolderLink: folderInfo.link,
      connectedEmail,
      listedAt,
      driveMs: Date.now() - started,
      source: "drive",
      clips,
      message: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const driveAuth = isDriveAuthError(msg) || msg.includes("Google Drive is not connected") || msg.includes("Drive not connected");
    return stockJson({
      folder,
      count: 0,
      driveCount: 0,
      localOnlyCount: 0,
      staleCacheCount: 0,
      clips: [],
      localFolders,
      connectedEmail,
      listedAt,
      driveMs: Date.now() - started,
      source: "unavailable",
      errorKind: driveAuth ? "drive_auth" : "stock_list_failed",
      message: driveAuth ? "Reconnect Google Drive before clips can be loaded." : msg,
      detail: msg,
    }, { status: driveAuth ? 401 : 400 });
  }
}
