"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "../../../_page-header";

interface StockGenClipStep {
  index: number;
  prompt: string;
  finalPrompt?: string;
  promptSource?: "exact" | "ai";
  status: "queued" | "image" | "video" | "upload" | "complete" | "failed" | "cancelled";
  imageStatus?: string;
  videoStatus?: string;
  uploadStatus?: string;
  imageJobId?: string;
  videoJobId?: string;
  driveFileId?: string;
  driveName?: string;
  reviewStatus?: "unreviewed" | "good" | "weak" | "needs_review";
  retryCount?: number;
  lastProgressAt?: number;
  promptReadyAt?: number;
  imageStartedAt?: number;
  imageFinishedAt?: number;
  videoStartedAt?: number;
  videoFinishedAt?: number;
  uploadStartedAt?: number;
  uploadFinishedAt?: number;
  error?: string;
}

interface StockGenStatus {
  running: boolean;
  cancelRequested?: boolean;
  phase?: "prompting" | "generating" | "finished" | "failed" | "cancelled" | "missing";
  total: number;
  requestedCount?: number;
  done: number;
  failed: number;
  folder: string;
  jobId?: string;
  theme?: string;
  styleBrief?: string;
  fallbackStyle?: string;
  negativePrompt?: string;
  exactPrompts?: string[];
  aiPrompts?: string[];
  promptSource?: "ai" | "exact" | "mixed";
  imageConcurrency?: number;
  videoConcurrency?: number;
  startedAt?: number;
  updatedAt?: number;
  promptStartedAt?: number;
  finishedAt?: number;
  lastError?: string;
  prompts?: string[];
  clips?: StockGenClipStep[];
  driveFolderLink?: string;
}

type PromptModalClip = StockGenClipStep | null;

async function fetchJsonWithTimeout<T>(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 9000): Promise<{ response: Response; json: T }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await response.text();
    let json: T;
    try {
      json = (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Error(response.ok ? "The server returned a temporary HTML response. Retry in a moment." : `The server returned ${response.status}. Retry in a moment.`);
    }
    return { response, json };
  } finally {
    window.clearTimeout(timer);
  }
}

function statusLabel(step: StockGenClipStep) {
  if (step.status === "complete") return "Uploaded to Drive";
  if (step.status === "failed") return "Failed";
  if (step.status === "cancelled") return "Cancelled";
  if (step.status === "upload") return "Uploading to Drive";
  if (step.status === "video") return "Generating video";
  if (step.status === "image") return "Generating image";
  return "Prompt ready";
}

function generationStatusLabel(status: StockGenStatus | null) {
  if (!status) return "Loading";
  if (status.phase === "missing") return "Job not found";
  if (status.phase === "prompting") return status.promptStartedAt ? "Requesting AI prompts" : "Checking Drive folder";
  if (status.phase === "generating") return "Generating clips";
  if (status.phase === "failed") return "Failed";
  if (status.phase === "cancelled") return "Cancelled";
  if (status.phase === "finished") return "Finished";
  return status.running ? "Generating" : "Finished";
}

function emptyStateCopy(status: StockGenStatus | null) {
  if (!status) return "Loading generation job...";
  if (status.phase === "missing") return "This generation job was not found. New jobs are persisted now, so future refreshes should keep their state.";
  if (status.phase === "failed") return "Generation stopped before prompts were created. The issue is shown above.";
  if (status.phase === "cancelled") return "Generation was cancelled before prompts were created.";
  if (status.phase === "prompting") {
    return status.promptStartedAt
      ? "Requesting AI prompts... if the AI provider does not answer, this will timeout instead of waiting for minutes."
      : "Checking the Drive folder before requesting AI prompts, so we do not spend generation credits if Drive is stale.";
  }
  return "Waiting for clip steps. This page will update automatically.";
}

function formatElapsed(ms: number) {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function clipVideoSrc(clip: StockGenClipStep) {
  if (!clip.driveFileId) return null;
  const params = new URLSearchParams({ id: clip.driveFileId });
  return `/api/stock/file?${params.toString()}`;
}

function clipPosterSrc(folder: string, clip: StockGenClipStep) {
  if (!clip.driveFileId) return null;
  const params = new URLSearchParams({ id: clip.driveFileId, folder, name: clip.driveName || `clip-${clip.index + 1}.mp4` });
  return `/api/stock/poster?${params.toString()}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  }
  return <button className="btn-ghost btn-sm" type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>;
}

function PromptDrawer({ clip, status, onClose }: { clip: PromptModalClip; status: StockGenStatus | null; onClose: () => void }) {
  if (!clip) return null;
  const driveLink = clip.driveFileId ? `https://drive.google.com/file/d/${clip.driveFileId}/view` : null;
  return (
    <div className="stock-prompt-modal" role="dialog" aria-modal="true" aria-label={`Clip ${clip.index + 1} prompt details`}>
      <div className="stock-prompt-modal-backdrop" onClick={onClose} />
      <div className="stock-prompt-modal-card">
        <div className="stock-prompt-modal-head">
          <div>
            <span>Prompt details</span>
            <h2>Clip {clip.index + 1}</h2>
          </div>
          <button className="btn-secondary btn-sm" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="stock-prompt-modal-grid">
          <section>
            <div className="stock-prompt-section-head"><strong>Original prompt</strong><CopyButton value={clip.prompt} /></div>
            <p>{clip.prompt}</p>
          </section>
          <section>
            <div className="stock-prompt-section-head"><strong>Final image prompt</strong><CopyButton value={clip.finalPrompt || clip.prompt} /></div>
            <p>{clip.finalPrompt || clip.prompt}</p>
          </section>
          <section>
            <div className="stock-prompt-section-head"><strong>Negative prompt</strong><CopyButton value={status?.negativePrompt || ""} /></div>
            <p>{status?.negativePrompt || "No negative prompt saved for this run."}</p>
          </section>
          <section>
            <strong>Job ids</strong>
            <div className="stock-prompt-id-list">
              <span>Image: {clip.imageJobId || "not started"}</span>
              <span>Video: {clip.videoJobId || "not started"}</span>
              <span>Drive: {clip.driveFileId || "not uploaded"}</span>
            </div>
            {driveLink && <a href={driveLink} target="_blank" rel="noreferrer">Open Drive file</a>}
          </section>
        </div>
      </div>
    </div>
  );
}

function canRetryClip(clip: StockGenClipStep, now: number) {
  if (clip.status === "complete" || clip.status === "cancelled") return false;
  if (clip.status === "failed") return true;
  if (!["image", "video", "upload"].includes(clip.status)) return false;
  const last = clip.lastProgressAt || clip.videoStartedAt || clip.imageStartedAt || clip.promptReadyAt || 0;
  return last > 0 && now - last > 120_000;
}

function GeneratedClipCard({
  clip,
  folder,
  jobId,
  now,
  retrying,
  onReview,
  onOpenPrompt,
  onRetry,
}: {
  clip: StockGenClipStep;
  folder: string;
  jobId: string;
  now: number;
  retrying: boolean;
  onReview: (index: number, reviewStatus: NonNullable<StockGenClipStep["reviewStatus"]>) => void;
  onOpenPrompt: (clip: StockGenClipStep) => void;
  onRetry: (clip: StockGenClipStep) => void;
}) {
  const videoSrc = clipVideoSrc(clip);
  const posterSrc = clipPosterSrc(folder, clip);
  const driveLink = clip.driveFileId ? `https://drive.google.com/file/d/${clip.driveFileId}/view` : null;
  const review = clip.reviewStatus || "unreviewed";
  const showRetry = canRetryClip(clip, now);

  return (
    <div className="card-inset stock-gen-step-card">
      <div className="stock-gen-card-head">
        <strong>Clip {clip.index + 1}</strong>
        <span className={`stock-gen-status stock-gen-status-${clip.status}`}>{statusLabel(clip)}</span>
      </div>

      <div className="stock-gen-view-toggle" role="group" aria-label={`Clip ${clip.index + 1} view`}>
        <button type="button" className="active" disabled={!videoSrc && clip.status !== "complete"}>
          Preview
        </button>
        <button type="button" onClick={() => onOpenPrompt(clip)}>
          Prompt
        </button>
      </div>

      <div className="stock-gen-card-stage" data-mode="preview">
        {videoSrc ? (
          <video className="stock-gen-video" src={videoSrc} poster={posterSrc || undefined} controls muted playsInline preload="metadata" />
        ) : (
          <div className="stock-gen-preview-pending">
            <strong>{clip.status === "failed" ? "Video failed" : "Preview coming"}</strong>
            <span>{clip.status === "video" ? "Video is being generated now." : clip.status === "upload" ? "Uploading to Drive now." : "The card will switch to video preview after Drive upload."}</span>
          </div>
        )}
      </div>

      <div className="stock-gen-step-list">
        <span data-done={clip.imageStatus === "done"}>Image</span>
        <span data-done={clip.videoStatus === "done"}>Video</span>
        <span data-done={clip.uploadStatus === "done"}>Drive upload</span>
      </div>

      <div className="stock-gen-card-foot">
        {clip.driveName ? <span className="faint">Saved as {clip.driveName}</span> : <span className="faint">Prompt ready</span>}
        {driveLink && <a href={driveLink} target="_blank" rel="noreferrer">Open Drive file</a>}
      </div>
      {(clip.imageJobId || clip.videoJobId) && (
        <div className="stock-gen-job-meta">
          {clip.imageJobId && <span>Image job {clip.imageJobId.slice(0, 8)}</span>}
          {clip.videoJobId && <span>Video job {clip.videoJobId.slice(0, 8)}</span>}
        </div>
      )}
      {showRetry && (
        <button className="stock-gen-retry-clip" type="button" onClick={() => onRetry(clip)} disabled={retrying || !jobId} title="Retry this clip only">
          {retrying ? "Retrying..." : "↻ Retry clip"}
        </button>
      )}
      {clip.status === "complete" && (
        <div className="stock-gen-review-row" aria-label={`Review clip ${clip.index + 1}`}>
          {([
            ["good", "Looks good"],
            ["weak", "Weak match"],
            ["needs_review", "Needs review"],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" className={review === value ? "active" : ""} onClick={() => onReview(clip.index, value)} disabled={!jobId}>
              {label}
            </button>
          ))}
        </div>
      )}
      {clip.error && <div style={{ color: "var(--danger)", fontSize: 12 }}>Issue: {clip.error}</div>}
    </div>
  );
}

export default function StockGeneratePage() {
  const params = useParams<{ jobId?: string | string[] }>();
  const jobId = useMemo(() => {
    const raw = params?.jobId;
    return Array.isArray(raw) ? raw[0] : raw || "";
  }, [params]);
  const [status, setStatus] = useState<StockGenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [promptModalClip, setPromptModalClip] = useState<PromptModalClip>(null);
  const [retryingClip, setRetryingClip] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    async function poll() {
      try {
        const params = new URLSearchParams({ jobId, t: String(Date.now()) });
        const { response, json } = await fetchJsonWithTimeout<StockGenStatus & { error?: string }>(`/api/stock/generate?${params.toString()}`, { cache: "no-store", headers: { "Cache-Control": "no-cache" } }, 9000);
        if (!response.ok) throw new Error(json.error || response.statusText);
        if (!cancelled) {
          setStatus(json);
          setError(null);
          setLastRefreshedAt(Date.now());
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    poll();
    const timer = window.setInterval(poll, status?.running === false ? 6000 : 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, status?.running, retryNonce]);

  useEffect(() => {
    function refreshNow() {
      setRetryNonce((n) => n + 1);
    }
    function refreshOnVisible() {
      if (document.visibilityState === "visible") refreshNow();
    }
    window.addEventListener("focus", refreshNow);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.removeEventListener("focus", refreshNow);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function stopGeneration() {
    if (!jobId) return;
    setStopping(true);
    try {
      const r = await fetch(`/api/stock/generate?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
      const j = await r.json();
      setStatus(j);
    } finally {
      setStopping(false);
    }
  }

  async function markReview(index: number, reviewStatus: NonNullable<StockGenClipStep["reviewStatus"]>) {
    if (!jobId) return;
    setStatus((prev) => prev ? { ...prev, clips: prev.clips?.map((clip) => clip.index === index ? { ...clip, reviewStatus } : clip) } : prev);
    const r = await fetch("/api/stock/generate", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, index, reviewStatus }),
    });
    if (!r.ok) {
      setError("Could not save review status.");
    }
  }

  async function retryClip(clip: StockGenClipStep) {
    if (!jobId) return;
    setRetryingClip(clip.index);
    try {
      const r = await fetch("/api/stock/generate/retry-clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, index: clip.index, mode: clip.imageStatus === "failed" ? "image" : "video" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setStatus(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryingClip(null);
    }
  }

  const clips = status?.clips ?? [];
  const denominator = status ? Math.max(status.total || 0, status.requestedCount || 0) : 0;
  const uploadedCount = status ? Math.max(status.done || 0, clips.filter((clip) => clip.status === "complete").length) : 0;
  const failedCount = status ? Math.max(status.failed || 0, clips.filter((clip) => clip.status === "failed").length) : 0;
  const imageActiveCount = clips.filter((clip) => clip.status === "image" || clip.imageStatus === "running").length;
  const videoActiveCount = clips.filter((clip) => clip.status === "video" || clip.videoStatus === "running").length;
  const uploadActiveCount = clips.filter((clip) => clip.status === "upload" || clip.uploadStatus === "running").length;
  const waitingCount = clips.filter((clip) => clip.status === "queued" || (clip.imageStatus === "done" && clip.videoStatus === "queued")).length;
  const completed = uploadedCount + failedCount;
  const percent = denominator > 0 ? Math.min(100, Math.round((completed / denominator) * 100)) : 0;
  const elapsed = status?.startedAt
    ? formatElapsed((status.finishedAt || now) - status.startedAt)
    : status
      ? "—" // loaded but never started (missing/not-yet-running) — avoid a stuck "Loading…"
      : "Loading...";
  const refreshedCopy = lastRefreshedAt ? `${formatElapsed(now - lastRefreshedAt)} ago` : "Waiting...";
  const hasRecoveryState = !status || status.phase === "missing" || !!error && clips.length === 0;

  return (
    <div>
      <PromptDrawer clip={promptModalClip} status={status} onClose={() => setPromptModalClip(null)} />
      <PageHeader
        backHref="/clips/generate"
        title="B-roll generation"
        description="Prompt to image to video to Drive. One focused production run."
        actions={
          <>
          {status?.driveFolderLink && (
            <a className="btn-secondary btn-sm" href={status.driveFolderLink} target="_blank" rel="noreferrer">Open Drive folder</a>
          )}
          <button className="btn-secondary btn-sm" type="button" onClick={() => setRetryNonce((n) => n + 1)}>Retry status</button>
          {status?.running && (
            <button className="btn-danger btn-sm" onClick={stopGeneration} disabled={stopping}>
              {stopping ? "Stopping..." : "Stop after current clips"}
            </button>
          )}
          </>
        }
      />

      <div className="card stock-gen-command-card" style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div className="label">Drive folder</div>
            <strong>{status?.folder || "Loading..."}</strong>
          </div>
          <div>
            <div className="label">Uploaded</div>
            <strong>{status ? `${uploadedCount}/${denominator}${failedCount ? `, ${failedCount} failed` : ""}` : "Loading..."}</strong>
          </div>
          <div>
            <div className="label">Requested</div>
            <strong>{status?.requestedCount ?? "Loading..."}</strong>
          </div>
          <div>
            <div className="label">Elapsed</div>
            <strong>{elapsed}</strong>
          </div>
          <div>
            <div className="label">Status</div>
            <strong>{generationStatusLabel(status)}</strong>
          </div>
          <div>
            <div className="label">Refreshed</div>
            <strong>{refreshedCopy}</strong>
          </div>
        </div>
        <div className="stock-gen-progress" aria-label={`${percent}% complete`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {status && (
          <div className="stock-gen-live-strip" aria-label="Live generation stage counts">
            <span><strong>{uploadedCount}</strong> uploaded</span>
            <span><strong>{videoActiveCount}</strong> video</span>
            <span><strong>{imageActiveCount}</strong> image</span>
            <span><strong>{uploadActiveCount}</strong> upload</span>
            <span><strong>{waitingCount}</strong> waiting</span>
          </div>
        )}
        {status?.lastError && <div className="card-inset" style={{ color: "var(--danger)", fontSize: 12.5 }}>Last issue: {status.lastError}</div>}
        {error && <div className="card-inset" style={{ color: "var(--danger)", fontSize: 12.5 }}>Could not refresh progress: {error}</div>}
      </div>

      {hasRecoveryState && (
        <div className="card stock-gen-recovery-card">
          <div>
            <span>{status?.phase === "missing" ? "Missing job" : error ? "Status unavailable" : "Loading job"}</span>
            <h2>{status?.phase === "missing" ? "This run is not available" : error ? "Progress could not load" : "Checking the generation run"}</h2>
            <p>{status?.phase === "missing" ? "The saved job file was not found or was removed. New runs persist their state so refreshes should not lose progress." : error ? "The page stopped waiting and surfaced the issue instead of spinning forever." : "This should resolve quickly. If it does not, retry status or return to Studio."}</p>
          </div>
          <div className="stock-gen-recovery-actions">
            <button className="btn btn-sm" type="button" onClick={() => setRetryNonce((n) => n + 1)}>Retry status</button>
            {status?.driveFolderLink && <a className="btn-secondary btn-sm" href={status.driveFolderLink} target="_blank" rel="noreferrer">Open Drive folder</a>}
          </div>
        </div>
      )}

      {status && status.phase !== "missing" && (
        <details className="card stock-gen-decision-card stock-gen-brief-disclosure">
          <summary>
            <span>AI brief</span>
            <strong>How prompts were chosen</strong>
            <em>{status.exactPrompts?.length || 0} exact · {status.aiPrompts?.length || 0} AI-filled · {status.imageConcurrency || 20}/{status.videoConcurrency || 5} queue</em>
          </summary>
          <div className="stock-gen-decision-grid">
            <div>
              <strong>Channel</strong>
              <p>{status.theme || status.folder}</p>
            </div>
            <div>
              <strong>Style</strong>
              <p>{status.styleBrief || (status.fallbackStyle ? `Using channel fallback: ${status.fallbackStyle}` : "Generic reusable B-roll rules.")}</p>
            </div>
            <div>
              <strong>Avoid</strong>
              <p>{status.negativePrompt || "No negative prompt saved for this run."}</p>
            </div>
            <div>
              <strong>Rules</strong>
              <p>Distinct shots. No faces. No readable text. Reusable scenes only.</p>
            </div>
            <div>
              <strong>Throughput</strong>
              <p>{status.imageConcurrency || 20} image slots. {status.videoConcurrency || 5} video slots. Uploads separate.</p>
            </div>
          </div>
        </details>
      )}

      {clips.length === 0 ? (
        // The recovery card already explains missing/loading/error states — don't
        // repeat the same message in a second card below it.
        hasRecoveryState ? null : (
          <div className="card stock-gen-empty-card" style={{ color: "var(--fg-muted)", fontSize: 13 }}>
            {emptyStateCopy(status)}
          </div>
        )
      ) : (
        <div className="stock-gen-grid">
          {clips.map((clip) => (
            <GeneratedClipCard
              key={`${clip.index}-${clip.prompt}`}
              clip={clip}
              folder={status?.folder || "Pirates"}
              jobId={jobId}
              now={now}
              retrying={retryingClip === clip.index}
              onReview={markReview}
              onOpenPrompt={setPromptModalClip}
              onRetry={retryClip}
            />
          ))}
        </div>
      )}
    </div>
  );
}
