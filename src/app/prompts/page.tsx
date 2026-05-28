"use client";
import { useEffect, useState } from "react";
import { usePersistedState } from "../_use-persisted-state";
import { ChannelFields, type ChannelFieldsValue } from "../_channel-fields";
import { VoiceLibraryModal, type VoiceOption } from "../_voice-library-modal";
import { loadStylePreset, DEFAULT_STYLE_PRESET_ID } from "@/lib/style-presets";

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
  updated_at: string;
}

const labelStyle: React.CSSProperties = { marginTop: 6 };

/** A fresh ChannelFieldsValue pre-filled from a style preset's defaults. */
function cfFromPreset(id: string): ChannelFieldsValue {
  const p = loadStylePreset(id);
  return {
    stylePresetId: p.id,
    videoStyle: p.defaults.videoStyle,
    videoModel: "veo-video",
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

  // Edit form
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCF, setEditCF] = useState<ChannelFieldsValue>(cfFromPreset(DEFAULT_STYLE_PRESET_ID));
  const [editVoiceId, setEditVoiceId] = useState("");
  const [editVoiceProvider, setEditVoiceProvider] = useState("");
  const [editVoiceLabel, setEditVoiceLabel] = useState("");

  // Voice picker (shared modal)
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<"new" | "edit">("new");
  const [voiceMap, setVoiceMap] = useState<Record<string, string>>({});

  async function loadPresets() {
    const r = await fetch("/api/prompt-presets");
    setPresets(await r.json());
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
      videoModel: p.video_model ?? "veo-video",
      aspectRatio: p.aspect_ratio ?? "16:9",
      voiceSpeed: p.voice_speed == null ? "" : String(p.voice_speed),
      voiceStability: p.voice_stability == null ? "" : String(p.voice_stability),
      voiceSimilarity: p.voice_similarity_boost == null ? "" : String(p.voice_similarity_boost),
      voiceStyle: p.voice_style == null ? "" : String(p.voice_style),
    });
    setEditVoiceId(p.voice_id ?? "");
    setEditVoiceProvider(p.voice_provider ?? "");
    setEditVoiceLabel(p.voice_id ? voiceMap[p.voice_id] ?? p.voice_id : "");
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
    if (!confirm("Delete this channel profile? Past runs that used it keep their snapshot.")) return;
    await fetch(`/api/prompt-presets/${id}`, { method: "DELETE" });
    if (editingId === id) cancelEdit();
    await loadPresets();
  }

  return (
    <div>
      <h1>Channels</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
        Each channel bundles a prompt, voice and look — pick it in one click on a new run.
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Channels</h2>
          <span className="badge badge-neutral">{presets.length}</span>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>
          Pick a style preset; fine-tune voice and video only if you need to.
        </p>

        {presetError && (
          <div
            style={{
              background: "var(--danger-soft)",
              border: "1px solid rgba(248,113,113,0.3)",
              padding: "9px 12px",
              borderRadius: "var(--r-sm)",
              marginBottom: 12,
              color: "var(--danger)",
              fontSize: 13,
            }}
          >
            {presetError}
          </div>
        )}

        {presets.length === 0 && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 16, fontStyle: "italic" }}>
            No channels yet. Add one below.
          </div>
        )}

        {presets.map((p) => (
          <div key={p.id} className="card-inset" style={{ padding: 14, marginBottom: 10 }}>
            {editingId === p.id ? (
              <>
                <label className="label" style={labelStyle}>
                  Channel name <span style={{ color: "var(--danger)" }}>*</span>
                </label>
                <input
                  className="input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Channel name"
                  style={{ marginBottom: 10 }}
                />
                <label className="label" style={labelStyle}>Description</label>
                <input
                  className="input"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="e.g. Calm sleep stories, 30-min episodes"
                  style={{ marginBottom: 14 }}
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
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button className="btn" onClick={saveEdit}>Save</button>
                  <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
                  <button className="btn-danger" onClick={() => deletePreset(p.id)} style={{ marginLeft: "auto" }}>
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 650, fontSize: 14.5 }}>{p.name}</div>
                  <span className="badge badge-accent">{loadStylePreset(p.style_preset_id).label}</span>
                  {p.voice_id && (
                    <span className="badge badge-success" title={voiceMap[p.voice_id] ?? p.voice_id}>Voice</span>
                  )}
                  <div className="faint" style={{ fontSize: 11.5, marginLeft: "auto" }}>
                    {new Date(p.updated_at).toLocaleDateString()}
                  </div>
                  <button className="btn-secondary btn-sm" onClick={() => startEdit(p)}>Edit</button>
                </div>
                {p.description && (
                  <div style={{ color: "var(--fg-muted)", fontSize: 12.5, marginTop: 6 }}>{p.description}</div>
                )}
              </>
            )}
          </div>
        ))}

        {/* Add new channel */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Add new channel</h3>
          <label className="label" style={labelStyle}>
            Channel name <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <input
            className="input"
            placeholder="e.g. Midnight Sleep Stories"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <label className="label" style={labelStyle}>Description</label>
          <input
            className="input"
            placeholder="e.g. Calm sleep stories, 30-min episodes"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            style={{ marginBottom: 14 }}
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
          <div style={{ marginTop: 14 }}>
            <button className="btn" onClick={createPreset}>Add channel</button>
          </div>
        </div>
      </div>

      <VoiceLibraryModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        onSelect={onSelectVoice}
        selectedVoiceId={voiceTarget === "new" ? newVoiceId || null : editVoiceId || null}
      />
    </div>
  );
}
