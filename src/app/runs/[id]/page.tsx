"use client";
import { useEffect, useRef, useState, use, useMemo } from "react";
import Link from "next/link";
import { RunPhaseMonitor, type PhaseAssets } from "../../_run-phase-monitor";
import { ActionNoticeCard, type ActionNotice } from "../../_action-notice";
import { ConfirmDialog, type ConfirmRequest } from "../../_confirm-dialog";

interface LogEntry {
  id?: number;
  ts: string;
  level: "info" | "warn" | "error" | "success" | "debug";
  stage?: string;
  message: string;
}
interface Run {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled" | "paused";
  output_path: string | null;
  mode?: string | null;
}
interface DriveStatus {
  syncEnabled: boolean;
  connected: boolean;
  synced: boolean;
  syncedAt?: string;
  finalVideoLink?: string;
  clipsFolderLink?: string;
  canRetry: boolean;
  rawClipsRemainCount?: number;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [assets, setAssets] = useState<PhaseAssets | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [uploadingDrive, setUploadingDrive] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [expandedScene, setExpandedScene] = useState<number | null>(null);
  const [logFilter, setLogFilter] = useState<"important" | "all">("important");
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const logPanelRef = useRef<HTMLDivElement>(null);
  const logTail = useRef<HTMLDivElement>(null);
  const logFollowRef = useRef(true);
  const [logFollowing, setLogFollowing] = useState(true);

  useEffect(() => {
    // Fresh run → reset streamed logs (SSE can replay on reconnect; we dedupe by id below).
    setLogs([]);
    const es = new EventSource(`/api/runs/${id}/logs`);
    es.addEventListener("log", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as LogEntry;
      setLogs((prev) => {
        const key = e.id != null ? `id:${e.id}` : `msg:${e.ts}|${e.stage ?? ""}|${e.message}`;
        const exists = prev.some((l) => {
          const prevKey = l.id != null ? `id:${l.id}` : `msg:${l.ts}|${l.stage ?? ""}|${l.message}`;
          return prevKey === key;
        });
        return exists ? prev : [...prev, e];
      });
    });
    return () => es.close();
  }, [id]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const [runR, assetsR] = await Promise.all([
        fetch(`/api/runs/${id}`).then((r) => r.json()),
        fetch(`/api/runs/${id}/assets`).then((r) => r.json()),
      ]);
      if (!alive) return;
      const nextRun = runR.run as Run;
      const nextAssets = assetsR as PhaseAssets;
      setRun(nextRun);
      setAssets(nextAssets);
      if (nextAssets.finalExists || nextRun.status === "done") {
        const driveR = await fetch(`/api/runs/${id}/drive`).then((r) => r.json()).catch(() => null);
        if (alive) setDrive(driveR as DriveStatus | null);
      }
    }
    tick();
    const interval = run?.status === "running" || run?.status === "pending" ? 2000 : 4000;
    const t = setInterval(tick, interval);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, run?.status]);

  const loaded = assets !== null;
  // A run whose DB status is still "running" but has no live worker is "paused"
  // (e.g. a long hybrid run the server restarted out from under). Treat it as
  // settled for display so the monitor stops showing misleading spinners.
  const isPaused = !!assets?.recovery?.paused || run?.status === "paused";
  const isActive = (run?.status === "running" || run?.status === "pending") && !isPaused;
  const displayStatus = run ? (isPaused ? "paused" : run.status) : null;
  const hasPlan = (assets?.planSceneCount ?? 0) > 0;

  // SSE can replay rows on reconnect — collapse to one entry per persisted id,
  // falling back to a timestamp+stage+message key for rows that arrive without an id.
  const dedupedLogs = useMemo(() => {
    const seen = new Set<string>();
    const out: LogEntry[] = [];
    for (const l of logs) {
      const key = l.id != null ? `id:${l.id}` : `msg:${l.ts}|${l.stage ?? ""}|${l.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out;
  }, [logs]);

  const visibleLogs = useMemo(() => {
    if (logFilter === "all") return dedupedLogs;
    return dedupedLogs.filter((l) => l.level !== "debug");
  }, [dedupedLogs, logFilter]);

  // Only auto-scroll inside the log panel when the user is already at the bottom (never hijack page scroll).
  useEffect(() => {
    if (!isActive || !logPanelRef.current || !logFollowRef.current) return;
    const panel = logPanelRef.current;
    panel.scrollTop = panel.scrollHeight;
  }, [visibleLogs.length, isActive]);

  function onLogPanelScroll() {
    const panel = logPanelRef.current;
    if (!panel) return;
    const dist = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    const following = dist < 64;
    logFollowRef.current = following;
    setLogFollowing(following);
  }

  const lastError = useMemo(() => {
    for (let i = dedupedLogs.length - 1; i >= 0; i--) {
      if (dedupedLogs[i].level === "error") return dedupedLogs[i].message;
    }
    return null;
  }, [dedupedLogs]);
  const speed = useMemo(() => (assets ? deriveRunSpeed(assets, dedupedLogs) : null), [assets, dedupedLogs]);

  const fileUrl = (p: string, dl = false) =>
    `/api/runs/${id}/file?p=${encodeURIComponent(p)}${dl ? "&download=1" : ""}`;

  async function cancel() {
    setConfirming({
      title: "Stop this run?",
      body: "Already generated files stay on disk, and the run can be resumed from saved work later.",
      confirmLabel: "Stop run",
      danger: true,
      onConfirm: async () => {
        await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
        setNotice({ kind: "info", title: "Stop requested", body: "The active provider jobs are being cancelled." });
      },
    });
  }

  async function uploadToDrive() {
    setUploadingDrive(true);
    try {
      const r = await fetch(`/api/runs/${id}/drive`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}) as { error?: string });
        setNotice({
          kind: "error",
          title: "Drive upload failed",
          body: String(j.error || r.statusText),
          actionHref: String(j.error || "").toLowerCase().includes("connect") ? "/settings" : undefined,
          actionLabel: "Open Settings",
        });
        return;
      }
      setDrive(await fetch(`/api/runs/${id}/drive`).then((x) => x.json()));
      setNotice({ kind: "success", title: "Drive upload finished", body: "The final video and reusable clips are now synced." });
    } finally {
      setUploadingDrive(false);
    }
  }

  async function openFolder() {
    const r = await fetch(`/api/runs/${id}/open-folder`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) {
      setNotice({
        kind: "error",
        title: "Folder could not be opened",
        body: String(j.error || "The run folder was not found."),
      });
    }
  }

  async function resume() {
    setResuming(true);
    try {
      const r = await fetch(`/api/runs/${id}/reassemble`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}) as { error?: string });
        setNotice({
          kind: "error",
          title: "Resume could not start",
          body: String(j.error || r.statusText),
        });
      } else {
        setNotice({ kind: "info", title: "Resume started", body: "The run is picking up from saved work." });
      }
    } finally {
      setResuming(false);
    }
  }

  async function repairChunksAndRebuild() {
    setConfirming({
      title: "Repair chunks and rebuild?",
      body:
        "This run was made with old tiny chunks. The app will archive the broken media, rebuild the scene plan, and regenerate media so sentences do not cut off.\n\nThis can use generation credits.",
      confirmLabel: "Repair and rebuild",
      danger: true,
      onConfirm: resume,
    });
  }

  return (
    <div>
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />

      <div className="run-header">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ marginBottom: 2 }}>{run?.title || `Run ${id.slice(0, 8)}`}</h1>
          <div className="mono faint" style={{ fontSize: 11.5 }}>{id}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {isActive && (
            <button className="btn-danger btn-sm" onClick={cancel}>
              Stop
            </button>
          )}
          {assets?.finalExists && (
            <>
              <a className="btn-secondary btn-sm" href={fileUrl("final.mp4", true)}>
                Download
              </a>
              <button className="btn-ghost btn-sm" onClick={openFolder}>
                Folder
              </button>
            </>
          )}
          {displayStatus ? (
            <span className={`tag tag-${statusTagClass(displayStatus)}`}>{statusLabel(displayStatus)}</span>
          ) : (
            <span className="skeleton skeleton-pill" />
          )}
        </div>
      </div>

      {!loaded && (
        <div className="card phase-monitor">
          <div className="skeleton" style={{ width: "100%", height: 56, borderRadius: "var(--r-sm)", marginBottom: 16 }} />
          <div className="skeleton" style={{ width: "100%", height: 120, borderRadius: "var(--r-sm)" }} />
        </div>
      )}

      {notice && <ActionNoticeCard notice={notice} onDismiss={() => setNotice(null)} style={{ marginBottom: 14 }} />}

      {loaded && run?.status === "error" && lastError && (
        <div
          className="card"
          style={{ marginBottom: 14, borderColor: "rgba(248,113,113,0.45)", background: "var(--danger-soft)" }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: 15, color: "var(--danger)" }}>Run failed</h2>
          <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.55, color: "var(--fg-muted)" }}>
            {friendlyRunMessage(lastError)}
          </p>
          {lastError.includes("invalid_grant") && (
            <p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-muted)" }}>
              Google Drive expired — <Link href="/settings">reconnect</Link>, or Resume to use local stock cache.
            </p>
          )}
          {hasPlan && !assets?.finalExists && (
            <button className="btn" onClick={resume} disabled={resuming} style={{ marginBottom: 8 }}>
              {resuming ? "Resuming…" : "Resume run"}
            </button>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-secondary" href="/">
              New run
            </Link>
            <button className="btn-ghost" onClick={() => window.location.reload()}>
              Refresh
            </button>
          </div>
        </div>
      )}

      {loaded &&
        (run?.status === "error" || run?.status === "cancelled") &&
        hasPlan &&
        !assets?.finalExists &&
        !lastError && (
          <div className="card" style={{ marginBottom: 14, borderColor: "rgba(252,211,77,0.4)" }}>
            <h2 style={{ marginBottom: 6 }}>Run incomplete</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.55 }}>
              Script plan saved ({assets?.planSceneCount?.toLocaleString()} beats). Resume keeps usable work and
              repairs old tiny chunks first when needed.
            </p>
            <button className="btn" onClick={resume} disabled={resuming}>
              {resuming ? "Resuming…" : "Resume run"}
            </button>
          </div>
        )}

      {loaded && assets?.recovery && !assets.finalNeedsRepair && (assets.recovery.paused || assets.recovery.canResume) && (
        <div
          className="card"
          style={{ marginBottom: 14, borderColor: "rgba(252,211,77,0.45)", background: "var(--warning-soft, rgba(252,211,77,0.06))" }}
        >
          <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Saved work found — pick up where it left off</h2>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 14px", lineHeight: 1.55 }}>
            This run stopped before finishing, but we found your saved progress on disk. Resume regenerates only
            what&apos;s missing; old tiny chunks are repaired before the final video is rebuilt.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            <RecoveryStat
              ok={assets.recovery.openingReady}
              label={`Opening clips${assets.freshSceneCount ? ` · ${assets.freshSceneCount}` : ""}`}
            />
            <RecoveryStat
              ok={assets.recovery.tailVoiceReady}
              label={`Long voiceover${
                assets.tail?.voiceoverPartCount
                  ? ` · ${assets.tail.voiceoverPartCount}${assets.tail?.expectedVoiceoverPartCount ? `/${assets.tail.expectedVoiceoverPartCount}` : ""} chunks`
                  : ""
              }`}
            />
            <RecoveryStat ok={assets.recovery.tailSegmentReady} label="Stock B-roll segment" />
          </div>
          <button className="btn" onClick={resume} disabled={resuming || !assets.recovery.canResume}>
            {resuming
              ? "Resuming…"
              : assets.recovery.tailSegmentReady && assets.recovery.openingReady
                ? "Assemble final video"
                : "Resume run"}
          </button>
        </div>
      )}

      {loaded && assets?.scenePlanHealth && !assets.scenePlanHealth.ok && (
        <div
          className="card"
          style={{ marginBottom: 14, borderColor: "rgba(252,211,77,0.45)", background: "var(--warning-soft, rgba(252,211,77,0.06))" }}
        >
          <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Old chunking detected</h2>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
            This video was planned with tiny narration chunks, so sentences can feel interrupted. New runs use
            sentence-safe chunks automatically. Repair archives the old broken media first, then rebuilds cleanly.
            {assets.finalNeedsRepair && (
              <>
                {" "}A final video file exists, but it was built from the old chunks, so it is not treated as export-ready.
              </>
            )}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="badge badge-neutral">
              {assets.scenePlanHealth.sceneCount} beats · avg {assets.scenePlanHealth.avgWords.toFixed(1)} words
            </span>
            <span className="badge badge-neutral">
              {assets.scenePlanHealth.danglingScenes} mid-thought cuts
            </span>
            {assets.finalNeedsRepair && assets.oldFinalSize ? (
              <span className="badge badge-neutral">
                old render hidden · {(assets.oldFinalSize / (1024 * 1024)).toFixed(1)} MB
              </span>
            ) : null}
            <button className="btn" onClick={repairChunksAndRebuild} disabled={resuming || isActive}>
              {resuming ? "Starting…" : "Repair chunks + rebuild"}
            </button>
            {assets.finalNeedsRepair && (
              <button className="btn-secondary" onClick={openFolder}>
                Open folder
              </button>
            )}
          </div>
        </div>
      )}

      {loaded && assets && (
        <div className="card" style={{ marginBottom: 14, padding: "18px 20px" }}>
          <RunPhaseMonitor
            assets={assets}
            logs={dedupedLogs}
            isActive={isActive}
            runStatus={run?.status}
            fileUrl={fileUrl}
          />
        </div>
      )}

      {drive && assets?.finalExists && run?.status === "done" && (
        <div className="card" style={{ marginBottom: 14 }}>
          {drive.synced ? (
            <>
              <h2 style={{ margin: "0 0 10px", color: "var(--success)", fontSize: 15 }}>Saved to Google Drive</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {drive.finalVideoLink && (
                  <a className="btn-secondary" href={drive.finalVideoLink} target="_blank" rel="noopener noreferrer">
                    Open in Drive
                  </a>
                )}
                <button
                  className="btn-secondary"
                  onClick={uploadToDrive}
                  disabled={uploadingDrive || !drive.canRetry}
                  title={drive.canRetry ? undefined : "Raw reusable clips were already cleaned after the last Drive sync."}
                >
                  {uploadingDrive ? "Syncing…" : "Sync again"}
                </button>
              </div>
              {!drive.canRetry && (
                <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.5 }}>
                  Already synced. Local reusable clips were cleaned after upload, so there is nothing safe to re-sync.
                </p>
              )}
            </>
          ) : drive.connected ? (
            <>
              <h2 style={{ marginBottom: 6, fontSize: 15 }}>Save a copy to Drive</h2>
              <button className="btn" onClick={uploadToDrive} disabled={uploadingDrive}>
                {uploadingDrive ? "Uploading…" : "Upload to Drive"}
              </button>
            </>
          ) : (
            <>
              <h2 style={{ marginBottom: 6, fontSize: 15, color: "var(--warning)" }}>Drive not connected</h2>
              <a className="btn-secondary" href="/settings">
                Connect in Settings
              </a>
            </>
          )}
        </div>
      )}

      {loaded && (
        <details
          className="card"
          style={{ padding: 0, overflow: "hidden" }}
          open={run?.status === "error"}
        >
          <summary
            style={{
              fontWeight: 650,
              fontSize: 13,
              padding: "12px 16px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <span>
              Advanced details
              {isActive && dedupedLogs.some((l) => l.level === "error") && (
                <span style={{ color: "var(--danger)", marginLeft: 8 }}>· errors</span>
              )}
            </span>
            <span className="faint" style={{ fontSize: 12 }}>Fresh AI script chunks</span>
          </summary>
          <div className="run-advanced-stack">
            {assets && (
              <FreshChunkPlan
                assets={assets}
                fileUrl={fileUrl}
                expandedScene={expandedScene}
                setExpandedScene={setExpandedScene}
              />
            )}
          </div>
          <details className="run-diagnostics" open={run?.status === "error" || !!assets?.finalNeedsRepair}>
            <summary>
              <span>Diagnostics{dedupedLogs.length ? ` · ${dedupedLogs.length}` : ""}</span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                aria-pressed={logFilter === "important"}
                onClick={(e) => {
                  e.preventDefault();
                  setLogFilter((current) => (current === "important" ? "all" : "important"));
                }}
                style={{ fontSize: 11.5 }}
              >
                {logFilter === "important" ? "Debug hidden" : "Debug shown"}
              </button>
            </summary>
            <div className="run-advanced-stack" style={{ paddingTop: 0 }}>
              {assets?.exportQuality && <ExportQualityCard assets={assets} embedded />}
              {assets && speed && <RunSpeedPanel speed={speed} embedded />}
            </div>
            <div ref={logPanelRef} className="mono run-log-panel" onScroll={onLogPanelScroll}>
              {visibleLogs.length === 0 && <div className="faint">Waiting…</div>}
              {visibleLogs.map((l, i) => (
                <div key={`${l.id ?? "log"}-${i}`}>
                  <span className="faint">{new Date(l.ts).toLocaleTimeString()}</span>{" "}
                  {l.stage && <span style={{ color: "var(--accent-hover)" }}>[{l.stage}]</span>}{" "}
                  <span style={{ color: levelColor(l.level), fontWeight: 600 }}>{l.level.toUpperCase()}</span>{" "}
                  <span style={{ color: "var(--fg-muted)" }}>{friendlyRunMessage(l.message)}</span>
                </div>
              ))}
              <div ref={logTail} />
            </div>
            {isActive && !logFollowing && (
              <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)" }}>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    logFollowRef.current = true;
                    setLogFollowing(true);
                    if (logPanelRef.current) logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
                  }}
                >
                  Jump to latest ↓
                </button>
              </div>
            )}
          </details>
        </details>
      )}
    </div>
  );
}

function FreshChunkPlan({
  assets,
  fileUrl,
  expandedScene,
  setExpandedScene,
}: {
  assets: PhaseAssets;
  fileUrl: (p: string, dl?: boolean) => string;
  expandedScene: number | null;
  setExpandedScene: (n: number | null) => void;
}) {
  const chunks = assets.scenes;
  const mode = assets.mode ?? "hybrid";
  if (mode === "stock") {
    return (
      <div className="card-inset run-chunk-empty">
        <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Stock-only run</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          This run has no Fresh AI opening. The script is narrated over channel B-roll as one stock tail.
        </p>
      </div>
    );
  }

  if (chunks.length === 0) {
    return (
      <div className="card-inset run-chunk-empty">
        <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Script chunks will appear here</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          Once the script plan is ready, this area shows the exact Fresh AI opening chunks the creator will hear.
        </p>
      </div>
    );
  }

  return (
    <div className="run-chunk-plan">
      <div className="run-chunk-plan-head">
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Fresh AI script chunks</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
            These are the short opening beats sent to AI video. The stock tail is intentionally not shown as chunks.
          </p>
        </div>
        <span className="badge badge-neutral">{chunks.length} chunk{chunks.length === 1 ? "" : "s"}</span>
      </div>
      <div className="run-chunk-list">
        {chunks.map((s) => {
          const videoSrc = s.clip
            ? fileUrl(`clips/${s.clip.name}`)
            : s.animation
              ? fileUrl(`animations/${s.animation.name}`)
              : null;
          const thumbSrc = s.image ? fileUrl(`images/${s.image.name}`) : null;
          const expanded = expandedScene === s.index;
          return (
            <article key={s.index} className={`run-chunk-card stage-${s.stage}`}>
              <div className="run-chunk-media">
                {videoSrc ? (
                  <video
                    src={videoSrc}
                    controls={expanded}
                    preload="metadata"
                    muted={!expanded}
                    playsInline
                    poster={thumbSrc ?? undefined}
                    onClick={() => setExpandedScene(expanded ? null : s.index)}
                  />
                ) : thumbSrc ? (
                  <img src={thumbSrc} alt="" />
                ) : (
                  <div className="run-chunk-placeholder">
                    <span className={s.stage === "pending" ? "scene-monitor-spinner" : ""} aria-hidden="true" />
                  </div>
                )}
              </div>
              <div className="run-chunk-copy">
                <div className="run-chunk-meta">
                  <strong>Chunk {s.index + 1}</strong>
                  <span>{s.duration_hint_sec ? `~${Math.round(s.duration_hint_sec)}s` : "Short beat"}</span>
                  <span>{creatorStageLabel(s.stage)}</span>
                </div>
                {s.text && <p>{s.text}</p>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function creatorStageLabel(stage: PhaseAssets["scenes"][number]["stage"]): string {
  switch (stage) {
    case "audio":
      return "Voice ready";
    case "image":
      return "Image ready";
    case "video":
      return "AI video ready";
    case "rendered":
      return "Synced clip";
    default:
      return "Waiting";
  }
}

function ExportQualityCard({ assets, embedded = false }: { assets: PhaseAssets; embedded?: boolean }) {
  if (!assets.exportQuality) return null;
  const quality = assets.exportQuality;
  const tone =
    quality.overall === "ready"
      ? "var(--success)"
      : quality.overall === "blocked"
        ? "var(--danger)"
        : quality.overall === "needs_work"
          ? "var(--warning)"
          : "var(--fg-muted)";
  const bg =
    quality.overall === "ready"
      ? "var(--success-soft, rgba(74,222,128,0.1))"
      : quality.overall === "blocked"
        ? "var(--danger-soft)"
        : quality.overall === "needs_work"
          ? "var(--warning-soft, rgba(252,211,77,0.06))"
          : "transparent";
  const border =
    quality.overall === "ready"
      ? "rgba(74,222,128,0.35)"
      : quality.overall === "blocked"
        ? "rgba(248,113,113,0.45)"
        : quality.overall === "needs_work"
          ? "rgba(252,211,77,0.45)"
          : "var(--border)";

  return (
    <div className={embedded ? "card-inset" : "card"} style={{ marginBottom: embedded ? 0 : 14, padding: 14, borderColor: border, background: bg }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Export quality</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
            Generated clips use image keyframes first, then Veo image-to-video. This panel blocks old chopped exports.
          </p>
        </div>
        <span
          className="tag"
          style={{ color: tone, borderColor: border, background: "rgba(0,0,0,0.08)", whiteSpace: "nowrap" }}
        >
          {quality.overall === "ready"
            ? "ready"
            : quality.overall === "needs_work"
              ? "needs check"
              : quality.overall === "blocked"
                ? "blocked"
                : "waiting"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        {quality.checks.map((check) => (
          <div key={check.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "10px 12px", background: "var(--bg-elev)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <strong style={{ fontSize: 12.5 }}>{check.label}</strong>
              <span style={{ color: qualityCheckColor(check.status), fontSize: 12, fontWeight: 750 }}>
                {qualityCheckLabel(check.status)}
              </span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.45 }}>
              {check.detail}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function qualityCheckLabel(status: "pass" | "warn" | "fail" | "pending"): string {
  if (status === "pass") return "Ready";
  if (status === "warn") return "Check";
  if (status === "fail") return "Fix";
  return "Waiting";
}

function qualityCheckColor(status: "pass" | "warn" | "fail" | "pending"): string {
  if (status === "pass") return "var(--success)";
  if (status === "warn") return "var(--warning)";
  if (status === "fail") return "var(--danger)";
  return "var(--fg-muted)";
}

function RecoveryStat({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12.5,
        padding: "5px 10px",
        borderRadius: "var(--r-sm)",
        border: "1px solid var(--border)",
        background: ok ? "var(--success-soft, rgba(74,222,128,0.1))" : "transparent",
        color: ok ? "var(--success)" : "var(--fg-muted)",
      }}
    >
      <span aria-hidden="true">{ok ? "✓" : "○"}</span>
      {label}
    </span>
  );
}

interface RunSpeed {
  freshDone: number;
  freshTotal: number;
  activeVideoSlots: number | null;
  videoSlots: number | null;
  imageSlots: number | null;
  keyCount: number | null;
  waitingForProvider: boolean;
  averageVideoTime: string;
  eta: string;
  hint: string;
}

function RunSpeedPanel({ speed, embedded = false }: { speed: RunSpeed; embedded?: boolean }) {
  return (
    <div className={embedded ? "card-inset" : "card"} style={{ marginBottom: embedded ? 0 : 14, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Speed</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {speed.hint}
          </p>
        </div>
        <span className={`tag ${speed.waitingForProvider ? "tag-paused" : "tag-running"}`}>
          {speed.waitingForProvider ? "waiting" : "active"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <SpeedMetric label="Fresh videos" value={`${speed.freshDone}/${speed.freshTotal}`} />
        <SpeedMetric
          label="Video slots"
          value={
            speed.videoSlots
              ? `${speed.activeVideoSlots ?? 0}/${speed.videoSlots}`
              : speed.activeVideoSlots != null
                ? String(speed.activeVideoSlots)
                : "checking"
          }
        />
        <SpeedMetric label="Image slots" value={speed.imageSlots ? String(speed.imageSlots) : "checking" } />
        <SpeedMetric label="Average video" value={speed.averageVideoTime} />
        <SpeedMetric label="Time left" value={speed.eta} />
        <SpeedMetric label="Keys" value={speed.keyCount ? String(speed.keyCount) : "checking"} />
      </div>
    </div>
  );
}

function SpeedMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "10px 12px" }}>
      <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function deriveRunSpeed(assets: PhaseAssets, logs: LogEntry[]): RunSpeed {
  const freshTotal = assets.hybridProgress?.freshTotal ?? assets.progress.total ?? 0;
  const freshDone = assets.hybridProgress?.freshWithVideo ?? assets.progress.withVideo ?? 0;
  const capacity = parseCapacity(logs);
  const starts = logs.filter((l) => l.stage === "animate" && /69labs video job/i.test(l.message));
  const done = logs.filter((l) => l.stage === "animate" && /Animation done/i.test(l.message));
  const failedScenes = logs.filter((l) => /Scene #\d+ failed/i.test(l.message)).length;
  const remaining = Math.max(0, freshTotal - freshDone);
  const activeRaw = Math.max(0, starts.length - done.length - failedScenes);
  const activeVideoSlots =
    capacity?.videoSlots != null ? Math.min(capacity.videoSlots, activeRaw, Math.max(remaining, 0)) : activeRaw || null;
  const waitingForProvider = logs.slice(-40).some((l) => /Provider full|rate limit/i.test(l.message));

  const firstStart = starts.map((l) => Date.parse(l.ts)).find((t) => Number.isFinite(t));
  const lastDone = [...done].reverse().map((l) => Date.parse(l.ts)).find((t) => Number.isFinite(t));
  const elapsed = firstStart && lastDone && lastDone > firstStart ? lastDone - firstStart : null;
  const msPerDone = elapsed && done.length > 0 ? elapsed / done.length : null;

  let hint = "Starting clips as provider slots open.";
  if (waitingForProvider) hint = "Provider slots are full; the app is waiting instead of failing scenes.";
  else if (capacity?.videoSlots && activeVideoSlots === capacity.videoSlots) hint = "Using every available video slot.";
  else if (remaining === 0) hint = "Fresh video generation is complete.";

  return {
    freshDone,
    freshTotal,
    activeVideoSlots,
    videoSlots: capacity?.videoSlots ?? null,
    imageSlots: capacity?.imageSlots ?? null,
    keyCount: capacity?.keyCount ?? null,
    waitingForProvider,
    averageVideoTime: msPerDone ? formatDuration(msPerDone) : "learning",
    eta: msPerDone && remaining > 0 ? formatDuration(msPerDone * remaining) : remaining === 0 ? "done" : "learning",
    hint,
  };
}

function parseCapacity(logs: LogEntry[]): { keyCount: number; imageSlots: number; videoSlots: number; ttsSlots: number } | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].message.match(/69labs capacity:\s*(\d+)\s+keys?.*?image\s+(\d+)\s+slots?.*?video\s+(\d+)\s+slots?.*?TTS\s+(\d+)\s+slots?/i);
    if (m) {
      return {
        keyCount: Number(m[1]),
        imageSlots: Number(m[2]),
        videoSlots: Number(m[3]),
        ttsSlots: Number(m[4]),
      };
    }
  }
  return null;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function levelColor(l: LogEntry["level"]) {
  switch (l) {
    case "error":
      return "var(--danger)";
    case "warn":
      return "var(--warning)";
    case "success":
      return "var(--success)";
    default:
      return "var(--accent-hover)";
  }
}

function friendlyRunMessage(message: string): string {
  const cleaned = message.replace(/^Pipeline crashed:\s*/i, "");
  if (/invalid_grant|Token has been expired|revoked/i.test(cleaned)) {
    return "Google Drive login expired. Refresh Google login in Settings, then resume or use local cached clips.";
  }
  if (/redirect_uri_mismatch/i.test(cleaned)) {
    return "Google rejected the callback URL. Open Settings, copy the callback URL, add it in Google Cloud, then reconnect.";
  }
  if (/Provider full|Concurrent .* limit reached|rate limit \(429\)/i.test(cleaned)) {
    return "Provider full - waiting for an open slot. Nothing is broken.";
  }
  if (/polling timeout/i.test(cleaned)) {
    return "The video provider kept processing longer than expected. Finished work is saved; Resume can continue from there.";
  }
  return cleaned;
}

function statusLabel(status: Run["status"]): string {
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

function statusTagClass(status: Run["status"]): Run["status"] {
  return status === "error" ? "paused" : status;
}
