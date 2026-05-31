"use client";
import { useEffect, useState } from "react";
import { isSecretKey, isMaskedValue } from "@/lib/secret-keys";
import { ALL_GROUPS, type Group } from "./_groups";
import { GroupCard } from "./_group-card";
import { GdriveSection, type GdriveStatus } from "./_gdrive-section";
import { ActionNoticeCard, type ActionNotice } from "../_action-notice";
import { ConfirmDialog, type ConfirmRequest } from "../_confirm-dialog";

interface StatsResp {
  keyCount: number;
  total: { image: number; tts: number; anim: number };
  assembleConcurrency: number;
  xfadeChunks: number;
}

const TABS = [
  { id: "keys", label: "Connections" },
  { id: "pipeline", label: "Speed & Quality" },
  { id: "storage", label: "Files" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// Which schema groups render under each tab (by title). Voice + Video creative
// settings moved to channels (Prompt 9) — only technical globals remain here.
const TAB_GROUPS: Record<TabId, string[]> = {
  keys: ["Main connections", "Rarely needed"],
  pipeline: [
    "Script Breakdown (LLM)",
    "Voice engine",
    "Video output",
    "Video Assembly (FFmpeg)",
    "Performance (Concurrency)",
    "Reliability & Scaling",
  ],
  storage: ["Storage Location"],
};

const TAB_INTRO: Record<TabId, string> = {
  keys: "Connect Google Drive and the generation services.",
  pipeline: "Tune scene reading, voice, video, speed, and recovery.",
  storage: "Choose where finished videos and run files are saved.",
};

function groupsFor(tab: TabId): Group[] {
  return TAB_GROUPS[tab]
    .map((t) => ALL_GROUPS.find((g) => g.title === t))
    .filter((g): g is Group => Boolean(g));
}

function isTabId(s: string | null): s is TabId {
  return !!s && TABS.some((t) => t.id === s);
}

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [gdrive, setGdrive] = useState<GdriveStatus | null>(null);
  const [tab, setTab] = useState<TabId>("keys");
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);

  async function load(reveal = false) {
    const [settingsR, statsR, gdriveR] = await Promise.all([
      fetch(`/api/settings${reveal ? "?reveal=1" : ""}`).then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()).catch(() => null),
      fetch("/api/gdrive/status").then((r) => r.json()).catch(() => null),
    ]);
    setValues(settingsR);
    setStats(statsR);
    setGdrive(gdriveR);
    setRevealing(reveal);
  }

  useEffect(() => {
    load(false);
  }, []);

  // Deep-link + OAuth return: read ?tab= and ?gdrive= once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "voice" || t === "video") {
      // Voice/Video moved to channels (Prompt 9) — redirect old links to Keys.
      setTab("keys");
      setToast("Voice and Video settings now live on each channel.");
      setTimeout(() => setToast(null), 4000);
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "keys");
      window.history.replaceState({}, "", url);
    } else if (isTabId(t)) {
      setTab(t);
    }
    const gd = params.get("gdrive");
    if (gd === "connected") {
      setToast("Google Drive connected.");
      setTimeout(() => setToast(null), 4000);
    } else if (gd === "error") {
      const reason = params.get("reason") || "unknown error";
      setToast(
        reason.includes("redirect_uri_mismatch")
          ? "Google rejected the callback URL. Add the exact callback URL shown below, then reconnect."
          : `Drive connection failed: ${reason}`
      );
      setTimeout(() => setToast(null), 6000);
    }
    if (gd) {
      const url = new URL(window.location.href);
      url.searchParams.delete("gdrive");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url);
      load(false);
    }
  }, []);

  useEffect(() => {
    const syncTab = () => {
      const nextTab = new URLSearchParams(window.location.search).get("tab");
      if (isTabId(nextTab)) {
        setTab(nextTab);
        return;
      }
      setTab("keys");
    };
    syncTab();
    window.addEventListener("popstate", syncTab);
    return () => window.removeEventListener("popstate", syncTab);
  }, []);

  function selectTab(t: TabId) {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "keys") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", t);
    }
    window.history.replaceState({}, "", url);
  }

  async function save() {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      // Never POST a masked secret back — it would clobber the stored value.
      // Shared helper keeps this in lockstep with the server-side guard.
      if (isSecretKey(k) && typeof v === "string" && isMaskedValue(v)) continue;
      cleaned[k] = v;
    }
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleaned),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}) as { error?: string });
      setNotice({
        kind: "error",
        title: "Settings were not saved",
        body: String(j.error || r.statusText),
      });
      return;
    }
    setNotice(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    load(revealing);
  }

  async function disconnectGdrive() {
    setConfirming({
      title: "Disconnect Google Drive?",
      body: "Uploads and Drive clip loading will stop until you authorize Google Drive again.",
      confirmLabel: "Disconnect",
      danger: true,
      onConfirm: async () => {
        await fetch("/api/gdrive/disconnect", { method: "POST" });
        await load(revealing);
        setNotice({ kind: "info", title: "Google Drive disconnected", body: "Runs will stay local until Drive is connected again." });
      },
    });
  }

  function connectGdrive() {
    if (!gdrive?.credentialsConfigured) {
      setNotice({
        kind: "warning",
        title: "Google Drive needs credentials first",
        body: "Fill GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET, then save changes before connecting.",
      });
      return;
    }
    window.location.href = "/api/gdrive/oauth/start";
  }

  return (
    <div>
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />

      {toast && (
        <div
          style={{
            position: "fixed",
            top: 18,
            right: 18,
            zIndex: 1000,
            background: "var(--surface-2)",
            border: "1px solid var(--accent)",
            color: "var(--fg)",
            padding: "10px 14px",
            borderRadius: "var(--r-sm)",
            fontSize: 13,
            boxShadow: "var(--shadow-md)",
            maxWidth: 320,
          }}
        >
          {toast}
        </div>
      )}

      <h1>Settings</h1>
      <p className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
        {TAB_INTRO[tab]}{" "}
        <span className="faint">
          Channel voices and visual styles live under{" "}
          <a className="inline-action-link" href="/prompts">
            Channels
          </a>
        </span>
      </p>

      {notice && <ActionNoticeCard notice={notice} onDismiss={() => setNotice(null)} style={{ marginBottom: 16 }} />}

      {/* Sub-tabs + sticky action bar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          padding: "10px 0",
          marginBottom: 18,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div role="tablist" aria-label="Settings sections" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map((t) => {
                const active = t.id === tab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`settings-panel-${t.id}`}
                    onClick={() => selectTab(t.id)}
                    style={{
                      minHeight: 36,
                      padding: "7px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: "999px",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "#fff" : "var(--fg-muted)",
                  cursor: "pointer",
                }}
                  >
                    {t.label}
                  </button>
                );
              })}
        </div>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button className="btn-secondary" onClick={() => load(!revealing)} aria-label={revealing ? "Hide saved secrets" : "Reveal saved secrets"}>
            {revealing ? "Hide secrets" : "Reveal secrets"}
          </button>
          <button className="btn" onClick={save}>
            {saved ? "Saved ✓" : "Save all changes"}
          </button>
        </div>
      </div>

      <section id={`settings-panel-${tab}`} role="tabpanel" aria-label={`${TABS.find((t) => t.id === tab)?.label ?? "Settings"} settings`}>
        {/* Keys tab: parallel-capacity readout above the key fields. */}
        {tab === "keys" && stats && stats.keyCount > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <h2 style={{ margin: 0 }}>Parallel capacity</h2>
                  {stats.keyCount >= 2 && <span className="badge badge-success">× {stats.keyCount} keys</span>}
                </div>
                <div style={{ color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
                  <strong style={{ color: "var(--fg)" }}>{stats.total.anim}</strong> video jobs ·{" "}
                  <strong style={{ color: "var(--fg)" }}>{stats.total.tts}</strong> TTS jobs running at once
                </div>
                {stats.keyCount === 1 && (
                  <div style={{ color: "var(--warning)", fontSize: 12, marginTop: 7 }}>
                    Add a second / third 69labs key below to multiply capacity — with 3 keys, ~3× faster.
                  </div>
                )}
              </div>
              <div className="faint" style={{ fontSize: 11, textAlign: "right" }}>
                FFmpeg: {stats.assembleConcurrency} parallel clips
                <br />
                xfade chunks: {stats.xfadeChunks}
              </div>
            </div>
          </div>
        )}

        {groupsFor(tab).map((g) => (
          <GroupCard key={g.title} group={g} values={values} setValues={setValues} />
        ))}

        {tab === "keys" && (
          <GdriveSection
            values={values}
            setValues={setValues}
            gdrive={gdrive}
            onConnect={connectGdrive}
            onDisconnect={disconnectGdrive}
          />
        )}
      </section>
    </div>
  );
}
