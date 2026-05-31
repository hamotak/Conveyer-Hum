"use client";
import { useEffect, useState, useRef } from "react";
import { usePersistedState } from "../_use-persisted-state";
import { ChannelFields, type ChannelFieldsValue } from "../_channel-fields";
import { VoiceLibraryModal, type VoiceOption } from "../_voice-library-modal";
import { ChannelStockGen, defaultStockFolder, channelStockTheme } from "../_channel-stock-gen";
import { ConfirmDialog, type ConfirmRequest } from "../_confirm-dialog";
import { loadStylePreset, DEFAULT_STYLE_PRESET_ID } from "@/lib/style-presets";
import { DEFAULT_HYBRID_FRESH_MINUTES, MAX_HYBRID_FRESH_MINUTES, resolveStockFolder } from "@/lib/channel-stock";

interface PromptPreset {
  id: number;
  name: string;
  description: string | null;
  style_preset_id: string | null;
  video_style: string | null;
  video_model: string | null;
  aspect_ratio: string | null;
  voice_speed: number | null;
  voice_stability: number | null;
  voice_similarity_boost: number | null;
  voice_style: number | null;
  voice_id: string | null;
  voice_provider: string | null;
  stock_folder: string | null;
  hybrid_fresh_minutes: number | null;
  updated_at: string;
}

const labelStyle: React.CSSProperties = { marginTop: 6 };

/** Per-channel stock folder + hybrid fresh-minutes. These move the only two
 *  per-run knobs out of the New Video page and onto the channel. */
function StockHybridFields({
  stockFolder,
  setStockFolder,
  freshMinutes,
  setFreshMinutes,
  onStockFolderManualEdit,
}: {
  stockFolder: string;
  setStockFolder: (v: string) => void;
  freshMinutes: string;
  setFreshMinutes: (v: string) => void;
  onStockFolderManualEdit?: () => void;
}) {
  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
      <div className="label" style={{ marginBottom: 10, fontWeight: 600 }}>Stock library &amp; hybrid</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 220px" }}>
          <label className="label">Stock folder (Google Drive)</label>
          <input
            className="input"
            placeholder="Auto from channel name"
            value={stockFolder}
            onChange={(e) => {
              onStockFolderManualEdit?.();
              setStockFolder(e.target.value);
            }}
          />
          <div className="faint" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.5 }}>
            Auto-created from the channel name. B-roll for Hybrid / Stock Cut lives here.
          </div>
        </div>
        <div style={{ flex: "0 1 150px" }}>
          <label className="label">Hybrid fresh minutes</label>
          <input
            className="input"
            type="number"
            min={1}
            max={MAX_HYBRID_FRESH_MINUTES}
            step={1}
            value={freshMinutes}
            onChange={(e) => {
              const n = Number(e.target.value);
              setFreshMinutes(Number.isFinite(n) ? String(Math.min(MAX_HYBRID_FRESH_MINUTES, Math.max(1, Math.round(n)))) : e.target.value);
            }}
          />
          <div className="faint" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.5 }}>
            Fresh AI minutes at the start in Hybrid mode. Max {MAX_HYBRID_FRESH_MINUTES}.
          </div>
        </div>
      </div>
    </div>
  );
}

/** A fresh ChannelFieldsValue pre-filled from a style preset's defaults. */
function cfFromPreset(id: string): ChannelFieldsValue {
  const p = loadStylePreset(id);
  return {
    stylePresetId: p.id,
    videoStyle: p.defaults.videoStyle,
    videoModel: "veo-3.1-fast",
    aspectRatio: "16:9",
    voiceSpeed: String(p.defaults.ttsSpeed),
    voiceStability: String(p.defaults.ttsStability),
    voiceSimilarity: String(p.defaults.ttsSimilarityBoost),
    voiceStyle: String(p.defaults.ttsStyle),
  };
}

function cfPayload(cf: ChannelFieldsValue) {
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
  return {
    style_preset_id: cf.stylePresetId,
    video_style: cf.videoStyle.trim() || null,
    video_model: cf.videoModel.trim() || null,
    aspect_ratio: cf.aspectRatio.trim() || null,
    voice_speed: numOrNull(cf.voiceSpeed),
    voice_stability: numOrNull(cf.voiceStability),
    voice_similarity_boost: numOrNull(cf.voiceSimilarity),
    voice_style: numOrNull(cf.voiceStyle),
  };
}

export default function PromptsPage() {
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);

  // Add form
  const [newName, setNewName] = usePersistedState("channels.new.name", "");
  const [newDescription, setNewDescription] = usePersistedState("channels.new.description", "");
  const [newCF, setNewCF] = usePersistedState<ChannelFieldsValue>(
    "channels.new.cf",
    cfFromPreset(DEFAULT_STYLE_PRESET_ID)
  );
  const [newVoiceId, setNewVoiceId] = usePersistedState("channels.new.voiceId", "");
  const [newVoiceProvider, setNewVoiceProvider] = usePersistedState("channels.new.voiceProvider", "");
  const [newVoiceLabel, setNewVoiceLabel] = usePersistedState("channels.new.voiceLabel", "");
  const [newStockFolder, setNewStockFolder] = usePersistedState("channels.new.stockFolder", "");
  const [newFreshMinutes, setNewFreshMinutes] = usePersistedState("channels.new.freshMinutes", String(DEFAULT_HYBRID_FRESH_MINUTES));

  // Edit form
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCF, setEditCF] = useState<ChannelFieldsValue>(cfFromPreset(DEFAULT_STYLE_PRESET_ID));
  const [editVoiceId, setEditVoiceId] = useState("");
  const [editVoiceProvider, setEditVoiceProvider] = useState("");
  const [editVoiceLabel, setEditVoiceLabel] = useState("");
  const [editStockFolder, setEditStockFolder] = useState("");
  const [editFreshMinutes, setEditFreshMinutes] = useState("5");

  // Voice picker (shared modal)
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<"new" | "edit">("new");
  const [voiceMap, setVoiceMap] = useState<Record<string, string>>({});

  // Add-channel form is hidden until the user clicks "New channel" — keeps the
  // list clean and stops new channels from stacking on top of an always-open form.
  const [showAdd, setShowAdd] = useState(false);
  const newStockTouched = useRef(false);
  const editStockTouched = useRef(false);

  // Auto-fill stock folder from channel name until the user edits it manually.
  useEffect(() => {
    if (showAdd && !newStockTouched.current && newName.trim()) {
      setNewStockFolder(defaultStockFolder(newName));
    }
  }, [newName, showAdd, setNewStockFolder]);

  useEffect(() => {
    if (editingId != null && !editStockTouched.current && editName.trim()) {
      setEditStockFolder(defaultStockFolder(editName));
    }
  }, [editName, editingId]);

  async function loadPresets() {
    const r = await fetch("/api/prompt-presets");
    setPresets(await r.json());
    fetch("/api/settings")
      .then((s) => s.json())
      .then((s: Record<string, string>) => setSettings(s))
      .catch(() => setSettings({}));
    try {
      const v = (await (await fetch("/api/voices")).json()) as { voices: VoiceOption[] };
      const map: Record<string, string> = {};
      for (const o of v.voices ?? []) map[o.voiceId] = o.name;
      setVoiceMap(map);
    } catch {
      /* labels fall back to the id */
    }
  }
  useEffect(() => {
    loadPresets();
  }, []);

  function onSelectVoice(v: VoiceOption) {
    if (voiceTarget === "new") {
      setNewVoiceId(v.voiceId);
      setNewVoiceProvider(v.provider);
      setNewVoiceLabel(v.name);
    } else {
      setEditVoiceId(v.voiceId);
      setEditVoiceProvider(v.provider);
      setEditVoiceLabel(v.name);
    }
    setVoiceModalOpen(false);
  }

  async function createPreset() {
    setPresetError(null);
    if (!newName.trim()) {
      setPresetError("Channel name is required");
      return;
    }
    const r = await fetch("/api/prompt-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName,
        description: newDescription.trim() || null,
        voice_id: newVoiceId.trim() || null,
        voice_provider: newVoiceProvider.trim() || null,
        stock_folder: newStockFolder.trim() || null,
        hybrid_fresh_minutes: newFreshMinutes.trim() === "" ? null : Number(newFreshMinutes),
        ...cfPayload(newCF),
      }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setPresetError(j.error ?? `HTTP ${r.status}`);
      return;
    }
    setNewName("");
    setNewDescription("");
    setNewCF(cfFromPreset(DEFAULT_STYLE_PRESET_ID));
    setNewVoiceId("");
    setNewVoiceProvider("");
    setNewVoiceLabel("");
    setNewStockFolder("");
    setNewFreshMinutes("5");
    newStockTouched.current = false;
    setShowAdd(false);
    await loadPresets();
  }

  function startEdit(p: PromptPreset) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditDescription(p.description ?? "");
    const presetId = p.style_preset_id ?? DEFAULT_STYLE_PRESET_ID;
    setEditCF({
      stylePresetId: presetId,
      videoStyle: p.video_style ?? "",
      videoModel: p.video_model ?? "veo-3.1-fast",
      aspectRatio: p.aspect_ratio ?? "16:9",
      voiceSpeed: p.voice_speed == null ? "" : String(p.voice_speed),
      voiceStability: p.voice_stability == null ? "" : String(p.voice_stability),
      voiceSimilarity: p.voice_similarity_boost == null ? "" : String(p.voice_similarity_boost),
      voiceStyle: p.voice_style == null ? "" : String(p.voice_style),
    });
    setEditVoiceId(p.voice_id ?? "");
    setEditVoiceProvider(p.voice_provider ?? "");
    setEditVoiceLabel(p.voice_id ? voiceMap[p.voice_id] ?? p.voice_id : "");
    setEditStockFolder(resolveStockFolder(p.name, p.stock_folder, settings.STOCK_LIBRARY_FOLDER));
    setEditFreshMinutes(
      p.hybrid_fresh_minutes == null
        ? String(DEFAULT_HYBRID_FRESH_MINUTES)
        : String(Math.min(MAX_HYBRID_FRESH_MINUTES, Math.max(1, Math.round(p.hybrid_fresh_minutes))))
    );
    editStockTouched.current = Boolean(p.stock_folder?.trim());
    setPresetError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit() {
    if (editingId == null) return;
    setPresetError(null);
    const r = await fetch(`/api/prompt-presets/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName,
        description: editDescription.trim() || null,
        voice_id: editVoiceId.trim() || null,
        voice_provider: editVoiceProvider.trim() || null,
        stock_folder: editStockFolder.trim() || null,
        hybrid_fresh_minutes: editFreshMinutes.trim() === "" ? null : Number(editFreshMinutes),
        ...cfPayload(editCF),
      }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setPresetError(j.error ?? `HTTP ${r.status}`);
      return;
    }
    cancelEdit();
    await loadPresets();
  }

  async function deletePreset(id: number) {
    const preset = presets.find((p) => p.id === id);
    setConfirming({
      title: "Delete this channel?",
      body: `${preset?.name ?? "This channel"} will be removed from the channel picker. Past runs keep their saved snapshot.`,
      confirmLabel: "Delete channel",
      danger: true,
      onConfirm: async () => {
        const r = await fetch(`/api/prompt-presets/${id}`, { method: "DELETE" });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `Could not delete channel (HTTP ${r.status}).`);
        }
        if (editingId === id) cancelEdit();
        await loadPresets();
      },
    });
  }

  return (
    <div>
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <div>
          <h1>Channels</h1>
          <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
            Set up a channel once — voice, look, B-roll folder. Your team just picks it and runs.
          </p>
        </div>
        {!showAdd && (
          <button className="btn" onClick={() => { setShowAdd(true); setEditingId(null); newStockTouched.current = false; }}>
            + New channel
          </button>
        )}
      </div>

      {presetError && (
        <div
          style={{
            background: "var(--danger-soft)",
            border: "1px solid rgba(248,113,113,0.3)",
            padding: "9px 12px",
            borderRadius: "var(--r-sm)",
            marginBottom: 14,
            color: "var(--danger)",
            fontSize: 13,
          }}
        >
          {presetError}
        </div>
      )}

      {/* ── Add-channel form (revealed by the New channel button) ── */}
      {showAdd && (
        <div className="card" style={{ marginBottom: 20, borderColor: "var(--accent)" }}>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>New channel</h2>
          </div>
          <label className="label" style={labelStyle}>
            Channel name <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <input
            className="input"
            placeholder="e.g. Midnight Sleep Stories"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ marginBottom: 12 }}
            autoFocus
          />
          <label className="label" style={labelStyle}>Description</label>
          <input
            className="input"
            placeholder="e.g. Calm sleep stories, 30-min episodes"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            style={{ marginBottom: 16 }}
          />
          <ChannelFields
            value={newCF}
            onChange={(patch) => setNewCF((c) => ({ ...c, ...patch }))}
            voiceLabel={newVoiceLabel || null}
            onOpenVoicePicker={() => {
              setVoiceTarget("new");
              setVoiceModalOpen(true);
            }}
          />
          <StockHybridFields
            stockFolder={newStockFolder}
            setStockFolder={setNewStockFolder}
            freshMinutes={newFreshMinutes}
            setFreshMinutes={setNewFreshMinutes}
            onStockFolderManualEdit={() => { newStockTouched.current = true; }}
          />
          {newName.trim() && newStockFolder.trim() && (
            <ChannelStockGen
              folder={newStockFolder.trim()}
              theme={channelStockTheme({
                name: newName,
                description: newDescription,
                stylePresetId: newCF.stylePresetId,
                videoStyle: newCF.videoStyle,
              })}
              videoStyle={newCF.videoStyle}
            />
          )}
          <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
            <button className="btn" onClick={createPreset}>Add channel</button>
            <button className="btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Channel list ── */}
      {presets.length === 0 && !showAdd ? (
        <div className="empty-state">
          <div className="empty-state-title">No channels yet</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px", lineHeight: 1.5 }}>
            A channel saves your style, voice and look so every new video is one click.
          </p>
          <button className="btn" onClick={() => setShowAdd(true)}>+ New channel</button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {presets.map((p) => (
            <div key={p.id} className="card" style={{ padding: 16, borderColor: editingId === p.id ? "var(--accent)" : undefined }}>
              {editingId === p.id ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <h2 style={{ margin: 0 }}>Edit channel</h2>
                  </div>
                  <label className="label" style={labelStyle}>
                    Channel name <span style={{ color: "var(--danger)" }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Channel name"
                    style={{ marginBottom: 12 }}
                  />
                  <label className="label" style={labelStyle}>Description</label>
                  <input
                    className="input"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="e.g. Calm sleep stories, 30-min episodes"
                    style={{ marginBottom: 16 }}
                  />
                  <ChannelFields
                    value={editCF}
                    onChange={(patch) => setEditCF((c) => ({ ...c, ...patch }))}
                    voiceLabel={editVoiceLabel || null}
                    onOpenVoicePicker={() => {
                      setVoiceTarget("edit");
                      setVoiceModalOpen(true);
                    }}
                  />
                  <StockHybridFields
                    stockFolder={editStockFolder}
                    setStockFolder={setEditStockFolder}
                    freshMinutes={editFreshMinutes}
                    setFreshMinutes={setEditFreshMinutes}
                    onStockFolderManualEdit={() => { editStockTouched.current = true; }}
                  />
                  <ChannelStockGen
                    folder={(editStockFolder.trim() || defaultStockFolder(editName)).trim()}
                    theme={channelStockTheme({
                      name: editName,
                      description: editDescription,
                      stylePresetId: editCF.stylePresetId,
                      videoStyle: editCF.videoStyle,
                    })}
                    videoStyle={editCF.videoStyle}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
                    <button className="btn" onClick={saveEdit}>Save changes</button>
                    <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
                    <button className="btn-danger" onClick={() => deletePreset(p.id)} style={{ marginLeft: "auto" }}>
                      Delete channel
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</span>
                      <span className="badge badge-accent">{loadStylePreset(p.style_preset_id).label}</span>
                      {p.voice_id && (
                        <span className="badge badge-success" title={voiceMap[p.voice_id] ?? p.voice_id}>Voice set</span>
                      )}
                    </div>
                    {p.description && (
                      <div style={{ color: "var(--fg-muted)", fontSize: 12.5, marginTop: 5 }}>{p.description}</div>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <ChannelStockGen
                        compact
                        folder={resolveStockFolder(p.name, p.stock_folder, settings.STOCK_LIBRARY_FOLDER)}
                        theme={channelStockTheme({
                          name: p.name,
                          description: p.description,
                          stylePresetId: p.style_preset_id,
                          videoStyle: p.video_style,
                        })}
                        videoStyle={p.video_style}
                      />
                    </div>
                  </div>
                  <button className="btn-secondary btn-sm" onClick={() => { setShowAdd(false); startEdit(p); }}>Edit</button>
                  <button
                    className="btn-ghost-danger btn-sm"
                    title="Delete channel"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => deletePreset(p.id)}
                    style={{ padding: "5px 9px" }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <VoiceLibraryModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        onSelect={onSelectVoice}
        selectedVoiceId={voiceTarget === "new" ? newVoiceId || null : editVoiceId || null}
      />
    </div>
  );
}
