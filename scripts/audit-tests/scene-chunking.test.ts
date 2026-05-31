/**
 * Proof for narration-safe scene normalization.
 *
 *   node scripts/audit-tests/scene-chunking.test.ts
 *
 * The LLM sometimes returns tiny 6-12 word visual fragments. Production must
 * rebuild those into complete narration beats so the voiceover does not feel
 * chopped mid-sentence.
 */
import {
  GENERATED_SCENE_MAX_SECONDS,
  estimateGeneratedSceneSeconds,
  normalizeNarrationScenes,
  validateFreshOpeningScenes,
  type SceneChunkInput,
} from "../../src/lib/scene-chunking.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const compact = (s: string) => s.trim().replace(/\s+/g, " ");
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const danglingEnd = /\b(?:a|an|after|although|and|as|at|before|because|but|by|during|even|for|from|against|across|if|in|into|of|on|or|since|so|that|the|their|though|to|unless|until|when|where|while|who|whose|which|with|without)[,;:—-]?$/i;

function scene(text: string, index: number): SceneChunkInput {
  return {
    index,
    text,
    visual_prompt: `cinematic shot ${index}`,
    duration_hint_sec: 5,
    continuity_break: index === 0,
  };
}

console.log("Test 1 - broken micro-scenes become sentence-first narration beats:");
{
  const raw = [
    "Before the smoke and the pistols and",
    "the name that made harbor masters sweat,",
    "there was just a man. A young one, probably from Bristol, England,",
    "though even that is foggy.",
    "He went to sea when empires were fighting",
    "over sugar, silver, tobacco, and maps.",
    "And somewhere in those wars,",
    "Edward Teach learned the most useful lesson a sailor could learn:",
    "fear could move faster than cannon fire.",
  ].map(scene);
  const normalized = normalizeNarrationScenes(raw);

  check("scene count is reduced", normalized.length < raw.length);
  check("all text preserved", compact(normalized.map((s) => s.text).join(" ")) === compact(raw.map((s) => s.text).join(" ")));
  check("chunks stay within the AI clip duration", normalized.every((s) => s.duration_hint_sec <= GENERATED_SCENE_MAX_SECONDS));
  check("no chunk ends on a dangling connector", normalized.every((s) => !danglingEnd.test(s.text)));
  check("durations are narration-length and provider-safe", normalized.every((s) => s.duration_hint_sec >= 3));
}

console.log("Test 2 - a normal long sentence splits into provider-safe chunks:");
{
  const text =
    "The harbor was quiet at sunrise, with gulls circling the mastheads, sailors whispering over wet rope, merchants pretending not to worry, and a black-sailed ship waiting beyond the sandbar like a threat nobody wanted to name, while every bell in town seemed to hold its breath, every shutter stayed closed, and every dockhand found a reason to look busy somewhere else.";
  const normalized = normalizeNarrationScenes([scene(text, 0)]);

  check("long sentence becomes multiple AI chunks", normalized.length > 1);
  check("all words preserved", compact(normalized.map((s) => s.text).join(" ")) === compact(text));
  check("every chunk estimates at 8 seconds or less", normalized.every((s) => s.duration_hint_sec <= GENERATED_SCENE_MAX_SECONDS));
  check("no chunk ends on a dangling connector", normalized.every((s) => !danglingEnd.test(s.text)));
}

console.log("Test 3 - an oversized sentence splits near a real clause, not the first comma:");
{
  const text =
    "The captain kept speaking, with the tide crawling under the pier, with lantern smoke gathering beneath the roof, with sailors pretending not to listen, with merchants counting coins behind locked doors, with the harbor bell hanging silent above the square, with every window reflecting a different fear, with every dock rope pulled tight by the current, with every gull turning away from the channel, with every rumor becoming heavier than the guns, with every tavern table scraped clean by nervous hands, with every prayer muttered too quietly to comfort anyone, and with the black-sailed ship waiting beyond the sandbar like a verdict nobody in town could delay forever.";
  const normalized = normalizeNarrationScenes([scene(text, 0)]);

  check("oversized sentence splits into multiple beats", normalized.length > 1);
  check("all words preserved", compact(normalized.map((s) => s.text).join(" ")) === compact(text));
  check("first chunk is not a tiny early-comma fragment", words(normalized[0].text) >= 7);
  check("every chunk estimates at 8 seconds or less", normalized.every((s) => s.duration_hint_sec <= GENERATED_SCENE_MAX_SECONDS));
  check("no chunk ends on a dangling connector", normalized.every((s) => !danglingEnd.test(s.text)));
}

console.log("Test 4 - visual prompts inherit the beat and forbid watermarks:");
{
  const normalized = normalizeNarrationScenes([
    {
      ...scene("The ship crossed the bar. The town fell silent.", 0),
      visual_prompt: "wide shot of a pirate ship entering harbor",
    },
  ]);
  const prompt = normalized[0].visual_prompt.toLowerCase();
  check("visual prompt carries source description", prompt.includes("pirate ship"));
  check("visual prompt carries the narration beat", prompt.includes("the town fell silent"));
  check("visual prompt bans watermarks/logos", prompt.includes("no watermarks") && prompt.includes("no logos"));
}

console.log("Test 5 - false sentence breaks ending mid-thought are repaired:");
{
  const raw = [
    "The harbor master read the ledger by candlelight, tracing the same impossible name through every column with.",
    "a shaking hand while the tide knocked against the pilings.",
    "By sunrise, every sailor in the room understood what the mark meant.",
  ].map(scene);
  const normalized = normalizeNarrationScenes(raw);

  check("first dangling unit merged forward", normalized.map((s) => s.text).join(" ").includes("with a shaking hand"));
  check("no chunk ends on a dangling connector", normalized.every((s) => !danglingEnd.test(s.text)));
  check("no unusably tiny fragments remain", normalized.every((s) => words(s.text) >= 6));
}

console.log("Test 6 - tiny leftovers merge with a long neighbor:");
{
  const long = Array.from({ length: 79 }, (_, i) => `word${i + 1}`).join(" ");
  const raw = [
    `${long}.`,
    "Then it vanished forever.",
  ].map(scene);
  const normalized = normalizeNarrationScenes(raw);

  check("every chunk stays provider-safe", normalized.every((s) => s.duration_hint_sec <= GENERATED_SCENE_MAX_SECONDS));
  check("tiny leftover was merged", normalized.some((s) => s.text.includes("Then it vanished forever.")));
}

console.log("Test 7 - while/because false stops are repaired:");
{
  const raw = [
    "The crew waited in silence while.",
    "the tide pulled the ship toward the harbor mouth because.",
    "nobody wanted to name the flag above the mast.",
    "By morning, the whole town knew.",
  ].map(scene);
  const normalized = normalizeNarrationScenes(raw);

  check("while break is removed", !normalized.map((s) => s.text).join(" ").includes("while."));
  check("because break is removed", !normalized.map((s) => s.text).join(" ").includes("because."));
  check("no chunk ends on a broadened dangling connector", normalized.every((s) => !danglingEnd.test(s.text)));
}

console.log("Test 8 - valid AI chunks are preserved instead of mechanically re-split:");
{
  const raw = [
    "A quiet harbor wakes before sunrise, with ropes creaking against wooden posts.",
    "Pale mist moves across the water as a young sailor watches the first ships.",
    "Merchants unlock their doors while gulls circle over the rooftops.",
  ].map(scene);
  const normalized = normalizeNarrationScenes(raw);

  check("AI chunk count stays stable", normalized.length === raw.length);
  check("natural harbor phrase is not cut into an orphan", normalized[1].text.includes("across the water"));
  check("merchant phrase stays together", normalized[2].text.includes("unlock their doors"));
  check("all chunks estimate to provider-safe duration", normalized.every((s) => estimateGeneratedSceneSeconds(words(s.text)) <= GENERATED_SCENE_MAX_SECONDS));
}

console.log("Test 9 - Fresh AI validator catches awkward cuts from the reported run:");
{
  const source =
    "A quiet harbor wakes before sunrise, with ropes creaking against wooden posts and pale mist moving across the water. A young sailor stands at the edge of the pier, watching the first ships turn toward the open sea. The camera follows him through narrow streets where candlelight fades from windows and merchants unlock their doors.";
  const broken = [
    "A quiet harbor wakes before sunrise, with ropes creaking against wooden posts and pale mist moving",
    "across the water. A young sailor stands at the edge of the pier,",
    "watching the first ships turn toward the open sea.",
    "The camera follows him through narrow streets where candlelight fades from windows and merchants unlock their",
    "doors.",
  ].map(scene);
  const repaired = [
    "A quiet harbor wakes before sunrise, with ropes creaking against wooden posts and pale mist moving across the water.",
    "A young sailor stands at the edge of the pier, watching the first ships turn toward the open sea.",
    "The camera follows him through narrow streets where candlelight fades from windows and merchants unlock their doors.",
  ].map(scene);

  check("broken plan is rejected", !validateFreshOpeningScenes(broken, source).ok);
  check("natural repaired plan is accepted", validateFreshOpeningScenes(repaired, source).ok);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
