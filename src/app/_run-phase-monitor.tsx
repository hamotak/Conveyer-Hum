"use client";

type SceneStage = "pending" | "audio" | "image" | "video" | "rendered";
export interface SceneAsset {
  index: number;
  text?: string;
  duration_hint_sec?: number;
  source_kind?: "fresh" | "stock";
  stage: SceneStage;
  audio?: { name: string; size: number };
  image?: { name: string; size: number };
  animation?: { name: string; size: number };
  clip?: { name: string; size: number };
}

export interface PhaseAssets {
  mode?: string;
  scenes: SceneAsset[];
  planSceneCount?: number;
  stockSceneCount?: number;
  freshSceneCount?: number;
  finalExists: boolean;
  finalSize: number;
  finalOnDisk?: boolean;
  finalNeedsRepair?: boolean;
  oldFinalSize?: number;
  tail?: {
    voiceoverReady: boolean;
    voiceoverFileReady?: boolean;
    voiceoverPartCount?: number;
    expectedVoiceoverPartCount?: number;
    segmentReady: boolean;
    renderedClipCount?: number;
  };
  progress: { total: number; rendered: number; withVideo: number; withAudio: number };
  hybridProgress?: {
    freshTotal: number;
    freshWithVideo: number;
    freshRendered: number;
    stockSceneCount: number;
  } | null;
  recovery?: {
    paused: boolean;
    canResume: boolean;
    openingReady: boolean;
    tailVoiceReady: boolean;
    tailSegmentReady: boolean;
    finalReady: boolean;
    nextAction: "resume" | "wait" | "download" | "inspect" | "repair";
  };
  scenePlanHealth?: {
    ok: boolean;
    issue: string | null;
    sceneCount: number;
    avgWords: number;
    shortScenes: number;
    danglingScenes: number;
  };
  exportQuality?: {
    overall: "ready" | "needs_work" | "blocked" | "pending";
    checks: {
      id: "chunking" | "sync" | "watermark" | "duration";
      label: string;
      status: "pass" | "warn" | "fail" | "pending";
      detail: string;
    }[];
  };
  syncReport?: Record<string, unknown> | null;
}

type PhaseId = "script" | "fresh" | "stock" | "assemble" | "final";
type PhaseStatus = "pending" | "active" | "done";

interface Phase {
  id: PhaseId;
  label: string;
  status: PhaseStatus;
  detail: string;
}

function derivePhases(
  assets: PhaseAssets,
  logs: { stage?: string; message: string }[],
  isActive: boolean
): { phases: Phase[]; activePhase: PhaseId } {
  const mode = assets.mode ?? "hybrid";
  const isHybrid = mode === "hybrid";
  const isStock = mode === "stock";
  const isFull = mode === "full";
  const planN = assets.planSceneCount ?? assets.scenes.length;
  const freshN = assets.hybridProgress?.freshTotal ?? assets.freshSceneCount ?? (isFull ? planN : 0);
  const stockN = assets.stockSceneCount ?? assets.hybridProgress?.stockSceneCount ?? 0;
  const hp = assets.hybridProgress;

  const planReady =
    planN > 0 ||
    logs.some((l) => l.stage === "scene_split" && (l.message.includes("plan ready") || l.message.includes("Done:")));

  const voiceReady = isStock || freshN === 0 || assets.progress.withAudio >= freshN;
  const visualsReady = isStock || freshN === 0 || (hp ? hp.freshWithVideo >= freshN : assets.progress.withVideo >= freshN);
  const freshDone = isStock || assets.finalExists || (freshN > 0 && voiceReady && visualsReady);
  const stockDone = !isHybrid && !isStock ? true : stockN === 0 || assets.tail?.segmentReady || assets.finalExists;
  const assembleReady = (freshDone || isStock) && stockDone;
  const finalDone = assets.finalExists;

  let activePhase: PhaseId = "script";
  if (finalDone) activePhase = "final";
  else if (!planReady) activePhase = "script";
  else if (!freshDone && !isStock) activePhase = "fresh";
  else if (!stockDone && (isHybrid || isStock)) activePhase = "stock";
  else activePhase = "assemble";

  if (!isActive && assets.finalExists) activePhase = "final";

  const phases: Phase[] = [
    {
      id: "script",
      label: "Script plan",
      status: planReady ? "done" : isActive ? "active" : "pending",
      detail: planReady ? `${freshN || planN} opening chunk${(freshN || planN) === 1 ? "" : "s"}` : "Reading script",
    },
    {
      id: "fresh",
      label: "Fresh AI opening",
      status: isStock ? "done" : freshDone ? "done" : planReady ? "active" : "pending",
      detail: isStock
        ? "Skipped"
        : freshDone
          ? `${freshN}/${freshN} synced`
          : freshN > 0
            ? `${Math.min(assets.progress.withAudio, hp?.freshWithVideo ?? assets.progress.withVideo)}/${freshN} ready`
            : "Waiting",
    },
    {
      id: "stock",
      label: "Stock tail",
      status: stockDone ? "done" : planReady && (isHybrid || isStock) ? "active" : "pending",
      detail: stockN === 0
        ? isFull ? "Not needed" : "No tail"
        : stockDone
          ? "B-roll timed"
          : assets.tail?.voiceoverReady
            ? "Matching B-roll"
            : "Recording narration",
    },
    {
      id: "assemble",
      label: "Assemble",
      status: finalDone ? "done" : assembleReady && activePhase === "assemble" ? "active" : "pending",
      detail: finalDone ? "Timed and stitched" : assembleReady ? "Stitching final" : "Waiting",
    },
    {
      id: "final",
      label: "Final video",
      status: finalDone ? "done" : activePhase === "final" ? "active" : "pending",
      detail: finalDone ? `${(assets.finalSize / (1024 * 1024)).toFixed(1)} MB` : "Waiting",
    },
  ];

  return { phases, activePhase };
}

function MiniStatus({ label, done, active }: { label: string; done: boolean; active?: boolean }) {
  return (
    <span className={`creator-mini-status${done ? " done" : active ? " active" : ""}`}>
      <span aria-hidden="true">{done ? "✓" : active ? "●" : "○"}</span>
      {label}
    </span>
  );
}

export function RunPhaseMonitor({
  assets,
  logs,
  isActive,
  runStatus,
  fileUrl,
}: {
  assets: PhaseAssets;
  logs: { stage?: string; level?: string; message: string }[];
  isActive: boolean;
  runStatus?: string;
  fileUrl: (p: string, dl?: boolean) => string;
}) {
  const { phases, activePhase } = derivePhases(assets, logs, isActive);
  const mode = assets.mode ?? "hybrid";
  const isHybridLike = mode === "hybrid" || mode === "stock";
  const hp = assets.hybridProgress;
  const planReady = (assets.planSceneCount ?? assets.scenes.length) > 0;
  const freshN = hp?.freshTotal ?? assets.freshSceneCount ?? assets.scenes.length;
  const stockN = assets.stockSceneCount ?? hp?.stockSceneCount ?? 0;
  const freshAudio = Math.min(assets.progress.withAudio, freshN);
  const freshVideo = Math.min(hp?.freshWithVideo ?? assets.progress.withVideo, freshN);
  const freshRendered = Math.min(hp?.freshRendered ?? assets.progress.rendered, freshN);
  const freshPct = freshN > 0 ? Math.round((Math.min(freshAudio, freshVideo) / freshN) * 100) : 0;

  return (
    <div className="phase-monitor">
      <div className="phase-strip" role="list" aria-label="Run progress">
        {phases.map((p, i) => (
          <div key={p.id} className="phase-strip-item" role="listitem">
            <div className={`phase-node phase-${p.status}${activePhase === p.id ? " phase-current" : ""}`}>
              <span className="phase-node-icon" aria-hidden="true">
                {p.status === "done" ? "✓" : p.status === "active" ? "●" : "○"}
              </span>
              <div className="phase-node-text">
                <span className="phase-node-label">{p.label}</span>
                <span className="phase-node-detail">{p.detail}</span>
              </div>
            </div>
            {i < phases.length - 1 && (
              <div className={`phase-connector${p.status === "done" ? " done" : ""}`} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      {isHybridLike && planReady && (
        <p className="phase-summary">
          {mode === "hybrid" ? (
            <>
              <strong>{freshN}</strong> Fresh AI opening chunk{freshN === 1 ? "" : "s"} · then one stock tail from
              your channel B-roll
            </>
          ) : (
            <>Entire script uses channel B-roll with one continuous narration track</>
          )}
        </p>
      )}

      <div className="phase-detail">
        {activePhase === "script" && isActive && phases[0].status !== "done" && (
          <div className="phase-detail-card">
            <div className="scene-monitor-spinner" style={{ margin: "0 auto 12px" }} />
            <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: "center" }}>
              Finding natural Fresh AI chunks and preparing the stock tail.
            </p>
          </div>
        )}

        {mode !== "stock" && freshN > 0 && !assets.finalExists && (
          <div className="phase-detail-card creator-progress-card">
            <div className="phase-detail-head">
              <div>
                <h2 style={{ margin: 0, fontSize: 15 }}>Fresh AI opening</h2>
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.5 }}>
                  Voice and visuals start together for each short opening chunk.
                </p>
              </div>
              <span className="faint" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                {Math.min(freshAudio, freshVideo)}/{freshN}
              </span>
            </div>
            <div className="run-progress-track" style={{ width: "100%" }}>
              <div className="run-progress-fill" style={{ width: `${freshPct}%` }} />
            </div>
            <div className="creator-mini-status-row">
              <MiniStatus label={`Voice ${freshAudio}/${freshN}`} done={freshAudio >= freshN} active={isActive && freshAudio < freshN} />
              <MiniStatus label={`AI visuals ${freshVideo}/${freshN}`} done={freshVideo >= freshN} active={isActive && freshVideo < freshN} />
              <MiniStatus label={`Synced clips ${freshRendered}/${freshN}`} done={freshRendered >= freshN} active={freshVideo >= freshN && freshRendered < freshN} />
            </div>
            <p className="faint" style={{ margin: "12px 0 0", fontSize: 12 }}>
              Open Advanced details for the exact script chunks and clip previews.
            </p>
          </div>
        )}

        {isHybridLike && stockN > 0 && !assets.finalExists && (
          <div className="phase-detail-card phase-tail-card">
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Stock tail</h2>
            <p className="muted" style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.55 }}>
              After the Fresh AI opening, the rest of the script uses one narration track over matched channel B-roll.
            </p>
            <ul className="phase-tail-steps">
              <li className={assets.tail?.voiceoverReady ? "done" : isActive ? "active" : ""}>
                Tail narration
                {assets.tail?.voiceoverReady
                  ? ` ✓${assets.tail.voiceoverPartCount ? ` (${assets.tail.voiceoverPartCount} saved part${assets.tail.voiceoverPartCount === 1 ? "" : "s"})` : ""}`
                  : ""}
              </li>
              <li className={assets.tail?.segmentReady ? "done" : isActive && assets.tail?.voiceoverReady ? "active" : ""}>
                B-roll timing
                {assets.tail?.segmentReady
                  ? " ✓"
                  : assets.tail?.renderedClipCount
                    ? ` · ${assets.tail.renderedClipCount.toLocaleString()} clips prepared`
                    : ""}
              </li>
              <li className={assets.finalExists ? "done" : ""}>Join opening + tail</li>
            </ul>
          </div>
        )}

        {(activePhase === "final" || assets.finalExists) && assets.finalExists && (
          <div>
            <div className="phase-detail-head">
              <h2 style={{ margin: 0, fontSize: 15 }}>Final video</h2>
              <span className="faint" style={{ fontSize: 12 }}>
                {(assets.finalSize / (1024 * 1024)).toFixed(2)} MB
              </span>
            </div>
            <video
              controls
              preload="metadata"
              playsInline
              poster={fileUrl("final-poster.jpg")}
              style={{
                width: "100%",
                aspectRatio: "16 / 9",
                maxHeight: 480,
                display: "block",
                objectFit: "contain",
                borderRadius: "var(--r-sm)",
                background: "#000",
              }}
              src={fileUrl("final.mp4")}
            />
          </div>
        )}
      </div>

      {runStatus === "error" && (
        <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
          Open <strong>Diagnostics</strong> inside Advanced details for logs and provider details.
        </p>
      )}
    </div>
  );
}
