# CLAUDE.md — project context for Claude Code

This file is auto-loaded by Claude Code. It gives you (Claude) the full picture
of Conveyer Hum so you can confidently answer questions and make changes.

## Required handoff memory

Before doing project work, read `AI_HANDOFF.md` in the repo root. It contains
the latest session notes, current verification state, tool/plugin assumptions,
and what not to re-explain to the user.

Before ending any substantial session, update `AI_HANDOFF.md` if you changed
features, UI, tests, setup, commands, safety guidance, known bugs, or next
steps. Keep it concise, dated, and never include full secrets or tokens.

---

## What Conveyer Hum is

A **local web app** for making faceless-YouTube content. It runs entirely on the
user's machine (Next.js dev server + local SQLite + local FFmpeg) — no hosted
backend. It has **two modes**, picked from the sidebar:

1. **Video Conveyer** (`/`) — the full pipeline: paste a script → split into
   scenes → ElevenLabs voiceover + image keyframe + Veo image-to-video per
   scene → assemble one MP4.
2. **Re-assembly** (`/reassembly`) — hybrid build: AI matches script scenes to
   clips in the Google Drive library, the user swaps any pick, and only the
   missing scenes are generated fresh. It reuses the Video Conveyer pipeline
   via a manual reuse map.

(A standalone **Voiceover** mode existed previously but has been removed —
`src/app/voiceover/` and `/api/voiceover/*` are gone.)

**Target users**: non-technical YouTube channel operators. UX must stay simple.
**Primary operator**: Vlad (mentor) builds/extends it; his mentees (e.g. Miguel
of Bull Network) use it and request features.

---

## Origin / history

- Forked from **Conveyer Grok** (lineage: Conveyer Isabell → Hum Conveyer →
  Conveyer Grok → Conveyer Hum). Conveyer Grok stays untouched as the base.
- Conveyer Grok used **xAI Grok** for video (via 69labs) and **HeyGen** for TTS.
- Conveyer Hum now defaults to **Veo 3.1 Fast** for image-to-video and
  **ElevenLabs** for voiceover, both routed through 69labs — so a single
  `LABS69_API_KEY` covers image keyframes + video + audio. **Grok** (fixed ~6s
  clips) and **MiniMax** TTS remain available as legacy/alternative options,
  but neither is the default any more.
- Because of the fork lineage, some legacy names survive intentionally:
  - The DB column `prompt_presets.content` actually holds the scene_split prompt.
  - The setting key `ANIMATION_KEEP_VEO_AUDIO` applies to any model, not just Veo.
  - The `image-gen.ts` service + `IMAGE_*` settings are active again: each fresh
    scene generates a still keyframe first, then chains that 69labs image job
    into the video job for first-frame consistency. `IMAGE_RATIO` still doubles
    as the video aspect ratio.

---

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** · **Tailwind 4**
- **better-sqlite3** — local DB at `~/.conveyer-hum/hum.db`
- **fluent-ffmpeg** — video assembly (needs system FFmpeg)
- **@anthropic-ai/sdk** — optional Claude scene-split path
- **googleapis** — Google Drive sync
- Node ≥ 20. Dev server: `npm run dev` — uses port 3000 if free, otherwise the
  next free port (3001, 3002, …).

---

## Pipeline — end to end

This is the engine behind both modes — **Video Conveyer** and **Re-assembly**.

Entry point: `POST /api/runs` → inserts a `runs` row → calls `runPipeline()` in
the background → redirects the UI to `/runs/[id]` which streams logs.

`src/lib/pipeline.ts` `runPipeline(runId, script)`:

1. **Scene split** — `splitScript()` in `services/scene-split.ts`. Sends script
   + system prompt to Gemini (default) or Claude. Returns `Scene[]`, each with
   `text`, `visual_prompt`, `duration_hint_sec`. The system prompt is the
   chosen channel profile's `scene_split`, else the global default.
2. **Per scene, in parallel** (concurrency-limited via `plimit.ts`):
   - `synthesizeFullScript()` (`services/tts.ts`) → one continuous narration
     MP3. Default provider is 69labs with `TTS_VOICE_PROVIDER="elevenlabs"`;
     MiniMax via 69labs, ElevenLabs (direct) and OpenAI stay available as
     alternatives via `TTS_PROVIDER` / `TTS_VOICE_PROVIDER`.
   - `generateImage()` (`services/image-gen.ts`) → `images/scene_###.png`
     keyframe via 69labs (default). The shared channel/video style is appended
     to the image prompt for consistency.
   - `animateScene()` (`services/img2vid.ts`) → image-to-video clip via Veo 3.1
     Fast through 69labs (default), chained by `imageJobId` so the still image
     anchors the first frame. Grok (legacy, fixed ~6s clip) and Kling stay
     available. OR, if the scene was marked for reuse, `downloadReusedClip()`
     pulls an existing clip from Google Drive instead and skips new image/video
     generation.
3. **Per-scene render** — `services/video-assemble.ts` combines narration + clip
   into one MP4 per scene, matching durations (trim / stretch / pad).
4. **Final assembly** — FFmpeg xfade-concatenates all scene clips → `final.mp4`.
5. **Drive sync** (if enabled) — `services/run-upload.ts` uploads final video +
   raw clips + `clips.json` + `description.md`, then deletes local raw clips.

Every stage writes to `run_logs` via `logger.ts`; the run page streams them over
Server-Sent Events (`/api/runs/[id]/logs`).

---

## Key external services

| Service | Used for | Notes |
|---|---|---|
| **Google Gemini** | scene split | `GOOGLE_API_KEY`. Free tier fine. |
| **69labs.vip** | image keyframes + Veo image-to-video (default; Grok legacy) + ElevenLabs voiceover (default; MiniMax alt) | `LABS69_API_KEY` covers images, video, and audio. Multi-key supported (newline/comma separated). Each key = 7 parallel image jobs and 5 parallel video jobs. |
| **ElevenLabs (via 69labs)** | TTS voiceover (default) | Default `TTS_PROVIDER="69labs"` + `TTS_VOICE_PROVIDER="elevenlabs"`. `TTS_VOICE_ID` = the voice id for the chosen provider. |
| **MiniMax (via 69labs)** | TTS voiceover (alternative) | Set `TTS_VOICE_PROVIDER="minimax"`. MiniMax voice id is a catalog string e.g. `English_Comedian` (or a cloned voice). Model `speech-02-hd`. |
| **Google Drive** | optional sync + reuse | OAuth2. The callback `redirect_uri` is derived from the live request origin (overridable via `APP_ORIGIN` / `NEXT_PUBLIC_APP_ORIGIN`), e.g. `http://localhost:3001/api/gdrive/oauth/callback` if Next picked port 3001 — NOT hardcoded to 3000. The Settings page shows the exact callback URL to register in Google Cloud. |

### Hard external constraints (don't fight these)

- **Grok via 69labs returns a fixed ~6s clip.** 69labs runtime-blocks the
  `duration` parameter for Grok — sending it (any format) returns HTTP 400.
  Grok is now the legacy video option; the default is Veo 3.1 Fast, which is not
  capped at 6s. If a channel still uses Grok, its scene-split prompt MUST keep
  each scene ≤ ~6s of narration.
- **MiniMax voice ids are catalog strings, not UUIDs.** When using the MiniMax
  TTS alternative, the voice id looks like `English_Comedian` (browse the catalog
  in the 69labs dashboard → MiniMax) or is a cloned-voice id. `tts.ts` sends it
  with `voiceProvider: "minimax"`. The default ElevenLabs-via-69labs provider
  uses ElevenLabs voice ids instead.
- **Windows Defender** truncates native `.node` binaries on `npm install`.
  `scripts/fix-native-binaries.mjs` (postinstall) restores them from a sibling
  project on Windows; it no-ops on macOS/Linux.

---

## File map

```
src/
├── app/
│   ├── layout.tsx              Root layout — renders <Sidebar/> + content
│   ├── _sidebar.tsx            Client sidebar, active-route highlighting
│   ├── globals.css             Premium design system (tokens + component classes)
│   ├── page.tsx                Video Conveyer — new-run page (Mode 1)
│   ├── reassembly/page.tsx     Re-assembly — hybrid library build (Mode 2)
│   ├── runs/page.tsx           Run history list
│   ├── runs/[id]/page.tsx      Run detail — logs (SSE), final video, assets
│   ├── library/page.tsx        Drive library browser
│   ├── prompts/page.tsx        Channels & Prompts (channel profiles + defaults)
│   ├── settings/page.tsx       Keys & Settings (required keys + Drive)
│   ├── settings/_groups.ts     Settings form schema (single source of truth)
│   ├── settings/_group-card.tsx  Renders one settings group
│   ├── advanced/page.tsx       Redirects to /settings?tab=pipeline (advanced settings merged into /settings)
│   └── api/
│       ├── runs/route.ts             POST create run, GET list
│       ├── runs/[id]/route.ts        GET one run
│       ├── runs/[id]/logs/route.ts   SSE log stream
│       ├── runs/[id]/assets/route.ts GET scene assets on disk
│       ├── runs/[id]/cancel/route.ts POST cancel
│       ├── runs/[id]/drive/route.ts  GET/POST Drive sync for a run
│       ├── runs/[id]/file/route.ts   GET serve a run file
│       ├── runs/[id]/open-folder/route.ts  POST open run folder in OS
│       ├── runs/[id]/reassemble/route.ts   DISABLED (returns 410)
│       ├── prompts/route.ts          GET/POST default prompts (latent — no current UI caller)
│       ├── prompt-presets/route.ts   GET list / POST create channel profile
│       ├── prompt-presets/[id]/route.ts  GET/PUT/DELETE channel profile
│       ├── preview/scenes/route.ts   POST scene-split preview (no run created)
│       ├── library/runs/route.ts     GET Drive library listing
│       ├── library/find-similar/route.ts  POST AI clip matching
│       ├── settings/route.ts         GET/POST settings
│       ├── stats/route.ts            GET concurrency capacity
│       └── gdrive/*                  OAuth start/callback, status, disconnect
└── lib/
    ├── db.ts                   SQLite open + schema + migrations
    ├── settings.ts             SETTING_KEYS, DEFAULTS, get/set helpers
    ├── prompts.ts              DEFAULT_PROMPTS + channel-profile CRUD
    ├── pipeline.ts             runPipeline orchestrator
    ├── run-paths.ts            DATA_DIR + per-run + voiceover folder paths
    ├── logger.ts               writes run_logs
    ├── plimit.ts               tiny concurrency limiter
    ├── cancellation.ts         cooperative run cancellation
    ├── init.ts                 ensureInit — seeds defaults
    └── services/
        ├── scene-split.ts      script → Scene[] via Gemini/Claude
        ├── tts.ts              69labs (ElevenLabs default / MiniMax alt) / ElevenLabs / OpenAI TTS
        ├── image-gen.ts        69labs/Replicate/OpenAI/fal image keyframes
        ├── img2vid.ts          Veo (default) / Grok (legacy) / Kling image-to-video generation
        ├── labs69.ts           69labs client + multi-key pool + voice catalogs
        ├── video-assemble.ts   FFmpeg per-scene render + final xfade
        ├── video-poster.ts     FFmpeg poster extraction for run-page previews
        ├── gdrive.ts           Google Drive client
        ├── run-upload.ts       upload a finished run to Drive
        ├── library.ts          AI clip-matching for reuse
        └── reuse.ts            download a reused clip from Drive
docs/                           INSTALL.md, USAGE.md, PROMPT-GUIDE.md
scripts/
├── fix-native-binaries.mjs     postinstall — restore .node on Windows
└── reassemble.mjs              DISABLED stub
```

---

## Data model (`hum.db`)

- **settings** — `key` → `value`. All config. See `SETTING_KEYS` in `settings.ts`.
- **prompts** — the 3 default prompts (`scene_split`, `image_prompt`,
  `animation_motion`).
- **prompt_presets** — channel profiles. Columns: `id`, `name`, `content`
  (= scene_split prompt), `description`, `animation_motion`, `image_prompt`,
  `voice_id`, timestamps. Optional columns NULL = inherit global default.
- **runs** — one row per run. Includes `preset_*` snapshot columns (the chosen
  channel profile is copied onto the run so deleting the profile later doesn't
  break old runs) and `reuse_map_json` (scene → Drive file id).
- **run_logs** — append-only log lines streamed to the run page.

The DB lives **outside** the project tree (`~/.conveyer-hum/`) so code updates
never touch user data — alongside `runs/` (pipeline output). (A `voiceovers/`
folder was used by the removed standalone Voiceover tool; `run-paths.ts` may
still reference it for legacy safety.) Schema changes use `tryAddColumn()` in
`db.ts` (SQLite has no `ADD COLUMN IF NOT EXISTS`).

---

## Core concepts

- **Two modes** — Video Conveyer (full pipeline) and Re-assembly (the Video
  Conveyer pipeline driven by a hand-picked `reuseMap`). Re-assembly POSTs
  `/api/runs` with `autoReuse: false` + the map. (The old standalone Voiceover
  mode has been removed.)
- **Channel profile** — a per-channel bundle: scene_split prompt + optional
  voice id + optional animation-motion override + description. Picked on
  the New Run page. UI label "Channels"; DB table `prompt_presets`.
- **Library reuse** — after Drive sync, the AI can match new scenes against past
  uploaded clips and skip generation for high-confidence matches.
- **Multi-key 69labs** — `LABS69_API_KEY` accepts several `vk_` keys; `labs69.ts`
  load-balances jobs across them via a key pool, binding each job to its key.

---

## Conventions & gotchas

- **Don't change pipeline logic for a UI request** and vice versa — keep them separate.
- TypeScript must stay clean: run `npx tsc --noEmit` before committing.
- Settings form is schema-driven — add a field by editing `_groups.ts`, and add
  the key to `SETTING_KEYS` + `DEFAULTS` in `settings.ts`.
- Adding a channel-profile field: one column in `db.ts` (`tryAddColumn`), update
  `PromptPreset` + CRUD in `prompts.ts`, the two `/api/prompt-presets` routes,
  and the `/prompts` page form. Snapshot it onto `runs` if the pipeline needs it.
- UI uses the design tokens / component classes in `globals.css` — prefer
  `var(--…)` and `.btn` / `.card` / `.input` over hardcoded colors.
- The project path can contain spaces (`Conveyer Hum`) — always use `path.join`.
- Secrets in settings are masked with `…` when sent to the UI; the save handler
  skips any value still containing `…` so it doesn't overwrite the real key.

---

## How to verify a change

1. `npx tsc --noEmit` — must be 0 errors.
2. `npm run dev`, open the URL it prints (`http://localhost:3000`, or 3001/3002
   if 3000 was taken), exercise the changed page.
3. For pipeline changes, run a short (~30s) script end-to-end and watch the logs.

---

## Out of scope (deliberately not built)

- **Avatar video assembly** — Bull Network has a separate avatar auto-editor;
  Conveyer Hum is text-to-AI-video only. Don't merge the two.
- **Auto-overlay** (arrows / text / infographics) — kept as a manual editor step.
- **Reassemble-from-disk** — the old Isabell `/api/runs/[id]/reassemble` route
  is disabled. The new **Re-assembly mode** (Mode 2) covers the real need:
  rebuild from the Drive clip library, not from local disk.

See also: `AI_HANDOFF.md`, `docs/INSTALL.md`, `docs/USAGE.md`,
`docs/PROMPT-GUIDE.md`, `README.md`.
