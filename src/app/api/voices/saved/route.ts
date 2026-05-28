import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { addSavedVoice, deleteSavedVoice, listSavedVoices } from "@/lib/voices";

export async function GET() {
  ensureInit();
  return NextResponse.json({ voices: listSavedVoices() });
}

export async function POST(req: Request) {
  ensureInit();
  let body: {
    name?: string;
    voice_id?: string;
    provider?: string;
    language?: string | null;
    gender?: string | null;
    preview_url?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const id = addSavedVoice({
      name: body.name ?? "",
      voice_id: body.voice_id ?? "",
      provider: body.provider,
      language: body.language,
      gender: body.gender,
      preview_url: body.preview_url,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  ensureInit();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  deleteSavedVoice(id);
  return NextResponse.json({ ok: true });
}
