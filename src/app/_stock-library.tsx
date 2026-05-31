"use client";

import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { resolveStockFolder } from "@/lib/channel-stock";
import { stockDeleteIdsForSelection } from "@/lib/stock-delete";
import { ActionNoticeCard, type ActionNotice } from "./_action-notice";
import { ConfirmDialog, type ConfirmRequest } from "./_confirm-dialog";
import { friendlyError } from "./_friendly-error";

interface StockClip {
  driveFileId: string;
  name: string;
  source?: "drive" | "local";
  previewFileId?: string;
}

interface Channel {
  id: number;
  name: string;
  video_style: string | null;
  stock_folder: string | null;
}

interface LocalRepairSummary {
  localOnlyCount: number;
  staleCacheCount: number;
}

interface DriveHealth {
  listedAt?: string;
  connectedEmail?: string;
  driveMs?: number;
}

const previewBoxStyle: CSSProperties = {
  width: "100%",
  borderRadius: 6,
  display: "block",
  background: "var(--surface-2)",
  aspectRatio: "16/9",
  objectFit: "cover",
};

const CHANNEL_KEY = "clips.selectedChannelId";

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function cleanClipName(name: string) {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatHealthTime(value?: string) {
  if (!value) return "Not checked yet";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ClipPreviewFallback({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="stock-preview-fallback" style={{ ...previewBoxStyle, display: "grid" }}>
      <div className="stock-preview-glyph" aria-hidden="true">
        <span />
      </div>
      <div>
        <div className="stock-preview-title">{title}</div>
        <div className="stock-preview-detail">{detail}</div>
      </div>
    </div>
  );
}

function ClipMediaPreview({ posterSrc, videoSrc, eager, active }: { posterSrc: string; videoSrc: string; eager: boolean; active: boolean }) {
  const [posterStatus, setPosterStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setPosterStatus("loading");
  }, [posterSrc]);

  useEffect(() => {
    if (!active) {
      setVideoReady(false);
      setVideoFailed(false);
    }
  }, [active, videoSrc]);

  return (
    <div className="stock-media-preview" style={{ position: "relative", ...previewBoxStyle, overflow: "hidden" }}>
      {posterStatus === "loading" && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 6 }} aria-hidden="true" />}
      {posterStatus === "failed" && <ClipPreviewFallback title="Thumbnail unavailable" detail="Hover can still try video" />}
      <img
        src={posterSrc}
        alt=""
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setPosterStatus("loaded")}
        onError={() => setPosterStatus("failed")}
        style={{ ...previewBoxStyle, opacity: posterStatus === "loaded" ? 1 : 0, transition: "opacity 140ms ease" }}
      />
      {active && !videoFailed && (
        <video
          src={videoSrc}
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          onCanPlay={() => setVideoReady(true)}
          onError={() => {
            setVideoFailed(true);
            setVideoReady(false);
          }}
          style={{ ...previewBoxStyle, position: "absolute", inset: 0, opacity: videoReady ? 1 : 0, transition: "opacity 140ms ease" }}
        />
      )}
    </div>
  );
}

function EmptyClipsState() {
  return (
    <div className="card" style={{ color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.6 }}>
      Pick a channel to load its Drive B-roll folder. Nothing is loaded until you choose one.
    </div>
  );
}

export function StockLibrary({ embedded = false }: { embedded?: boolean }) {
  const formId = useId();
  const channelId = `${formId}-stock-channel`;

  const [channels, setChannels] = useState<Channel[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState("");
  const [driveFolderLink, setDriveFolderLink] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [clips, setClips] = useState<StockClip[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [driveRepairing, setDriveRepairing] = useState(false);
  const [driveHealthOpen, setDriveHealthOpen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [restoredChannel, setRestoredChannel] = useState(false);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const [repairSummary, setRepairSummary] = useState<LocalRepairSummary>({ localOnlyCount: 0, staleCacheCount: 0 });
  const [driveHealth, setDriveHealth] = useState<DriveHealth>({});

  useEffect(() => {
    setPortalReady(true);
    fetch("/api/prompt-presets")
      .then((r) => r.json())
      .then((c: Channel[]) => setChannels(Array.isArray(c) ? c : []))
      .catch(() => setChannels([]));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: Record<string, string>) => setSettings(s))
      .catch(() => setSettings({}));
  }, []);

  const clearChannelState = useCallback(() => {
    setFolder("");
    setDriveFolderLink(null);
    setClips(null);
    setSelected(new Set());
    setError(null);
    setNotice(null);
    setRepairSummary({ localOnlyCount: 0, staleCacheCount: 0 });
    setDriveHealth({});
  }, []);

  const load = useCallback(async (f: string) => {
    if (!f.trim()) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSelected(new Set());
    try {
      const r = await fetchWithTimeout(`/api/stock/list?folder=${encodeURIComponent(f)}`, { cache: "no-store" }, 14000);
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Failed to load");
      setClips(Array.isArray(j.clips) ? (j.clips as StockClip[]) : []);
      setDriveFolderLink(typeof j.driveFolderLink === "string" ? j.driveFolderLink : null);
      setRepairSummary({
        localOnlyCount: Math.max(0, Number(j.localOnlyCount) || 0),
        staleCacheCount: Math.max(0, Number(j.staleCacheCount) || 0),
      });
      setDriveHealth({ listedAt: String(j.listedAt || ""), connectedEmail: String(j.connectedEmail || ""), driveMs: Number(j.driveMs) || undefined });
      if (j.message) {
        const driveAuth = j.errorKind === "drive_auth";
        setNotice({
          kind: driveAuth ? "warning" : "info",
          title: driveAuth ? "Google Drive needs reconnecting" : "Clips loaded",
          body: String(j.message),
          detail: j.detail ? String(j.detail) : undefined,
          code: j.errorKind ? String(j.errorKind) : undefined,
          actionHref: driveAuth ? "/settings" : undefined,
          actionLabel: driveAuth ? "Reconnect Drive" : undefined,
        });
      }
    } catch (e) {
      setError(friendlyError(e, "Could not load clips. Check Drive or reconnect in Settings."));
      setClips((prev) => prev ?? []);
      setRepairSummary({ localOnlyCount: 0, staleCacheCount: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  function pickChannel(id: string) {
    setSelectedChannelId(id);
    try {
      if (id) window.localStorage.setItem(CHANNEL_KEY, JSON.stringify(id));
      else window.localStorage.removeItem(CHANNEL_KEY);
    } catch {}
    if (!id) {
      clearChannelState();
      return;
    }
    const ch = channels.find((c) => String(c.id) === id);
    if (!ch) {
      clearChannelState();
      return;
    }
    const f = resolveStockFolder(ch.name, ch.stock_folder, settings.STOCK_LIBRARY_FOLDER);
    setFolder(f);
    load(f);
  }

  useEffect(() => {
    if (restoredChannel || channels.length === 0) return;
    setRestoredChannel(true);
    try {
      const raw = window.localStorage.getItem(CHANNEL_KEY);
      const saved = raw ? JSON.parse(raw) : "";
      if (saved && channels.some((channel) => String(channel.id) === String(saved))) pickChannel(String(saved));
    } catch {}
  }, [channels, restoredChannel]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function repairLocalCache() {
    if (!folder.trim()) return;
    setRepairing(true);
    setNotice(null);
    try {
      const r = await fetch("/api/stock/import-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Local cache repair failed");
      await load(folder);
      setNotice({
        kind: j.failed ? "warning" : "success",
        title: j.failed ? "Some cached clips need attention" : "Local cache repaired",
        body: `Imported ${j.imported || 0} clip${j.imported === 1 ? "" : "s"} to Drive and purged ${j.purged || 0} stale cached clip${j.purged === 1 ? "" : "s"}.`,
        detail: Array.isArray(j.errors) && j.errors.length ? j.errors.join("\n") : undefined,
      });
    } catch (e) {
      setNotice({ kind: "error", title: "Local cache repair failed", body: friendlyError(e, "Could not move local cached clips to Drive.") });
    } finally {
      setRepairing(false);
    }
  }

  async function repairDriveFolders() {
    const channel = channels.find((c) => String(c.id) === selectedChannelId);
    if (!channel || !folder.trim()) return;
    setDriveRepairing(true);
    setNotice(null);
    try {
      const r = await fetch("/api/stock/repair-drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.id, channelName: channel.name, targetFolder: folder }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Drive folder repair failed");
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? { ...c, stock_folder: folder } : c)));
      await load(folder);
      setNotice({
        kind: j.failed ? "warning" : "success",
        title: "Drive folders repaired",
        body: `Moved ${j.moved || 0} file${j.moved === 1 ? "" : "s"} into ${folder}, skipped ${j.skipped || 0} duplicate${j.skipped === 1 ? "" : "s"}, and trashed ${j.trashedFolders || 0} empty duplicate folder${j.trashedFolders === 1 ? "" : "s"}.`,
        detail: Array.isArray(j.errors) && j.errors.length ? j.errors.join("\n") : undefined,
      });
    } catch (e) {
      setNotice({ kind: "error", title: "Drive folder repair failed", body: friendlyError(e, "Could not consolidate duplicate Drive folders.") });
    } finally {
      setDriveRepairing(false);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    setConfirming({
      title: "Delete selected clips?",
      body: `Move ${selected.size} Drive clip${selected.size === 1 ? "" : "s"} to Google Drive trash and clear local previews?`,
      confirmLabel: "Delete clips",
      danger: true,
      onConfirm: runDeleteSelected,
    });
  }

  async function runDeleteSelected() {
    if (selected.size === 0) return;
    const ids = stockDeleteIdsForSelection(clips ?? [], selected);
    setDeleting(true);
    try {
      const r = await fetch("/api/stock/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const j = await r.json();
      if (!r.ok) {
        setNotice({ kind: "error", title: "Delete failed", body: String(j.error || r.statusText) });
        return;
      }
      const nextNotice: ActionNotice = {
        kind: j.failed ? "warning" : "success",
        title: j.failed ? "Some clips were not removed" : "Clips removed",
        body: j.failed
          ? `Deleted ${j.deleted}, but ${j.failed} could not be removed.`
          : `Moved ${j.deleted} clip${j.deleted === 1 ? "" : "s"} to Drive trash${j.localDeleted ? ` and cleared ${j.localDeleted} local preview${j.localDeleted === 1 ? "" : "s"}` : ""}.`,
        detail: Array.isArray(j.errors) && j.errors.length ? j.errors.join("\n") : undefined,
      };
      setClips((prev) => (prev ? prev.filter((c) => !selected.has(c.driveFileId)) : prev));
      setSelected(new Set());
      await load(folder);
      setNotice(nextNotice);
    } finally {
      setDeleting(false);
    }
  }

  const fileUrl = (id: string) => `/api/stock/file?id=${encodeURIComponent(id)}`;
  const posterUrl = (clip: StockClip) => {
    const id = clip.previewFileId || clip.driveFileId;
    const params = new URLSearchParams({ id, folder, name: clip.name });
    return `/api/stock/poster?${params.toString()}`;
  };
  const selectedChannel = channels.find((c) => String(c.id) === selectedChannelId);
  const visibleClips = clips ?? [];
  const repairTotal = repairSummary.localOnlyCount + repairSummary.staleCacheCount;
  const shouldShowDriveRepair = selectedChannel?.name === "Sleepy Pirate History" && folder === "Pirates";
  const driveHealthLine = useMemo(() => {
    if (!selectedChannelId) return null;
    const parts = [`Last Drive check: ${formatHealthTime(driveHealth.listedAt)}`];
    if (driveHealth.connectedEmail) parts.push(driveHealth.connectedEmail);
    if (driveHealth.driveMs) parts.push(`${Math.round(driveHealth.driveMs / 100) / 10}s`);
    return parts.join(" · ");
  }, [driveHealth, selectedChannelId]);

  const selectionActions = (
    <>
      <button className="btn-ghost btn-sm" onClick={() => clips && setSelected(new Set(clips.map((c) => c.driveFileId)))} disabled={!clips?.length}>Select all</button>
      <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Clear</button>
      <button className="btn-danger btn-sm" onClick={deleteSelected} disabled={selected.size === 0 || deleting}>{deleting ? "Deleting..." : "Delete selected"}</button>
    </>
  );

  const selectedActionsPanel = selected.size > 0 ? (
    <div className="stock-selected-bar" role="region" aria-label="Selected clip actions">
      <div><strong>{selected.size}</strong> selected</div>
      <div className="stock-selected-bar-actions">{selectionActions}</div>
    </div>
  ) : null;

  return (
    <div>
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />

      {!embedded && (
        <>
          <h1>Stock Library</h1>
          <p className="muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
            Review the B-roll clips used to fill your videos. Preview, delete the ones that do not fit, or generate more without leaving the app.
          </p>
        </>
      )}

      <div className="card" style={{ display: "grid", gap: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 260px" }}>
            <label className="label" htmlFor={channelId}>Channel</label>
            <select id={channelId} className="input" onChange={(e) => pickChannel(e.target.value)} value={selectedChannelId}>
              <option value="">- pick a channel -</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {selectedChannelId && (
            <div style={{ flex: "2 1 360px", display: "grid", gap: 6 }}>
              <span className="label">Drive folder</span>
              <div className="stock-folder-pill">
                <strong>{folder}</strong>
                <span>single folder for {selectedChannel?.name || "this channel"}</span>
              </div>
            </div>
          )}

          {selectedChannelId && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn-secondary btn-sm" onClick={() => load(folder)} disabled={loading || !folder.trim()}>{loading ? "Refreshing..." : "Refresh"}</button>
              {driveFolderLink && <a className="btn-secondary btn-sm" href={driveFolderLink} target="_blank" rel="noreferrer">Open Drive folder</a>}
              <button
                type="button"
                className="stock-drive-mini-button"
                aria-label="Drive status and repairs"
                aria-expanded={driveHealthOpen}
                onClick={() => setDriveHealthOpen((open) => !open)}
                title={driveHealthLine || "Drive status"}
              >
                <span />
              </button>
            </div>
          )}
        </div>

        {selectedChannelId ? (
          <div className="stock-clip-actions-row">
            <Link className="btn" href={`/clips/generate?channelId=${encodeURIComponent(selectedChannelId)}`}>Generate B-roll</Link>
            <span className="faint">Open Studio. Clips can keep refreshing in the background.</span>
          </div>
        ) : (
          <div className="card-inset" style={{ padding: 12, color: "var(--fg-muted)", fontSize: 13 }}>Pick a channel before generating B-roll so new clips land in the correct Drive folder.</div>
        )}
      </div>

      {notice && <ActionNoticeCard notice={notice} onDismiss={() => setNotice(null)} style={{ marginBottom: 16 }} />}

      {selectedChannelId && driveHealthOpen && (
        <div className="stock-drive-mini-popover card">
          <div>
            <strong>Drive status</strong>
            <p>{driveHealthLine || "Drive has not been checked yet."}</p>
            {repairTotal > 0 && <p>{repairSummary.localOnlyCount} local-only cached clip{repairSummary.localOnlyCount === 1 ? "" : "s"}; {repairSummary.staleCacheCount} stale cached clip{repairSummary.staleCacheCount === 1 ? "" : "s"}.</p>}
          </div>
          <div className="stock-drive-mini-actions">
            {shouldShowDriveRepair && <button className="btn-secondary btn-sm" onClick={repairDriveFolders} disabled={driveRepairing || loading}>{driveRepairing ? "Repairing..." : "Consolidate folders"}</button>}
            {repairTotal > 0 && <button className="btn-secondary btn-sm" onClick={repairLocalCache} disabled={repairing || loading}>{repairing ? "Repairing..." : "Move cache to Drive"}</button>}
          </div>
        </div>
      )}

      {!selectedChannelId && <EmptyClipsState />}

      {selectedChannelId && clips && clips.length > 0 && (
        <div className="stock-library-toolbar">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 650 }}>{clips.length} Drive clip{clips.length === 1 ? "" : "s"}</div>
            <div className="faint">{selected.size} selected</div>
          </div>
          <div className="stock-toolbar-actions">{selectionActions}</div>
        </div>
      )}

      {selectedChannelId && error && <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)", marginBottom: 16 }}>Could not load clips. {error}</div>}

      {selectedChannelId && clips && clips.length === 0 && !error && <div className="card" style={{ color: "var(--fg-muted)", fontSize: 13 }}>No Drive clips in this folder yet. Generate B-roll above or move local cache to Drive if a cleanup card is shown.</div>}

      {selectedChannelId && clips && clips.length > 0 && (
        <div className="stock-grid">
          {visibleClips.map((c, index) => {
            const displayName = cleanClipName(c.name);
            const sel = selected.has(c.driveFileId);
            const playing = hoveredClipId === c.driveFileId;
            const videoId = c.previewFileId || c.driveFileId;
            return (
              <button
                key={c.driveFileId}
                type="button"
                className="card-inset stock-clip-card"
                aria-pressed={sel}
                aria-label={`${sel ? "Deselect" : "Select"} ${displayName || "stock clip"}`}
                onClick={() => toggle(c.driveFileId)}
                onMouseEnter={() => setHoveredClipId(c.driveFileId)}
                onMouseLeave={() => setHoveredClipId((current) => (current === c.driveFileId ? null : current))}
                onFocus={() => setHoveredClipId(c.driveFileId)}
                onBlur={() => setHoveredClipId((current) => (current === c.driveFileId ? null : current))}
              >
                <div className="stock-preview-wrap">
                  <ClipMediaPreview posterSrc={posterUrl(c)} videoSrc={fileUrl(videoId)} eager={index < 16} active={playing} />
                  <label className="stock-select-hit" onClick={(e) => e.stopPropagation()}>
                    <span className="sr-only">{sel ? "Deselect" : "Select"} {displayName || "stock clip"}</span>
                    <input type="checkbox" checked={sel} onChange={() => toggle(c.driveFileId)} />
                  </label>
                  <span className="stock-source-badge">Drive</span>
                </div>
                <div className="stock-clip-name" title={c.name}>{displayName || c.name}</div>
              </button>
            );
          })}
        </div>
      )}

      {portalReady && selectedActionsPanel ? createPortal(selectedActionsPanel, document.body) : null}
    </div>
  );
}
