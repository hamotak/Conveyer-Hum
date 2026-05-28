import db from "./db";
import { DEFAULT_STYLE_PRESET_ID, loadStylePreset } from "./style-presets";

export const PROMPT_NAMES = ["scene_split", "image_prompt", "animation_motion"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  scene_split: `You are a video editor for a faceless YouTube channel. Split the provided script into scenes for an automated AI video pipeline (one short narrated clip per scene).

HOW TO SPLIT — cut by IDEA, not by sentence:
  Each scene is ONE complete idea or beat. Read for meaning, not punctuation.

SCENE LENGTH:
- Target: 6–8 seconds of narration per scene (roughly 12–20 words at a calm speaking pace).
- Hard maximum: 8 seconds (~20 words). Never exceed this.
- Minimum: 4 seconds (~10 words). A slice shorter than 4 seconds is NOT a complete idea — merge it with a neighbor (merge forward unless that would push the combined scene past 8 seconds, in which case merge backward).
- A 2–4 word fragment is never its own scene. Always merge fragments.

SENTENCE & CLAUSE RULES:
- Prefer breaking on sentence boundaries (. ? !) whenever the sentence fits in 6–8 seconds.
- Two short related sentences MAY share one scene if their combined narration is ≤ 8 seconds.
- If a SINGLE sentence is longer than 8 seconds, split it at the nearest natural clause boundary, in this priority order: em-dash (—), semicolon (;), colon (:), comma (,). Never split in the middle of a clause or phrase.

VERBATIM COVERAGE (critical):
- Cover the ENTIRE script word-for-word. No omissions, no summarizing, no paraphrasing, no reordering, no punctuation changes.
- The concatenation of every scene's "text" field, joined with single spaces, MUST equal the original script exactly.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script for this scene (no edits, no punctuation changes).
- "visual_prompt": a 40–90-word English description of a single cinematic shot that literally illustrates this scene's text. Describe the subject, the setting, and explicit camera or subject motion (slow push-in, gentle parallax, drifting light, rising mist). Photographic realism. No on-screen text, captions, logos, or watermarks. No recognizable real people or faces in close-up. The channel's overall look (lighting, mood, color grade) is appended automatically afterward — describe SUBSTANCE here, not style.
- "duration_hint_sec": estimated narration length in seconds (number, 4–8).

VISUAL CONTINUITY (additional fields — emit honestly; do NOT fake continuity):
- "continuity_group_id": a short kebab-case slug naming the SHOT IDENTITY (e.g. "ship-charleston-harbor", "blackbeard-deck", "blockade-charleston-1718"). Consecutive scenes that show the SAME subject + same location + same time of day MUST share the same group id. Different subject / different place / major time jump = a NEW group id.
- "continuity_break": true when this scene introduces a new place, new subject, new time of day, or a deliberate cut to a different shot type that should NOT carry visual identity from the previous scene. Set true on the FIRST scene of a new group. Otherwise false. The first scene of the whole script is always true.
- "continuity_hint": a 12–25-word identity carrier — the specific subject (e.g. "a massive 1718 wooden three-masted pirate ship, 40 cannon ports, black hull, weathered sails"), the era/wardrobe, lighting and palette. Reused by the pipeline to anchor the next scene's image to the same subject. Empty string when not applicable.

Honest rule: a tight close-up after a wide shot of the SAME ship is the same group (continuity_break: false). A cut to a new harbor, a new character, or a flashback is a different group (continuity_break: true). Do not chain everything — chaining a close-up of a beard to a wide ocean shot would just blur the identity.

Return ONLY a strictly valid JSON array — no markdown, no commentary.`,

  image_prompt: `documentary photography, photoreal, NatGeo / BBC Earth cinematography style, golden-hour Mediterranean light, warm earth tones, natural color grading, soft contrast, 35mm full-frame, shallow depth of field on close-ups, wide cinematic landscape for environments, sharp focus, 16:9 aspect ratio, no text overlays, no watermarks, no logos, no captions, no recognizable faces in close-up, no young people, no children, no sick or hospitalized bodies, no cartoon stylization, no painterly artwork, no fantasy elements, no sci-fi, no clickbait graphics`,

  animation_motion: `subtle cinematic documentary camera motion, slow dolly push-in or gentle parallax, natural ambient movement (steam rising, leaves drifting, sunlight shifting), shallow depth of field, photographic realism in the style of a NatGeo or BBC Earth documentary, no jarring cuts, no rapid pans, no whip motion — feels like a living photograph`,
};

const getStmt = db.prepare("SELECT content FROM prompts WHERE name = ?");
const upsertStmt = db.prepare(
  "INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = datetime('now')"
);

export function getPrompt(name: PromptName): string {
  const row = getStmt.get(name) as { content: string } | undefined;
  if (row?.content) return row.content;
  return DEFAULT_PROMPTS[name];
}

export function setPrompt(name: PromptName, content: string) {
  upsertStmt.run(name, content);
}

export function getAllPrompts(): Record<PromptName, string> {
  const out = {} as Record<PromptName, string>;
  for (const n of PROMPT_NAMES) out[n] = getPrompt(n);
  return out;
}

export function seedPromptDefaults() {
  for (const [n, c] of Object.entries(DEFAULT_PROMPTS)) {
    const row = getStmt.get(n) as { content: string } | undefined;
    if (!row) upsertStmt.run(n, c);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Channel Profiles — user-defined per-channel bundles.
// (DB table is named "prompt_presets" for legacy reasons.)
// Each profile carries: a scene_split prompt, optional animation-motion
// override, optional image-prompt override, optional per-channel voice id
// (MiniMax), and an optional human description. The user picks one on the
// New Run page; anything left empty falls back to global defaults/settings.
// ─────────────────────────────────────────────────────────────────────────

export interface PromptPreset {
  id: number;
  name: string;
  /** scene_split prompt (required) */
  content: string;
  /** human-readable note about the channel (optional) */
  description: string | null;
  /** style preset id (Prompt 9) — drives the scene-split prompt + default tuning. NULL = sleep-calm. */
  style_preset_id: string | null;
  /** video style override — appended to every scene's visual_prompt (optional — NULL = preset/global). */
  video_style: string | null;
  /** video model override (e.g. veo-video) — NULL = global ANIMATION_MODEL. */
  video_model: string | null;
  /** aspect ratio override (e.g. 16:9) — NULL = global IMAGE_RATIO. */
  aspect_ratio: string | null;
  /** voice speed override 0.5–1.5 — NULL = preset/global. */
  voice_speed: number | null;
  /** voice stability 0–1 — NULL = preset/global TTS_STABILITY. */
  voice_stability: number | null;
  /** voice similarity boost 0–1 — NULL = preset/global TTS_SIMILARITY_BOOST. */
  voice_similarity_boost: number | null;
  /** voice style 0–1 — NULL = preset/global TTS_STYLE. */
  voice_style: number | null;
  /** per-channel voice id (optional — NULL = global TTS_VOICE_ID). Set via the voice library picker. */
  voice_id: string | null;
  /** TTS provider for the per-channel voice (voice-clone | elevenlabs | edgetts). NULL = global TTS_VOICE_PROVIDER. */
  voice_provider: string | null;
  /** @deprecated scene-end pause — continuous voiceover has no inter-scene gaps */
  scene_end_pause_seconds: number | null;
  /** @deprecated legacy animation_motion override — superseded by video_style */
  animation_motion: string | null;
  /** @deprecated legacy per-channel image prompt override — currently unused */
  image_prompt: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields accepted when creating/updating a channel profile. */
export interface PromptPresetInput {
  name: string;
  /** @deprecated — scene-split prompt now comes from the style preset; auto-filled if omitted. */
  content?: string;
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
}

const PRESET_COLS =
  "id, name, content, description, style_preset_id, video_style, video_model, aspect_ratio, voice_speed, voice_stability, voice_similarity_boost, voice_style, voice_id, voice_provider, animation_motion, image_prompt, created_at, updated_at";

const listPresetsStmt = db.prepare(
  `SELECT ${PRESET_COLS} FROM prompt_presets ORDER BY name COLLATE NOCASE ASC`
);
const getPresetStmt = db.prepare(`SELECT ${PRESET_COLS} FROM prompt_presets WHERE id = ?`);
const getPresetByNameStmt = db.prepare(`SELECT ${PRESET_COLS} FROM prompt_presets WHERE name = ?`);
const createPresetStmt = db.prepare(
  "INSERT INTO prompt_presets (name, content, description, style_preset_id, video_style, video_model, aspect_ratio, voice_speed, voice_stability, voice_similarity_boost, voice_style, voice_id, voice_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const updatePresetStmt = db.prepare(
  "UPDATE prompt_presets SET name = ?, content = ?, description = ?, style_preset_id = ?, video_style = ?, video_model = ?, aspect_ratio = ?, voice_speed = ?, voice_stability = ?, voice_similarity_boost = ?, voice_style = ?, voice_id = ?, voice_provider = ?, updated_at = datetime('now') WHERE id = ?"
);
const deletePresetStmt = db.prepare("DELETE FROM prompt_presets WHERE id = ?");

export function listPromptPresets(): PromptPreset[] {
  return listPresetsStmt.all() as PromptPreset[];
}

export function getPromptPreset(id: number): PromptPreset | null {
  const row = getPresetStmt.get(id) as PromptPreset | undefined;
  return row ?? null;
}

export function getPromptPresetByName(name: string): PromptPreset | null {
  const row = getPresetByNameStmt.get(name) as PromptPreset | undefined;
  return row ?? null;
}

/** Normalize an optional string field — empty/whitespace becomes NULL (means "inherit default"). */
function normalizeOptional(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? s : null;
}

/** Normalize an optional numeric field — null/empty/NaN becomes NULL (means "inherit global"). */
function normalizeNumber(n: number | string | null | undefined): number | null {
  if (n == null || n === "") return null;
  const v = typeof n === "number" ? n : parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

/** Scene-split prompt now lives in code per style preset; keep the legacy NOT NULL
 *  `content` column populated with that prompt so old rows/diagnostics still read sensibly. */
function resolveContent(input: PromptPresetInput): string {
  if (input.content && input.content.trim()) return input.content;
  return loadStylePreset(input.style_preset_id ?? DEFAULT_STYLE_PRESET_ID).sceneSplitPrompt;
}

export function createPromptPreset(input: PromptPresetInput): number {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error("Channel name cannot be empty");
  const result = createPresetStmt.run(
    trimmedName,
    resolveContent(input),
    normalizeOptional(input.description),
    normalizeOptional(input.style_preset_id) ?? DEFAULT_STYLE_PRESET_ID,
    normalizeOptional(input.video_style),
    normalizeOptional(input.video_model),
    normalizeOptional(input.aspect_ratio),
    normalizeNumber(input.voice_speed),
    normalizeNumber(input.voice_stability),
    normalizeNumber(input.voice_similarity_boost),
    normalizeNumber(input.voice_style),
    normalizeOptional(input.voice_id),
    normalizeOptional(input.voice_provider)
  );
  return Number(result.lastInsertRowid);
}

export function updatePromptPreset(id: number, input: PromptPresetInput): void {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error("Channel name cannot be empty");
  const result = updatePresetStmt.run(
    trimmedName,
    resolveContent(input),
    normalizeOptional(input.description),
    normalizeOptional(input.style_preset_id) ?? DEFAULT_STYLE_PRESET_ID,
    normalizeOptional(input.video_style),
    normalizeOptional(input.video_model),
    normalizeOptional(input.aspect_ratio),
    normalizeNumber(input.voice_speed),
    normalizeNumber(input.voice_stability),
    normalizeNumber(input.voice_similarity_boost),
    normalizeNumber(input.voice_style),
    normalizeOptional(input.voice_id),
    normalizeOptional(input.voice_provider),
    id
  );
  if (result.changes === 0) throw new Error(`Channel profile id=${id} not found`);
}

export function deletePromptPreset(id: number): void {
  deletePresetStmt.run(id);
}
