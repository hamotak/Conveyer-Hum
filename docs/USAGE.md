# Usage guide — how to make videos with Conveyer Hum

This guide assumes you've already finished installation. If not, see [INSTALL.md](./INSTALL.md).

After install, you open the app in your browser (the terminal prints the exact URL — usually `http://localhost:3000`, or 3001/3002 if 3000 was taken) and see the Conveyer Hum interface with a left sidebar. Everything happens through that interface — no editing config files, no rebuilding.

---

## Sidebar at a glance

| Page | What it does |
|---|---|
| **Video Conveyer** | Paste a script → a full video: scenes, voiceover, clips, final MP4 |
| **Re-assembly** | Build a video mostly from clips you already have in your Drive library |
| **Run history** | All your past runs — status, final video, logs |
| **Library** | Browse clips from past runs on Google Drive (if Drive sync is on) |
| **Channels & Prompts** | Channel profiles (one per channel) + default prompts |
| **Keys & Settings** | API keys, Drive credentials, and (in the **Pipeline** tab) voice settings, video model, FFmpeg options, concurrency |

The first two are the **modes**; the rest are shared across both. Voice/model/FFmpeg/concurrency settings used to live on a separate **Advanced** page — those have been merged into **Keys & Settings** (Pipeline tab). The old `/advanced` URL now redirects to `/settings?tab=pipeline`, so existing bookmarks still land in the right place.

---

## Making your first video (3 minutes setup, 10–30 minutes generation)

### Step 1 — Paste API keys (one-time)

Go to **Keys & Settings** and fill in:

- `GOOGLE_API_KEY` — your Gemini key from [aistudio.google.com](https://aistudio.google.com/app/apikey) (free)
- `LABS69_API_KEY` — your 69labs key (starts with `vk_`). This one key powers **both** Veo video and ElevenLabs voiceover.

Only two keys to start. The voice itself is chosen in **Keys & Settings → Pipeline tab → Voice Over (TTS)**, and it already has a sensible default (ElevenLabs via 69labs).

Click **Reveal secret values** if you need to edit existing keys (they're masked by default).

Click **Save all changes**. You should see green confirmation.

### Step 2 — (Optional but recommended) Set up a channel profile

Default prompts work, but you'll get much better, more on-brand results with a channel profile tuned to your niche.

Go to **Channels & Prompts** → **Add new channel** → fill in the channel name, optionally a voice (this channel's own voice) and a description, then paste the Scene Split prompt → **Add channel**.

See [PROMPT-GUIDE.md](./PROMPT-GUIDE.md) for what to put in the Scene Split prompt and a full worked example.

### Step 3 — Paste script, run pipeline

Go to **Video Conveyer**.

1. (Optional) Give the run a title — useful for finding it later in Run history
2. **Channel** dropdown → pick the channel profile for this video. Its scene-split prompt, voice and motion all apply automatically. Leave at *"Default — no channel profile"* to use the global defaults
3. **Script** textarea → paste your full narrator script. Anything from 30 seconds to 30 minutes works.

Below the script box you'll see live stats: word count, estimated duration, estimated scenes, estimated total generation time.

Click **Run pipeline** — that's it. The page redirects to live logs and you can watch each scene generate in real time.

---

## What happens during a run

The pipeline runs 5 phases automatically. You don't intervene — just watch the logs.

```
[1] Scene split (Gemini)
    Your script + preset → JSON array of scenes (each with text + visual_prompt + duration)
       ↓
[2] Per scene IN PARALLEL:
       ├─ ElevenLabs TTS (via 69labs) → narration MP3
       └─ Veo via 69labs → silent video clip
           (or, if you picked Library reuse: download existing clip from Drive)
       ↓
[3] Per-scene render (FFmpeg)
    Combine narration + video into one MP4 clip per scene, sync durations
       ↓
[4] Final assembly (FFmpeg)
    Crossfade all scene clips into one final.mp4
       ↓
[5] (Optional) Drive sync
    Upload raw clips + clips.json + description.md + final video to your Google Drive
    Delete local raw clips to save disk space
```

Time per video:
- **30-second test script**: 2–5 minutes
- **2–3 minute video**: 5–10 minutes
- **10-minute video**: 15–25 minutes
- **25-minute video**: 40–80 minutes

These are with ONE 69labs key. Each extra key roughly halves total time (parallel jobs).

---

## Library reuse — save credits on similar scenes

If you've connected Google Drive AND made a few runs already, the AI can browse your past clips and reuse ones that match new scenes — skipping video generation for those scenes entirely.

On the Video Conveyer page:

1. Paste script as usual
2. Click **Preview scenes first** (instead of Run pipeline)
3. The page shows the scene split + a button **Find existing clips from library**
4. Click it — the AI scores every scene against your Drive library and auto-checks matches at 80% confidence or higher
5. Review the checked picks — uncheck any you don't like, expand a scene to see alternative matches
6. Click **Run pipeline (reusing N clips)** — N scenes skip generation, the rest generate fresh

This pays off quickly. The more videos you make, the more matches the library finds.

For a dedicated, review-every-scene version of this, use the **Re-assembly** mode (below).

---

## Re-assembly — build from clips you already have

The **Re-assembly** tab builds a video mostly from clips already in your Google
Drive library — only the genuinely new scenes are generated fresh. It needs
Google Drive connected and a few past runs synced.

1. Open **Re-assembly**, pick a **Channel**, and paste your **Script**
2. Click **Analyze script & match library** — the AI splits the script into
   scenes and matches each one against your Drive library
3. Every scene is listed with its best-matching clip pre-selected. For each scene
   you can:
   - **keep** the AI's pick,
   - click a different **AI-suggested clip**,
   - **Browse library…** to assign *any* clip from your whole library, or
   - **Generate fresh** to have the video model make a new clip for that scene
4. The summary shows how many scenes are reused vs generated fresh
5. Click **Build video** — the run starts; reused scenes download from Drive, the
   rest generate with the video model (Veo by default), and every scene gets a voiceover

This is the cheapest way to make a new video once you have a clip library — every
reused scene is one video generation you don't pay for.

---

## Channel profiles — one profile per channel

If you run multiple YouTube channels with different styles, save a profile for each on the **Channels & Prompts** page. Each profile bundles:

- **Scene Split prompt** — the visual rules for this channel (required)
- **Voice** — this channel's own voice (optional — empty uses the global voice)
- **Animation Motion override** — this channel's motion style (optional — empty uses the global default)
- **Description** — a note for your own reference (optional)

Examples:

- *"Blue Zone Way"* — Mediterranean visuals, calm voice, dignified slow motion
- *"Tech Explainer"* — futuristic visuals, energetic voice, kinetic motion

On the Video Conveyer page, pick the channel from the **Channel** dropdown — the prompt, voice and motion all apply in one click. The run snapshots which profile it used, so deleting a profile later doesn't break old runs.

See [PROMPT-GUIDE.md](./PROMPT-GUIDE.md) for how to write the Scene Split prompt.

---

## After a run finishes

On the run's detail page (under Run history) you can:

- **Play the final video** right in the browser
- **Download MP4** — to upload to YouTube or edit further
- **See Drive sync status** — link to the run's folder in your Drive
- **Open run folder** — opens the local folder with all assets (audio MP3s, individual scene MP4s, final.mp4)
- **Read full logs** — every step of the pipeline, useful for debugging

If something went wrong mid-run (a scene failed, the LLM produced bad output), the page shows which scene + what error.

---

## Where your files live

Two separate locations — code and data are kept apart so updates can never destroy your work.

**Code** (replaced when you update to a new version):
- The **Conveyer Hum** project folder (e.g. `~/Documents/Conveyer Hum`)

**Data** (persistent — settings, run records, all your work):
- macOS / Linux: `~/.conveyer-hum/`
- Windows: `C:\Users\YOU\.conveyer-hum\`

Inside that folder:
- `hum.db` — your settings, API keys, prompts, presets, run history
- `runs/<run-folder>/` — per-run output (audio, animations, final.mp4)

You can change `runs/` location in **Keys & Settings → Pipeline tab → RUNS_OUTPUT_DIR** if you want runs on a different disk.

> **macOS users** — the folder starts with a dot so Finder hides it. Press **⌘ + Shift + .** in Finder to show hidden folders, or **⌘ + Shift + G** and paste `~/.conveyer-hum/`.

---

## Multi-key 69labs — running faster

Each 69labs account has hard limits: 7 parallel images + 5 parallel videos. With multiple accounts you multiply parallelism — 3 keys = 21 image / 15 video slots simultaneously.

To use multiple keys:

1. Go to **Keys & Settings → LABS69_API_KEY**
2. Paste each `vk_...` key on its own line (or separate them with commas)
3. **Save all changes**

The pipeline automatically load-balances jobs across all configured keys. Each key has its own concurrency counter; the next job goes to the least-loaded account.

The header on the New Run page shows current key count and effective parallel capacity. With N keys, expect roughly N× faster generation (limited by total video throughput across accounts).

---

## Common questions

### How long can my video be?

No hard limit. The pipeline handles scripts from 30 seconds to 30+ minutes. Longer scripts = more scenes = more generation time + more 69labs credits used.

### How long can each clip be?

Depends on the video model. The default **Veo 3.1 Fast** is not capped at 6 seconds. The **legacy Grok** model (via 69labs) returns fixed ~6-second clips — we cannot ask for longer. If your channel still uses Grok, the scene split prompt should keep each scene's narration ≤ 6 seconds so the visual doesn't freeze on the last frame.

### Can I edit the final video?

Yes — download the MP4 and open in any editor. All raw scene clips are also saved on disk (and Drive if sync is on) so you can swap individual scenes manually.

### What if a scene fails?

The pipeline retries each scene up to 3 times with exponential backoff. If a scene still fails after retries, the run continues — you'll see the failed scene in the logs and final video skips that scene (or fails the whole run if too many scenes fail). For now, the easiest fix is to re-run the pipeline; **Library reuse** will pick up the scenes that succeeded last time, so only the failed ones regenerate.

### Can I use different video models (Grok / Kling) instead of Veo?

Yes — **Keys & Settings → Pipeline tab → ANIMATION_MODEL**. Conveyer Hum defaults to `veo-video` (Veo 3.1 Fast via 69labs). You can switch to `grok-imagine-video` (legacy Grok, fixed ~6s clips) or other providers. Note that if you switch to Grok, you'll want scene-split prompts tuned for its 6-second clip length.

### Where are my videos uploaded?

If Drive sync is on:
- Final MP4 → `Conveyer Hum/Final Videos/<run-folder>.mp4` in your Drive
- Raw clips → `Conveyer Hum/Clips Library/<run-folder>/` (scene clips + `clips.json` metadata + `description.md` human-readable summary)

The "Conveyer Hum" root folder is separate from any other forks (Hum Conveyer, Conveyer Isabell, etc.) so you can run multiple variants without collisions.

### Why does the Clip Library show 0 clips for a run?

The **Library** page lists a run's clips only when that run's Drive **`clips.json` manifest** uploaded successfully *and* it contains clips. If the manifest upload failed or produced an empty manifest, the run shows 0 clips even though the video uploaded fine. (An earlier bug where some runs uploaded an empty manifest has been fixed — re-syncing the run regenerates a correct `clips.json`.)
