import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";
import { WORDS_PER_MINUTE } from "../script-estimate";
import { chunkTextByNarrationUnits, splitIntoNarrationUnits } from "../text-chunking";
import {
  GENERATED_SCENE_MAX_SECONDS,
  estimateGeneratedSceneSeconds,
  normalizeNarrationScenes,
  validateFreshOpeningScenes,
} from "../scene-chunking";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  source_kind?: "fresh" | "stock";
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
const STOCK_TAIL_TARGET_WORDS = Math.round((16 / 60) * WORDS_PER_MINUTE);
const STOCK_TAIL_MAX_WORDS = Math.round((22 / 60) * WORDS_PER_MINUTE);

export interface HybridScriptPlan {
  scenes: Scene[];
  freshSceneCount: number;
  freshText: string;
  tailText: string;
}

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
    const chunks = chunkTextByNarrationUnits(script, { targetWords: WORDS_PER_CHUNK });
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

  // Apply narration-safe normalization AFTER all chunks are combined. The LLM
  // may still return tiny shot fragments; this rebuilds the scene text from the
  // original order into sentence-first narration beats.
  const scenes = normalizeNarrationScenes(rawScenes);

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
    const chunks = chunkTextByNarrationUnits(script, { targetWords: WORDS_PER_CHUNK });
    rawScenes = [];
    for (const chunk of chunks) {
      const chunkScenes = await processChunk(provider, systemPrompt, chunk, rawScenes.length, null);
      rawScenes.push(...chunkScenes);
    }
  }

  return normalizeNarrationScenes(rawScenes);
}

export async function splitHybridScript(
  runId: string,
  script: string,
  freshSeconds: number,
  overrideSystemPrompt?: string
): Promise<HybridScriptPlan> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");
  const { freshText, tailText } = splitScriptAtNarrationDuration(script, freshSeconds);

  log(runId, "info", `Planning hybrid script: ${freshSeconds > 0 ? `${Math.round(freshSeconds)}s Fresh AI opening` : "stock-only"} + stock tail`, {
    stage: "scene_split",
    data: {
      freshWords: wordCount(freshText),
      tailWords: wordCount(tailText),
      aiPlannerScope: "fresh_opening_only",
    },
  });

  const freshScenes = freshText
    ? await splitFreshOpening(provider, systemPrompt, freshText, runId)
    : [];
  const tailScenes = buildStockTailScenes(tailText, freshScenes.length);
  const scenes = [...freshScenes, ...tailScenes];

  log(
    runId,
    "success",
    `Hybrid script plan ready: ${freshScenes.length} Fresh AI chunk${freshScenes.length === 1 ? "" : "s"} + stock tail${tailScenes.length ? ` (${tailScenes.length} internal beats)` : ""}`,
    {
      stage: "scene_split",
      data: {
        freshSceneCount: freshScenes.length,
        stockBeatCount: tailScenes.length,
        scenes: freshScenes.slice(0, 5).map((s) => ({ i: s.index, text: s.text.slice(0, 80) })),
      },
    }
  );

  return {
    scenes,
    freshSceneCount: freshScenes.length,
    freshText,
    tailText,
  };
}

async function splitFreshOpening(
  provider: string,
  stylePrompt: string,
  freshText: string,
  runId: string
): Promise<Scene[]> {
  let rawScenes = await processFreshOpeningChunk(provider, stylePrompt, freshText, runId);
  let scenes = finalizeFreshScenes(rawScenes);
  let validation = validateFreshOpeningScenes(scenes, freshText);

  if (!validation.ok) {
    log(runId, "warn", `Fresh AI chunk planner needs repair: ${validation.errors.slice(0, 3).join(" ")}`, {
      stage: "scene_split",
      data: { errors: validation.errors },
    });
    rawScenes = await processFreshOpeningChunk(provider, stylePrompt, freshText, runId, validation.errors);
    scenes = finalizeFreshScenes(rawScenes);
    validation = validateFreshOpeningScenes(scenes, freshText);
  }

  if (!validation.ok) {
    log(runId, "warn", `Fresh AI chunk planner failed validation after repair; using deterministic fallback. ${validation.errors.slice(0, 3).join(" ")}`, {
      stage: "scene_split",
      data: { errors: validation.errors },
    });
    return fallbackFreshOpeningScenes(freshText);
  }

  return scenes;
}

async function processFreshOpeningChunk(
  provider: string,
  stylePrompt: string,
  freshText: string,
  runId: string,
  repairErrors?: string[]
): Promise<Scene[]> {
  const prompt = buildFreshOpeningPrompt(stylePrompt, repairErrors);
  const raw =
    provider === "google"
      ? await splitWithGemini(prompt, freshText, { thinkingBudget: 512 })
      : provider === "anthropic"
        ? await splitWithClaude(prompt, freshText)
        : (() => {
            throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
          })();

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    try {
      const runDir = getRunDir(runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, `fresh_chunk_plan_raw_${Date.now()}.txt`), raw, "utf-8");
    } catch {}
    throw e;
  }
  if (!Array.isArray(json)) throw new Error("fresh chunk planner: model did not return a JSON array");

  return (json as Record<string, unknown>[]).map((s, i) => ({
    index: i,
    text: String(s.text ?? ""),
    visual_prompt: String(s.visual_prompt ?? ""),
    duration_hint_sec: Number(s.duration_hint_sec ?? 6),
    source_kind: "fresh",
    continuity_group_id: typeof s.continuity_group_id === "string" ? s.continuity_group_id : null,
    continuity_break: i === 0 || s.continuity_break === true,
    continuity_hint: typeof s.continuity_hint === "string" ? s.continuity_hint : null,
  }));
}

function buildFreshOpeningPrompt(stylePrompt: string, repairErrors?: string[]): string {
  return [
    "You are planning the Fresh AI opening for an AI-video generator.",
    "Return ONLY a JSON array. Each item must include: text, visual_prompt, duration_hint_sec.",
    `Each chunk must be a natural narration beat estimated at ${GENERATED_SCENE_MAX_SECONDS} seconds or less. Target 5-7 seconds.`,
    "Preserve the script text exactly and in order. Do not summarize, paraphrase, duplicate, omit, or reorder words.",
    "Prefer sentence and clause boundaries. Never end a chunk on a connector or dangling word such as with, their, across, from, and, the, to, or of.",
    "Never start a chunk with a connector or orphaned phrase such as across the water.",
    "If a sentence is too long, split at a meaningful clause boundary so both sides sound natural when narrated.",
    "Write visual_prompt as one cinematic shot for that exact narration beat. No text, captions, logos, watermarks, or UI overlays.",
    repairErrors?.length
      ? `Repair these validation issues from the previous attempt: ${repairErrors.join(" ")}`
      : "",
    "Style guidance for visual prompts:",
    stylePrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function finalizeFreshScenes(rawScenes: Scene[]): Scene[] {
  return rawScenes
    .filter((s) => s.text.trim())
    .map((s, i) => ({
      ...s,
      index: i,
      text: s.text.trim().replace(/\s+/g, " "),
      visual_prompt: s.visual_prompt.trim(),
      duration_hint_sec: estimateGeneratedSceneSeconds(wordCount(s.text)),
      source_kind: "fresh",
      continuity_break: i === 0 ? true : !!s.continuity_break,
      continuity_group_id: s.continuity_group_id ?? null,
      continuity_hint: s.continuity_hint ?? null,
    }));
}

function fallbackFreshOpeningScenes(freshText: string): Scene[] {
  return normalizeNarrationScenes([
    {
      index: 0,
      text: freshText,
      visual_prompt: "Cinematic documentary-style opening shot for the Fresh AI narration.",
      duration_hint_sec: GENERATED_SCENE_MAX_SECONDS,
      source_kind: "fresh",
      continuity_break: true,
    },
  ]).map((s, i) => ({
    ...s,
    index: i,
    source_kind: "fresh",
    duration_hint_sec: estimateGeneratedSceneSeconds(wordCount(s.text)),
  }));
}

function buildStockTailScenes(tailText: string, startIndex: number): Scene[] {
  if (!tailText.trim()) return [];
  return chunkTextByNarrationUnits(tailText, {
    targetWords: STOCK_TAIL_TARGET_WORDS,
    maxWords: STOCK_TAIL_MAX_WORDS,
  }).map((text, i) => ({
    index: startIndex + i,
    text,
    visual_prompt: `Use channel stock B-roll that supports this narration beat: "${text.slice(0, 220)}"`,
    duration_hint_sec: estimateStockTailSeconds(wordCount(text)),
    source_kind: "stock",
    continuity_break: i === 0,
    continuity_group_id: null,
    continuity_hint: null,
  }));
}

function splitScriptAtNarrationDuration(script: string, freshSeconds: number): { freshText: string; tailText: string } {
  const clean = compact(script);
  if (!clean) return { freshText: "", tailText: "" };
  if (!Number.isFinite(freshSeconds) || freshSeconds <= 0) return { freshText: "", tailText: clean };

  const targetWords = Math.max(1, Math.round((freshSeconds / 60) * WORDS_PER_MINUTE));
  const totalWords = wordCount(clean);
  if (totalWords <= targetWords) return { freshText: clean, tailText: "" };

  const units = splitIntoNarrationUnits(clean);
  const freshParts: string[] = [];
  const tailParts: string[] = [];
  let acc = 0;
  let cut = false;

  for (const unit of units.length ? units : [clean]) {
    if (cut) {
      tailParts.push(unit);
      continue;
    }

    const unitWords = wordCount(unit);
    if (acc + unitWords <= targetWords) {
      freshParts.push(unit);
      acc += unitWords;
      continue;
    }

    const remaining = targetWords - acc;
    const [head, tail] = splitTextByWordsAtNaturalCut(unit, remaining);
    if (head) freshParts.push(head);
    if (tail) tailParts.push(tail);
    cut = true;
  }

  return { freshText: compact(freshParts.join(" ")), tailText: compact(tailParts.join(" ")) };
}

function splitTextByWordsAtNaturalCut(text: string, targetWords: number): [string, string] {
  const words = text.match(/\S+/g) ?? [];
  if (words.length === 0) return ["", ""];
  if (targetWords <= 0) return ["", text.trim()];
  if (words.length <= targetWords) return [text.trim(), ""];
  const cut = findNaturalWordCut(words, targetWords);
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

function findNaturalWordCut(words: string[], targetWords: number): number {
  const target = Math.max(1, Math.min(words.length - 1, targetWords));
  const min = Math.max(1, Math.floor(target * 0.65));
  const max = Math.min(words.length - 1, Math.ceil(target * 1.2));

  for (let i = target; i >= min; i--) {
    if (/[.!?;:,\u2014-]$/.test(words[i - 1] ?? "")) return i;
  }
  for (let i = target; i <= max; i++) {
    if (/[.!?;:,\u2014-]$/.test(words[i - 1] ?? "")) return i;
  }
  for (let i = target; i >= min; i--) {
    const next = (words[i] ?? "").toLowerCase().replace(/[^a-z]+/gi, "");
    if (new Set(["and", "but", "while", "because", "as", "with"]).has(next)) return i;
  }
  return target;
}

function estimateStockTailSeconds(words: number): number {
  return Math.max(4, Math.ceil(words / (WORDS_PER_MINUTE / 60)));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function compact(text: string): string {
  return text.trim().replace(/\s+/g, " ");
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

async function splitWithGemini(
  systemPrompt: string,
  script: string,
  opts?: { thinkingBudget?: number }
): Promise<string> {
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
      thinkingConfig: { thinkingBudget: opts?.thinkingBudget ?? 0 },
    },
  });

  // Retry with exponential backoff for transient errors
  // (503 UNAVAILABLE / 429 RATE_LIMIT / 500 — common Google API blips)
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = 4;
  let attempt = 0;
  let lastErr = "";

  while (attempt <= MAX_RETRIES) {
    try {
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
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Gemini finish=")) throw e;
      if (e instanceof Error && e.message.startsWith("Gemini: empty")) throw e;
      if (e instanceof Error && e.message.match(/^Gemini [45]\d{2}:/)) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Gemini request failed after ${MAX_RETRIES + 1} attempts (${lastErr}). Check your network and GOOGLE_API_KEY, then start a new run.`
        );
      }
    }
    // 1s, 2s, 4s, 8s — transient network blips + 429/503
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
