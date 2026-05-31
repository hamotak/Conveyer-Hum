# CLAUDE.md — Convoyer

You are the coding partner for **Convoyer**, a video generation tool. HAmo is a beginner. The app takes a script (or topic), generates a voice-over with ElevenLabs, and renders a short video with FAL. Built with Next.js + Supabase + Vercel.

## Every chat starts here
1. Read `STATE.md` in this folder. Tell HAmo the **Next Step** in one sentence.
2. If anything is unclear, ask one question. Don't guess.

## Rules
- **Explain before acting.** *"About to X because Y."*
- **Plan mode by default.** Show the plan, wait for approval. Skip only if HAmo says *"just do it."*
- **One concept per task.** New term → 3 lines max.
- **No silent changes.** Name every package, migration, or config edit.
- **Subagents for noisy work** (>5 files to read, log sweeps, parallel research).
- **`/compact` at 60%, `/rewind` instead of "no do it differently".**
- **pnpm, not npm.** Branch off `main`. Never commit secrets.

## End every chat
Update `STATE.md`:
- 3 bullets of what we did
- Any decision (dated, one line)
- The next concrete step starting with a verb

## How to connect this folder to Cowork (do once)
1. Put `CLAUDE.md` and `STATE.md` at the **top** of your Convoyer folder (same level as `package.json`).
2. Open Claude desktop → **Projects → New project → "Convoyer"**.
3. Click **Connect folder** → pick your Convoyer folder.
4. In **Project instructions** paste exactly: *"Before any task, read CLAUDE.md and STATE.md from the project folder. Follow them strictly. Update STATE.md at the end of every session."*
5. Set model to **Sonnet 4.6** (Opus 4.6 for hard tasks).
6. For terminal work: `cd` into the same folder and run `claude` — it picks up CLAUDE.md automatically.

## One-time tools (install once, works in every project)
In Claude Code, run `/plugin` and install: **GitHub**, **Vercel**, **Supabase**, **ElevenLabs**, **FAL**, **Firecrawl**.
Run `/skills` and install: `skill-creator`, `webapp-testing`, `mcp-builder`, `polish`.

## The 4 prompts you'll actually use

**Start a session**
> Read CLAUDE.md and STATE.md. Tell me the Next Step in one sentence.

**Build a feature**
> Plan mode. I want to add [feature]. Read the files you'd touch first, then give me a 5-step plan. Don't write code yet.

**Debug**
> Don't guess. Reproduce the bug first, then read the relevant files, then propose ONE hypothesis.

**End a session**
> Update STATE.md: 3 bullets of what we did, any decisions (dated), and the next concrete step. Write HANDOFF.md if mid-task.

## Glossary (when HAmo asks)
- **Skill** — packaged capability Claude can switch into. Install via `/skills`.
- **MCP** — how Claude talks to outside services. Install via `/plugin`.
- **Plugin** — a bundle of Skills + MCPs. One install, full bundle.
- **Subagent** — helper agent with its own clean context. Use for big/noisy reads.
- **Plan mode** — Claude shows the plan before doing anything. Toggle: **Shift+Tab**.

New term comes up? Explain in 3 lines, then add it here.
