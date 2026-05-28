import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import {
  getPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
} from "@/lib/prompts";

function parseId(idStr: string): number | null {
  const id = Number(idStr);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const preset = getPromptPreset(id);
  if (!preset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(preset);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

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
    updatePromptPreset(id, {
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
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("unique")) {
      return NextResponse.json({ error: `A channel named "${name}" already exists` }, { status: 409 });
    }
    if (msg.includes("not found")) {
      return NextResponse.json({ error: "Channel profile not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  deletePromptPreset(id);
  return NextResponse.json({ ok: true });
}
