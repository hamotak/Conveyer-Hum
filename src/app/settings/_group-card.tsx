"use client";
import { useState } from "react";
import type { Group } from "./_groups";

interface GroupCardProps {
  group: Group;
  values: Record<string, string>;
  setValues: (next: Record<string, string>) => void;
}

/** Renders one settings group as a single card with all its fields. */
export function GroupCard({ group, values, setValues }: GroupCardProps) {
  const [open, setOpen] = useState(!group.collapsed);
  const groupMissing = group.fields.some((f) => f.required && !values[f.key]);
  return (
    <div
      className="card"
      style={{
        marginBottom: 14,
        borderColor: groupMissing ? "rgba(248,113,113,0.4)" : undefined,
      }}
    >
      {group.collapsed ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 36,
            marginBottom: open ? 4 : 0,
            background: "none",
            border: "none",
            padding: "7px 0",
            cursor: "pointer",
            width: "100%",
            textAlign: "left",
            color: "var(--fg)",
          }}
        >
          <span style={{ fontSize: 12, opacity: 0.7 }}>{open ? "▾" : "▸"}</span>
          <h2 style={{ margin: 0 }}>{group.title}</h2>
        </button>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{group.title}</h2>
          {group.required && (
            <span
              className="badge"
              style={{
                background: groupMissing ? "var(--danger-soft)" : "var(--success-soft, rgba(74,222,128,0.1))",
                color: groupMissing ? "var(--danger)" : "var(--success)",
              }}
            >
              {groupMissing ? "NEEDS SETUP" : "READY"}
            </span>
          )}
        </div>
      )}
      {open && (
        <>
          {group.subtitle && (
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>
              {group.subtitle}
            </p>
          )}
          <div style={{ display: "grid", gap: 16 }}>
        {group.fields.map((f) => {
          const missing = f.required && !values[f.key];
          const inputId = `setting-${f.key}`;
          return (
            <div key={f.key}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                <label
                  htmlFor={inputId}
                  className="label"
                  style={{
                    margin: 0,
                    color: missing ? "var(--danger)" : "var(--fg)",
                    fontWeight: 600,
                    letterSpacing: "0.01em",
                  }}
                >
                  {f.label ?? f.key}
                </label>
                {f.required && (
                  <span
                    style={{
                      color: missing ? "var(--danger)" : "var(--success)",
                      fontSize: 10.5,
                      fontWeight: 700,
                    }}
                  >
                    {missing ? "required" : "set"}
                  </span>
                )}
              </div>
              {f.options ? (
                <select
                  id={inputId}
                  className="input"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  style={{ borderColor: missing ? "var(--danger)" : undefined }}
                >
                  {/* Surface an unrecognized stored value so it isn't silently lost. */}
                  {values[f.key] && !f.options.some((o) => o.value === values[f.key]) && (
                    <option value={values[f.key]}>{values[f.key]}</option>
                  )}
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.multiline ? (
                <textarea
                  id={inputId}
                  className="textarea"
                  value={values[f.key] ?? ""}
                  placeholder={f.examples ? `e.g. ${f.examples}` : ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  rows={Math.max(2, Math.min(6, (values[f.key] ?? "").split(/\n/).length + 1))}
                  style={{ borderColor: missing ? "var(--danger)" : undefined }}
                />
              ) : (
                <input
                  id={inputId}
                  className="input"
                  value={values[f.key] ?? ""}
                  placeholder={f.examples ? `e.g. ${f.examples}` : ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  style={{ borderColor: missing ? "var(--danger)" : undefined }}
                />
              )}
              {f.key === "LABS69_API_KEY" && values[f.key] && (
                <div style={{ color: "var(--success)", fontSize: 12, marginTop: 6 }}>
                  Detected{" "}
                  <strong>
                    {values[f.key].split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean).length}
                  </strong>{" "}
                  key
                  {values[f.key].split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean).length === 1
                    ? ""
                    : "s"}
                </div>
              )}
              <div
                style={{
                  color: "var(--fg-muted)",
                  fontSize: 12,
                  marginTop: 6,
                  lineHeight: 1.5,
                  whiteSpace: "pre-line",
                }}
              >
                {f.desc}
              </div>
              {f.examples && (
                <div className="mono faint" style={{ fontSize: 11, marginTop: 3 }}>
                  {f.examples}
                </div>
              )}
            </div>
          );
        })}
          </div>
        </>
      )}
    </div>
  );
}
