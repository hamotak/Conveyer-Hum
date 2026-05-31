"use client";

import { useEffect, useState } from "react";

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, request]);

  useEffect(() => {
    if (!request) {
      setBusy(false);
      setError(null);
    }
  }, [request]);

  if (!request) return null;

  async function confirm() {
    try {
      setBusy(true);
      setError(null);
      await request?.onConfirm();
      onClose();
    } catch (e) {
      setError((e as Error).message || "That action failed. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "grid",
        placeItems: "center",
        padding: 18,
        background: "rgba(0,0,0,0.62)",
        backdropFilter: "blur(8px)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="card"
        style={{
          width: "min(460px, 100%)",
          boxShadow: "var(--shadow-lg)",
          borderColor: request.danger ? "rgba(248,113,113,0.42)" : "var(--border-strong)",
        }}
      >
        <h2 id="confirm-dialog-title" style={{ margin: "0 0 8px", fontSize: 17 }}>
          {request.title}
        </h2>
        <p className="muted" style={{ margin: "0 0 18px", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-line" }}>
          {request.body}
        </p>
        {error && (
          <div
            role="alert"
            style={{
              margin: "0 0 14px",
              padding: "9px 11px",
              borderRadius: "var(--r-sm)",
              border: "1px solid rgba(248,113,113,0.35)",
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={request.danger ? "btn-danger" : "btn"}
            onClick={confirm}
            disabled={busy}
            autoFocus
          >
            {busy ? "Working..." : request.confirmLabel ?? "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
