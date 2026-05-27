import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { synthesizeVoiceSample } from "@/lib/services/tts";

/**
 * POST /api/voices/test — synthesize a tiny sample with the given voice so the
 * user can validate it BEFORE it burns a paid run. User-initiated only (the
 * "Test" button in the voice picker). On success returns the mp3 bytes; on
 * failure returns a clear JSON error. Never echoes API keys.
 */
export async function POST(req: Request) {
  ensureInit();
  let body: { voice_id?: string; provider?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const voiceId = (body.voice_id ?? "").trim();
  if (!voiceId) {
    return NextResponse.json({ error: "voice_id is required" }, { status: 400 });
  }

  try {
    const mp3 = await synthesizeVoiceSample(voiceId, body.provider ?? "elevenlabs");
    return new NextResponse(new Uint8Array(mp3), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
