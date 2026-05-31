"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveStockFolder } from "@/lib/channel-stock";
import { PageHeader } from "../../_page-header";
import { usePersistedState } from "../../_use-persisted-state";
import { friendlyError } from "../../_friendly-error";

interface Channel {
  id: number;
  name: string;
  video_style: string | null;
  stock_folder: string | null;
}

interface StockGenJob {
  jobId: string;
  running: boolean;
  phase?: string;
  total: number;
  requestedCount?: number;
  done: number;
  failed: number;
  folder: string;
  theme?: string;
  styleBrief?: string;
  fallbackStyle?: string;
  negativePrompt?: string;
  exactPrompts?: string[];
  aiPrompts?: string[];
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  lastError?: string;
}

const CHANNEL_KEY = "clips.selectedChannelId";
type JobFilter = "all" | "generating" | "done" | "failed";

async function fetchJsonWithTimeout<T>(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10000): Promise<{ response: Response; json: T }> {
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

function splitPrompts(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function statusText(job: StockGenJob) {
  if (job.phase === "prompting") return "Prompting";
  if (job.phase === "generating") return "Generating";
  if (job.phase === "failed") return "Failed";
  if (job.phase === "cancelled") return "Cancelled";
  if (job.phase === "finished") return "Finished";
  return job.running ? "Generating" : "Finished";
}

function jobStatusBucket(job: StockGenJob): Exclude<JobFilter, "all"> {
  if (job.phase === "failed" || job.failed > 0 && !job.running && job.done === 0) return "failed";
  if (job.running || job.phase === "prompting" || job.phase === "generating") return "generating";
  return "done";
}

function formatWhen(value?: number) {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function JobCard({ job }: { job: StockGenJob }) {
  const total = Math.max(job.total || 0, job.requestedCount || 0);
  const complete = job.done + job.failed;
  const percent = total > 0 ? Math.min(100, Math.round((complete / total) * 100)) : 0;
  const bucket = jobStatusBucket(job);
  return (
    <Link href={`/clips/generate/${encodeURIComponent(job.jobId)}`} className="stock-studio-job-card card-inset">
      <div className="stock-studio-job-head">
        <strong>{job.theme || job.folder}</strong>
        <span data-running={job.running} data-status={bucket}>{statusText(job)}</span>
      </div>
      <div className="stock-gen-progress" aria-label={`${percent}% complete`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="stock-studio-job-meta">
        <span>{job.done}/{total} uploaded</span>
        {job.failed > 0 && <span>{job.failed} failed</span>}
        <span>{formatWhen(job.updatedAt || job.startedAt)}</span>
      </div>
      <p>{job.styleBrief || job.fallbackStyle || "Using channel style and reusable B-roll rules."}</p>
    </Link>
  );
}

export default function ClipsGenerateStudioPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [selectedChannelId, setSelectedChannelId] = usePersistedState<string>(CHANNEL_KEY, "");
  const [styleBrief, setStyleBrief] = usePersistedState("clips.generate.styleBrief", "");
  const [negativePrompt, setNegativePrompt] = usePersistedState("clips.generate.negativePrompt", "");
  const [exactPromptText, setExactPromptText] = usePersistedState("clips.generate.exactPrompts", "");
  const [count, setCount] = usePersistedState("clips.generate.count", 10);
  const [jobs, setJobs] = useState<StockGenJob[]>([]);
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/prompt-presets")
      .then((r) => r.json())
      .then((c: Channel[]) => setChannels(Array.isArray(c) ? c : []))
      .catch(() => setChannels([]));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: Record<string, string>) => setSettings(s))
      .catch(() => setSettings({}));
  }, []);

  useEffect(() => {
    const queryChannel = new URLSearchParams(window.location.search).get("channelId");
    if (queryChannel) {
      setSelectedChannelId(queryChannel);
      try {
        window.localStorage.setItem(CHANNEL_KEY, JSON.stringify(queryChannel));
      } catch {}
    }
  }, [setSelectedChannelId]);

  const selectedChannel = useMemo(() => channels.find((channel) => String(channel.id) === selectedChannelId) || null, [channels, selectedChannelId]);
  const folder = useMemo(() => {
    if (!selectedChannel) return "";
    return resolveStockFolder(selectedChannel.name, selectedChannel.stock_folder, settings.STOCK_LIBRARY_FOLDER);
  }, [selectedChannel, settings.STOCK_LIBRARY_FOLDER]);
  const fallbackStyle = selectedChannel?.video_style?.trim() || settings.VIDEO_STYLE || "";
  const exactPrompts = useMemo(() => splitPrompts(exactPromptText), [exactPromptText]);
  const requestedCount = Math.max(1, Math.max(Number(count) || 10, exactPrompts.length));
  const channelHydrating = Boolean(selectedChannelId && !selectedChannel);
  const jobCounts = useMemo(() => {
    const counts: Record<JobFilter, number> = { all: jobs.length, generating: 0, done: 0, failed: 0 };
    jobs.forEach((job) => {
      counts[jobStatusBucket(job)] += 1;
    });
    return counts;
  }, [jobs]);
  const filteredJobs = useMemo(() => {
    if (jobFilter === "all") return jobs;
    return jobs.filter((job) => jobStatusBucket(job) === jobFilter);
  }, [jobFilter, jobs]);

  const loadHistory = useCallback(async () => {
    if (!selectedChannelId || !folder) return;
    try {
      const params = new URLSearchParams({ channelId: selectedChannelId, folder, limit: "50" });
      const { response, json } = await fetchJsonWithTimeout<{ jobs?: StockGenJob[]; error?: string }>(`/api/stock/generate/history?${params.toString()}`, { cache: "no-store" }, 9000);
      if (!response.ok) throw new Error(json.error || response.statusText);
      setJobs(Array.isArray(json.jobs) ? json.jobs : []);
      setHistoryError(null);
    } catch (e) {
      const message = friendlyError(e, "Could not load generation history.");
      setHistoryError(jobs.length > 0 ? null : message);
    }
  }, [folder, jobs.length, selectedChannelId]);

  useEffect(() => {
    loadHistory();
    const timer = window.setInterval(loadHistory, 3500);
    return () => window.clearInterval(timer);
  }, [loadHistory]);

  function pickChannel(value: string) {
    setSelectedChannelId(value);
    try {
      if (value) window.localStorage.setItem(CHANNEL_KEY, JSON.stringify(value));
    } catch {}
  }

  async function startGeneration() {
    if (!selectedChannel || !folder) {
      setError("Pick a channel before generating B-roll.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, json } = await fetchJsonWithTimeout<{ jobId?: string; message?: string; error?: string }>("/api/stock/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder,
          theme: selectedChannel.name,
          count: requestedCount,
          styleBrief: styleBrief.trim() || null,
          videoStyle: fallbackStyle || null,
          negativePrompt: negativePrompt.trim() || settings.GENERATION_NEGATIVE_PROMPT || null,
          exactPrompts,
          channelId: selectedChannel.id,
          channelName: selectedChannel.name,
          promptMode: exactPrompts.length > 0 ? "mixed" : "brief",
        }),
      }, 12000);
      if (!response.ok) throw new Error(json.message || json.error || response.statusText);
      await loadHistory();
      if (json.jobId) router.push(`/clips/generate/${encodeURIComponent(json.jobId)}`);
    } catch (e) {
      setError(friendlyError(e, "B-roll generation could not start."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stock-studio-page">
      <PageHeader
        backHref="/clips"
        eyebrow="B-roll Studio"
        title="Make channel clips"
        description="Write a brief or paste exact prompts. Images, videos, and Drive happen behind the scenes."
      />

      <div className="stock-studio-layout">
        <section className="card stock-studio-compose">
          <div className="stock-studio-section-title">
            <span>01</span>
            <div>
              <h2>Channel and direction</h2>
              <p>Choose where clips land and what they should feel like.</p>
            </div>
          </div>

          <label className="label" htmlFor="studio-channel">Channel</label>
          <select id="studio-channel" className="input" value={selectedChannelId} onChange={(e) => pickChannel(e.target.value)}>
            <option value="">- pick a channel -</option>
            {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </select>

          {selectedChannel && (
            <div className="stock-studio-folder-row">
              <span>Drive folder</span>
              <strong>{folder}</strong>
            </div>
          )}

          <label className="label" htmlFor="studio-style">Style brief</label>
          <textarea
            id="studio-style"
            className="textarea stock-studio-style"
            rows={6}
            value={styleBrief}
            onChange={(e) => setStyleBrief(e.target.value)}
            placeholder="Optional. Example: slow cinematic macro shots, candlelit cabin details, foggy ocean wides, no people, muted colors..."
          />
          {!styleBrief.trim() && (
            <div className="stock-studio-fallback-note">
              Empty brief: using the channel fallback style.
            </div>
          )}

          <label className="label" htmlFor="studio-negative">Avoid</label>
          <textarea
            id="studio-negative"
            className="textarea stock-studio-negative"
            rows={4}
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder={settings.GENERATION_NEGATIVE_PROMPT || "no split screen, no collage, no text, no logos, no bright cheerful lighting unless requested..."}
          />
          <div className="stock-studio-fallback-note">
            Empty avoid field: using the global negative prompt from Settings.
          </div>

          <label className="label" htmlFor="studio-prompts">Exact prompts, one per line</label>
          <textarea
            id="studio-prompts"
            className="textarea stock-studio-prompts"
            rows={8}
            value={exactPromptText}
            onChange={(e) => setExactPromptText(e.target.value)}
            placeholder="Optional. One clip prompt per line. AI fills the rest."
          />

          <div className="stock-studio-start-row">
            <div>
              <label className="label" htmlFor="studio-count">How many clips</label>
              <input id="studio-count" className="input" type="number" min={1} max={300} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </div>
            <button className="btn" onClick={startGeneration} disabled={busy || !selectedChannel}>{busy ? "Starting..." : `Generate ${requestedCount} B-roll clips`}</button>
          </div>
          <div className="stock-studio-pipeline-strip">
            <span>20 image slots</span>
            <span>5 video slots</span>
            <span>Drive upload</span>
          </div>
          {error && <div className="card-inset stock-studio-error">{error}</div>}
        </section>

        <aside className="card stock-studio-side stock-studio-generations-panel">
          <div className="stock-studio-generations-head">
            <div>
              <span>Runs</span>
              <h2>Generations</h2>
            </div>
            <button className="btn-ghost btn-sm" type="button" onClick={loadHistory}>Refresh</button>
          </div>
          <div className="stock-studio-tabs" role="tablist" aria-label="Generation status filter">
            {(["all", "generating", "done", "failed"] as const).map((filter) => (
              <button key={filter} type="button" className={jobFilter === filter ? "active" : ""} onClick={() => setJobFilter(filter)}>
                <span>{filter === "all" ? "All" : filter === "generating" ? "Generating" : filter === "done" ? "Done" : "Failed"}</span>
                <strong>{jobCounts[filter]}</strong>
              </button>
            ))}
          </div>

          <div className="stock-studio-prompt-mix">
            <strong>{exactPrompts.length}</strong> exact
            <span>{Math.max(0, requestedCount - exactPrompts.length)} AI-filled</span>
          </div>

          {historyError && (
            <div className="stock-studio-history-error">
              <span>{historyError}</span>
              <button className="btn-ghost btn-sm" type="button" onClick={loadHistory}>Retry</button>
            </div>
          )}

          <div className="stock-studio-job-list">
            {filteredJobs.length === 0 ? (
              <div className="stock-studio-empty">
                {channelHydrating ? "Loading channel runs..." : selectedChannel ? `No ${jobFilter === "all" ? "" : `${jobFilter} `}runs for this channel yet.` : "Pick a channel to see generation runs."}
              </div>
            ) : (
              filteredJobs.map((job) => <JobCard key={job.jobId} job={job} />)
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
