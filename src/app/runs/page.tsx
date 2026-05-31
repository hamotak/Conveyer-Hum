"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ActionNoticeCard, type ActionNotice } from "../_action-notice";
import { ConfirmDialog, type ConfirmRequest } from "../_confirm-dialog";

interface RunRow {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled" | "paused";
  needs_recovery?: boolean;
  needs_repair?: boolean;
  created_at: string;
  updated_at: string;
  output_path: string | null;
}

export default function RunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAuditRuns, setShowAuditRuns] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const r = await fetch("/api/runs");
      if (!alive) return;
      setRuns(await r.json());
      setLoaded(true);
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const auditRuns = runs.filter((r) => isAuditRun(r));
  const visibleRuns = showAuditRuns ? runs : runs.filter((r) => !isAuditRun(r));
  const doneCount = visibleRuns.filter((r) => r.status === "done").length;

  async function deleteRun(e: React.MouseEvent, r: RunRow) {
    e.preventDefault();
    e.stopPropagation();
    setConfirming({
      title: "Delete this run?",
      body: `"${r.title || r.id.slice(0, 8)}" will be removed from this machine. Drive copies, if any, stay in Drive.`,
      confirmLabel: "Delete run",
      danger: true,
      onConfirm: async () => {
    const resp = await fetch(`/api/runs/${r.id}`, { method: "DELETE" });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}) as { error?: string });
      setNotice({
        kind: "error",
        title: "Run was not deleted",
        body: String(j.error || resp.statusText),
      });
      return;
    }
    setRuns((prev) => prev.filter((x) => x.id !== r.id));
    setNotice({
      kind: "success",
      title: "Run deleted",
      body: `${r.title || r.id.slice(0, 8)} was removed from this machine.`,
    });
      },
    });
  }

  return (
    <div>
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />

      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Runs</h1>
        {visibleRuns.length > 0 && (
          <span className="faint" style={{ fontSize: 12.5 }}>
            {visibleRuns.length} shown · {doneCount} done
          </span>
        )}
        {auditRuns.length > 0 && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setShowAuditRuns((v) => !v)}
            style={{ marginLeft: "auto" }}
          >
            {showAuditRuns ? "Hide test runs" : `Show ${auditRuns.length} test run${auditRuns.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {notice && <ActionNoticeCard notice={notice} onDismiss={() => setNotice(null)} style={{ marginBottom: 16 }} />}

      {!loaded && (
        <div className="row-list" aria-busy="true" aria-label="Loading runs">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="row-item" style={{ cursor: "default" }}>
              <div style={{ flex: 1 }}>
                <div className="skeleton skeleton-line" style={{ width: "38%", marginBottom: 8 }} />
                <div className="skeleton skeleton-line" style={{ width: "22%", height: 9 }} />
              </div>
              <div className="skeleton skeleton-pill" />
            </div>
          ))}
        </div>
      )}

      {loaded && visibleRuns.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No runs yet</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px", lineHeight: 1.5 }}>
            Paste a script and start your first video — it&apos;ll show up here.
          </p>
          <Link href="/" className="btn">New video</Link>
        </div>
      )}

      {visibleRuns.length > 0 && (
        <div className="row-list">
          {visibleRuns.map((r) => (
            <Link key={r.id} href={`/runs/${r.id}`} className="row-item">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row-title">{r.title || r.id.slice(0, 8)}</div>
                <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                  {new Date(r.created_at.endsWith("Z") ? r.created_at : r.created_at + "Z").toLocaleString()}
                </div>
              </div>
              {r.output_path && (
                <span
                  className="faint"
                  style={{ fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}
                  title="Final video ready"
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }} />
                  video
                </span>
              )}
              <span className={`tag tag-${r.needs_repair ? "paused" : statusTagClass(r.status)}`}>
                {r.needs_repair ? "needs repair" : statusLabel(r.status)}
              </span>
              {r.status !== "running" && r.status !== "pending" && (
                <button
                  className="btn-ghost-danger btn-sm"
                  title="Delete run"
                  aria-label={`Delete ${r.title || r.id.slice(0, 8)}`}
                  onClick={(e) => deleteRun(e, r)}
                  style={{ padding: "5px 8px" }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              )}
              <span aria-hidden="true" className="row-chevron">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function isAuditRun(run: RunRow): boolean {
  const title = (run.title || "").trim();
  return title.startsWith("__AUDIT_") || /^__V\d+_/i.test(title) || /\bTEST\b/i.test(title);
}

function statusLabel(status: RunRow["status"]): string {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "working";
    case "paused":
      return "needs resume";
    case "error":
      return "needs review";
    case "cancelled":
      return "stopped";
    default:
      return status;
  }
}

function statusTagClass(status: RunRow["status"]): RunRow["status"] {
  return status === "error" ? "paused" : status;
}
