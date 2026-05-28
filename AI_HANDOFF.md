# AI_HANDOFF.md — latest working context

Last updated: 2026-05-28

Purpose: this is the short handoff file for new Claude Code / Codex chats.
Read this after `CLAUDE.md` so the user does not have to re-explain the
project, plugins, setup, latest UI work, or safety rules.

## First instructions for any new AI session

- Work in `/Users/hamidaliyev/Desktop/Conveyer-Hum`.
- Do not use `/Users/hamidaliyev/Documents/Conveyer-Hum` for this project; it
  has previously been the wrong folder/cache context.
- Use `http://localhost:3001` when the dev server is already running there.
  Prefer the URL printed by Next if the port changes.
- Do not reveal full secrets, tokens, OAuth credentials, or API keys.
- Do not disconnect Google Drive, delete Drive files, delete local run data, or
  run paid generation unless the user explicitly asks.
- Do not push or commit unless the user asks.
- The worktree is intentionally dirty with user/WIP/audit changes. Do not
  revert unrelated files.

## Claude Code / plugin setup assumptions

The user should not need to resend screenshots of `/skills`, `/mcp`, or
`/plugins` unless something is broken.

Known useful Claude Code setup from this project:

- MCPs seen connected: `playwright`, `github`, `context7`.
- Google Drive MCP may show `needs authentication`; that is separate from the
  app's own Google OAuth.
- Figma/plugin auth may show `needs authentication`; do not depend on it unless
  the user asks for Figma work.
- Useful installed skills/plugins seen: `feature-dev`, `code-review`,
  `commit-commands`, `frontend-design`.
- For UI work, always verify with Playwright screenshots on desktop and mobile.

## Current product state

Conveyer Hum is a local Next.js app for faceless AI video generation:

- Video mode: script -> scene split -> 69labs/ElevenLabs continuous voice ->
  69labs image keyframes -> Veo image-to-video clips -> FFmpeg final MP4.
- Re-assembly mode: match scenes to clips in the Drive library and regenerate
  gaps.
- Local DB/data lives in `~/.conveyer-hum/`.
- Current branch observed: `fix/conveyer-hum-audit-hardening-2026-05-27`.

Recent completed work:

- 2026-05-28: generation was switched back to a two-step visual flow for style
  consistency. Fresh scenes now call `generateImage()` first and then pass the
  69labs image job id into `animateScene()` for image-to-video. `IMAGE_PROVIDER`
  defaults/migrates to `69labs`; 69labs image job key bindings are preserved
  long enough for multi-key image-to-video chaining.
- 2026-05-28: run preview was improved. The run page uses `preload="metadata"`
  and a `final-poster.jpg` poster; `/api/runs/[id]/file?p=final-poster.jpg`
  lazily extracts a JPG from existing `final.mp4` files so old runs get a
  visible preview frame too.
- Audit hardening commits exist for Drive rebuild, OAuth redirect, voice picker
  keys/validation, cancellation of provider jobs, secret masking, mobile layout,
  docs, and audit regression tests.
- UI was redesigned toward a calmer ChatGPT-like shell:
  - collapsible desktop sidebar, mobile drawer
  - composer-first Home page
  - compact Runs list
  - Run detail with final-video hero, scene timeline, Drive status, collapsed
    logs/assets
  - Library and voice picker polish
- Preflight and long-run safety were added:
  - `GET /api/preflight`
  - `src/lib/preflight.ts`
  - `src/lib/preflight-eval.ts`
  - `src/lib/script-estimate.ts`
  - long scripts warn/confirm before starting

Latest verification reported by Claude Code:

- `npm test` -> 8/8 suites pass
- `npx tsc --noEmit` -> clean
- `npm run build` -> OK, with the existing Turbopack NFT warning on
  `/api/runs/[id]/file`
- Dev server left running at `http://localhost:3001`
- Checked existing Queen Anne run locally: `final.mp4` serves with byte ranges,
  `ffprobe` reports H.264/AAC 59.4s, and `final-poster.jpg` serves as a
  1920x1080 JPEG.
- Preflight green: Google key, 69labs key, FFmpeg, output folder writable.
- Google Drive status: connected, but sync may be off; check Settings before
  testing Drive/Library behavior.

## Current testing guidance

Do not start with a one-hour or two-hour video.

Safe real-run ladder:

1. `__QA_1MIN_2026-05-28__`
2. `__QA_10MIN_2026-05-28__`
3. 20-30 minute chapter test
4. Long videos as separate chapters, not one huge job

Reason: one 69labs key gives about 5 parallel video jobs. A two-hour script can
be roughly 18,000 words and around 1,400+ scenes with the current estimator,
which is too risky and expensive as a first test.

## Known issues / backlog

- The app is much more polished, but a full timeline editor is not built.
  Current scene timeline is only a foundation.
- Real long-run reliability still needs staged paid tests.
- Library usefulness depends on successful Drive sync and non-empty clip
  manifests.
- Dead/inert CSS may remain from earlier UI passes, such as old `.run-bar`
  styles; cleanup is low priority.
- There may be transient `.next` dev-cache issues when multiple tools work in
  this repo; retry/reload usually fixes it.

## How to update this file

Update this file at the end of any meaningful session when:

- a feature, route, API, data model, or UI flow changes
- verification status changes
- a new bug/blocker is found
- a testing recommendation changes
- setup/plugin assumptions change
- a new branch/commit strategy matters

Keep updates short. Add dates. Do not paste secrets.
