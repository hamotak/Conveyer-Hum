/**
 * Proof for long-script chunking.
 *
 *   node scripts/audit-tests/text-chunking.test.ts
 *
 * The production chunker is shared by scene splitting, long-form TTS, and
 * recovery counters. It must not cut inside common abbreviations, decimals, or
 * initials, and it must never drop text.
 */
import {
  chunkTextByNarrationUnits,
  countTextChunks,
  splitIntoNarrationUnits,
} from "../../src/lib/text-chunking.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const compact = (s: string) => s.trim().replace(/\s+/g, " ");

console.log("Test 1 - abbreviations and initials stay inside sentences:");
{
  const text = "Dr. Smith met Capt. Kidd in the U.S. archive. J. R. Morgan found the chart.";
  const units = splitIntoNarrationUnits(text);
  check("two real sentences", units.length === 2);
  check("first sentence keeps Dr./Capt./U.S.", units[0] === "Dr. Smith met Capt. Kidd in the U.S. archive.");
  check("second sentence keeps initials", units[1] === "J. R. Morgan found the chart.");
}

console.log("Test 2 - decimals do not split narration:");
{
  const text = "The ship drifted 3.14 miles by 5 a.m. The crew noticed too late, e.g. after sunrise.";
  const units = splitIntoNarrationUnits(text);
  check("decimal stayed in sentence", units.length === 2 && units[0].includes("3.14 miles"));
  check("a.m. and e.g. stayed inside sentences", units[0].includes("5 a.m.") && units[1].includes("e.g."));
}

console.log("Test 3 - chunking preserves every word:");
{
  const text = [
    "Dr. Smith met Capt. Kidd in the U.S. archive.",
    "The chart named three coves, two reefs, and one impossible route.",
    "Nobody believed it until the wreck appeared.",
  ].join(" ");
  const chunks = chunkTextByNarrationUnits(text, { maxChars: 70 });
  check("made multiple chunks", chunks.length > 1);
  check("joined chunks equal normalized input", compact(chunks.join(" ")) === compact(text));
  check("counter matches actual chunks", countTextChunks(text, { maxChars: 70 }) === chunks.length);
}

console.log("Test 4 - long no-punctuation text falls back without dropping words:");
{
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
  const text = words.join(" ");
  const chunks = chunkTextByNarrationUnits(text, { targetWords: 15 });
  check("long plain text is chunked", chunks.length === 4);
  check("all words preserved", compact(chunks.join(" ")) === text);
}

console.log("Test 5 - single huge sentence is safely split under provider cap:");
{
  const text = [
    "This sentence is intentionally long, with many clauses, with many details, with many pauses, with many names, with many places, with many turns, with many decisions, with many consequences.",
    "The next sentence should remain separate.",
  ].join(" ");
  const chunks = chunkTextByNarrationUnits(text, { maxChars: 90 });
  check("every chunk respects max chars", chunks.every((c) => c.length <= 90));
  check("all text preserved", compact(chunks.join(" ")) === compact(text));
}

console.log("Test 6 - soft target does not split a complete sentence until hard max:");
{
  const text =
    "This complete narration sentence has enough words to pass the soft target, but it is still one spoken thought with a natural ending, so it should stay together for smoother audio instead of being cut into two awkward pieces.";
  const chunks = chunkTextByNarrationUnits(text, { targetWords: 12, maxWords: 40 });
  check("complete sentence stays whole under hard max", chunks.length === 1);
  check("all text preserved", compact(chunks.join(" ")) === compact(text));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
