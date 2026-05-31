import { ensureInit } from "@/lib/init";
import { DATA_DIR } from "@/lib/run-paths";
import { ensureStockClipCached, isLocalStockClipId, resolveLocalStockClipPath } from "@/lib/services/stock-library";
import { ensureVideoPoster } from "@/lib/services/video-poster";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function streamFile(target: string): ReadableStream<Uint8Array> {
  const node = fs.createReadStream(target);
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk) => {
        node.pause();
        if (closed) return;
        try {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        } catch {
          closed = true;
          node.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) > 0) node.resume();
      });
      node.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      });
      node.once("error", (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {}
      });
    },
    pull() {
      if (!closed) node.resume();
    },
    cancel() {
      closed = true;
      node.destroy();
    },
  });
}

function withTimeout<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds`)), ms);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

/** GET /api/stock/poster?id=<id>&folder=<folder>&name=<name> - lightweight JPG for clip grids. */
export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const folder = (url.searchParams.get("folder") || "").trim();
  const name = (url.searchParams.get("name") || "stock.mp4").trim() || "stock.mp4";
  if (!id) return new Response("Missing id", { status: 400 });

  try {
    const localPath = isLocalStockClipId(id)
      ? resolveLocalStockClipPath(id)
      : await withTimeout("Drive preview cache", ensureStockClipCached(folder || "Pirates", { driveFileId: id, name }), 12_000);
    const posterKey = isLocalStockClipId(id) ? localPath : `${folder || "Pirates"}:${id}`;
    const hash = crypto.createHash("sha1").update(posterKey).digest("hex");
    const posterPath = path.join(DATA_DIR, "stock-posters", `${hash}.jpg`);
    await withTimeout("Poster generation", ensureVideoPoster(localPath, posterPath), 12_000);
    return new Response(streamFile(posterPath), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`Poster failed: ${msg}`, { status: 404, headers: { "Cache-Control": "private, max-age=30" } });
  }
}
