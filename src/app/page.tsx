"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePersistedState } from "./_use-persisted-state";
import { VoiceLibraryModal, type VoiceOption } from "./_voice-library-modal";
import { ChannelFields, type ChannelFieldsValue } from "./_channel-fields";
import { ConfirmDialog, type ConfirmRequest } from "./_confirm-dialog";
import { friendlyError } from "./_friendly-error";
import { estimateScript } from "@/lib/script-estimate";
import { resolveHybridFreshMinutes, resolveStockFolder } from "@/lib/channel-stock";
import type { PreflightResult } from "@/lib/preflight";
import {
  freshDurationError,
  getFreshDurationOptions,
  normalizeFreshAiPresetMinutes,
} from "@/lib/fresh-duration";

// Rough estimate: TTS narration averages ~150 words per minute
const WORDS_PER_MINUTE = 150;

// Per-job time estimates (in seconds), empirically tuned from production runs
const AVG_IMAGE_SEC = 90;
const AVG_GROK_VIDEO_SEC = 75; // Grok via 69labs averages ~60-90s per clip
const AVG_TTS_SEC = 4;
const AVG_CLIP_RENDER_SEC = 8;
const XFADE_FRAMES_PER_SEC = 1800;

interface StatsResp {
  keyCount: number;
  perKey: { image: number; tts: number; anim: number };
  total: { image: number; tts: number; anim: number };
  assembleConcurrency: number;
  xfadeChunks: number;
  animationEnabled: boolean;
  animationRatio: number;
  videoModelLabel: string;
}

interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
}

interface ClipMatch {
  new_scene_index: number;
  drive_file_id: string;
  score: number;
  reason: string;
  source: {
    run_title: string | null;
    folder_name: string;
    drive_file_link: string;
    scene_text: string;
    visual_prompt: string;
    audio_duration_sec: number | null;
  };
}

interface GdriveStatus {
  connected: boolean;
}

interface ActionNotice {
  kind: "error" | "warning" | "info";
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}

function NoticeCard({ notice, onDismiss }: { notice: ActionNotice; onDismiss: () => void }) {
  const isError = notice.kind === "error";
  const isWarning = notice.kind === "warning";
  const color = isError ? "var(--danger)" : isWarning ? "var(--warning)" : "var(--accent-hover)";
  const background = isError ? "var(--danger-soft)" : isWarning ? "var(--warning-soft)" : "var(--accent-soft)";
  const borderColor = isError
    ? "rgba(248,113,113,0.35)"
    : isWarning
      ? "rgba(252,211,77,0.35)"
      : "rgba(226,54,54,0.35)";

  return (
    <div
      role={isError ? "alert" : "status"}
      className="card-inset"
      style={{
        padding: "11px 13px",
        borderColor,
        background,
        display: "flex",
        gap: 12,
        justifyContent: "space-between",
        alignItems: "flex-start",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color, fontWeight: 750, fontSize: 13 }}>{notice.title}</div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.55, marginTop: 3, whiteSpace: "pre-line" }}>
          {notice.body}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {notice.actionHref && (
          <Link className="btn-secondary btn-sm" href={notice.actionHref}>
            {notice.actionLabel ?? "Open"}
          </Link>
        )}
        <button type="button" className="btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Maps a global setting key ↔ each ChannelFields field. */
const INLINE_KEY: Record<keyof ChannelFieldsValue, string> = {
  stylePresetId: "STYLE_PRESET_ID",
  videoStyle: "VIDEO_STYLE",
  videoModel: "ANIMATION_MODEL",
  aspectRatio: "IMAGE_RATIO",
  voiceSpeed: "TTS_SPEED",
  voiceStability: "TTS_STABILITY",
  voiceSimilarity: "TTS_SIMILARITY_BOOST",
  voiceStyle: "TTS_STYLE",
};

/** Run-relevant globals, editable on the New Run page when no channel is picked.
 *  Shares the channel form's layout (Style preset / Voice / Video) bound to globals. */
function InlineSettingsCard({
  settings,
  onChange,
  selectedVoiceLabel,
  onOpenVoicePicker,
}: {
  settings: Record<string, string>;
  onChange: (key: string, value: string) => void;
  selectedVoiceLabel: string | null;
  onOpenVoicePicker: () => void;
}) {
  const cf: ChannelFieldsValue = {
    stylePresetId: settings.STYLE_PRESET_ID || "sleep-calm",
    videoStyle: settings.VIDEO_STYLE ?? "",
    videoModel: settings.ANIMATION_MODEL || "veo-3.1-fast",
    aspectRatio: settings.IMAGE_RATIO || "16:9",
    voiceSpeed: settings.TTS_SPEED ?? "",
    voiceStability: settings.TTS_STABILITY ?? "",
    voiceSimilarity: settings.TTS_SIMILARITY_BOOST ?? "",
    voiceStyle: settings.TTS_STYLE ?? "",
  };
  function applyPatch(patch: Partial<ChannelFieldsValue>) {
    for (const [k, v] of Object.entries(patch)) {
      onChange(INLINE_KEY[k as keyof ChannelFieldsValue], v as string);
    }
  }
  // No wrapper box/header: this renders inside the home "Options" drawer, which
  // already provides the grouping — avoids card-inside-card nesting.
  return (
    <ChannelFields
      value={cf}
      onChange={applyPatch}
      voiceLabel={selectedVoiceLabel}
      onOpenVoicePicker={onOpenVoicePicker}
    />
  );
}

export default function NewRunPage() {
  // Persisted across navigation so a pasted script isn't lost on a tab switch.
  const [title, setTitle] = usePersistedState("newrun.title", "");
  const [script, setScript] = usePersistedState("newrun.script", "");
  // Per-run generation mode. fresh-minutes + stock folder are owned by the
  // selected channel (set in Channels), so there are no per-run knobs here.
  const [mode, setMode] = usePersistedState<"full" | "hybrid" | "stock">("newrun.mode", "hybrid");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [drive, setDrive] = useState<GdriveStatus | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);

  // Library preview state
  const [scenes, setScenes] = useState<Scene[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [matches, setMatches] = useState<ClipMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [reuseMap, setReuseMap] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // Channel is required — employees pick a pre-configured channel and run.
  const [presets, setPresets] = useState<
    {
      id: number;
      name: string;
      video_style: string | null;
      voice_id: string | null;
      voice_speed: number | null;
      stock_folder: string | null;
      hybrid_fresh_minutes: number | null;
      scene_end_pause_seconds: number | null;
    }[]
  >([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = usePersistedState<number | null>(
    "newrun.channel",
    null
  );
  const [hybridFreshMinutes, setHybridFreshMinutes] = usePersistedState("newrun.hybridFresh", "1");
  const hybridTouched = useRef(false);
  // Library search scope — by default only the selected channel; opt into all.
  const [crossChannel, setCrossChannel] = useState(false);

  // Library reuse mode. Auto: the pipeline finds + reuses clips itself (no
  // clicking). Manual: preview scenes and pick clips by hand in the section below.
  const [reuseMode, setReuseMode] = usePersistedState<"auto" | "manual">(
    "newrun.reuseMode",
    "auto"
  );

  // Global run settings — editable inline on this page when no channel is
  // selected. Writes go to the same /api/settings store the Advanced page uses.
  const [settings, setSettings] = useState<Record<string, string>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Record<string, string>>({});
  function updateSetting(key: string, value: string) {
    setSettings((s) => ({ ...s, [key]: value }));
    pendingRef.current[key] = value;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const body = pendingRef.current;
      pendingRef.current = {};
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }, 600);
  }

  // Voice library picker (global voice).
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [selectedVoiceLabel, setSelectedVoiceLabel] = useState<string | null>(null);
  // Resolve the current global voice id → a human label for the picker button.
  useEffect(() => {
    const vid = settings.TTS_VOICE_ID;
    if (!vid) {
      setSelectedVoiceLabel(null);
      return;
    }
    fetch("/api/voices")
      .then((r) => r.json())
      .then((j: { voices: VoiceOption[] }) => {
        const match = j.voices?.find((v) => v.voiceId === vid);
        setSelectedVoiceLabel(match ? match.name : vid);
      })
      .catch(() => setSelectedVoiceLabel(vid));
  }, [settings.TTS_VOICE_ID]);

  function onSelectVoice(v: VoiceOption) {
    updateSetting("TTS_VOICE_ID", v.voiceId);
    updateSetting("TTS_VOICE_PROVIDER", v.provider);
    setSelectedVoiceLabel(v.name);
    setVoiceModalOpen(false);
  }

  const AUTO_PICK_THRESHOLD = 80;
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("mode");
    if (requestedMode === "full" || requestedMode === "hybrid" || requestedMode === "stock") {
      setMode(requestedMode);
      params.delete("mode");
      const qs = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, [setMode]);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setStats(null));
    fetch("/api/gdrive/status")
      .then((r) => r.json())
      .then(setDrive)
      .catch(() => setDrive(null));
    fetch("/api/prompt-presets")
      .then((r) => r.json())
      .then((list: typeof presets) => {
        setPresets(list);
      })
      .catch(() => setPresets([]))
      .finally(() => setPresetsLoaded(true));
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => setSettings({}));
    fetch("/api/preflight")
      .then((r) => r.json())
      .then(setPreflight)
      .catch(() => setPreflight(null));
  }, []);

  useEffect(() => {
    if (!presetsLoaded) return;
    const selectedExists = selectedPresetId != null && presets.some((p) => p.id === selectedPresetId);
    if (selectedExists) return;
    setSelectedPresetId(presets.length === 1 ? presets[0].id : null);
  }, [presets, presetsLoaded, selectedPresetId, setSelectedPresetId]);

  const selectedPreset = useMemo(
    () => (selectedPresetId != null ? presets.find((p) => p.id === selectedPresetId) ?? null : null),
    [presets, selectedPresetId]
  );

  const effectivePreflight = useMemo<PreflightResult | null>(() => {
    if (!preflight) return null;
    const channelVoice = selectedPreset?.voice_id?.trim();
    if (!channelVoice) return preflight;
    const checks = preflight.checks.map((c) =>
      c.id === "voice" && c.status === "fail"
        ? {
            ...c,
            status: "ok" as const,
            detail: "This channel has its own voice selected, so this run can use it.",
          }
        : c
    );
    return {
      checks,
      ready: checks.every((c) => !c.required || c.status === "ok"),
    };
  }, [preflight, selectedPreset]);

  const requiredPreflightFailures = useMemo(
    () => effectivePreflight?.checks.filter((c) => c.required && c.status === "fail") ?? [],
    [effectivePreflight]
  );

  const resolvedStockFolder = useMemo(() => {
    if (!selectedPreset) return (settings.STOCK_LIBRARY_FOLDER || "Pirates").trim() || "Pirates";
    return resolveStockFolder(
      selectedPreset.name,
      selectedPreset.stock_folder,
      settings.STOCK_LIBRARY_FOLDER
    );
  }, [selectedPreset, settings.STOCK_LIBRARY_FOLDER]);

  const freshMin = normalizeFreshAiPresetMinutes(hybridFreshMinutes);

  // Load fresh minutes from the channel when it changes (unless user dragged the slider).
  useEffect(() => {
    if (!selectedPreset || hybridTouched.current) return;
    const globalFresh = settings.HYBRID_FRESH_MINUTES;
    const fromChannel = resolveHybridFreshMinutes(selectedPreset.hybrid_fresh_minutes, globalFresh);
    setHybridFreshMinutes(String(normalizeFreshAiPresetMinutes(fromChannel)));
  }, [selectedPreset, settings.HYBRID_FRESH_MINUTES, setHybridFreshMinutes]);

  const scriptStats = useMemo(() => {
    const text = script.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.length;
    const seconds = (words / WORDS_PER_MINUTE) * 60;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return {
      words,
      chars,
      duration: words === 0 ? "0 min" : m > 0 ? `${m} min ${s} s` : `${s} s`,
      scenes: words === 0 ? 0 : Math.max(1, Math.round(seconds / 5)),
      narrationSeconds: seconds,
    };
  }, [script]);

  // Shared long-run estimate (drives the preflight confirm + the "long video" note).
  const scriptEstimate = useMemo(() => estimateScript(scriptStats.words), [scriptStats.words]);
  const freshOptions = useMemo(() => getFreshDurationOptions(script), [script]);
  const bestSupportedFreshMinutes = useMemo(() => {
    let best: number | null = null;
    for (const option of freshOptions) {
      if (option.supported) best = option.minutes;
    }
    return best;
  }, [freshOptions]);
  const hybridShortScriptFallback = mode === "hybrid" && script.trim().length > 0 && bestSupportedFreshMinutes == null;
  const effectiveFreshMin = normalizeFreshAiPresetMinutes(
    bestSupportedFreshMinutes == null ? freshMin : Math.min(freshMin, bestSupportedFreshMinutes)
  );

  useEffect(() => {
    if (mode !== "hybrid" || !script.trim() || bestSupportedFreshMinutes == null) return;
    if (freshMin > bestSupportedFreshMinutes) {
      setHybridFreshMinutes(String(bestSupportedFreshMinutes));
    }
  }, [bestSupportedFreshMinutes, freshMin, mode, script, setHybridFreshMinutes]);

  const freshSelectionError = useMemo(
    () => (mode === "hybrid" && script.trim() && !hybridShortScriptFallback ? freshDurationError(script, effectiveFreshMin) : null),
    [effectiveFreshMin, hybridShortScriptFallback, mode, script]
  );

  const timeEstimate = useMemo(() => {
    if (!stats || scriptStats.scenes === 0) return null;
    const N = scriptStats.scenes;
    const imageMin = (Math.ceil(N / stats.total.image) * AVG_IMAGE_SEC) / 60;
    const animScenes = stats.animationEnabled ? Math.ceil(N * (stats.animationRatio / 100)) : 0;
    const animMin =
      animScenes > 0 ? (Math.ceil(animScenes / stats.total.anim) * AVG_GROK_VIDEO_SEC) / 60 : 0;
    const ttsMin = (Math.ceil(N / stats.total.tts) * AVG_TTS_SEC) / 60;
    const phase1 = Math.max(imageMin, animMin, ttsMin);
    const phase2 = (Math.ceil(N / stats.assembleConcurrency) * AVG_CLIP_RENDER_SEC) / 60;
    const totalFrames = scriptStats.narrationSeconds * 30;
    const chunks = stats.xfadeChunks;
    const phase3 = totalFrames / chunks / XFADE_FRAMES_PER_SEC / 60;
    const total = phase1 + phase2 + phase3;
    return { total, phase1, phase2, phase3, imageMin, animMin, ttsMin, animScenes };
  }, [stats, scriptStats]);

  const matchesByScene = useMemo(() => {
    const m = new Map<number, ClipMatch[]>();
    for (const x of matches ?? []) {
      const list = m.get(x.new_scene_index) ?? [];
      list.push(x);
      m.set(x.new_scene_index, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.score - a.score);
    return m;
  }, [matches]);

  useEffect(() => {
    if (!matches || matches.length === 0) return;
    const auto: Record<number, string> = {};
    for (const [sceneIdx, list] of matchesByScene.entries()) {
      const best = list[0];
      if (best && best.score >= AUTO_PICK_THRESHOLD) {
        auto[sceneIdx] = best.drive_file_id;
      }
    }
    setReuseMap(auto);
    setExpanded({});
  }, [matches, matchesByScene]);

  const reuseCount = Object.keys(reuseMap).length;
  const actionHelp = useMemo(() => {
    if (!presetsLoaded) return "Loading channels before actions are available.";
    if (!selectedPreset) return "Pick a channel before running or previewing.";
    if (!script.trim()) return "Paste a script to enable Run and scene preview.";
    if (freshSelectionError) return freshSelectionError;
    if (hybridShortScriptFallback) return "Ready. This short script has no B-roll tail yet, so Run will use Full Render automatically.";
    if (!effectivePreflight) return "Checking setup before Run becomes available.";
    if (requiredPreflightFailures.length > 0) return "Fix the setup items shown below before running.";
    return mode === "stock"
      ? "Ready. Stock Cut uses your channel B-roll over one continuous voiceover."
      : "Ready. Hybrid keeps a fresh AI opening and uses channel B-roll for the long tail.";
  }, [effectivePreflight, freshSelectionError, hybridShortScriptFallback, mode, presetsLoaded, requiredPreflightFailures.length, script, selectedPreset]);
  const actionHelpId = "newrun-action-help";

  async function previewScenes() {
    if (!script.trim()) return;
    setPreviewing(true);
    setNotice(null);
    setMatches(null);
    setReuseMap({});
    try {
      const r = await fetch("/api/preview/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, presetId: selectedPreset?.id ?? null }),
      });
      const j = await r.json();
      if (!r.ok) {
        setNotice({
          kind: "error",
          title: "Scene preview failed",
          body: friendlyError(j.error || r.statusText, "Scene preview failed. Try again after checking Settings."),
        });
        return;
      }
      setScenes(j.scenes as Scene[]);
    } finally {
      setPreviewing(false);
    }
  }

  async function findClips() {
    if (!scenes) return;
    setSearching(true);
    setNotice(null);
    try {
      // Scope the search: the selected channel by default, or every channel
      // when the cross-channel toggle is on.
      const channelName = selectedPreset ? selectedPreset.name : "_No Channel";
      const r = await fetch("/api/library/find-similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenes, channel: crossChannel ? null : channelName }),
      });
      const j = await r.json();
      if (!r.ok) {
        setNotice({
          kind: "error",
          title: "Clip search failed",
          body: friendlyError(j.error || r.statusText, "Clip search failed. Check Drive or try again."),
          actionHref: "/clips",
          actionLabel: "Open Clips",
        });
        return;
      }
      setMatches(j.matches as ClipMatch[]);
    } finally {
      setSearching(false);
    }
  }

  function toggleReuse(sceneIndex: number, fileId: string) {
    setReuseMap((prev) => {
      const copy = { ...prev };
      if (copy[sceneIndex] === fileId) delete copy[sceneIndex];
      else copy[sceneIndex] = fileId;
      return copy;
    });
  }

  function clearDraft(confirmFirst = true) {
    if (confirmFirst && (title.trim() || script.trim())) {
      setConfirming({
        title: "Clear this draft?",
        body: "The current title, script, scene preview, and clip picks will be cleared from this browser.",
        confirmLabel: "Clear draft",
        danger: true,
        onConfirm: () => clearDraft(false),
      });
      return;
    }
    setTitle("");
    setScript("");
    setScenes(null);
    setMatches(null);
    setReuseMap({});
    setExpanded({});
    setNotice(null);
  }

  async function start(skipLongConfirm = false) {
    if (!selectedPreset) {
      setNotice({
        kind: "warning",
        title: "Pick a channel first",
        body: "The channel controls the voice, look, and B-roll folder for the run.",
        actionHref: "/prompts",
        actionLabel: "Open Channels",
      });
      return;
    }
    if (!effectivePreflight) {
      setNotice({
        kind: "warning",
        title: "Setup check is still loading",
        body: "Wait a moment, then press Run again. The app checks keys, voice, FFmpeg, and output folders before spending credits.",
      });
      return;
    }
    if (requiredPreflightFailures.length > 0) {
      setNotice({
        kind: "warning",
        title: "Not ready to run",
        body: requiredPreflightFailures.map((c) => `${c.label}: ${c.detail}`).join("\n"),
        actionHref: "/settings",
        actionLabel: "Open Settings",
      });
      return;
    }
    if (freshSelectionError) {
      setNotice({
        kind: "warning",
        title: "Fresh AI needs more script",
        body: freshSelectionError,
      });
      return;
    }
    // Long scripts: warn + require confirmation (short runs are never blocked).
    if (scriptEstimate.isLong && !skipLongConfirm) {
      setConfirming({
        title: "Start this long run?",
        body: `${scriptEstimate.warnings.join("\n\n")}\n\nThis may take a long time and can use generation credits.`,
        confirmLabel: "Start long run",
        danger: true,
        onConfirm: () => start(true),
      });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const runMode = mode === "hybrid" && hybridShortScriptFallback ? "full" : mode;
      const body: {
        title?: string;
        script: string;
        reuseMap?: Record<number, string>;
        presetId?: number | null;
        autoReuse: boolean;
        mode: "full" | "hybrid" | "stock";
        hybridFreshMinutes?: number;
        stockFolder?: string;
      } = { title, script, autoReuse: reuseMode === "auto", mode: runMode };
      if (runMode === "hybrid") {
        body.hybridFreshMinutes = effectiveFreshMin;
      }
      if (runMode === "hybrid" || runMode === "stock") {
        body.stockFolder = resolvedStockFolder;
      }
      if (reuseCount > 0) body.reuseMap = reuseMap;
      body.presetId = selectedPreset.id;
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text();
        const parsedError = (() => {
          try {
            const j = JSON.parse(text) as { error?: string };
            return j.error || text;
          } catch {
            return text;
          }
        })();
        setNotice({
          kind: "error",
          title: "Run could not start",
          body: friendlyError(parsedError || r.statusText, "Run could not start. Check Settings and try again."),
        });
        return;
      }
      const data = (await r.json()) as { id: string };
      clearDraft(false);
      router.push(`/runs/${data.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />

      <h1>New Video</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
        Pick your channel, paste the script, press Run.
      </p>

      {!presetsLoaded ? (
        <div className="empty-state card" aria-busy="true">
          <div className="empty-state-title">Loading channels</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.5 }}>
            Checking your saved voice, style, and B-roll setup.
          </p>
        </div>
      ) : presets.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-state-title">Set up a channel first</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px", lineHeight: 1.5 }}>
            A channel holds the voice, visual style, and B-roll library. Create one, then come back here to run videos.
          </p>
          <Link href="/prompts" className="btn">Go to Channels</Link>
        </div>
      ) : (
      <div className="card" style={{ display: "grid", gap: 16 }}>
        <div>
          <label className="label" htmlFor="newrun-title">Title (optional)</label>
          <input
            id="newrun-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Okinawa Longevity — Test 1"
          />
        </div>

        <div>
          <label className="label" htmlFor="newrun-channel">Channel</label>
          <select
            id="newrun-channel"
            className="input"
            value={selectedPresetId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedPresetId(v === "" ? null : Number(v));
              hybridTouched.current = false;
              setScenes(null);
              setMatches(null);
              setNotice(null);
            }}
          >
            <option value="" disabled>Select channel…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Generation mode — Full Render / Hybrid / Stock Cut (cards only;
            stock folder + fresh minutes are owned by the channel). */}
        <div>
          <label className="label">How should it make the video?</label>
          <div className="mode-grid">
            {([
              { id: "full", title: "Full Render", desc: "Every scene a fresh AI clip, synced to the voice. Richest, slowest." },
              { id: "hybrid", title: "Hybrid", tag: "Recommended", desc: "Fresh AI opening, the rest from the channel's stock library. Fast & cheap." },
              { id: "stock", title: "Stock Cut", desc: "Entirely the channel's stock library over one continuous voice. Fastest." },
            ] as const).map((m) => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-label={`Select ${m.title} mode`}
                  aria-pressed={active}
                  onClick={() => setMode(m.id)}
                  className="card-inset"
                  style={{
                    textAlign: "left",
                    padding: 13,
                    cursor: "pointer",
                    background: active ? "var(--accent-soft)" : "var(--field)",
                    borderColor: active ? "var(--accent)" : "var(--border)",
                    transition: "border-color .13s, background .13s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{m.title}</span>
                    {active && <span style={{ color: "var(--accent)" }}>✓</span>}
                    {"tag" in m && m.tag && !active && <span className="badge badge-accent">{m.tag}</span>}
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{m.desc}</div>
                </button>
              );
            })}
          </div>

          {mode === "hybrid" && (
            <div className="fresh-preset-panel">
              <div className="fresh-preset-head">
                <div>
                  <span className="fresh-preset-label">Fresh AI opening</span>
                  <p className="fresh-preset-copy">
                    Pick how much of the opening gets custom AI video. Longer choices unlock when the script is long enough.
                  </p>
                </div>
                <span className="fresh-preset-value">
                  {hybridShortScriptFallback ? "Full" : effectiveFreshMin}<span>{hybridShortScriptFallback ? " render" : " min"}</span>
                </span>
              </div>
              <div className="fresh-preset-grid" role="radiogroup" aria-label="Fresh AI opening length">
                {freshOptions.map((option) => {
                  const disabled = !script.trim() || !option.supported;
                  const selected = effectiveFreshMin === option.minutes && !disabled;
                  return (
                    <button
                      key={option.minutes}
                      type="button"
                      className={`fresh-preset-card${selected ? " selected" : ""}`}
                      disabled={disabled}
                      aria-checked={selected}
                      role="radio"
                      title={option.reason ?? undefined}
                      onClick={() => {
                        hybridTouched.current = true;
                        setHybridFreshMinutes(String(option.minutes));
                      }}
                    >
                      <span className="fresh-preset-minutes">{option.minutes} min</span>
                      <span className="fresh-preset-status">
                        {!script.trim()
                          ? "Paste script"
                          : option.supported
                            ? "Available"
                            : "Needs longer script"}
                      </span>
                    </button>
                  );
                })}
              </div>
              {hybridShortScriptFallback ? (
                <p className="fresh-preset-hint">
                  This script is shorter than a 1 minute opening, so Run will use Full Render automatically instead of blocking you.
                </p>
              ) : freshSelectionError ? (
                <p className="fresh-preset-hint warning">{freshSelectionError}</p>
              ) : scriptStats.words > 0 ? (
                <p className="fresh-preset-hint">
                  <strong>{effectiveFreshMin} min</strong> of synced AI clips, then{" "}
                  <strong>~{Math.max(0, Math.round(scriptStats.narrationSeconds / 60) - effectiveFreshMin)} min</strong> of
                  stock B-roll from your channel.
                </p>
              ) : (
                <p className="fresh-preset-hint">Paste a script to unlock the Fresh AI presets.</p>
              )}
            </div>
          )}
        </div>

        {/* Script — the composer's center. */}
        <div>
          <label className="label" htmlFor="newrun-script">Script</label>
          <textarea
            id="newrun-script"
            className="textarea"
            rows={14}
            value={script}
            onChange={(e) => {
              setScript(e.target.value);
              setScenes(null);
              setMatches(null);
              setReuseMap({});
              setNotice(null);
            }}
            placeholder="Paste the full narrator script here…"
          />
          <div
            className="faint"
            style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 12, flexWrap: "wrap" }}
          >
            <span>{scriptStats.words} words</span>
            <span>{scriptStats.words === 0 ? "0 min video" : `≈ ${scriptStats.duration} video`}</span>
            <span>
              {scriptStats.scenes === 0
                ? "0 scenes"
                : `≈ ${scriptStats.scenes} short clip${scriptStats.scenes === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        {/* Primary actions — always visible directly under the script. */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn"
            onClick={() => start()}
            disabled={busy || !script.trim() || !selectedPreset || effectivePreflight?.ready !== true || !!freshSelectionError}
            title={
              freshSelectionError ??
              (effectivePreflight?.ready === false ? "Fix the setup items below before running." : undefined)
            }
            aria-describedby={actionHelpId}
          >
            {busy
              ? "Starting…"
              : reuseCount > 0
                ? `Run · reusing ${reuseCount} clip${reuseCount === 1 ? "" : "s"}`
                : "Run"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => clearDraft(true)}
            disabled={busy || (!title.trim() && !script.trim() && !scenes)}
          >
            Clear draft
          </button>
        </div>

        <details className="advanced-actions">
          <summary>Advanced manual tools</summary>
          <div className="advanced-actions-body">
            <p className="muted" style={{ flexBasis: "100%", margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
              Optional legacy controls for inspecting splits or manually reusing clips. Normal runs do not need these.
            </p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                if (scenes) {
                  setScenes(null);
                  setMatches(null);
                  setReuseMap({});
                  setExpanded({});
                  return;
                }
                void previewScenes();
              }}
              disabled={busy || previewing || !script.trim() || !selectedPreset}
              aria-describedby={actionHelpId}
            >
              {previewing ? "Previewing…" : scenes ? "Hide script split" : "Preview script split"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                if (reuseMode === "manual") {
                  setReuseMode("auto");
                  setMatches(null);
                  setReuseMap({});
                  setExpanded({});
                  return;
                }
                setReuseMode("manual");
                if (!scenes) void previewScenes();
              }}
              disabled={busy || previewing || !script.trim() || !selectedPreset}
              aria-describedby={actionHelpId}
            >
              {reuseMode === "manual" ? "Use automatic reuse" : "Manual clip picker"}
            </button>
          </div>
        </details>
        <p id={actionHelpId} className="faint" style={{ margin: "-4px 0 0", fontSize: 12.5 }}>
          {actionHelp}
        </p>

        {notice && <NoticeCard notice={notice} onDismiss={() => setNotice(null)} />}

        {/* Preflight — required checks gate the run; failures link to Settings. */}
        {!effectivePreflight && (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: "9px 12px",
              borderRadius: "var(--r-sm)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              color: "var(--fg-muted)",
            }}
          >
            Checking setup before Run becomes available.
          </div>
        )}

        {effectivePreflight && !effectivePreflight.ready && (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: "9px 12px",
              borderRadius: "var(--r-sm)",
              background: "var(--warning-soft)",
              border: "1px solid rgba(252,211,77,0.3)",
              color: "var(--warning)",
            }}
          >
            <strong>Not ready to run.</strong>{" "}
            {requiredPreflightFailures.map((c) => c.label).join(", ")} —{" "}
            fix in <a href="/settings">Settings</a>.
          </div>
        )}
      </div>
      )}

      {/* Scene preview — only when explicitly split (hidden from default employee flow) */}
      {scenes && scenes.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ marginBottom: 2 }}>Legacy script split preview · {scenes.length}</h2>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {reuseMode === "auto"
                  ? "Auto reuse is on — the app handles library clips for you. This is just a preview of the split."
                  : "Reuse clips from past runs to skip generation — saves time and credits."}
              </div>
            </div>
            {reuseMode === "manual" && (drive?.connected ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <button className="btn-secondary btn-sm" onClick={findClips} disabled={searching}>
                  {searching
                    ? "Searching library…"
                    : matches
                      ? "Search again"
                      : "Find existing clips"}
                </button>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11.5,
                    color: "var(--fg-muted)",
                    cursor: "pointer",
                  }}
                  title="By default the search is scoped to the selected channel. Tick this to search across every channel."
                >
                  <input
                    type="checkbox"
                    checked={crossChannel}
                    onChange={(e) => setCrossChannel(e.target.checked)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  Search all channels
                </label>
              </div>
            ) : (
              <a className="btn-secondary btn-sm" href="/settings" title="Connect Google Drive to enable library search">
                Connect Drive to search
              </a>
            ))}
          </div>

          {matches !== null && matches.length === 0 && (
            <div
              className="card-inset"
              style={{ marginBottom: 12, padding: "10px 12px", color: "var(--fg-muted)", fontSize: 12.5 }}
            >
              No similar clips found in your library — every scene will be generated from scratch.
            </div>
          )}

          {matches !== null && matches.length > 0 && (
            <div
              style={{
                marginBottom: 14,
                padding: "11px 13px",
                background: reuseCount > 0 ? "var(--success-soft)" : "var(--surface-2)",
                border: `1px solid ${reuseCount > 0 ? "rgba(74,222,128,0.3)" : "var(--border)"}`,
                borderRadius: "var(--r-sm)",
                fontSize: 13,
                color: reuseCount > 0 ? "var(--success)" : "var(--fg-muted)",
                lineHeight: 1.55,
              }}
            >
              {reuseCount > 0 ? (
                <>
                  Auto-picked {reuseCount} clip{reuseCount === 1 ? "" : "s"} at ≥{AUTO_PICK_THRESHOLD}% confidence.
                  Other scenes generate fresh. Click any scene below to inspect or change the pick.
                </>
              ) : (
                <>
                  Found {matches.length} suggestion{matches.length === 1 ? "" : "s"} across{" "}
                  {matchesByScene.size} scene{matchesByScene.size === 1 ? "" : "s"}, but none passed the{" "}
                  {AUTO_PICK_THRESHOLD}% auto-pick threshold. Click a scene to review and pick manually.
                </>
              )}
              <div style={{ marginTop: 9, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    const all: Record<number, boolean> = {};
                    for (const idx of matchesByScene.keys()) all[idx] = true;
                    setExpanded(all);
                  }}
                >
                  Expand all
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded({})}>
                  Collapse all
                </button>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 6 }}>
            {scenes.map((scene) => {
              const sceneMatches = matchesByScene.get(scene.index) ?? [];
              const picked = reuseMap[scene.index];
              const pickedMatch = picked ? sceneMatches.find((m) => m.drive_file_id === picked) : null;
              const bestScore = sceneMatches[0]?.score ?? 0;
              const isExpanded = !!expanded[scene.index];

              let statusBadge: React.ReactNode = null;
              if (pickedMatch) {
                statusBadge = (
                  <span className="badge badge-success">✓ reusing {pickedMatch.score}%</span>
                );
              } else if (sceneMatches.length > 0 && bestScore >= AUTO_PICK_THRESHOLD) {
                statusBadge = (
                  <span className="badge" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
                    will generate new
                  </span>
                );
              } else if (sceneMatches.length > 0) {
                statusBadge = (
                  <span className="badge badge-neutral">
                    {sceneMatches.length} low-confidence
                  </span>
                );
              }

              return (
                <div
                  key={scene.index}
                  className="card-inset"
                  style={{ borderColor: pickedMatch ? "rgba(74,222,128,0.3)" : undefined }}
                >
                  <div
                    style={{
                      padding: "9px 11px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: sceneMatches.length > 0 ? "pointer" : "default",
                    }}
                    onClick={() => {
                      if (sceneMatches.length === 0) return;
                      setExpanded((prev) => ({ ...prev, [scene.index]: !prev[scene.index] }));
                    }}
                  >
                    <span style={{ fontWeight: 650, fontSize: 12.5, minWidth: 62 }}>
                      Scene {scene.index + 1}
                    </span>
                    <span
                      style={{
                        color: "var(--fg-muted)",
                        fontSize: 12.5,
                        flex: 1,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={scene.text}
                    >
                      {scene.text}
                    </span>
                    {statusBadge}
                    {sceneMatches.length > 0 && (
                      <span style={{ color: "var(--fg-faint)", fontSize: 11, width: 12, textAlign: "center" }}>
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    )}
                  </div>

                  {isExpanded && (
                    <div style={{ padding: "0 11px 11px", borderTop: "1px solid var(--border)" }}>
                      <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.5, margin: "9px 0 4px" }}>
                        {scene.text}
                      </div>
                      <div
                        className="mono"
                        style={{ color: "var(--accent-hover)", fontSize: 11, lineHeight: 1.45, marginBottom: 10 }}
                      >
                        {scene.visual_prompt}
                      </div>
                      {sceneMatches.length > 0 && (
                        <div style={{ display: "grid", gap: 6 }}>
                          <div className="muted" style={{ fontSize: 11, fontWeight: 600 }}>
                            Suggestions (sorted by confidence):
                          </div>
                          {sceneMatches.map((m) => {
                            const isPicked = picked === m.drive_file_id;
                            return (
                              <label
                                key={m.drive_file_id}
                                style={{
                                  display: "flex",
                                  gap: 10,
                                  padding: 9,
                                  background: isPicked ? "var(--success-soft)" : "var(--surface)",
                                  border: `1px solid ${isPicked ? "rgba(74,222,128,0.3)" : "var(--border)"}`,
                                  borderRadius: "var(--r-sm)",
                                  cursor: "pointer",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isPicked}
                                  onChange={() => toggleReuse(scene.index, m.drive_file_id)}
                                  style={{ marginTop: 3, accentColor: "var(--accent)" }}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 8,
                                      alignItems: "baseline",
                                      flexWrap: "wrap",
                                      marginBottom: 4,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 12,
                                        fontWeight: 650,
                                        color: m.score >= AUTO_PICK_THRESHOLD ? "var(--success)" : "var(--warning)",
                                      }}
                                    >
                                      {m.score}% match
                                      {m.score >= AUTO_PICK_THRESHOLD ? " · auto-pick" : ""}
                                    </span>
                                    <span className="faint" style={{ fontSize: 11 }}>
                                      from &quot;{m.source.run_title || m.source.folder_name}&quot;
                                    </span>
                                    <a
                                      href={m.source.drive_file_link}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      style={{ fontSize: 11, marginLeft: "auto" }}
                                    >
                                      Preview ↗
                                    </a>
                                  </div>
                                  <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 4 }}>
                                    {m.reason}
                                  </div>
                                  <div
                                    className="mono"
                                    style={{
                                      fontSize: 10,
                                      color: "var(--fg-faint)",
                                      lineHeight: 1.4,
                                      maxHeight: 40,
                                      overflow: "auto",
                                    }}
                                  >
                                    {m.source.visual_prompt}
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {reuseCount > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: "11px 13px",
                background: "var(--success-soft)",
                border: "1px solid rgba(74,222,128,0.3)",
                borderRadius: "var(--r-sm)",
                fontSize: 13,
                color: "var(--success)",
              }}
            >
              {reuseCount} clip{reuseCount === 1 ? "" : "s"} marked for reuse. Click{" "}
              <strong>Run</strong> above — those scenes skip generation and download from Drive.
            </div>
          )}
        </div>
      )}

      <VoiceLibraryModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        onSelect={onSelectVoice}
        selectedVoiceId={settings.TTS_VOICE_ID ?? null}
      />
    </div>
  );
}
