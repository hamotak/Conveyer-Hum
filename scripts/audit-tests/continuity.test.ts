/**
 * Proof for the visual-continuity planner (pure, no DB / no FFmpeg).
 *
 *   node scripts/audit-tests/continuity.test.ts
 *
 * The planner decides per scene whether the next image should ANCHOR to the
 * previous one (carry its identity hint) or render FRESH. It must never chain
 * a close-up beard to a wide ocean shot — that would smear identities.
 */
import {
  isContinuityMode,
  lastFramePath,
  planContinuity,
  type ContinuityScene,
} from "../../src/lib/continuity.ts";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const ship = (index: number, opts: Partial<ContinuityScene> = {}): ContinuityScene => ({
  index,
  visual_prompt: opts.visual_prompt ?? "a wooden three-masted pirate ship at dawn, calm misty sea",
  continuity_group_id: opts.continuity_group_id ?? "queen-anne-revenge",
  continuity_break: opts.continuity_break ?? false,
  continuity_hint:
    opts.continuity_hint ??
    "a massive 1718 three-masted black-hulled pirate ship, 40 cannon ports, weathered sails, calm misty dawn light",
});

console.log("Test 1 — path naming uses 3-digit padding (matches scene_NNN.mp4):");
check("scene 0 → scene_000_last.jpg", lastFramePath("/r", 0).endsWith("continuity/scene_000_last.jpg"));
check("scene 9 → scene_009_last.jpg", lastFramePath("/r", 9).endsWith("scene_009_last.jpg"));
check("scene 123 → scene_123_last.jpg", lastFramePath("/r", 123).endsWith("scene_123_last.jpg"));
check("path is under the run dir's continuity subfolder", lastFramePath("/r", 1).startsWith("/r/continuity/"));

console.log("Test 2 — mode 'off' never anchors:");
{
  const scenes = [ship(0), ship(1), ship(2)];
  const plan = planContinuity(scenes, "off");
  check("3/3 steps fresh", plan.every((s) => s.anchorIndex === null && s.promptSuffix === null));
}

console.log("Test 3 — first scene is always fresh (no predecessor):");
{
  const scenes = [ship(0), ship(1)];
  const [first] = planContinuity(scenes, "prompt");
  check("step 0 anchorIndex null", first.anchorIndex === null);
  check("step 0 promptSuffix null", first.promptSuffix === null);
}

console.log("Test 4 — same group, no break → anchor to previous + carry hint:");
{
  const scenes = [ship(0), ship(1)];
  const [, second] = planContinuity(scenes, "prompt");
  check("anchorIndex = 0", second.anchorIndex === 0);
  check("promptSuffix includes previous hint", !!second.promptSuffix?.includes("massive 1718"));
  check("promptSuffix starts with 'Match the visual identity'", second.promptSuffix?.startsWith("Match the visual identity") === true);
}

console.log("Test 5 — continuity_break on the next scene → fresh:");
{
  const scenes = [ship(0), ship(1, { continuity_break: true })];
  const [, second] = planContinuity(scenes, "prompt");
  check("break → no anchor", second.anchorIndex === null && second.promptSuffix === null);
}

console.log("Test 6 — group change → fresh (close-up beard after wide ship):");
{
  const scenes = [
    ship(0),
    ship(1, { continuity_group_id: "blackbeard-portrait", continuity_break: true, continuity_hint: "Blackbeard's bearded face in low candlelight" }),
  ];
  const [, second] = planContinuity(scenes, "prompt");
  check("different group + break → no anchor", second.anchorIndex === null);
}

console.log("Test 7 — missing metadata (older scenes.json) → safe fresh fallback:");
{
  const scenes: ContinuityScene[] = [
    { index: 0, visual_prompt: "ocean at dawn" },
    { index: 1, visual_prompt: "ship in harbor" },
  ];
  const [, second] = planContinuity(scenes, "prompt");
  check("no group ids → no anchor", second.anchorIndex === null);
}

console.log("Test 8 — fallback to visual_prompt first sentence when hint missing:");
{
  const scenes: ContinuityScene[] = [
    {
      index: 0,
      visual_prompt: "A wide shot of the Queen Anne's Revenge anchored in Charleston harbor. Slow drift.",
      continuity_group_id: "qar",
      continuity_break: false,
      continuity_hint: null,
    },
    {
      index: 1,
      visual_prompt: "close-up of cannon",
      continuity_group_id: "qar",
      continuity_break: false,
    },
  ];
  const [, second] = planContinuity(scenes, "prompt");
  check("anchored despite missing hint", second.anchorIndex === 0);
  check("suffix carries the previous prompt's first sentence", !!second.promptSuffix?.includes("Queen Anne"));
}

console.log("Test 9 — isContinuityMode guard:");
check("off / prompt / keyframe accepted", isContinuityMode("off") && isContinuityMode("prompt") && isContinuityMode("keyframe"));
check("unknown rejected", !isContinuityMode("on") && !isContinuityMode(null) && !isContinuityMode(""));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
