# Conveyer Hum — Rebuild Brief for Claude Code

> Paste everything below the line into Claude Code, running inside the
> `~/Desktop/Conveyer-Hum` project. It is a complete, self-contained spec — you
> do not need any outside context. Work through it top to bottom. Prefer editing
> the existing files named here over rewriting from scratch.

---

You are working on **Conveyer Hum**, a local Next.js 16 (Turbopack) + React 19 +
TypeScript app that turns a single narration script into a finished faceless
YouTube video. It generates one TTS voiceover and one AI video clip per scene
(via the 69labs gateway: Veo 3.1 for video, MiniMax/ElevenLabs for voice), then
stitches everything with FFmpeg. Data lives at `~/.conveyer-hum/` (SQLite
`hum.db` + `runs/<id>/`). Start with `npm run dev` (http://localhost:3000).

There are **two missions**, in priority order:

1. **Fix audio/video synchronization for good** (the #1 bug).
2. **Turn the app into a beautiful, zero-config "one script in, finished video
   out" studio** where every scene and clip is visible and every detail is
   managed for the user.

Do not break: the 69labs client, multi-key concurrency, cancellation, resume,
Google Drive sync, channel profiles, or the library-reuse feature.

---

## MISSION 1 — Perfect synchronization

### Why it's broken today

The active pipeline (`src/lib/pipeline.ts` → `runPipeline`) uses a "continuous
voiceover" design:

- It synthesizes the **entire script as ONE mp3** (`synthesizeFullScript`) and
  measures only the *total* duration.
- It generates one fixed-length clip per scene (Veo = exactly 8.0s).
- In `buildAssemblyClips`, it gives each scene screen-time by **word-count
  proportion**: `targetSec = words[i] / totalWords × totalAudioDuration`.
  **It never measures where each scene's narration actually falls in the audio.**

Because real speech timing is NOT proportional to word count (dramatic pauses,
the `TTS_AUTO_PAUSE` feature, sentence breaths, numbers, emphasis), each scene's
visual cut drifts away from its narration. The error accumulates and peaks in
the middle of the video. Verified on a real run (`6ea77e30`, 18 scenes, 61.5s):
every clip was exactly 8.0s natively, then trimmed to word-share values
(3.17s, 3.6s, 4.97s…). Totals matched, but each individual scene was only a
guess — so the picture describes a different sentence than the voice.

### The constraint you must design around

AI video clips have a hard length ceiling: **Veo 3.1 via 69labs = ~8s, Grok =
~6s.** A scene's narration can easily run **10s+**. You cannot ask the model for
a 10s clip. Do NOT "solve" this by stretching one 8s clip to 10s (it judders —
this is the old `renderAnimatedClip` MAX_STRETCH symptom) and do NOT freeze the
last frame (the "scene replays / picture stops" glitch).

### The fix: build the video timeline FROM the audio, per scene

Switch the pipeline from "one continuous audio + word-count guess" to
**per-scene audio chunks**, where each scene's clip is fit to that scene's own
**measured** narration duration. This removes the estimate entirely → zero drift
by construction.

Implement this in `src/lib/pipeline.ts` and `src/lib/services/video-assemble.ts`
(the per-scene building blocks already exist: `synthesizeScene` in
`tts.ts`, `renderAnimatedClip`, `probeDuration`, `extractLastFrame` in
`frame-extract.ts`, and `kenBurnsBufferFromClip`). New per-scene flow:

1. **Scene split, length-aware** (`scene-split.ts`): keep the splitter, but
   size each scene so its narration is expected to fit within ONE clip's
   ceiling with headroom (target ≤ ~7s of speech for an 8s Veo clip). Estimate
   words→seconds using the *active voice + TTS_SPEED*, not a fixed 150 wpm.
   Hard-split any scene whose estimated narration exceeds the budget. Most
   scenes should then need only one clip.

2. **Per scene, in parallel** (respect existing concurrency limiters):
   - TTS **only this scene's text** → `audio/scene_NNN.mp3`. Measure duration
     `A` with `probeDurationSafe`.
   - Generate keyframe image + img2vid clip → `animations/scene_NNN.mp4`
     (native length `V`, ≤ ceiling). Reuse the existing img2vid path.

3. **Per-scene fit — the heart. Each rendered clip's duration must equal `A`
   exactly:**
   - If `A ≤ V`: tail-cut the clip to `A`. Done (frame-accurate).
   - If `A > V` (narration longer than one clip can be):
     - Absorb a tiny overrun (`A − V` ≤ ~1.0s) with a gentle slowdown
       (`setpts` ≤ **1.10×** only — never more, to avoid judder).
     - Otherwise **chain a seamless continuation clip**: extract the LAST FRAME
       of the clip (`extractLastFrame`) and run img2vid from it with a
       "camera continues the same shot, slow motion" prompt suffix. Concat
       clip₁+clip₂(+clip₃…) until native total ≥ `A`, then tail-cut to `A`.
       This covers any length with *continuous on-theme motion*.
     - **Fallback only if continuation generation fails:** a slow Ken-Burns push
       on the last frame (`kenBurnsBufferFromClip`) for the remainder. Motion,
       never a frozen hold.

4. **Assembly** (`video-assemble.ts`): concat the per-scene clips with a short
   video crossfade (~0.3s) and join the per-scene audio with a tiny
   declick/crossfade (~40–80ms) plus an optional natural ~150ms breath at
   sentence boundaries. Because every clip equals its scene's audio, **there is
   no drift** — scene N's picture always plays over scene N's narration.

5. **Keep the voice consistent** (the reason continuous mode existed): use the
   SAME voice id + settings for every scene; pass `previous_text` / `next_text`
   context to the TTS request when the provider supports it (for prosody
   continuity); and rely on the tiny inter-scene breath so joins sound natural,
   not seamed.

6. **Prove it.** After assembly, compute and log a **sync report**: per-scene
   `audioSec` vs `clipSec` (delta must be ≈ 0.000s), max drift, and
   `totalVideoSec` vs `totalAudioSec` (assert within one frame). Persist it to
   the run and show it in the UI (see Mission 2). Add this to the audit test
   suite (`scripts/audit-tests/`) as a regression guard.

Update `resumeRun` to the same per-scene model so resume stays consistent.
Remove or quarantine the word-count `buildAssemblyClips` path so it can't be
used again. Update `README.md`'s "How it works" diagram to the new flow.

### Acceptance criteria (Mission 1)

- For a script with deliberately uneven sentence lengths (mix of 3-word and
  25-word lines), the finished video shows each scene's visual exactly during
  that scene's spoken line, start to finish, with **no** mid-video drift.
- No frozen last-frame holds and no juddery slow-motion anywhere.
- Sync report logged and shown: max per-scene drift < 0.10s; total
  video/audio delta < 0.05s.

---

## MISSION 2 — The zero-config studio ("set nothing, it tells me what to do")

Make the whole thing feel like a premium, $1B-quality desktop studio that runs
locally — calm, dark, confident, fast. The user pastes ONE script and never has
to configure anything; the app reads the script and tells them, in plain
language, exactly what (if anything) to do.

### A. One-screen flow (rework `src/app/page.tsx`)

- A single, focused composer: big script textarea + one primary **Generate**
  button. No required settings visible. Everything else is auto-defaulted for
  the sleep / long-form documentary niche and tucked into an "Advanced" drawer.
- An **Analyze** step that runs instantly and cheaply (local stats + scene-split
  preview + preflight) and renders a **Plan card** before generating:
  - detected language, recommended voice, estimated final length, scene count,
    estimated credit cost and wall-clock time (reuse `script-estimate.ts`,
    `/api/stats`, `/api/preflight`).
  - a plain-English **"To do before you generate"** checklist that reads the
    script and the environment and tells the user what to fix — missing API
    keys, no voice selected, script too short/long, no punctuation (hurts scene
    splitting), etc. Each item links to where to fix it. If nothing's wrong:
    a confident "Ready — press Generate." Nothing should require the user to
    understand the internals.
- Auto-pick sensible defaults (voice, pacing, model, aspect) when unset, and say
  what was chosen, so "set nothing" really works.

### B. Live run screen (rework `src/app/runs/[id]/page.tsx`)

- A hero progress area (overall %, current stage, ETA), then a **responsive grid
  of scene cards**. Each scene card updates live and shows:
  - the keyframe thumbnail, then the generated **clip playable inline**,
  - the scene's narration text,
  - measured **audio duration**, rendered **clip duration**, and a small
    **"synced ✓"** indicator (delta ≈ 0),
  - status: queued → generating → rendering → done / failed,
  - per-scene **Regenerate** and **Replace clip** actions (wire to resume-style
    single-scene regeneration; it's fine to regenerate one scene and re-assemble).
- "Every clip is shown, every detail is managed": surface the visual prompt,
  the continuation-clip count (if a long scene was chained), and any per-scene
  warning right on the card.
- The old log list crashed React with "two children with the same key" because
  the SSE log stream emits duplicate ids on reconnect/replay. Whatever live log
  view remains must use collision-proof keys AND de-duplicate replayed log rows
  so the list doesn't balloon with hundreds of dupes.

### C. Final state

- Big final-video player front and center (already exists — keep/polish), with
  Download, Open folder, Drive status, and a compact **Sync report** (max drift,
  total duration, scene count) so the user can trust it's aligned.

### D. Errors & launch hygiene

Two real launch blockers were diagnosed on this machine (Node 24, Next 16.2.4
Turbopack) — fix both properly:

1. **Stale `.next` 500s.** The dev server 500s when the `.next` Turbopack cache
   goes stale or gets duplicated conflict-copies (`build 2`, `build-manifest 5.json`
   — likely from a backup/restore process), throwing
   `ENOENT … build-manifest.json` / `routes-manifest.json`. Add a clean-start
   guard (e.g. a `predev` script that removes a stale `.next`, or detect+recover)
   and document a single start command. Also gitignore stray `.next_*` backup
   dirs so the toolchain never scans them.

2. **Tailwind v4 PostCSS deadlock (every page hung compiling at 0% CPU).**
   `src/app/globals.css` began with `@import "tailwindcss";`, which deadlocked
   the Turbopack PostCSS worker under Node 24 — every *page* request hung
   forever in "Compiling …" while API routes (no CSS) were instant. **This was
   already removed** as a fix: the app uses a 100% custom CSS design system in
   `globals.css` (CSS variables + classes like `.card`, `.btn`) and **zero**
   Tailwind utility classes or directives, so the import was pure dead weight.
   Do **NOT** re-add `@import "tailwindcss"`. If Mission 2's redesign wants
   Tailwind utilities, first resolve the Node-24/Turbopack PostCSS deadlock
   (pin a compatible toolchain or switch the CSS pipeline) and verify a page
   actually compiles before relying on it.

- Replace the bare "Internal Server Error" with a branded error page that says
  what happened and what to do.
- Every error surface (failed run, bad voice, missing key, Drive failure) must
  be friendly and actionable — no raw stack traces in the UI.

### E. Design

- Cohesive, premium dark "sleep studio" aesthetic with a real design system
  (the app already uses CSS variables in `globals.css` — extend, don't fight
  them). Smooth, restrained motion. It should feel expensive and calm, not
  generic-AI-dashboard.

### Acceptance criteria (Mission 2)

- A non-technical user can paste a script, read the Plan card, and press one
  button — with zero settings — and get a correct video.
- During a run, every scene's image + clip + narration + durations + sync status
  are visible and individually inspectable, with working per-scene regenerate.
- No stale-`.next` 500 on a normal start; all error states are friendly.

---

## MISSION 3 — Hybrid "fresh + library" mode for long sleep videos (speed)

This is how long videos (up to ~1–2 hours) get made cheaply and FAST. The goal:
**a full long video produced in roughly one hour of wall-clock time.** Confirmed
real-world need: a sleep/pirate-history channel where only the opening needs
bespoke synced visuals and the rest is calm ambient B-roll.

### The model

A run has a **"fresh minutes" setting (default 5, adjustable per run)**:

1. **First N minutes of narration → fresh AI clips** with the Mission 1 per-scene
   sync engine (the topical, frame-accurate opening; default N = 5 min).
   Determine the cut-over by walking scenes until cumulative narration ≥ N min.
2. **Remaining narration → library fill.** Instead of generating, cover the rest
   of the audio with clips pulled from the channel's **stock library**, chosen by
   **pure random shuffle — NO LLM/AI matching** (zero extra tokens; it's ambient
   sleep B-roll). Concatenate/loop enough shuffled clips to cover the remaining
   audio with light crossfades; never repeat the same clip back-to-back. Sync is
   intentionally loose here — only the fresh opening needs tight alignment.

This also sidesteps the desync problem for the long tail entirely, and makes a
2-hour video mostly a download-and-concat job (fast) instead of 1000+ generations.

### Storage model (Google Drive is the source of truth — do NOT bloat local disk)

- The stock library lives in **Google Drive**, organized in per-channel / per-topic
  folders (e.g. a "Pirates" library with subfolders like pirate-ships, symbols,
  seas, battles). Multiple channels each have their own library folder.
- The app **downloads each library clip from Drive on first use, caches it locally**
  (e.g. `~/.conveyer-hum/library-cache/<channel>/…`), and **reuses the cache** on
  later runs — each clip is fetched at most once. Bound the cache size with LRU
  eviction so local disk never fills up.
- Generated assets continue to upload to Drive; raw per-scene clips may be cleaned
  locally after upload. The local machine should never be "crushed by the size of
  the files it generates," per the owner.
- Build on the existing Google Drive integration + library/reuse code rather than
  inventing a new storage layer.

### Bulk library builder

- A tool/page to generate a batch of **100–300 topical clips** once (from a list of
  prompts or a topic like "pirate ships, flags, stormy seas, treasure, decks…"),
  and store them straight into the channel's Drive library folder for future runs.
- Must be **resumable and rate-limit/network aware** (the owner hits `fetch failed`
  storms and content-moderation blocks on a single 69labs key — see below), so a
  batch can stop and continue without re-paying for clips already made.

### Speed + resilience (the owner's runs currently take hours)

- A real 175-scene run took ~3.5h, dominated by a long network outage where each
  video job **hung polling for ~15 min before timing out**. Make polling timeouts
  and retry/backoff sane so a flaky connection degrades gracefully instead of
  stalling for 15 minutes per job. Surface "network unstable, retrying" clearly.
- Encourage/support **multiple 69labs keys** for parallelism (already supported —
  make it obvious in the Plan card how much faster N keys would be).
- Some scenes fail (content-moderation blocks, network). When clips are MISSING,
  the continuous assembler currently smears the surviving clips across the full
  audio, which **shoves every later scene out of sync** — this is a second, big
  cause of "visuals stop matching the voice after a few minutes." The per-scene
  rewrite (Mission 1) plus the hybrid model must handle missing scenes without
  desyncing the remainder (e.g. fill a failed fresh-scene's slot from the library
  rather than redistributing time).

### Acceptance criteria (Mission 3)

- A long run generates fresh synced clips only for the first N minutes, fills the
  rest from the shuffled Drive library, and finishes a 1–2h video in ≈1 hour.
- Library clips download from Drive once, cache locally, and are reused next run;
  local disk stays bounded.
- The bulk builder can produce 100–300 clips into a Drive library folder and
  resume after interruption.
- Missing/failed fresh scenes never push the rest of the video out of sync.

---

## Working notes

- Keep changes incremental and run `npm run dev` to verify after each milestone.
- Run the audit suite (`npm test`) and add new regression tests for the sync
  report.
- Don't spend more 69labs/Veo credits than needed: validate logic with a tiny
  2–3 scene script before any long run.
- Preserve all existing settings keys and DB columns; add new ones additively.
