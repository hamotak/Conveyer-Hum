"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePersistedState } from "./_use-persisted-state";
import { VoiceLibraryModal, type VoiceOption } from "./_voice-library-modal";
import { ChannelFields, type ChannelFieldsValue } from "./_channel-fields";
import { estimateScript } from "@/lib/script-estimate";
import type { PreflightResult } from "@/lib/preflight";

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
    videoModel: settings.ANIMATION_MODEL || "veo-video",
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
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [drive, setDrive] = useState<GdriveStatus | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);

  // Library preview state
  const [scenes, setScenes] = useState<Scene[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [matches, setMatches] = useState<ClipMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [reuseMap, setReuseMap] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // Channel profiles (full rows so we can show override badges + counts)
  const [presets, setPresets] = useState<
    {
      id: number;
      name: string;
      video_style: string | null;
      voice_speed: number | null;
      scene_end_pause_seconds: number | null;
    }[]
  >([]);
  const [selectedPresetId, setSelectedPresetId] = usePersistedState<number | null>(
    "newrun.channel",
    null
  );
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
      .then(setPresets)
      .catch(() => setPresets([]));
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => setSettings({}));
    fetch("/api/preflight")
      .then((r) => r.json())
      .then(setPreflight)
      .catch(() => setPreflight(null));
  }, []);

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
      duration: words === 0 ? "—" : m > 0 ? `~${m} min ${s} s` : `~${s} s`,
      scenes: Math.max(1, Math.round(seconds / 5)),
      narrationSeconds: seconds,
    };
  }, [script]);

  // Shared long-run estimate (drives the preflight confirm + the "long video" note).
  const scriptEstimate = useMemo(() => estimateScript(scriptStats.words), [scriptStats.words]);

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

  async function previewScenes() {
    if (!script.trim()) return;
    setPreviewing(true);
    setMatches(null);
    setReuseMap({});
    try {
      const r = await fetch("/api/preview/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, presetId: selectedPresetId }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert(`Couldn't split scenes:\n\n${j.error || r.statusText}`);
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
    try {
      // Scope the search: the selected channel by default, or every channel
      // when the cross-channel toggle is on.
      const channelName =
        selectedPresetId != null
          ? (presets.find((p) => p.id === selectedPresetId)?.name ?? "_No Channel")
          : "_No Channel";
      const r = await fetch("/api/library/find-similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenes, channel: crossChannel ? null : channelName }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert(`Couldn't search library:\n\n${j.error || r.statusText}`);
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

  async function start() {
    // Preflight: don't let a run start if a required check failed. Fail-open if
    // preflight hasn't loaded yet (null) — the server-side run will still error
    // on a genuinely missing key; we just don't block the click on a slow fetch.
    const fails = preflight?.checks.filter((c) => c.required && c.status === "fail") ?? [];
    if (fails.length > 0) {
      alert(
        `Can't start the run yet:\n\n${fails.map((c) => `• ${c.label}: ${c.detail}`).join("\n")}\n\nFix these in Settings, then try again.`
      );
      return;
    }
    // Long scripts: warn + require confirmation (short runs are never blocked).
    if (scriptEstimate.isLong) {
      const ok = window.confirm(
        `${scriptEstimate.warnings.join("\n\n")}\n\nStart this full-length run anyway?`
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const body: {
        title?: string;
        script: string;
        reuseMap?: Record<number, string>;
        presetId?: number | null;
        autoReuse: boolean;
      } = { title, script, autoReuse: reuseMode === "auto" };
      if (reuseCount > 0) body.reuseMap = reuseMap;
      if (selectedPresetId != null) body.presetId = selectedPresetId;
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        alert(`Error: ${await r.text()}`);
        return;
      }
      const data = (await r.json()) as { id: string };
      router.push(`/runs/${data.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Video Conveyer</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
        Paste a script — get a finished video.
      </p>

      <div className="card" style={{ display: "grid", gap: 16 }}>
        <div>
          <label className="label">Title (optional)</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Okinawa Longevity — Test 1"
          />
        </div>

        <div>
          <label className="label">Channel</label>
          <select
            className="input"
            value={selectedPresetId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedPresetId(v === "" ? null : Number(v));
              setScenes(null);
              setMatches(null);
            }}
          >
            <option value="">Default — no channel profile</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
            Sets the prompt, voice and look. Manage in Channels.
          </div>
          {presets.length === 0 && (
            <div style={{ marginTop: 6 }}>
              <Link
                href="/prompts"
                className="btn-ghost btn-sm"
                style={{ color: "var(--accent)" }}
              >
                + Create your first channel profile
              </Link>
            </div>
          )}
        </div>

        {/* Script — the composer's center. */}
        <div>
          <label className="label">Script</label>
          <textarea
            className="textarea"
            rows={14}
            value={script}
            onChange={(e) => {
              setScript(e.target.value);
              setScenes(null);
              setMatches(null);
              setReuseMap({});
            }}
            placeholder="Paste the full narrator script here…"
          />
          <div
            className="faint"
            style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 12, flexWrap: "wrap" }}
          >
            <span>{scriptStats.words} words</span>
            <span>≈ {scriptStats.duration} video</span>
            <span>≈ {scriptStats.scenes} scenes</span>
          </div>
        </div>

        {/* Primary actions — always visible directly under the script. */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={start} disabled={busy || !script.trim()}>
            {busy
              ? "Starting…"
              : reuseCount > 0
                ? `Run · reusing ${reuseCount} clip${reuseCount === 1 ? "" : "s"}`
                : "Run"}
          </button>
          <button
            className="btn-secondary"
            onClick={previewScenes}
            disabled={previewing || !script.trim()}
            title="Split the script into scenes before running — lets you reuse clips from past runs."
          >
            {previewing ? "Splitting…" : scenes ? "Re-split" : "Preview"}
          </button>
        </div>

        {/* Preflight — required checks gate the run; failures link to Settings. */}
        {preflight && !preflight.ready && (
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
            {preflight.checks.filter((c) => c.required && c.status === "fail").map((c) => c.label).join(", ")} —{" "}
            fix in <a href="/settings">Settings</a>.
          </div>
        )}
        {preflight?.ready && (
          <div className="faint" style={{ fontSize: 12 }}>
            ✓ Ready to run
            {scriptEstimate.isLong && (
              <span style={{ color: "var(--warning)" }}>
                {" "}· long video (~{Math.round(scriptEstimate.minutes)} min, ~{scriptEstimate.scenes} scenes) — you&apos;ll
                confirm before it starts.
              </span>
            )}
          </div>
        )}

        {/* Working with long videos — short, practical chaptering advice. */}
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--fg-muted)" }}>
            Working with long videos
          </summary>
          <ol style={{ paddingLeft: 20, margin: "8px 0 0", color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.7 }}>
            <li>Test a <strong>1-minute</strong> script first to confirm voice + look.</li>
            <li>Then a <strong>5–10 minute</strong> run to check pacing and reliability.</li>
            <li>Then <strong>20–30 minutes</strong> once you trust the settings.</li>
            <li>For <strong>~1 hour</strong>, run it as separate chapters, not one job.</li>
          </ol>
        </details>

        {/* Options — style, voice, reuse, video. Collapsed until needed. */}
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 550, color: "var(--fg-muted)" }}>
            Options{selectedPresetId == null ? " · style, voice, reuse, video" : ""}
          </summary>
          <div style={{ display: "grid", gap: 16, marginTop: 14 }}>
            {selectedPresetId == null ? (
              <InlineSettingsCard
                settings={settings}
                onChange={updateSetting}
                selectedVoiceLabel={selectedVoiceLabel}
                onOpenVoicePicker={() => setVoiceModalOpen(true)}
              />
            ) : (
              (() => {
                const sel = presets.find((p) => p.id === selectedPresetId);
                const n = sel
                  ? [sel.video_style, sel.voice_speed, sel.scene_end_pause_seconds].filter(
                      (v) => v != null && v !== ""
                    ).length
                  : 0;
                return (
                  <div className="faint" style={{ fontSize: 12.5 }}>
                    Using channel: <strong style={{ color: "var(--fg)" }}>{sel?.name ?? "—"}</strong> · {n}{" "}
                    override{n === 1 ? "" : "s"}
                  </div>
                );
              })()
            )}

            <div>
              <label className="label">Library reuse</label>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className={reuseMode === "auto" ? "btn btn-sm" : "btn-secondary btn-sm"}
                  onClick={() => {
                    setReuseMode("auto");
                    setMatches(null);
                    setReuseMap({});
                  }}
                >
                  Auto
                </button>
                <button
                  type="button"
                  className={reuseMode === "manual" ? "btn btn-sm" : "btn-secondary btn-sm"}
                  onClick={() => setReuseMode("manual")}
                >
                  Manual
                </button>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>
                {reuseMode === "auto"
                  ? "Reuses matching clips from your library; generates the rest."
                  : "Preview scenes and pick which clips to reuse."}
              </div>
            </div>
          </div>
        </details>
      </div>

      {/* ─── Scene preview + library suggestions ─────────────────────────── */}
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
              <h2 style={{ marginBottom: 2 }}>Scene preview · {scenes.length}</h2>
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

      {/* ─── Time estimate ───────────────────────────────────────────────── */}
      {timeEstimate && stats && scriptStats.words > 0 && (
        <details className="card" style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 650, fontSize: 14 }}>Estimated time</span>
            <span style={{ color: "var(--accent-hover)", fontSize: 15, fontWeight: 700 }}>
              ~{timeEstimate.total < 1 ? "<1" : Math.round(timeEstimate.total)} min
            </span>
          </summary>
          <div style={{ color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.8, marginTop: 12 }}>
            <div>
              <strong style={{ color: "var(--fg)" }}>Parallel generation</strong>
              {stats.animationEnabled ? ` (TTS + ${timeEstimate.animScenes} video clips)` : " (TTS)"}: ~
              {Math.round(timeEstimate.phase1)} min
              <span className="faint" style={{ marginLeft: 8 }}>
                {stats.keyCount} {stats.keyCount === 1 ? "key" : "keys"} · {stats.total.anim} video / {stats.total.tts} TTS in parallel
              </span>
            </div>
            <div>
              <strong style={{ color: "var(--fg)" }}>FFmpeg clip render</strong>: ~
              {Math.round(timeEstimate.phase2 * 10) / 10} min
              <span className="faint" style={{ marginLeft: 8 }}>
                {stats.assembleConcurrency} clips at once
              </span>
            </div>
            <div>
              <strong style={{ color: "var(--fg)" }}>Final xfade assembly</strong>: ~
              {Math.round(timeEstimate.phase3 * 10) / 10} min
              <span className="faint" style={{ marginLeft: 8 }}>
                {stats.xfadeChunks} parallel chunks
              </span>
            </div>
          </div>
          {stats.keyCount === 1 && scriptStats.scenes > 30 && (
            <div
              style={{
                color: "var(--warning)",
                fontSize: 12,
                marginTop: 11,
                padding: "9px 11px",
                background: "var(--warning-soft)",
                borderRadius: "var(--r-sm)",
                lineHeight: 1.55,
              }}
            >
              You&apos;re on a single 69labs key. A 2nd key roughly halves the generation phase
              (~{Math.round(timeEstimate.total / 2)} min instead of ~{Math.round(timeEstimate.total)} min).
              Add keys in <a href="/settings">Keys &amp; Settings</a>.
            </div>
          )}
          <div className="faint" style={{ fontSize: 11, marginTop: 9 }}>
            Rough numbers — real runs are usually 10–30% faster.
          </div>
        </details>
      )}

      {/* ─── How it works (collapsed — not needed on every visit) ────────── */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--fg-muted)" }}>
          What happens when I run this?
        </summary>
        <ol style={{ paddingLeft: 20, lineHeight: 1.7, margin: "10px 0 0", color: "var(--fg-muted)", fontSize: 13 }}>
          <li>Gemini splits the script into scenes, each with a visual prompt.</li>
          <li>ElevenLabs narrates the whole script; a {stats?.videoModelLabel ?? "Veo 3.1"} clip is generated per scene.</li>
          <li>FFmpeg stitches the clips with crossfades; live logs stream to the run page.</li>
          <li>If Drive sync is on, the finished run uploads automatically.</li>
        </ol>
      </details>

      <VoiceLibraryModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        onSelect={onSelectVoice}
        selectedVoiceId={settings.TTS_VOICE_ID ?? null}
      />
    </div>
  );
}
