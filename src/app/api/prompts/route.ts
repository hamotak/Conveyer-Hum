// UNUSED / LATENT ENDPOINT — no current UI caller. This is the default-prompts
// CRUD; the /prompts page uses /api/prompt-presets instead. Note that
// lib/prompts.ts getPrompt() is still used internally by scene-split, so don't
// remove that.
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { PROMPT_NAMES, getAllPrompts, setPrompt, type PromptName } from "@/lib/prompts";

export async function GET() {
  ensureInit();
  return NextResponse.json(getAllPrompts());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as Record<string, string>;
  const allowed = new Set<string>(PROMPT_NAMES);
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    setPrompt(k as PromptName, String(v ?? ""));
  }
  return NextResponse.json({ ok: true });
}
