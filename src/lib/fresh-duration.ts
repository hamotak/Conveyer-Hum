import { WORDS_PER_MINUTE } from "./script-estimate.ts";

export const FRESH_AI_PRESETS_MINUTES = [1, 3, 5, 10] as const;
export type FreshAiPresetMinutes = (typeof FRESH_AI_PRESETS_MINUTES)[number];

export interface FreshDurationOption {
  minutes: FreshAiPresetMinutes;
  supported: boolean;
  requiredWords: number;
  missingWords: number;
  reason: string | null;
}

const WORD = /\S+/g;

export function countScriptWords(script: string): number {
  return (script.trim().match(WORD) ?? []).length;
}

export function estimateScriptSecondsFromText(script: string): number {
  return (countScriptWords(script) / WORDS_PER_MINUTE) * 60;
}

export function normalizeFreshAiPresetMinutes(value: unknown): FreshAiPresetMinutes {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return FRESH_AI_PRESETS_MINUTES.reduce((best, current) => {
    const bestDistance = Math.abs(best - n);
    const currentDistance = Math.abs(current - n);
    return currentDistance < bestDistance ? current : best;
  }, FRESH_AI_PRESETS_MINUTES[0]);
}

export function getFreshDurationOptions(script: string): FreshDurationOption[] {
  const words = countScriptWords(script);
  return FRESH_AI_PRESETS_MINUTES.map((minutes) => {
    const requiredWords = minutes * WORDS_PER_MINUTE;
    const missingWords = Math.max(0, requiredWords - words);
    const supported = words >= requiredWords;
    return {
      minutes,
      supported,
      requiredWords,
      missingWords,
      reason: supported ? null : `Add ${missingWords.toLocaleString()} more words for ${minutes} min Fresh AI.`,
    };
  });
}

export function freshDurationError(script: string, minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Choose a Fresh AI length before running.";
  const words = countScriptWords(script);
  const requiredWords = Math.ceil(minutes * WORDS_PER_MINUTE);
  if (words >= requiredWords) return null;
  const missingWords = requiredWords - words;
  return `Add more script to create a ${minutes} minute Fresh AI opening. You have ${words.toLocaleString()} words; this needs about ${requiredWords.toLocaleString()} words (${missingWords.toLocaleString()} more).`;
}
