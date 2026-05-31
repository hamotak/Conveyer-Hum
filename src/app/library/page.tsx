"use client";
import { useEffect, useMemo, useState } from "react";

interface LibraryClip {
  index: number;
  file: string;
  drive_file_id: string;
  drive_file_link: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
}

interface LibraryRun {
  drive_folder_id: string;
  drive_folder_name: string;
  drive_folder_link: string;
  run_id: string;
  run_title: string | null;
  folder_name: string;
  channel: string;
  created_at: string;
  scene_count: number;
  uploaded_clip_count: number;
  settings: {
    animation_provider: string;
    animation_model: string;
    video_resolution: string;
  };
  clips: LibraryClip[];
}

interface GdriveStatus {
  connected: boolean;
  credentialsConfigured: boolean;
}

interface LocalRun {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  output_path: string | null;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 6000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function isAuditRun(run: LocalRun): boolean {
  const title = (run.title || "").trim();
  return title.startsWith("__AUDIT_") || /^__V\d+_/i.test(title) || /\bTEST\b/i.test(title);
}

export default function LibraryPage() {
  const embedded = false;
  const [runs, setRuns] = useState<LibraryRun[] | null>(null);
  const [localRuns, setLocalRuns] = useState<LocalRun[]>([]);
  const [drive, setDrive] = useState<GdriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [driveR, localR] = await Promise.all([
          fetchJsonWithTimeout<GdriveStatus>("/api/gdrive/status", 4000),
          fetchJsonWithTimeout<LocalRun[]>("/api/runs", 4000).catch(() => []),
        ]);
        if (!alive) return;
        setDrive(driveR as GdriveStatus);
        setLocalRuns(
          (Array.isArray(localR) ? (localR as LocalRun[]) : [])
            .filter((r) => r.status === "done" && r.output_path && !isAuditRun(r))
        );
        if (!driveR.connected) {
          setRuns([]);
          return;
        }
        const r = await fetchJsonWithTimeout<{ runs?: LibraryRun[]; error?: string }>("/api/library/runs", 3500);
        if (!alive) return;
        if (r.error) {
          setError(String(r.error));
          setRuns([]);
        } else {
          setRuns((r.runs ?? []) as LibraryRun[]);
        }
      } catch (e) {
        if (alive) {
          const timedOut = e instanceof DOMException && e.name === "AbortError";
          setError(timedOut ? "Drive library is taking too long to respond. Local saved videos are still available." : (e as Error).message);
          setRuns([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const reusableRuns = useMemo(() => {
    if (!runs) return [];
    return runs.filter((r) => r.uploaded_clip_count > 0 && r.clips.length > 0);
  }, [runs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reusableRuns;
    return reusableRuns.filter((r) => {
      const inTitle = (r.run_title || r.folder_name).toLowerCase().includes(q);
      const inClips = r.clips.some(
        (c) => c.scene_text.toLowerCase().includes(q) || c.visual_prompt.toLowerCase().includes(q)
      );
      return inTitle || inClips;
    });
  }, [reusableRuns, query]);

  // Group runs by channel — channels alphabetical, "_No Channel" last.
  const grouped = useMemo(() => {
    const m = new Map<string, LibraryRun[]>();
    for (const r of filtered) {
      const list = m.get(r.channel) ?? [];
      list.push(r);
      m.set(r.channel, list);
    }
    return [...m.entries()].sort(([a], [b]) => {
      if (a === "_No Channel") return 1;
      if (b === "_No Channel") return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <div>
      {!embedded && (
        <>
          <h1>Saved Videos</h1>
          <p className="muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
            Finished videos on this Mac first. Drive uploads and reusable scene clips appear below when connected.
          </p>
        </>
      )}

      {localRuns.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>On this Mac</h2>
            <span className="badge badge-neutral">
              {localRuns.length} video{localRuns.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="row-list">
            {localRuns.map((r) => (
              <div
                key={r.id}
                className="row-item"
                role="link"
                tabIndex={0}
                onClick={() => {
                  window.location.href = `/runs/${r.id}`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    window.location.href = `/runs/${r.id}`;
                  }
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-title">{r.title || r.id.slice(0, 8)}</div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                    {new Date(r.created_at.endsWith("Z") ? r.created_at : `${r.created_at}Z`).toLocaleString()}
                  </div>
                </div>
                <a
                  className="btn-secondary btn-sm"
                  href={`/api/runs/${r.id}/file?p=final.mp4&download=1`}
                  onClick={(e) => e.stopPropagation()}
                >
                  Download
                </a>
                <span aria-hidden="true" className="row-chevron">›</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 10px" }}>
            <h2 style={{ margin: 0 }}>Drive library</h2>
            <span className="badge badge-neutral">loading</span>
          </div>
          <div className="row-list" aria-busy="true" aria-label="Loading library">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="row-item" style={{ cursor: "default" }}>
                <div style={{ flex: 1 }}>
                  <div className="skeleton skeleton-line" style={{ width: "42%", marginBottom: 8 }} />
                  <div className="skeleton skeleton-line" style={{ width: "24%", height: 9 }} />
                </div>
                <div className="skeleton skeleton-pill" style={{ width: 84 }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && drive && !drive.connected && (
        <div className={localRuns.length > 0 ? "card" : "empty-state"}>
          <div className="empty-state-title">Connect Google Drive</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px", lineHeight: 1.5 }}>
            Drive adds cloud backups and reusable scene clips. Local finished videos still work above.
          </p>
          <a className="btn" href="/settings">Open Settings</a>
        </div>
      )}

      {!loading && drive?.connected && error && (
        <div
          className="card"
          style={{
            borderColor: "rgba(252,211,77,0.35)",
            background: "var(--warning-soft)",
            marginBottom: 16,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--warning)", fontWeight: 750, fontSize: 13 }}>
              Drive library paused
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.55, marginTop: 4 }}>
              {error}
            </div>
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setReloadKey((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}

      {!loading && drive?.connected && !error && runs && reusableRuns.length === 0 && localRuns.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No saved videos yet</div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px", lineHeight: 1.5 }}>
            Finished Drive uploads with reusable scene clips appear here. Empty or test-only folders stay hidden.
          </p>
          <a className="btn" href="/">New video</a>
        </div>
      )}

      {!loading && drive?.connected && runs && reusableRuns.length > 0 && (
        <>
          <div style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="input"
              placeholder="Search by title or scene text…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ maxWidth: 380, flex: 1 }}
            />
            <span className="muted" style={{ fontSize: 13 }}>
              {filtered.length === reusableRuns.length
                ? `${reusableRuns.length} run${reusableRuns.length === 1 ? "" : "s"}`
                : `${filtered.length} of ${reusableRuns.length} runs`}
            </span>
          </div>

          {grouped.map(([channel, channelRuns]) => (
            <div key={channel} style={{ marginBottom: 26 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>{channel === "_No Channel" ? "No channel" : channel}</h2>
                <span className="badge badge-neutral">
                  {channelRuns.length} run{channelRuns.length === 1 ? "" : "s"}
                </span>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {channelRuns.map((r) => {
                  const isOpen = openRunId === r.drive_folder_id;
                  return (
                <div key={r.drive_folder_id} className="card">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 3 }}>
                        {r.run_title || r.folder_name}
                      </div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {r.created_at && <span>{new Date(r.created_at).toLocaleString()} · </span>}
                        {r.uploaded_clip_count} clip{r.uploaded_clip_count === 1 ? "" : "s"}
                        {r.scene_count !== r.uploaded_clip_count && <span> / {r.scene_count} scenes</span>}
                        {r.settings.animation_model && (
                          <span>
                            {" "}· {r.settings.animation_model}
                            {r.settings.video_resolution && ` (${r.settings.video_resolution})`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      {r.uploaded_clip_count > 0 ? (
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => setOpenRunId(isOpen ? null : r.drive_folder_id)}
                        >
                          {isOpen ? "Hide clips" : `View ${r.uploaded_clip_count} clips`}
                        </button>
                      ) : (
                        <span className="faint" style={{ fontSize: 12 }}>No reusable clips in this run</span>
                      )}
                      <a
                        className="btn-secondary btn-sm"
                        href={r.drive_folder_link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open in Drive
                      </a>
                    </div>
                  </div>

                  {isOpen && (
                    <div
                      style={{
                        marginTop: 14,
                        paddingTop: 12,
                        borderTop: "1px solid var(--border)",
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))",
                        gap: 10,
                      }}
                    >
                      {r.clips.map((c) => (
                        <div key={c.drive_file_id} className="card-inset" style={{ padding: 11 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                            Scene {c.index}
                            {c.audio_duration_sec != null && c.audio_duration_sec > 0 && (
                              <span className="faint" style={{ marginLeft: 6, fontWeight: 400 }}>
                                {c.audio_duration_sec.toFixed(1)}s audio
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              color: "var(--fg-muted)",
                              fontSize: 11,
                              lineHeight: 1.5,
                              marginBottom: 6,
                              maxHeight: 70,
                              overflow: "auto",
                            }}
                          >
                            {c.scene_text}
                          </div>
                          <div
                            className="mono"
                            style={{
                              color: "var(--accent-hover)",
                              fontSize: 10,
                              marginBottom: 8,
                              maxHeight: 70,
                              overflow: "auto",
                              lineHeight: 1.4,
                            }}
                          >
                            {c.visual_prompt}
                          </div>
                          <a href={c.drive_file_link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
                            Open clip in Drive →
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
