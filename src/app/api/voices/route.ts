import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { fetchGlobalVoiceLibrary, savedVoicesAsOptions } from "@/lib/voices";

/**
 * GET /api/voices — voices for the library picker: the 69labs global
 * voice-clone library merged with locally saved voices. Saved voices come
 * first so the user's own picks are easy to find.
 */
export async function GET() {
  ensureInit();
  const [library, saved] = [await fetchGlobalVoiceLibrary(), savedVoicesAsOptions()];
  return NextResponse.json({ voices: [...saved, ...library] });
}
