"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { voiceUid, selectedVoiceUid } from "@/lib/voice-key";

export interface VoiceOption {
  voiceId: string;
  provider: "voice-clone" | "elevenlabs" | "edgetts";
  name: string;
  language: string | null;
  gender: string | null;
  previewUrl: string | null;
  source: "library" | "saved";
  /** DB primary key for saved voices — unique React key + delete target. */
  savedId?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (voice: VoiceOption) => void;
  selectedVoiceId?: string | null;
}

type GenderFilter = "all" | "male" | "female";
type SourceFilter = "all" | "saved" | "library";

const seg = (active: boolean): React.CSSProperties => ({
  padding: "5px 11px",
  fontSize: 12.5,
  fontWeight: active ? 600 : 450,
  borderRadius: "var(--r-sm)",
  border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
  background: active ? "var(--surface-2)" : "transparent",
  color: active ? "var(--fg)" : "var(--fg-faint)",
  cursor: "pointer",
});

export function VoiceLibraryModal({ open, onClose, onSelect, selectedVoiceId }: Props) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<GenderFilter>("all");
  // Default to the user's saved voices; the celebrity/library catalog is one tab away.
  const [source, setSource] = useState<SourceFilter>("saved");
  const [sortAZ, setSortAZ] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // Keyed by voiceUid: which card is mid-test, and the latest test result per card.
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Add-voice form
  const [aName, setAName] = useState("");
  const [aVoiceId, setAVoiceId] = useState("");
  const [aProvider, setAProvider] = useState("elevenlabs");
  const [aPreview, setAPreview] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/voices");
      const j = (await r.json()) as { voices: VoiceOption[] };
      setVoices(Array.isArray(j.voices) ? j.voices : []);
    } catch {
      setVoices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Scroll lock + ESC to close while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      audioRef.current?.pause();
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    let list = voices;
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((v) => v.name.toLowerCase().includes(q) || v.voiceId.toLowerCase().includes(q));
    if (gender !== "all") list = list.filter((v) => (v.gender ?? "").toLowerCase() === gender);
    if (source !== "all") list = list.filter((v) => v.source === source);
    // Saved voices always come first; A–Z sorts within each group.
    const rank = (v: VoiceOption) => (v.source === "saved" ? 0 : 1);
    list = [...list].sort((a, b) =>
      rank(a) - rank(b) || (sortAZ ? a.name.localeCompare(b.name) : 0)
    );
    return list;
  }, [voices, query, gender, source, sortAZ]);

  // Exactly one row may show as selected, even if two saved voices share a voiceId
  // (first match wins). Resolved against the FULL list so an active filter can't
  // change which row is "the" selected one.
  const selectedUid = useMemo(
    () => selectedVoiceUid(voices, selectedVoiceId),
    [voices, selectedVoiceId]
  );

  function togglePreview(v: VoiceOption) {
    const el = audioRef.current;
    if (!el || !v.previewUrl) return;
    const uid = voiceUid(v);
    if (playingId === uid) {
      el.pause();
      setPlayingId(null);
      return;
    }
    el.src = v.previewUrl;
    el.play().then(() => setPlayingId(uid)).catch(() => setPlayingId(null));
  }

  /** Synthesize a tiny sample to validate a voice before it's used in a paid run. */
  async function testVoice(v: VoiceOption) {
    const uid = voiceUid(v);
    setTestingId(uid);
    setTestResult((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    try {
      const r = await fetch("/api/voices/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: v.voiceId, provider: v.provider }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setTestResult((prev) => ({
          ...prev,
          [uid]: { ok: false, msg: j.error ?? `This voice failed (HTTP ${r.status}). Pick another voice.` },
        }));
        return;
      }
      // Success: play the returned sample so the user can hear it.
      const blob = await r.blob();
      const el = audioRef.current;
      if (el) {
        el.src = URL.createObjectURL(blob);
        el.play().then(() => setPlayingId(uid)).catch(() => setPlayingId(null));
      }
      setTestResult((prev) => ({ ...prev, [uid]: { ok: true, msg: "Voice works — playing sample." } }));
    } catch (e) {
      setTestResult((prev) => ({
        ...prev,
        [uid]: { ok: false, msg: (e as Error).message || "This voice failed. Pick another voice." },
      }));
    } finally {
      setTestingId(null);
    }
  }

  /** Remove a saved voice (saved voices only). Never touches library/clone voices. */
  async function deleteVoice(v: VoiceOption) {
    if (v.source !== "saved" || !v.savedId) return;
    if (!window.confirm(`Delete saved voice "${v.name}"? This only removes it from your list.`)) return;
    setDeletingId(v.savedId);
    try {
      await fetch(`/api/voices/saved?id=${encodeURIComponent(v.savedId)}`, { method: "DELETE" });
      await load();
    } catch {
      /* keep the modal open; a reload will re-sync state */
    } finally {
      setDeletingId(null);
    }
  }

  async function addVoice() {
    setAddError(null);
    if (!aName.trim() || !aVoiceId.trim()) {
      setAddError("Name and voice ID are required");
      return;
    }
    const r = await fetch("/api/voices/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: aName,
        voice_id: aVoiceId,
        provider: aProvider,
        preview_url: aPreview.trim() || null,
      }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setAddError(j.error ?? `HTTP ${r.status}`);
      return;
    }
    setAName("");
    setAVoiceId("");
    setAPreview("");
    setShowAdd(false);
    await load();
  }

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
        animation: "fadeIn 0.15s ease",
      }}
    >
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} />
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: "min(920px, 100%)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Select a voice</h2>
          <span className="faint" style={{ fontSize: 12 }}>{filtered.length} voices</span>
          <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? "Cancel" : "+ Add a voice"}
          </button>
          <button className="btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        {/* Add-voice form */}
        {showAdd && (
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: "1 1 160px" }}>
                <label className="label">Name</label>
                <input className="input" value={aName} onChange={(e) => setAName(e.target.value)} placeholder="e.g. Calm narrator" />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <label className="label">Voice ID</label>
                <input className="input" value={aVoiceId} onChange={(e) => setAVoiceId(e.target.value)} placeholder="ElevenLabs or clone id" />
              </div>
              <div style={{ flex: "0 1 150px" }}>
                <label className="label">Provider</label>
                <select className="input" value={aProvider} onChange={(e) => setAProvider(e.target.value)}>
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="voice-clone">Voice clone</option>
                  <option value="edgetts">Edge TTS</option>
                </select>
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <label className="label">Preview URL (optional)</label>
                <input className="input" value={aPreview} onChange={(e) => setAPreview(e.target.value)} placeholder="https://…mp3" />
              </div>
              <button className="btn" onClick={addVoice}>Save voice</button>
            </div>
            {addError && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 8 }}>{addError}</div>}
          </div>
        )}

        {/* Filters */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <input
            className="input"
            style={{ flex: "1 1 220px" }}
            placeholder="Search by name or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button style={seg(gender === "all")} onClick={() => setGender("all")}>All</button>
            <button style={seg(gender === "male")} onClick={() => setGender("male")}>Male</button>
            <button style={seg(gender === "female")} onClick={() => setGender("female")}>Female</button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={seg(source === "all")} onClick={() => setSource("all")}>All</button>
            <button style={seg(source === "saved")} onClick={() => setSource("saved")}>Saved</button>
            <button style={seg(source === "library")} onClick={() => setSource("library")}>Library</button>
          </div>
          <button style={seg(sortAZ)} onClick={() => setSortAZ((s) => !s)}>A–Z</button>
        </div>

        {/* Grid */}
        <div style={{ overflowY: "auto", padding: 18 }}>
          {loading ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading voices…</div>
          ) : filtered.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No voices match. Add one above, or clear the filters.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 12 }}>
              {filtered.map((v) => {
                const uid = voiceUid(v);
                const isSel = uid === selectedUid;
                const result = testResult[uid];
                const isTesting = testingId === uid;
                return (
                  <div
                    key={uid}
                    data-voice-uid={uid}
                    className="card-inset"
                    style={{ padding: 12, border: isSel ? "1px solid var(--accent)" : undefined }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 650, fontSize: 14 }}>{v.name}</div>
                      {isSel && <span className="badge badge-success">selected</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {v.gender && <span className="badge badge-neutral">{v.gender}</span>}
                      {v.language && <span className="badge badge-neutral">{v.language}</span>}
                      {v.source === "saved" && <span className="badge badge-neutral">saved</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                      {/* Primary action first; utilities grouped quietly on the right. */}
                      <button className="btn btn-sm" onClick={() => onSelect(v)}>
                        Use this voice
                      </button>
                      <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                        <button
                          className="btn-ghost btn-sm"
                          disabled={!v.previewUrl}
                          onClick={() => togglePreview(v)}
                          title={v.previewUrl ? "Play the sample" : "No preview available for this voice"}
                          aria-label={v.previewUrl ? `Play ${v.name} sample` : `${v.name} has no preview`}
                        >
                          {playingId === uid ? "Pause" : "Play"}
                        </button>
                        <button
                          className="btn-secondary btn-sm"
                          disabled={isTesting}
                          onClick={() => testVoice(v)}
                          title="Synthesize a 1-line sample to check this voice works"
                        >
                          {isTesting ? "Testing…" : "Test"}
                        </button>
                        {v.source === "saved" && v.savedId && (
                          <button
                            className="btn-danger btn-sm"
                            disabled={deletingId === v.savedId}
                            onClick={() => deleteVoice(v)}
                            title="Remove this saved voice from your list"
                            aria-label={`Delete saved voice ${v.name}`}
                          >
                            {deletingId === v.savedId ? "Deleting…" : "Delete"}
                          </button>
                        )}
                      </div>
                    </div>
                    {result && (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 12,
                          lineHeight: 1.45,
                          color: result.ok ? "var(--success)" : "var(--danger)",
                        }}
                      >
                        {result.msg}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
