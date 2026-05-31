"use client";
import { useEffect, useState } from "react";

type GdriveErrorKind = "api_not_enabled" | "auth_invalid" | "network" | "other";

export interface GdriveStatus {
  connected: boolean;
  email?: string;
  error?: string;
  errorKind?: GdriveErrorKind;
  enableUrl?: string;
  syncEnabled?: boolean;
  credentialsConfigured: boolean;
}

const GDRIVE_FIELDS = [
  {
    key: "GDRIVE_CLIENT_ID",
    label: "Client ID",
    desc: "From your Google Cloud OAuth web application.",
    examples: "Format: 123456789-abc.apps.googleusercontent.com",
  },
  {
    key: "GDRIVE_CLIENT_SECRET",
    label: "Client Secret",
    desc: "From the same OAuth credential. It is masked after you save.",
    examples: "Format: GOCSPX-xxxxxxxxxxxxxxxx",
  },
  {
    key: "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
    label: "Final videos folder",
    desc: "Leave empty and the app will create Conveyer Hum / Final Videos automatically.",
    examples: "From folder URL: drive.google.com/drive/folders/<THIS_PART>",
  },
  {
    key: "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
    label: "Clips library folder",
    desc: "Leave empty and the app will create Conveyer Hum / Clips Library automatically.",
    examples: "Same format as above",
  },
];

export function GdriveSection({
  values,
  setValues,
  gdrive,
  onConnect,
  onDisconnect,
}: {
  values: Record<string, string>;
  setValues: (next: Record<string, string>) => void;
  gdrive: GdriveStatus | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  // The OAuth redirect URI must match the app's actual origin. Resolve it client-side.
  const [callbackUrl, setCallbackUrl] = useState("http://localhost:3001/api/gdrive/oauth/callback");
  const [copied, setCopied] = useState(false);
  const [showConnectPrep, setShowConnectPrep] = useState(false);
  useEffect(() => {
    setCallbackUrl(`${window.location.origin}/api/gdrive/oauth/callback`);
  }, []);

  const statusText = gdrive?.connected
    ? `Connected${gdrive.email ? ` as ${gdrive.email}` : ""}`
    : gdrive?.errorKind === "auth_invalid"
      ? "Expired login"
      : gdrive?.credentialsConfigured
        ? "Ready to connect"
        : "Needs setup";
  const statusColor = gdrive?.connected
    ? "var(--success)"
    : gdrive?.errorKind === "auth_invalid"
      ? "var(--warning)"
      : gdrive?.error
        ? "var(--danger)"
        : "var(--fg-muted)";
  const needsCredentials = !gdrive?.credentialsConfigured;
  const needsDriveRepair = gdrive?.errorKind === "auth_invalid";
  const credentialsUrl = "https://console.cloud.google.com/apis/credentials";

  async function copyCallbackUrl() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = callbackUrl;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function openConnectPrep() {
    if (needsCredentials) {
      onConnect();
      return;
    }
    setShowConnectPrep(true);
  }

  function continueToGoogle() {
    setShowConnectPrep(false);
    onConnect();
  }

  const showCallbackPrep = showConnectPrep || needsDriveRepair;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <h2 style={{ margin: 0 }}>Google Drive</h2>
            <span className="badge badge-accent">optional</span>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>
            Saves final videos and reusable clips. Local cached clips still work when Drive is offline.
          </p>
        </div>
        <span className="badge" style={{ background: "var(--surface-2)", color: statusColor }}>
          {statusText}
        </span>
      </div>

      {showCallbackPrep && (
        <div className="card-inset" style={{ padding: 14, marginBottom: 14, borderColor: "rgba(252,211,77,0.35)", background: "var(--warning-soft)" }}>
          <div style={{ color: "var(--warning)", fontWeight: 750, fontSize: 14 }}>
            {needsDriveRepair ? "Fix Google Drive login" : "Before Google opens"}
          </div>
          <div style={{ color: "var(--fg-muted)", fontSize: 12.5, marginTop: 6, lineHeight: 1.55 }}>
            Google only accepts login if this exact callback URL is saved in your OAuth client.
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11.5,
              marginTop: 10,
              padding: "9px 10px",
              borderRadius: "var(--r-sm)",
              background: "var(--bg-deep)",
              overflowX: "auto",
              color: "var(--fg)",
            }}
          >
            {callbackUrl}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button className="btn-secondary btn-sm" onClick={copyCallbackUrl}>
              {copied ? "Copied" : "Copy callback URL"}
            </button>
            <a className="btn-secondary btn-sm" href={credentialsUrl} target="_blank" rel="noopener noreferrer">
              Open Google credentials
            </a>
            <button className="btn btn-sm" onClick={continueToGoogle}>
              Continue to Google
            </button>
            {showConnectPrep && !needsDriveRepair && (
              <button className="btn-secondary btn-sm" onClick={() => setShowConnectPrep(false)}>
                Cancel
              </button>
            )}
          </div>
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 10, lineHeight: 1.55 }}>
            In Google Cloud: open your OAuth client, add the callback URL under Authorized redirect URIs, save, then reconnect.
          </div>
        </div>
      )}

      {gdrive?.errorKind === "api_not_enabled" && (
        <div className="card-inset" style={{ padding: 13, marginBottom: 14, borderColor: "rgba(248,113,113,0.35)", background: "var(--danger-soft)" }}>
          <div style={{ color: "var(--danger)", fontWeight: 700, fontSize: 13 }}>
            Google Drive API is not enabled.
          </div>
          {gdrive.enableUrl && (
            <a className="btn-secondary btn-sm" href={gdrive.enableUrl} target="_blank" rel="noopener noreferrer" style={{ marginTop: 10 }}>
              Enable Drive API
            </a>
          )}
        </div>
      )}

      {!needsDriveRepair && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {gdrive?.connected ? (
          <>
            <button className="btn-secondary" onClick={openConnectPrep}>
              Refresh Google login
            </button>
            <button className="btn-danger" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
          ) : (
          <button className="btn" onClick={openConnectPrep} disabled={!gdrive?.credentialsConfigured}>
            Connect Google Drive
          </button>
          )}
        </div>
      )}

      <div
        className="card-inset"
        style={{ marginBottom: 16, padding: "9px 11px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        <label className="settings-check-label">
          <input
            className="settings-check-input"
            type="checkbox"
            checked={values.GDRIVE_SYNC_ENABLED === "1"}
            onChange={(e) => setValues({ ...values, GDRIVE_SYNC_ENABLED: e.target.checked ? "1" : "" })}
          />
          <span className="settings-check-box" aria-hidden="true" />
          <span>Auto-upload finished runs to Drive</span>
        </label>
        <span className="faint" style={{ fontSize: 11 }}>
          Saves the final video, source clips, and metadata after each run.
        </span>
      </div>

      <details className="card-inset" open={needsCredentials} style={{ marginBottom: 12, padding: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 650, fontSize: 13, minHeight: 36, display: "flex", alignItems: "center" }}>
          Google login keys
        </summary>
        <div style={{ display: "grid", gap: 16, marginTop: 14 }}>
        {GDRIVE_FIELDS.slice(0, 2).map((f) => (
          <div key={f.key}>
            <label htmlFor={`gdrive-${f.key}`} className="label" style={{ fontWeight: 600, letterSpacing: "0.01em" }}>
              {f.label ?? f.key}
            </label>
            <input
              id={`gdrive-${f.key}`}
              className="input"
              value={values[f.key] ?? ""}
              placeholder={`e.g. ${f.examples}`}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>{f.desc}</div>
            <div className="mono faint" style={{ fontSize: 10.5, marginTop: 3 }}>{f.key}</div>
            <div className="mono faint" style={{ fontSize: 11, marginTop: 3 }}>
              {f.examples}
            </div>
          </div>
        ))}
        </div>
      </details>

      <details className="card-inset" style={{ marginTop: 16, padding: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 650, fontSize: 13, minHeight: 36, display: "flex", alignItems: "center" }}>
          Setup help
        </summary>
        <div style={{ display: "grid", gap: 16, marginTop: 14 }}>
          {GDRIVE_FIELDS.slice(2).map((f) => (
            <div key={f.key}>
              <label htmlFor={`gdrive-${f.key}`} className="label" style={{ fontWeight: 600, letterSpacing: "0.01em" }}>
                {f.label ?? f.key}
              </label>
              <input
                id={`gdrive-${f.key}`}
                className="input"
                value={values[f.key] ?? ""}
                placeholder={`e.g. ${f.examples}`}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
              <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>{f.desc}</div>
              <div className="mono faint" style={{ fontSize: 10.5, marginTop: 3 }}>{f.key}</div>
            </div>
          ))}
        </div>
        <ol style={{ marginTop: 16, paddingLeft: 20, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.75 }}>
          <li>
            Open{" "}
            <a className="inline-action-link" href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">
              Google Cloud Console
            </a>
          </li>
          <li>Create a new project (or reuse an existing one)</li>
          <li>APIs &amp; Services → Library → enable <strong>Google Drive API</strong></li>
          <li>OAuth consent screen → <strong>External</strong> → add your Gmail to <strong>Test users</strong></li>
          <li>Credentials → Create OAuth client → <strong>Web Application</strong></li>
          <li>
            Authorized redirect URI:{" "}
            <code style={{ background: "var(--bg-deep)", padding: "2px 6px", borderRadius: 4 }}>{callbackUrl}</code>
          </li>
          <li>Copy <strong>Client ID</strong> + <strong>Client Secret</strong> into the fields above</li>
          <li>Click <strong>Save all changes</strong> at the top</li>
          <li>Then click <strong>Connect Google Drive</strong> — approve access in the browser tab</li>
        </ol>
      </details>
    </div>
  );
}
