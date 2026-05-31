import { chunkTextByNarrationUnits } from "./text-chunking.ts";

export interface SceneChunkInput {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  continuity_group_id?: string | null;
  continuity_break?: boolean;
  continuity_hint?: string | null;
}

export const GENERATED_SCENE_MAX_SECONDS = 8;
export const GENERATED_SCENE_TARGET_SECONDS = 7;
export const GENERATED_SCENE_WORDS_PER_SECOND = 2.5; // 150 wpm narration pace
const WORDS_PER_SECOND = GENERATED_SCENE_WORDS_PER_SECOND;
const NARRATION_TARGET_WORDS = Math.floor(GENERATED_SCENE_TARGET_SECONDS * WORDS_PER_SECOND);
const MIN_NARRATION_WORDS = 7;
const MAX_NARRATION_WORDS = Math.floor(GENERATED_SCENE_MAX_SECONDS * WORDS_PER_SECOND);
const MAX_TINY_MERGE_WORDS = MAX_NARRATION_WORDS;
const DANGLING_END_WORDS = new Set([
  "a",
  "an",
  "after",
  "although",
  "and",
  "as",
  "at",
  "before",
  "because",
  "but",
  "by",
  "during",
  "even",
  "for",
  "from",
  "against",
  "across",
  "if",
  "in",
  "into",
  "of",
  "on",
  "or",
  "since",
  "so",
  "that",
  "the",
  "their",
  "though",
  "to",
  "unless",
  "until",
  "when",
  "where",
  "while",
  "who",
  "whose",
  "which",
  "with",
  "without",
]);
const AWKWARD_START_WORDS = new Set(
  [...DANGLING_END_WORDS].filter((word) => !["a", "an", "the", "their"].includes(word))
);

export interface FreshChunkValidation {
  ok: boolean;
  errors: string[];
}

export function normalizeNarrationScenes<T extends SceneChunkInput>(rawScenes: T[]): T[] {
  const source = rawScenes.filter((s) => s.text.trim().length > 0);
  if (source.length === 0) return [];

  if (looksLikeSafeGeneratedPlan(source)) {
    return source.map((s, i) => ({
      ...s,
      index: i,
      duration_hint_sec: estimateGeneratedSceneSeconds(wordCount(s.text)),
      visual_prompt: visualPromptForChunk(s.text, s.visual_prompt),
      continuity_break: i === 0 ? true : !!s.continuity_break,
      continuity_group_id: s.continuity_group_id ?? null,
      continuity_hint: s.continuity_hint ?? null,
    }) as T);
  }

  const fullText = repairFalseSentenceBreaks(
    source.map((s) => s.text.trim()).join(" ").replace(/\s+/g, " ").trim()
  );
  const chunks = balanceShortNarrationChunks(
    chunkTextByNarrationUnits(fullText, {
      targetWords: NARRATION_TARGET_WORDS,
      maxWords: MAX_NARRATION_WORDS,
    })
  ).map(repairFalseSentenceBreaks);

  const out: T[] = [];
  let sourceIndex = 0;
  let wordsConsumedInSource = 0;

  for (const chunk of chunks) {
    const words = wordCount(chunk);
    const startSource = source[sourceIndex] ?? source[source.length - 1];
    const covered = collectCoveredSources(source, sourceIndex, wordsConsumedInSource, words);
    const promptSource = covered.find((s) => s.visual_prompt?.trim()) ?? startSource;

    out.push({
      ...startSource,
      index: out.length,
      text: chunk,
      visual_prompt: visualPromptForChunk(chunk, promptSource.visual_prompt),
      duration_hint_sec: estimateNarrationSeconds(words),
      continuity_group_id: startSource.continuity_group_id ?? null,
      continuity_break: out.length === 0 ? true : !!startSource.continuity_break,
      continuity_hint: startSource.continuity_hint ?? null,
    } as T);

    let remaining = words;
    while (remaining > 0 && sourceIndex < source.length) {
      const sourceWords = wordCount(source[sourceIndex].text);
      const available = sourceWords - wordsConsumedInSource;
      if (remaining < available) {
        wordsConsumedInSource += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        sourceIndex++;
        wordsConsumedInSource = 0;
      }
    }
  }

  return out;
}

function balanceShortNarrationChunks(chunks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const current = chunks[i].trim();
    const words = wordCount(current);
    const interrupted = looksInterrupted(current);

    if ((words < MIN_NARRATION_WORDS || interrupted) && i + 1 < chunks.length) {
      const next = chunks[i + 1].trim();
      if (wordCount(`${current} ${next}`) <= MAX_TINY_MERGE_WORDS && !wouldExceedGeneratedLimit(current, next)) {
        out.push(joinNarrationParts(current, next));
        i++;
        continue;
      }
    }

    if ((words < MIN_NARRATION_WORDS || interrupted) && out.length > 0) {
      const prev = out[out.length - 1];
      if (wordCount(`${prev} ${current}`) <= MAX_TINY_MERGE_WORDS && !wouldExceedGeneratedLimit(prev, current)) {
        out[out.length - 1] = joinNarrationParts(prev, current);
        continue;
      }
    }

    out.push(current);
  }
  return out;
}

function joinNarrationParts(left: string, right: string): string {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();
  if (!cleanLeft) return cleanRight;
  if (!cleanRight) return cleanLeft;
  if (!looksInterrupted(cleanLeft)) return `${cleanLeft} ${cleanRight}`.trim();
  return `${cleanLeft.replace(/[.!?,;:—-]+$/g, "").trim()} ${cleanRight}`.trim();
}

function repairFalseSentenceBreaks(text: string): string {
  return text.replace(
    /\b(a|an|after|although|and|as|at|before|because|but|by|during|even|for|from|if|in|into|of|on|or|since|so|that|the|though|to|unless|until|when|where|while|who|whose|which|with|without)[.!?]\s+([a-z])/gi,
    "$1 $2"
  );
}

function looksInterrupted(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const lastWord = clean
    .split(/\s+/)
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z]+$/i, "");
  if (lastWord && DANGLING_END_WORDS.has(lastWord)) return true;
  return /[,;:—-]$/.test(clean);
}

function startsAwkwardly(text: string): boolean {
  const firstWord = text
    .trim()
    .split(/\s+/)
    .at(0)
    ?.toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/gi, "");
  return !!firstWord && AWKWARD_START_WORDS.has(firstWord);
}

function wouldExceedGeneratedLimit(left: string, right: string): boolean {
  return estimateGeneratedSceneSeconds(wordCount(`${left} ${right}`)) > GENERATED_SCENE_MAX_SECONDS;
}

function collectCoveredSources<T extends SceneChunkInput>(
  scenes: T[],
  startIndex: number,
  startOffsetWords: number,
  takeWords: number
): T[] {
  const covered: T[] = [];
  let i = startIndex;
  let offset = startOffsetWords;
  let remaining = takeWords;
  while (remaining > 0 && i < scenes.length) {
    covered.push(scenes[i]);
    const available = wordCount(scenes[i].text) - offset;
    remaining -= Math.max(0, available);
    i++;
    offset = 0;
  }
  return covered;
}

function visualPromptForChunk(text: string, sourcePrompt: string): string {
  const cleanText = text.replace(/\s+/g, " ").trim();
  const cleanPrompt = sourcePrompt.replace(/\s+/g, " ").trim();
  return [
    cleanPrompt,
    `One polished documentary shot should cover the whole narration beat: "${cleanText}".`,
    "Keep the frame clean: no text, no captions, no logos, no watermarks, no UI overlays.",
  ]
    .filter(Boolean)
    .join(" ");
}

function estimateNarrationSeconds(words: number): number {
  return estimateGeneratedSceneSeconds(words);
}

export function estimateGeneratedSceneSeconds(words: number): number {
  return Math.min(GENERATED_SCENE_MAX_SECONDS, Math.max(3, Math.ceil(words / WORDS_PER_SECOND)));
}

export function validateFreshOpeningScenes(
  scenes: { text?: unknown; duration_hint_sec?: unknown }[],
  sourceText: string
): FreshChunkValidation {
  const errors: string[] = [];
  const texts = scenes.map((s) => String(s.text ?? "").trim()).filter(Boolean);
  const expected = compact(sourceText);
  const actual = compact(texts.join(" "));

  if (!expected) errors.push("Fresh opening text is empty.");
  if (texts.length === 0) errors.push("No Fresh AI chunks were returned.");
  if (expected && actual !== expected) errors.push("Chunk text must preserve the Fresh AI opening exactly, in order.");

  texts.forEach((text, i) => {
    const words = wordCount(text);
    const estimate = estimateGeneratedSceneSeconds(words);
    const modelHint = Number(scenes[i]?.duration_hint_sec);
    if (words > MAX_NARRATION_WORDS || estimate > GENERATED_SCENE_MAX_SECONDS || (Number.isFinite(modelHint) && modelHint > GENERATED_SCENE_MAX_SECONDS)) {
      errors.push(`Chunk ${i + 1} is longer than ${GENERATED_SCENE_MAX_SECONDS}s.`);
    }
    if (looksInterrupted(text)) errors.push(`Chunk ${i + 1} ends mid-thought.`);
    if (i > 0 && startsAwkwardly(text)) errors.push(`Chunk ${i + 1} starts mid-thought.`);
    if (texts.length > 1 && words < 4) errors.push(`Chunk ${i + 1} is too short to stand alone.`);
    if (i < texts.length - 1 && words < MIN_NARRATION_WORDS) errors.push(`Chunk ${i + 1} is too short to stand alone.`);
  });

  return { ok: errors.length === 0, errors };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function compact(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function looksLikeSafeGeneratedPlan(scenes: SceneChunkInput[]): boolean {
  if (scenes.length === 0) return false;
  return scenes.every((s, i) => {
    const text = s.text.trim();
    if (!text) return false;
    if (scenes.length > 1 && wordCount(text) < 4) return false;
    if (wordCount(text) > MAX_NARRATION_WORDS) return false;
    if (looksInterrupted(text)) return false;
    if (i > 0 && startsAwkwardly(text)) return false;
    return true;
  });
}
