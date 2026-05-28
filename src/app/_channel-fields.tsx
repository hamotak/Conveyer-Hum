"use client";
import { STYLE_PRESETS, loadStylePreset } from "@/lib/style-presets";

/** The creative settings a channel (or the no-channel global run) owns. All strings
 *  for form-binding; the parent maps them to channel columns or global settings. */
export interface ChannelFieldsValue {
  stylePresetId: string;
  videoStyle: string;
  videoModel: string;
  aspectRatio: string;
  voiceSpeed: string;
  voiceStability: string;
  voiceSimilarity: string;
  voiceStyle: string;
}

const VIDEO_MODELS = [
  { value: "veo-video", label: "Veo 3.1 Fast (recommended)" },
  { value: "grok-imagine-video", label: "Grok Video (legacy — 6-second clips)" },
];

const labelStyle: React.CSSProperties = { marginTop: 0 };

function num(
  label: string,
  hint: string,
  value: string,
  ph: string,
  min: number,
  max: number,
  step: number,
  onChange: (v: string) => void
) {
  return (
    <div style={{ flex: 1, minWidth: 120 }}>
      <label className="label" style={labelStyle}>{label}</label>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={ph}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{hint}</div>
    </div>
  );
}

/**
 * Style preset + Voice + Video sections — shared by the channel form (/prompts)
 * and the no-channel inline card (/). Picking a style preset pre-fills the voice
 * tuning + video style from the preset's defaults; the user can still override.
 */
export function ChannelFields({
  value,
  onChange,
  voiceLabel,
  onOpenVoicePicker,
}: {
  value: ChannelFieldsValue;
  onChange: (patch: Partial<ChannelFieldsValue>) => void;
  voiceLabel: string | null;
  onOpenVoicePicker: () => void;
}) {
  const preset = loadStylePreset(value.stylePresetId);

  function pickPreset(id: string) {
    const p = loadStylePreset(id);
    onChange({
      stylePresetId: id,
      voiceSpeed: String(p.defaults.ttsSpeed),
      voiceStability: String(p.defaults.ttsStability),
      voiceSimilarity: String(p.defaults.ttsSimilarityBoost),
      voiceStyle: String(p.defaults.ttsStyle),
      videoStyle: p.defaults.videoStyle,
    });
  }

  return (
    <>
      {/* ── Style preset ── */}
      <div style={{ marginBottom: 16 }}>
        <label className="label" style={labelStyle}>Style preset</label>
        <select
          className="input"
          value={value.stylePresetId || preset.id}
          onChange={(e) => pickPreset(e.target.value)}
        >
          {STYLE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>{preset.description}</div>
      </div>

      {/* ── Voice ── */}
      <div style={{ marginBottom: 16 }}>
        <label className="label" style={labelStyle}>Voice</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <button type="button" className="btn-secondary" onClick={onOpenVoicePicker}>
            {voiceLabel ? "Change voice" : "Select a voice ▾"}
          </button>
          {voiceLabel && <span className="faint" style={{ fontSize: 13 }}>{voiceLabel}</span>}
        </div>
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--fg-muted)" }}>Voice tuning</summary>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
            {num("Speed", "0.85 = slower", value.voiceSpeed, "0.85", 0.5, 1.5, 0.05, (v) => onChange({ voiceSpeed: v }))}
            {num("Stability", "0–1", value.voiceStability, "0.6", 0, 1, 0.05, (v) => onChange({ voiceStability: v }))}
            {num("Similarity", "0–1", value.voiceSimilarity, "0.75", 0, 1, 0.05, (v) => onChange({ voiceSimilarity: v }))}
            {num("Style", "0–1", value.voiceStyle, "0.15", 0, 1, 0.05, (v) => onChange({ voiceStyle: v }))}
          </div>
        </details>
      </div>

      {/* ── Video (advanced — collapsed; the style preset already sets sensible defaults) ── */}
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--fg-muted)" }}>
          Video model &amp; style
        </summary>
        <div style={{ marginTop: 10 }}>
          <label className="label" style={labelStyle}>Video model</label>
          <select
            className="input"
            value={value.videoModel || "veo-video"}
            onChange={(e) => onChange({ videoModel: e.target.value })}
            style={{ marginBottom: 10 }}
          >
            {VIDEO_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <label className="label" style={labelStyle}>Video style</label>
          <textarea
            className="textarea"
            rows={3}
            placeholder={preset.defaults.videoStyle}
            value={value.videoStyle}
            onChange={(e) => onChange({ videoStyle: e.target.value })}
            style={{ marginBottom: 10 }}
          />
          <label className="label" style={labelStyle}>Aspect ratio</label>
          <input
            className="input"
            placeholder="16:9"
            value={value.aspectRatio}
            onChange={(e) => onChange({ aspectRatio: e.target.value })}
          />
        </div>
      </details>
    </>
  );
}
