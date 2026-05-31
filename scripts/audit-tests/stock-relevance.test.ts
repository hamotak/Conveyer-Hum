/**
 * Proof that stock tails can use both the legacy narration-aware ordering and
 * the default shuffled-deck picker used by Hybrid runs.
 */
import {
  createNarrationAwareStockPicker,
  createShuffledStockDeckPicker,
  orderStockForNarration,
} from "../../src/lib/stock-relevance.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const candidates = [
  { localPath: "/cache/gold-coins-treasure-room.mp4", clip: { name: "gold coins treasure room.mp4" } },
  { localPath: "/cache/stormy-harbor-ship.mp4", clip: { name: "stormy harbor ship.mp4" } },
  { localPath: "/cache/jungle-birds.mp4", clip: { name: "jungle birds.mp4" } },
];

console.log("Test 1 - first tail beat gets the closest stock clip:");
{
  const ordered = orderStockForNarration(candidates, [
    { text: "The ship waited outside the harbor while the storm rolled in.", visual_prompt: "wide shot of a ship in a stormy harbor" },
    { text: "Gold coins lay scattered across the captain's table.", visual_prompt: "close-up of treasure and coins" },
  ]);
  check("ship/harbor clip is first", ordered[0].localPath.includes("harbor-ship"));
  check("treasure clip is second", ordered[1].localPath.includes("treasure-room"));
  check("unmatched clips still remain available", ordered.some((c) => c.localPath.includes("jungle-birds")));
}

console.log("Test 2 - picker cycles through the narration-aware order:");
{
  const picker = createNarrationAwareStockPicker(candidates, [
    { text: "Gold treasure filled the room.", visual_prompt: "coins and treasure" },
  ]);
  check("records a matched scene", picker.matchedScenes === 1);
  check("first pick follows relevance", picker.pick().includes("treasure-room"));
  check("second pick is different when options exist", !picker.pick().includes("treasure-room"));
}

console.log("Test 3 - no scenes falls back to original order:");
{
  const ordered = orderStockForNarration(candidates, []);
  check("keeps original order", ordered[0] === candidates[0] && ordered[1] === candidates[1]);
}

console.log("Test 4 - long narration plans do not duplicate clips early:");
{
  const ordered = orderStockForNarration(candidates, [
    { text: "The ship waited outside the harbor.", visual_prompt: "stormy harbor ship" },
    { text: "Gold coins covered the table.", visual_prompt: "treasure room" },
    { text: "Birds moved through the trees.", visual_prompt: "jungle birds" },
    { text: "The harbor came back into view.", visual_prompt: "stormy harbor" },
    { text: "The coins appeared again.", visual_prompt: "gold treasure" },
  ]);
  check("ordered list contains each candidate once", new Set(ordered).size === ordered.length);
  check("all candidates remain available", ordered.length === candidates.length);
}

console.log("Test 5 - shuffled deck uses every clip before repeating:");
{
  const many = Array.from({ length: 100 }, (_, i) => ({
    localPath: `/cache/clip-${String(i).padStart(3, "0")}.mp4`,
    clip: { driveFileId: `drive-${i}`, name: `clip ${i}` },
  }));
  const picker = createShuffledStockDeckPicker(many, "run-alpha");
  const picks = Array.from({ length: 800 }, () => picker.pick());

  let everyBlockHasAll = true;
  for (let start = 0; start < picks.length; start += many.length) {
    const block = picks.slice(start, start + many.length);
    if (new Set(block).size !== many.length) everyBlockHasAll = false;
  }

  check("each 100-clip pass contains every clip exactly once", everyBlockHasAll);
  check("first repeat is spaced by at least the library size", picks[0] !== picks[1] && picks.slice(1, 100).every((p) => p !== picks[0]));
}

console.log("Test 6 - shuffled deck is deterministic per run and different across runs:");
{
  const a1 = createShuffledStockDeckPicker(candidates, "same-run");
  const a2 = createShuffledStockDeckPicker(candidates, "same-run");
  const b = createShuffledStockDeckPicker(candidates, "different-run");
  const seqA1 = Array.from({ length: 9 }, () => a1.pick()).join("|");
  const seqA2 = Array.from({ length: 9 }, () => a2.pick()).join("|");
  const seqB = Array.from({ length: 9 }, () => b.pick()).join("|");

  check("same run id produces the same stock order", seqA1 === seqA2);
  check("different run id produces a different stock order", seqA1 !== seqB);
}

console.log("Test 7 - tiny libraries avoid immediate repeats when possible:");
{
  const two = candidates.slice(0, 2);
  const picker = createShuffledStockDeckPicker(two, "tiny-run");
  const picks = Array.from({ length: 12 }, () => picker.pick());
  const noImmediateRepeats = picks.every((pick, i) => i === 0 || pick !== picks[i - 1]);

  check("two-clip decks alternate without immediate repeats", noImmediateRepeats);
  check("one-clip deck still works", createShuffledStockDeckPicker(candidates.slice(0, 1), "one").pick() === candidates[0].localPath);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
