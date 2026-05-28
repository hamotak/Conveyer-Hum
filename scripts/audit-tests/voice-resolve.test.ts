/**
 * Proof for the channel → global → provider-default voice fallback chain.
 *
 *   node scripts/audit-tests/voice-resolve.test.ts
 *
 * tts.ts now routes resolveVoiceId() through pickVoiceId(), so these checks
 * pin the exact rules a channel run relies on: a channel without its own
 * voice MUST safely fall back to the global TTS_VOICE_ID instead of using an
 * empty/garbage id at provider call time.
 */
import { pickVoiceId } from "../../src/lib/voice-resolve.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("Test 1 — channel voice wins when set:");
check(
  "channel set + global set → channel wins",
  pickVoiceId({ channel: "Christoher", global: "GlobalVoice", fallback: "fb" }) === "Christoher"
);
check(
  "channel set + no global → still channel",
  pickVoiceId({ channel: "Christoher", global: "", fallback: "fb" }) === "Christoher"
);
check(
  "whitespace-only channel does NOT count",
  pickVoiceId({ channel: "   ", global: "GlobalVoice", fallback: "fb" }) === "GlobalVoice"
);

console.log("Test 2 — channel blank falls back to global (the safety net):");
check(
  "channel null + global set → global",
  pickVoiceId({ channel: null, global: "GlobalVoice", fallback: "fb" }) === "GlobalVoice"
);
check(
  "channel undefined + global set → global",
  pickVoiceId({ channel: undefined, global: "GlobalVoice", fallback: "fb" }) === "GlobalVoice"
);
check(
  "channel empty string + global set → global",
  pickVoiceId({ channel: "", global: "GlobalVoice", fallback: "fb" }) === "GlobalVoice"
);

console.log("Test 3 — neither channel nor global → provider default:");
check(
  "nothing set → fallback",
  pickVoiceId({ channel: null, global: "", fallback: "21m00Tcm4TlvDq8ikWAM" }) === "21m00Tcm4TlvDq8ikWAM"
);
check(
  "no fallback either → empty string (caller handles)",
  pickVoiceId({}) === ""
);

console.log("Test 4 — channel value gets trimmed:");
check(
  "channel with surrounding whitespace",
  pickVoiceId({ channel: "  Christoher  ", global: "GlobalVoice" }) === "Christoher"
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
