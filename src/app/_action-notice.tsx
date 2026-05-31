"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

export interface ActionNotice {
  kind: "error" | "warning" | "info" | "success";
  title: string;
  body: string;
  detail?: string;
  code?: string;
  actionHref?: string;
  actionLabel?: string;
}

export function ActionNoticeCard({
  notice,
  onDismiss,
  style,
}: {
  notice: ActionNotice;
  onDismiss?: () => void;
  style?: CSSProperties;
}) {
  const tone =
    notice.kind === "error"
      ? {
          color: "var(--danger)",
          background: "var(--danger-soft)",
          border: "rgba(248,113,113,0.38)",
        }
      : notice.kind === "warning"
        ? {
            color: "var(--warning)",
            background: "var(--warning-soft)",
            border: "rgba(252,211,77,0.42)",
          }
        : notice.kind === "success"
          ? {
              color: "var(--success)",
              background: "var(--success-soft)",
              border: "rgba(74,222,128,0.36)",
            }
          : {
              color: "var(--accent-hover)",
              background: "var(--accent-soft)",
              border: "rgba(226,54,54,0.32)",
            };

  return (
    <div
      role={notice.kind === "error" ? "alert" : "status"}
      className="card-inset"
      style={{
        padding: "12px 14px",
        borderColor: tone.border,
        background: tone.background,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        ...style,
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        <div style={{ color: tone.color, fontWeight: 750, fontSize: 13.5 }}>{notice.title}</div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.55, marginTop: 3, whiteSpace: "pre-line" }}>
          {notice.body}
        </div>
        {notice.detail && (
          <pre
            className="mono"
            style={{
              margin: "8px 0 0",
              whiteSpace: "pre-wrap",
              color: "var(--fg-muted)",
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {notice.detail}
          </pre>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {notice.actionHref && (
          <Link className="btn-secondary btn-sm" href={notice.actionHref}>
            {notice.actionLabel ?? "Open"}
          </Link>
        )}
        {onDismiss && (
          <button type="button" className="btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
