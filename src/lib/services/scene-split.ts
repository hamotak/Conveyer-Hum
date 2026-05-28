import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  /** Visual continuity (optional, added 2026-05-28). All three are emitted by
   *  the LLM when the scene-split prompt asks for them; older scenes.json files
   *  lack them and the planner falls back to "fresh shot per scene". */
  continuity_group_id?: string | null;
  continuity_break?: boolean;
  continuity_hint?: string | null;
}

/**
 * Chunk threshold for scene-split.
 *
 * Gemini 2.5 Flash/Pro caps output at 65 535 tokens. A scene-split JSON entry
 * averages ~180 tokens (text + 60–120-word visual_prompt + duration), so a
 * ~3 000-word script → ~300 scenes → ~54 K output — at that point we are
 * uncomfortably close to the hard cap. Past this we split the script at
 * SENTENCE boundaries into chunks of ≤ this many words, scene-split each
 * chunk separately, and concatenate the results. The pipeline downstream
 * (TTS, video, assembly) is unaware that any chunking happened.
 *
 * Why sentence boundaries: the LLM never sees a half-sentence at the seam,
 * so coverage stays clean and no scene is born torn-in-two.
 */
const WORDS_PER_CHUNK = 3000;

/**
 * Splits the script into scenes. Supports Google Gemini (default, cheap) and
 * Anthropic Claude.
 *
 * `overrideSystemPrompt` — when a channel profile chose its own scene_split
 * prompt on the New Run page, that prompt replaces the default for this call.
 *
 * Scripts longer than ~3 000 words (≈ 20–25 min of narration) are
 * automatically chunked at sentence boundaries; no manual intervention needed.
 */
export async function splitScript(
  runId: string,
  script: string,
  overrideSystemPrompt?: string
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");

  const totalWords = script.trim().split(/\s+/).filter(Boolean).length;
  log(runId, "info", `Splitting script (${provider}) — ${totalWords} words`, {
    stage: "scene_split",
    data: { scriptChars: script.length, totalWords },
  });

  let rawScenes: Scene[];

  if (totalWords <= WORDS_PER_CHUNK) {
    // Small enough for one pass.
    rawScenes = await processChunk(provider, systemPrompt, script, 0, runId);
  } else {
    // Long script — split at sentence boundaries and scene-split each chunk.
    const chunks = chunkScript(script, WORDS_PER_CHUNK);
    log(
      runId,
      "info",
      `Script is too long for one ${provider} call (over ${WORDS_PER_CHUNK} words) — ` +
        `splitting into ${chunks.length} chunks for scene_split`,
      { stage: "scene_split", data: { chunkCount: chunks.length, totalWords } }
    );

    rawScenes = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkWords = chunks[i].trim().split(/\s+/).filter(Boolean).length;
      log(
        runId,
        "info",
        `Scene-splitting chunk ${i + 1}/${chunks.length} (${chunkWords} words)`,
        { stage: "scene_split" }
      );
      const chunkScenes = await processChunk(
        provider,
        systemPrompt,
        chunks[i],
        rawScenes.length,
        runId
      );
      rawScenes.push(...chunkScenes);
    }
  }

  // Apply the Grok 6-second guard AFTER all chunks are combined — enforce
  // and re-index in one pass over the full scene list.
  const scenes = enforceMaxSceneLength(rawScenes);

  // Coverage check: words in scene.text vs original script. <70% means the
  // model summarized; we warn but still return what we got.
  const sceneWords = scenes.reduce(
    (sum, s) => sum + s.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const coverage = totalWords > 0 ? (sceneWords / totalWords) * 100 : 0;

  log(
    runId,
    "success",
    `Done: ${scenes.length} scenes · script coverage ${coverage.toFixed(0)}% (${sceneWords}/${totalWords} words)`,
    {
      stage: "scene_split",
      // Show only the first 5 scene snippets so data_json doesn't bloat on
      // long videos with 500+ scenes.
      data: { scenes: scenes.slice(0, 5).map((s) => ({ i: s.index, text: s.text.slice(0, 60) })) },
    }
  );

  if (coverage < 70) {
    log(
      runId,
      "warn",
      `⚠️ Low coverage (${coverage.toFixed(0)}%) — the model likely summarized the script. Review the scene_split prompt on /prompts.`,
      { stage: "scene_split" }
    );
  }

  return scenes;
}

/**
 * Same logic as splitScript but with no DB logging and no artifact files.
 * Used by /api/preview/scenes — the user wants to *see* the scenes before
 * deciding to start a run, so we shouldn't create run_logs rows or temp dirs.
 *
 * Also chunks long scripts the same way — a preview of a 2-hour script
 * must show its full scene list, not bail at the Gemini cap.
 */
export async function splitScriptPreview(
  script: string,
  overrideSystemPrompt?: string
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");
  const totalWords = script.trim().split(/\s+/).filter(Boolean).length;

  let rawScenes: Scene[];

  if (totalWords <= WORDS_PER_CHUNK) {
    rawScenes = await processChunk(provider, systemPrompt, script, 0, null);
  } else {
    const chunks = chunkScript(script, WORDS_PER_CHUNK);
    rawScenes = [];
    for (const chunk of chunks) {
      const chunkScenes = await processChunk(provider, systemPrompt, chunk, rawScenes.length, null);
      rawScenes.push(...chunkScenes);
    }
  }

  return enforceMaxSceneLength(rawScenes);
}

/**
 * Sends one chunk of script to the configured LLM, parses the response, and
 * returns its scenes — re-indexed starting at `sceneIndexOffset` so they line
 * up inside the full-script scene array.
 *
 * `runId === null` skips the on-disk raw-output dump (used by preview).
 */
async function processChunk(
  provider: string,
  systemPrompt: string,
  scriptChunk: string,
  sceneIndexOffset: number,
  runId: string | null
): Promise<Scene[]> {
  let raw: string;
  if (provider === "google") {
    raw = await splitWithGemini(systemPrompt, scriptChunk);
  } else if (provider === "anthropic") {
    raw = await splitWithClaude(systemPrompt, scriptChunk);
  } else {
    throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
  }

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    // Save raw output so we can see what went wrong — one file per chunk so
    // chunks don't overwrite each other's dumps.
    if (runId) {
      try {
        const runDir = getRunDir(runId);
        fs.mkdirSync(runDir, { recursive: true });
        const filename = `scene_split_raw_${sceneIndexOffset}.txt`;
        fs.writeFileSync(path.join(runDir, filename), raw, "utf-8");
        log(runId, "error", `Raw output saved to ${runDir}/${filename} (${raw.length} chars)`, {
          stage: "scene_split",
        });
      } catch {}
    }
    throw e;
  }
  if (!Array.isArray(json)) {
    if (runId) {
      log(runId, "error", "LLM did not return an array", {
        stage: "scene_split",
        data: { raw: raw.slice(0, 500) },
      });
    }
    throw new Error("scene_split: model did not return a JSON array");
  }

  return json.map((s, i) => {
    const groupId = typeof s.continuity_group_id === "string" && s.continuity_group_id.trim() ? s.continuity_group_id.trim() : null;
    const hint = typeof s.continuity_hint === "string" && s.continuity_hint.trim() ? s.continuity_hint.trim() : null;
    return {
      index: sceneIndexOffset + i,
      text: String(s.text ?? ""),
      visual_prompt: String(s.visual_prompt ?? ""),
      duration_hint_sec: Number(s.duration_hint_sec ?? 6),
      continuity_group_id: groupId,
      continuity_break: s.continuity_break === true,
      continuity_hint: hint,
    } as Scene;
  });
}

/**
 * Splits a script into chunks at sentence boundaries, targeting `targetWords`
 * per chunk. A "sentence" is anything up to a `.`, `!` or `?`.
 *
 * If the script has no sentence terminators we return it whole — bad chunking
 * is worse than no chunking, and the only way to get here is a script written
 * without punctuation, which won't scene-split well anyway.
 */
function chunkScript(script: string, targetWords: number): string[] {
  const sentenceRegex = /[^.!?]+[.!?]+["')\]]*\s*/g;
  const matches = script.match(sentenceRegex);
  if (!matches || matches.length === 0) return [script];

  // If the regex didn't consume the trailing characters (e.g. a final
  // sentence without a terminator), append the leftover so we cover 100%
  // of the script.
  const sentences: string[] = [...matches];
  const captured = matches.join("");
  if (captured.length < script.length) {
    sentences.push(script.slice(captured.length));
  }

  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;
  for (const sent of sentences) {
    const sentWords = sent.trim().split(/\s+/).filter(Boolean).length;
    if (currentWords > 0 && currentWords + sentWords > targetWords) {
      chunks.push(current.trim());
      current = "";
      currentWords = 0;
    }
    current += sent;
    currentWords += sentWords;
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

/**
 * Scene-length normalization (pacing rewrite — Prompt 6).
 *
 * Target is 6–8s scenes cut by idea. The LLM does most of this, but we enforce
 * the hard bounds in code so output is predictable no matter what the model did.
 * Splitting/merging only ever moves whole words, so the joined text stays
 * byte-identical and script coverage remains 100%.
 *
 *  - Over-long scenes (> MAX_SCENE_WORDS, ~8s) are split into the fewest pieces
 *    that all fit, preferring a clause boundary (em-dash, semicolon, colon,
 *    comma) near each cut and falling back to an even word split.
 *  - Under-length scenes (< MIN_SCENE_WORDS, ~4s) are merged with a neighbor —
 *    forward (into the next scene) first, then backward — so a stray fragment
 *    is never its own scene. A merge is skipped only if it would exceed the max.
 *
 * Word↔second mapping assumes the calm narration pace (~150 raw wpm × 0.85).
 */
// Pacing bounds (Prompt 9 — faster chunking + hook acceleration).
// Body: 4–6s scenes (~10–14 words); the first ~150 words (the hook) go faster
// at 3–5s (~8–12 words). Bounds are chosen by each scene's cumulative position.
const MAX_WORDS = 15; // ~6s body hard max
const MIN_WORDS = 8; // ~3.2s body minimum
const HOOK_MAX_WORDS = 12; // ~4.8s hook max
const HOOK_MIN_WORDS = 6; // ~2.4s hook minimum
const HOOK_WORD_WINDOW = 150; // first ~150 words use the hook bounds
const CLAUSE_END = /[—;:,]$/; // a word that ends a clause

const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const hintSec = (words: number) => Math.min(8, Math.max(3, Math.round((words / 150) * 60)));
const boundsAt = (cumWords: number) =>
  cumWords < HOOK_WORD_WINDOW
    ? { max: HOOK_MAX_WORDS, min: HOOK_MIN_WORDS }
    : { max: MAX_WORDS, min: MIN_WORDS };

/** Split one over-long scene into ≤maxWords pieces, preferring clause cuts. */
function splitLongScene(s: Scene, maxWords: number): Scene[] {
  const words = s.text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [s];

  const pieceCount = Math.ceil(words.length / maxWords);
  const targetLen = Math.ceil(words.length / pieceCount);
  const pieces: string[][] = [];
  let start = 0;

  for (let p = 0; p < pieceCount - 1; p++) {
    const ideal = start + targetLen;
    let cut = ideal;
    // Look for a clause boundary within ±4 words of the ideal cut; nearest wins.
    let best = -1;
    const lo = Math.max(start + 1, ideal - 4);
    const hi = Math.min(words.length - 1, ideal + 4);
    for (let i = lo; i <= hi; i++) {
      if (CLAUSE_END.test(words[i - 1]) && (best === -1 || Math.abs(i - ideal) < Math.abs(best - ideal))) {
        best = i;
      }
    }
    if (best !== -1) cut = best;
    // Leave at least one word for each remaining piece.
    cut = Math.max(start + 1, Math.min(cut, words.length - (pieceCount - 1 - p)));
    pieces.push(words.slice(start, cut));
    start = cut;
  }
  pieces.push(words.slice(start));

  // The pieces describe the SAME beat as the parent — only the first piece may
  // legitimately break continuity (inheriting the parent's flag); subsequent
  // pieces explicitly do NOT break (they're a forced sub-split of one shot).
  return pieces.map((w, i) => ({
    index: 0,
    text: w.join(" "),
    visual_prompt: s.visual_prompt,
    duration_hint_sec: hintSec(w.length),
    continuity_group_id: s.continuity_group_id ?? null,
    continuity_break: i === 0 ? !!s.continuity_break : false,
    continuity_hint: s.continuity_hint ?? null,
  }));
}

function enforceMaxSceneLength(scenes: Scene[]): Scene[] {
  // Pass 1 — split over-long scenes. Bounds depend on cumulative word position
  // (the hook window gets a tighter max for snappier pacing).
  const split: Scene[] = [];
  let cumSplit = 0;
  for (const s of scenes) {
    const { max } = boundsAt(cumSplit);
    split.push(...splitLongScene(s, max));
    cumSplit += wordCount(s.text);
  }

  // Pass 2 — merge under-length scenes (forward first, then backward).
  const merged: Scene[] = [];
  let i = 0;
  let cumMerge = 0;
  while (i < split.length) {
    const { min, max } = boundsAt(cumMerge);
    let cur: Scene = { ...split[i] };
    let curWords = wordCount(cur.text);

    // Merge forward while still too short and the next scene fits.
    while (curWords < min && i + 1 < split.length) {
      const nextWords = wordCount(split[i + 1].text);
      if (curWords + nextWords > max) break;
      cur = { ...cur, text: `${cur.text} ${split[i + 1].text}`.trim() };
      curWords += nextWords;
      i++;
    }

    // Still short and nothing to merge forward → fold backward into previous.
    if (curWords < min && merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevWords = wordCount(prev.text);
      if (prevWords + curWords <= max) {
        prev.text = `${prev.text} ${cur.text}`.trim();
        prev.duration_hint_sec = hintSec(prevWords + curWords);
        cumMerge += curWords;
        i++;
        continue;
      }
    }

    cur.duration_hint_sec = hintSec(curWords);
    merged.push(cur);
    cumMerge += curWords;
    i++;
  }

  return merged.map((s, i) => ({ ...s, index: i }));
}

async function splitWithGemini(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Script:\n\n${script}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
      // 65535 — Gemini 2.5 Flash/Pro hard max for output. Per-chunk we target
      // ~3 000 words of input → ~54 K of output, leaving an 11 K-token buffer
      // before the hard cap. Anything that still overflows surfaces below
      // with a clear "lower WORDS_PER_CHUNK" message.
      maxOutputTokens: 65535,
      // Disable thinking — for structured output it just wastes the token budget
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Retry with exponential backoff for transient errors
  // (503 UNAVAILABLE / 429 RATE_LIMIT / 500 — common Google API blips)
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = 4;
  let attempt = 0;
  let lastErr = "";

  while (attempt <= MAX_RETRIES) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
          finishReason?: string;
        }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const reason = cand?.finishReason;
      if (reason && reason !== "STOP") {
        throw new Error(
          `Gemini finish=${reason} (output cut off, tokens=${json.usageMetadata?.candidatesTokenCount}). ` +
            `Even a single ~3 000-word chunk produced more than Gemini's 65 535-token output cap — ` +
            `lower WORDS_PER_CHUNK in scene-split.ts, or shorten this chunk's visual_prompt instructions.`
        );
      }
      if (!text) throw new Error(`Gemini: empty output (${JSON.stringify(json).slice(0, 300)})`);
      return text;
    }
    const errText = (await resp.text()).slice(0, 400);
    lastErr = `Gemini ${resp.status}: ${errText}`;
    if (!RETRYABLE.has(resp.status) || attempt === MAX_RETRIES) {
      throw new Error(lastErr);
    }
    // 1s, 2s, 4s, 8s
    const waitMs = 1000 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
  throw new Error(lastErr);
}

async function splitWithClaude(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Script:\n\n${script}` }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Extracts the first JSON array from a text response, even if the model added markdown. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error("Could not parse JSON from model response");
  }
}
