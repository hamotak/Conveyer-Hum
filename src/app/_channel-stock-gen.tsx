"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { defaultStockFolder, channelStockTheme } from "@/lib/channel-stock";
import { ActionNoticeCard, type ActionNotice } from "./_action-notice";

interface GenStatus {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  folder: string;
  cancelRequested?: boolean;
  lastError?: string;
}

interface Props {
  folder: string;
  theme: string;
  videoStyle?: string | null;
  compact?: boolean;
}

/** Inline B-roll generator — polls progress and refreshes clip count. */
export function ChannelStockGen({
  folder,
  theme,
  videoStyle,
  compact = false,
}: Props) {
  const [count, setCount] = useState(20);
  const [gen, setGen] = useState<GenStatus | null>(null);
  const [clipCount, setClipCount] = useState<number | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const folderRef = useRef(folder);

  useEffect(() => {
    folderRef.current = folder;
    setClipCount(null);
  }, [folder]);

  const refreshCount = useCallback(async () => {
    const targetFolder = folder.trim();
    if (!targetFolder) return;
    try {
      const r = await fetch(`/api/stock/list?folder=${encodeURIComponent(targetFolder)}`);
      const j = await r.json();
      if (r.ok && folderRef.current.trim() === targetFolder) {
        setClipCount((j.clips as unknown[])?.length ?? 0);
      }
    } catch {
      if (folderRef.current.trim() === targetFolder) setClipCount(null);
    }
  }, [folder]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  useEffect(() => {
    const targetFolder = folder.trim();
    if (!targetFolder) return;
    fetch(`/api/stock/generate?folder=${encodeURIComponent(targetFolder)}`)
      .then((r) => r.json())
      .then((s: GenStatus) => {
        if (folderRef.current.trim() === targetFolder && (s.running || s.done > 0)) setGen(s);
      })
      .catch(() => {});
  }, [folder]);

  useEffect(() => {
    if (!gen?.running) return;
    const t = setInterval(async () => {
      const s = await fetch(`/api/stock/generate?folder=${encodeURIComponent(folder)}`).then((r) =>
        r.json()
      );
      setGen(s);
      if (!s.running) {
        clearInterval(t);
        refreshCount();
      }
    }, 4000);
    return () => clearInterval(t);
  }, [gen?.running, folder, refreshCount]);

  async function start() {
    const themeToUse = theme.trim() || folder.trim();
    const r = await fetch("/api/stock/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, theme: themeToUse, count, videoStyle: videoStyle ?? null }),
    });
    const j = await r.json();
    if (!r.ok) {
      setNotice({
        kind: "error",
        title: "B-roll generation could not start",
        body: String(j.error || r.statusText),
      });
      return;
    }
    setNotice(null);
    setGen(j);
  }

  async function stop() {
    const r = await fetch(`/api/stock/generate?folder=${encodeURIComponent(folder)}`, {
      method: "DELETE",
    });
    const j = await r.json();
    setGen(j);
  }

  const needsLibrary = clipCount === 0;
  const busy = gen?.running;

  if (compact) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {clipCount != null && (
          <span className="faint" style={{ fontSize: 11.5 }}>
            {clipCount} B-roll clip{clipCount === 1 ? "" : "s"}
          </span>
        )}
        <a className="btn-secondary btn-sm" href="/clips">
          {needsLibrary ? "Set up B-roll" : "Manage B-roll"}
        </a>
        {busy && (
          <span className="badge badge-neutral" style={{ fontSize: 10 }}>
            Generating {gen!.done + gen!.failed}/{gen!.total}
          </span>
        )}
        {gen && !gen.running && gen.done > 0 && (
          <span className="badge badge-success" style={{ fontSize: 10 }}>+{gen.done} added</span>
        )}
      </div>
    );
  }

  return (
    <div className="card-inset" style={{ padding: 12, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 650, fontSize: 13 }}>B-roll library</div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
            Folder: <strong>{folder || "—"}</strong>
            {clipCount != null && <> · {clipCount} clip{clipCount === 1 ? "" : "s"}</>}
          </div>
        </div>
        {needsLibrary && !busy && (
          <span className="badge" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
            Empty — generate before first hybrid run
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "0 1 90px" }}>
          <label className="label" style={{ fontSize: 11 }}>Count</label>
          <input
            className="input"
            type="number"
            min={5}
            max={100}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </div>
        <button className="btn" onClick={start} disabled={busy || !folder.trim()}>
          {busy ? `Generating… ${gen!.done + gen!.failed}/${gen!.total}` : "Generate B-roll"}
        </button>
        {busy && (
          <button className="btn-secondary" onClick={stop}>
            {gen?.cancelRequested ? "Stopping…" : "Stop"}
          </button>
        )}
        <a className="btn-secondary btn-sm" href="/clips" style={{ alignSelf: "flex-end" }}>
          Manage in Clips
        </a>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
        General reusable shots for Hybrid / Stock Cut — not tied to any one script.
      </div>
      {notice && <ActionNoticeCard notice={notice} onDismiss={() => setNotice(null)} style={{ marginTop: 10 }} />}
      {gen && (gen.running || gen.done > 0 || gen.failed > 0) && (
        <div
          style={{
            fontSize: 12,
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: "var(--r-sm)",
            background: gen.running ? "var(--surface-2)" : "var(--success-soft)",
            color: gen.running ? "var(--fg-muted)" : "var(--success)",
          }}
        >
          {gen.running
            ? gen.cancelRequested
              ? `Stopping… ${gen.done + gen.failed}/${gen.total} finished so far`
              : `Generating… ${gen.done + gen.failed}/${gen.total} (${gen.failed} failed)`
            : `Done — ${gen.done}/${gen.total} clips added${gen.failed ? `, ${gen.failed} failed` : ""}.`}
          {gen.lastError && <div className="faint" style={{ marginTop: 4 }}>{gen.lastError}</div>}
        </div>
      )}
    </div>
  );
}

export { defaultStockFolder, channelStockTheme };
