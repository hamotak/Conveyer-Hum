/**
 * Single source of truth for the settings form schema.
 *
 * Shared between /settings (only `MAIN_GROUPS`) and /advanced (only
 * `ADVANCED_GROUPS`). Editing a field's description here updates it on whatever
 * page renders that group.
 *
 * NOTE: only the settings relevant to Conveyer Hum's actual pipeline are
 * surfaced here. Less common keys (image model tuning, ElevenLabs voice
 * fine-tuning, animation ratio/distribution) still exist in SETTING_KEYS /
 * DEFAULTS so old DB rows and code paths don't break, but the main flow keeps
 * the UI focused on simple channel presets.
 */

export interface Field {
  key: string;
  label?: string;
  desc: string;
  examples?: string;
  required?: boolean;
  multiline?: boolean;
  /** When set, the field renders as a dropdown of these value/label pairs
   *  instead of a free-text input. The stored value is always `value`. */
  options?: { value: string; label: string }[];
}

export interface Group {
  title: string;
  subtitle?: string;
  required?: boolean;
  /** When true, the group renders collapsed (inside a closed <details>) so
   *  rarely-needed fields stay out of the way until expanded. */
  collapsed?: boolean;
  fields: Field[];
}

export const ALL_GROUPS: Group[] = [
  {
    title: "Main connections",
    subtitle: "The two services the app needs before it can create videos.",
    required: true,
    fields: [
      {
        key: "GOOGLE_API_KEY",
        label: "Script reader key",
        desc: "Lets Gemini read your script and turn it into clear video scenes.",
        examples: "Get it free at https://aistudio.google.com/app/apikey (Create API key)",
        required: true,
      },
      {
        key: "LABS69_API_KEY",
        label: "Video and voice key",
        desc: "Creates the AI video clips and the ElevenLabs voiceover through 69labs. You can paste more than one key to run more jobs at the same time.",
        examples: "Single key: vk_abc... · Multiple keys: paste each on its own line. Each starts with vk_",
        required: true,
        multiline: true,
      },
    ],
  },
  {
    title: "Storage Location",
    subtitle: "Where generated files are saved on this computer.",
    fields: [
      {
        key: "RUNS_OUTPUT_DIR",
        label: "Runs folder",
        desc: "Leave empty to use the default local runs folder. Change this only if you want videos saved somewhere specific.",
        examples: "Mac: /Users/you/Documents/Conveyer-Runs  ·  Windows: D:\\YouTube\\Conveyer-Runs",
      },
      {
        key: "FFMPEG_PATH",
        label: "FFmpeg path",
        desc: "Only needed if the app cannot find FFmpeg automatically.",
        examples: "Mac: /opt/homebrew/bin/ffmpeg  ·  Windows: C:\\ffmpeg\\bin\\ffmpeg.exe  ·  Leave empty if `ffmpeg` works in your terminal",
      },
    ],
  },
  {
    title: "Script Breakdown (LLM)",
    subtitle: "How the app divides a long script into usable scenes.",
    fields: [
      {
        key: "SCENE_SPLIT_PROVIDER",
        label: "Scene reader",
        desc: "Gemini is the recommended fast, cheap option. Claude can be used when you want a slower, more detailed read.",
        examples: "google  or  anthropic",
      },
      {
        key: "SCENE_SPLIT_MODEL",
        label: "Reader model",
        desc: "The exact model used for scene splitting. The default tracks the current stable Gemini Flash model.",
        examples: "gemini-flash-latest, gemini-2.5-flash, gemini-2.5-pro",
      },
    ],
  },
  {
    // Voice + Video creative fields (voice id/tuning, model, style, aspect ratio)
    // now live on each channel (and the New Run inline card). Only the technical
    // engine/model settings stay here as global defaults.
    title: "Voice engine",
    subtitle: "Global voiceover engine. Pick the actual voice on each channel.",
    fields: [
      {
        key: "TTS_PROVIDER",
        label: "TTS engine",
        desc: "Recommended: ElevenLabs through your existing 69labs key, so you do not need another account.",
        options: [
          { value: "69labs", label: "ElevenLabs via 69labs (recommended — no extra key needed)" },
          { value: "elevenlabs", label: "ElevenLabs direct (requires separate ElevenLabs API key)" },
          { value: "openai", label: "OpenAI TTS (requires OpenAI key)" },
          { value: "minimax", label: "MiniMax (legacy — direct MiniMax API)" },
        ],
      },
      {
        key: "TTS_MODEL",
        label: "ElevenLabs model",
        desc: "The default is a strong all-purpose ElevenLabs model.",
        examples: "eleven_multilingual_v2 (default)",
      },
      {
        key: "TTS_LANGUAGE_BOOST",
        label: "Language boost",
        desc: "Helps pronunciation. Use auto when the script language changes or you are unsure.",
        examples: "English (default)  ·  Spanish  ·  French  ·  auto",
      },
    ],
  },
  {
    title: "Video output",
    subtitle: "Global video engine settings. Style and aspect ratio live on each channel.",
    fields: [
      {
        key: "ANIMATION_PROVIDER",
        label: "Video engine",
        desc: "Keep this on 69labs for the main workflow.",
        examples: "69labs  (default)  ·  replicate  ·  fal",
      },
      {
        key: "ANIMATION_KEEP_VEO_AUDIO",
        label: "Keep model ambient audio",
        desc: "Leave empty for clean narration. Set to 1 only if you want the video model's background audio under the voiceover.",
        examples: "empty = mute (default)  ·  1 = keep ambient audio",
      },
      {
        key: "CLEAN_PROVIDER_WATERMARK",
        label: "Clean corner mark",
        desc: "Veo can add a small corner mark. Keep this on so generated clips are gently reframed before final assembly and Drive upload.",
        options: [
          { value: "1", label: "On (recommended)" },
          { value: "0", label: "Off" },
        ],
      },
      {
        key: "GENERATION_NEGATIVE_PROMPT",
        label: "Always avoid",
        desc: "Global negative prompt for generated images and image-to-video clips. Use this to block split screens, collages, text, logos, and visual styles you never want.",
        examples: "no split screen, no collage, no multi-panel layout, no side-by-side frames, no picture-in-picture, no text, no logos, no bright cheerful lighting unless explicitly requested",
        multiline: true,
      },
    ],
  },
  {
    title: "Video Assembly (FFmpeg)",
    subtitle: "The final stitching step: size, frame rate, and transitions.",
    fields: [
      {
        key: "VIDEO_RESOLUTION",
        label: "Final resolution",
        desc: "1920x1080 is the normal YouTube 1080p choice.",
        examples: "1920x1080, 1280x720, 3840x2160",
      },
      {
        key: "VIDEO_FPS",
        label: "Frame rate",
        desc: "24 feels cinematic. 30 is the common YouTube default. 60 is heavier and slower.",
        examples: "24, 30, 60",
      },
      {
        key: "TRANSITION_DURATION",
        label: "Crossfade length",
        desc: "0.5 is a gentle blend. 1.0 is smoother. 0 makes hard cuts.",
        examples: "0.5 = smooth  ·  1.0 = cinematic  ·  0 = no transitions",
      },
      // SCENE_TAIL_SILENCE removed from UI — deprecated: continuous-voiceover
      // (one continuous audio track means there are no inter-scene gaps to pad).
    ],
  },
  {
    title: "Performance (Concurrency)",
    subtitle: "How much work the app tries to do at the same time.",
    fields: [
      {
        key: "TTS_CONCURRENCY",
        label: "Voice jobs at once",
        desc: "Higher can be faster, but too high may hit provider limits.",
        examples: "default 3  ·  bump to 5–7 on higher-tier plans",
      },
      {
        key: "ANIMATION_CONCURRENCY",
        label: "Video jobs at once",
        desc: "The app now reads 69labs live capacity and waits when slots are full.",
        examples: "default 5  ·  max 5 per 69labs account",
      },
      {
        key: "ASSEMBLE_CONCURRENCY",
        label: "Assembly jobs at once",
        desc: "Controls local FFmpeg work. Higher uses more CPU.",
        examples: "default 4  ·  raise on 8+ core CPUs",
      },
      {
        key: "ASSEMBLE_XFADE_CHUNKS",
        label: "Long-video assembly chunks",
        desc: "Speeds up very long videos by stitching sections in parallel. Use 1 to turn it off.",
        examples: "1 = no chunking  ·  4 = default  ·  6-8 for 16+ core CPUs",
      },
    ],
  },
  {
    title: "Reliability & Scaling",
    subtitle: "Recovery behavior for big runs and library reuse.",
    fields: [
      {
        key: "FAILURE_THRESHOLD_PERCENT",
        label: "Failure tolerance",
        desc: "If providers are flaky, raising this lets a partial run survive so Resume can fill the missing parts later.",
        examples: "25 = default (strict)  ·  60-70 = tolerant (keep partial runs)  ·  100 = never abort",
      },
      {
        key: "AUTO_REUSE_THRESHOLD",
        label: "Reuse strictness",
        desc: "Higher means fewer but safer reused clips. Lower means more reuse and more risk of a mismatched clip.",
        examples: "80 = default  ·  90 = very strict  ·  70 = aggressive reuse",
      },
    ],
  },
  {
    title: "Rarely needed",
    subtitle: "Alternative providers and advanced fields most people never touch. Only matters if you switch away from the default Veo 3.1 + ElevenLabs stack, or use a non-69labs video model. Leave empty otherwise.",
    collapsed: true,
    fields: [
      {
        key: "IMAGE_PROVIDER",
        desc: "Service for first-frame image keyframes. Keep this on `69labs` for the default flow so the generated image job can be chained directly into 69labs video generation.",
        examples: "69labs (default)  ·  replicate  ·  openai  ·  fal",
      },
      {
        key: "IMAGE_MODEL",
        desc: "Image model used for the first frame of every generated scene. The default is tuned for 69labs image generation.",
        examples: "nano-banana-pro  ·  imagen-4  ·  seedream-4.5",
      },
      {
        key: "IMAGE_RESOLUTION",
        desc: "Image keyframe resolution for models that support it. Higher can improve detail but costs more and may take longer.",
        examples: "1k = default  ·  2k  ·  4k",
      },
      {
        key: "ELEVENLABS_API_KEY",
        desc: "Direct ElevenLabs API key. Only used when the TTS engine is set to `ElevenLabs direct`.",
        examples: "Sign up at https://elevenlabs.io → Profile → API Keys",
      },
      {
        key: "REPLICATE_API_TOKEN",
        desc: "Replicate token — for using Kling or other video models directly instead of the default 69labs model.",
        examples: "Sign up at https://replicate.com → Account → API Tokens",
      },
      {
        key: "FAL_API_KEY",
        desc: "fal.ai key — alternative to Replicate for video models.",
        examples: "Sign up at https://fal.ai → API keys",
      },
      {
        key: "ANTHROPIC_API_KEY",
        desc: "Anthropic Claude key. Only used when SCENE_SPLIT_PROVIDER is `anthropic`.",
        examples: "Sign up at https://console.anthropic.com",
      },
      {
        key: "OPENAI_API_KEY",
        desc: "OpenAI key — for backup TTS (gpt-4o-mini-tts) when the TTS engine is set to `OpenAI`.",
        examples: "Sign up at https://platform.openai.com",
      },
      {
        key: "ANIMATION_DURATION",
        desc: "Clip length in seconds. IGNORED by the 69labs models (Veo and Grok both return a fixed-length clip — 69labs hard-blocks the duration parameter). Only used for other providers (Kling via Replicate/fal).",
        examples: "empty = provider default  ·  4–10 = explicit (Kling/Replicate only)",
      },
      {
        key: "SCENE_DURATION_SECONDS",
        desc: "Fallback clip duration when TTS audio length is somehow unknown. In normal operation this is never used — we measure actual audio length with ffprobe.",
        examples: "default 5",
      },
    ],
  },
];

/** Groups that stay on /settings (Keys & Settings). */
export const MAIN_GROUPS: Group[] = ALL_GROUPS.filter(
  (g) => g.title === "Required API Keys"
);

/** Groups that move to /advanced. */
export const ADVANCED_GROUPS: Group[] = ALL_GROUPS.filter(
  (g) => g.title !== "Required API Keys"
);
