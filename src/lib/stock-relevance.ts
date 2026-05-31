import path from "node:path";

export interface StockCandidate {
  localPath: string;
  clip?: {
    name?: string;
    driveFileId?: string;
  };
}

export interface StockNarrationScene {
  text: string;
  visual_prompt?: string;
}

export interface StockPickerPlan<T extends StockCandidate> {
  ordered: T[];
  pick: () => string;
  matchedScenes: number;
  averageBestScore: number;
  mode?: "relevance" | "shuffled_deck";
  deckSize?: number;
  seed?: string;
}

const STOP_WORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "amid",
  "among",
  "and",
  "another",
  "around",
  "because",
  "before",
  "behind",
  "between",
  "blackbeard",
  "could",
  "down",
  "during",
  "every",
  "from",
  "into",
  "like",
  "more",
  "over",
  "slow",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "while",
  "with",
  "without",
  "would",
]);

export function createShuffledStockDeckPicker<T extends StockCandidate>(
  candidates: T[],
  seed: string
): StockPickerPlan<T> {
  if (candidates.length === 0) throw new Error("Cannot pick from an empty stock library");

  let pass = 0;
  let lastKey: string | null = null;
  let deck = shuffleDeck(candidates, `${seed}:stock-deck:${pass}`, lastKey);
  let i = 0;
  const firstDeck = [...deck];

  return {
    ordered: firstDeck,
    mode: "shuffled_deck",
    deckSize: candidates.length,
    seed,
    matchedScenes: 0,
    averageBestScore: 0,
    pick: () => {
      if (i >= deck.length) {
        lastKey = deck.length > 0 ? candidateKey(deck[deck.length - 1]) : null;
        pass++;
        deck = shuffleDeck(candidates, `${seed}:stock-deck:${pass}`, lastKey);
        i = 0;
      }
      return deck[i++].localPath;
    },
  };
}

export function createNarrationAwareStockPicker<T extends StockCandidate>(
  candidates: T[],
  scenes: StockNarrationScene[]
): StockPickerPlan<T> {
  if (candidates.length === 0) throw new Error("Cannot pick from an empty stock library");

  const ordered = orderStockForNarration(candidates, scenes);
  let i = 0;
  const stats = scorePlan(ordered, scenes);
  return {
    ordered,
    pick: () => {
      const item = ordered[i % ordered.length];
      i++;
      return item.localPath;
    },
    ...stats,
  };
}

export function orderStockForNarration<T extends StockCandidate>(
  candidates: T[],
  scenes: StockNarrationScene[]
): T[] {
  if (candidates.length <= 1 || scenes.length === 0) return [...candidates];

  const indexed = candidates.map((candidate, index) => ({
    candidate,
    index,
    tokens: tokensForCandidate(candidate),
  }));
  const sceneTokens = scenes.map(tokensForScene);
  const usedInPass = new Set<number>();
  const selected = new Set<number>();
  const chosen: T[] = [];

  for (const tokens of sceneTokens) {
    if (selected.size >= indexed.length) break;
    if (usedInPass.size >= indexed.length) usedInPass.clear();
    const best = indexed
      .filter((row) => !selected.has(row.index) && !usedInPass.has(row.index))
      .map((row) => ({ ...row, score: scoreTokens(tokens, row.tokens) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (!best) continue;
    usedInPass.add(best.index);
    selected.add(best.index);
    chosen.push(best.candidate);
  }

  const remaining = indexed
    .filter((row) => !selected.has(row.index))
    .map((row) => ({
      ...row,
      score: Math.max(0, ...sceneTokens.map((tokens) => scoreTokens(tokens, row.tokens))),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.candidate);

  return [...chosen, ...remaining];
}

function scorePlan<T extends StockCandidate>(ordered: T[], scenes: StockNarrationScene[]) {
  if (ordered.length === 0 || scenes.length === 0) return { matchedScenes: 0, averageBestScore: 0 };
  let matchedScenes = 0;
  let scoreSum = 0;
  for (const scene of scenes) {
    const sceneTokenSet = tokensForScene(scene);
    const best = Math.max(...ordered.map((candidate) => scoreTokens(sceneTokenSet, tokensForCandidate(candidate))));
    if (best > 0) matchedScenes++;
    scoreSum += best;
  }
  return {
    matchedScenes,
    averageBestScore: Number((scoreSum / scenes.length).toFixed(2)),
  };
}

function tokensForScene(scene: StockNarrationScene): Set<string> {
  return tokenize(`${scene.text} ${scene.visual_prompt ?? ""}`);
}

function tokensForCandidate(candidate: StockCandidate): Set<string> {
  return tokenize(`${candidate.clip?.name ?? ""} ${path.basename(candidate.localPath)}`);
}

function tokenize(input: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of input.toLowerCase().split(/[^a-z0-9]+/i)) {
    const token = normalizeToken(raw);
    if (!token || STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function normalizeToken(token: string): string {
  if (token.length <= 2) return "";
  if (/^\d+$/.test(token)) return "";
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function scoreTokens(sceneTokens: Set<string>, candidateTokens: Set<string>): number {
  let score = 0;
  for (const token of candidateTokens) {
    if (sceneTokens.has(token)) score += importantTokenWeight(token);
  }
  return score;
}

function importantTokenWeight(token: string): number {
  if (token.length >= 8) return 2;
  return 1;
}

function shuffleDeck<T extends StockCandidate>(candidates: T[], seed: string, avoidFirstKey: string | null): T[] {
  const out = [...candidates];
  const rand = mulberry32(hashString(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  if (avoidFirstKey && out.length > 1 && candidateKey(out[0]) === avoidFirstKey) {
    const swapIndex = out.findIndex((candidate) => candidateKey(candidate) !== avoidFirstKey);
    if (swapIndex > 0) [out[0], out[swapIndex]] = [out[swapIndex], out[0]];
  }

  return out;
}

function candidateKey(candidate: StockCandidate): string {
  return candidate.clip?.driveFileId || candidate.clip?.name || candidate.localPath;
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
