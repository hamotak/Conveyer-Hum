import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listPromptPresets, createPromptPreset } from "@/lib/prompts";

export async function GET() {
  ensureInit();
  return NextResponse.json(listPromptPresets());
}

export async function POST(req: Request) {
  ensureInit();
  let body: {
    name?: string;
    description?: string | null;
    style_preset_id?: string | null;
    video_style?: string | null;
    video_model?: string | null;
    aspect_ratio?: string | null;
    voice_speed?: number | null;
    voice_stability?: number | null;
    voice_similarity_boost?: number | null;
    voice_style?: number | null;
    voice_id?: string | null;
    voice_provider?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  try {
    const id = createPromptPreset({
      name,
      description: body.description,
      style_preset_id: body.style_preset_id,
      video_style: body.video_style,
      video_model: body.video_model,
      aspect_ratio: body.aspect_ratio,
      voice_speed: body.voice_speed,
      voice_stability: body.voice_stability,
      voice_similarity_boost: body.voice_similarity_boost,
      voice_style: body.voice_style,
      voice_id: body.voice_id,
      voice_provider: body.voice_provider,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // SQLite UNIQUE constraint on name
    if (msg.toLowerCase().includes("unique")) {
      return NextResponse.json({ error: `A channel named "${name}" already exists` }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
