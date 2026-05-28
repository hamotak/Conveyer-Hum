"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface RunRow {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  created_at: string;
  updated_at: string;
  output_path: string | null;
}

export default function RunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);

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

  const doneCount = runs.filter((r) => r.status === "done").length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Runs</h1>
        {runs.length > 0 && (
          <span className="faint" style={{ fontSize: 12.5 }}>
            {runs.length} total · {doneCount} done
          </span>
        )}
      </div>

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

      {loaded && runs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No runs yet</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px", lineHeight: 1.5 }}>
            Paste a script and start your first video — it&apos;ll show up here.
          </p>
          <Link href="/" className="btn">New video</Link>
        </div>
      )}

      {runs.length > 0 && (
        <div className="row-list">
          {runs.map((r) => (
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
              <span className={`tag tag-${r.status}`}>{r.status}</span>
              <span aria-hidden="true" className="row-chevron">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
