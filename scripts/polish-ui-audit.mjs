#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import http from "node:http";
import https from "node:https";

const DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
const ARTIFACT_ROOT = path.resolve(process.cwd(), "artifacts", DATE, "ui-audit");

const BASE_CANDIDATES = process.env.BASE_URL
  ? [process.env.BASE_URL]
  : ["http://localhost:3001", "http://localhost:3000", "http://localhost:3002", "http://localhost:3003", "http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://127.0.0.1:3003"];

const VIEWPORTS = [
  { key: "desktop", width: 1440, height: 900 },
];
const VIEWPORTS_DEFAULT = [{ key: "desktop", width: 1440, height: 900 }];
const CLICK_TIMEOUT = Number(process.env.CLICK_TIMEOUT_MS || 3000);
const COMPATIBLE_PAGES = new Set(["/stock", "/advanced", "/reassembly"]);
const AUDIT_VIEWPORTS = (process.env.POLISH_VIEWPORTS || process.env.AUDIT_VIEWPORTS || "desktop")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const ACTIVE_VIEWPORTS = AUDIT_VIEWPORTS.length ? VIEWPORTS.filter((viewport) => AUDIT_VIEWPORTS.includes(viewport.key)) : VIEWPORTS_DEFAULT;
const PIPELINE_REPORT_PATH = path.join(ARTIFACT_ROOT, "pipeline", `github-workflows-${DATE}.json`);
const DEFECTS_REPORT_PATH = path.join(ARTIFACT_ROOT, "claude-code-defects.json");

const CONTROL_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="slider"], [role="combobox"], [role="menuitem"], [role="switch"], summary, [draggable="true"]';

const STOP_TOKENS = [
  "nextjs",
  "next.js",
  "open in editor",
  "open-in-editor",
  "copy error",
  "error-overlay",
  "open docs",
  "telemetry",
  "version-staleness",
  "runtime error",
  "component stack",
];

function log(...args) {
  console.log("[audit]", ...args);
}

function nextDefectId(counter) {
  return `DEF-${String(counter[0]).padStart(3, "0")}`;
}

function incrementDefect(counter) {
  counter[0] += 1;
  return counter;
}

function inferSeverity(resultType) {
  if (resultType === "fail") return "P1";
  if (resultType === "warn") return "P2";
  return "P3";
}

function buildEvidencePath(fileName, route, viewportKey, outRoot) {
  if (!fileName) return path.join(outRoot, "screenshots", viewportKey, route);
  return path.join(outRoot, "screenshots", viewportKey, fileName);
}

function addDefect(defects, counter, info) {
  const defect = {
    id: nextDefectId(counter),
    severity: info.severity,
    route: info.route,
    control_or_component: info.controlOrComponent,
    repro_steps: info.reproSteps,
    expected: info.expected,
    actual: info.actual,
    evidence: info.evidence,
    recommendation: info.recommendation,
  };
  defects.push(defect);
  incrementDefect(counter);
}

function evaluatePipelineContract(defects, counter) {
  fs.mkdirSync(path.dirname(PIPELINE_REPORT_PATH), { recursive: true });

  const workflowDir = path.join(process.cwd(), ".github", "workflows");
  if (!fs.existsSync(workflowDir)) {
    addDefect(defects, counter, {
      severity: "P3",
      route: "pipeline",
      control_or_component: "CI workflows",
      reproSteps: [
        "Inspect repository for GitHub Actions workflow directory at .github/workflows.",
        "Run the requested pipeline command sequence.",
      ],
      expected: "CI workflow files for lint, test, build, and ui-audit must exist and be executable.",
      actual: "No .github/workflows directory found.",
      evidence: { artifact: PIPELINE_REPORT_PATH },
      recommendation: "Create .github/workflows/ci.yml with lint/test/build and ui-audit jobs, then re-run the audit.",
    });
    fs.writeFileSync(PIPELINE_REPORT_PATH, JSON.stringify({ total_count: 0, workflows: [] }, null, 2));
    return;
  }

  const workflowFiles = fs
    .readdirSync(workflowDir)
    .filter((item) => item.endsWith(".yml") || item.endsWith(".yaml"))
    .map((item) => path.join(workflowDir, item));

  const allWorkflowText = workflowFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const hasLint = /\bnpm\s+run\s+lint\b/.test(allWorkflowText) || /\bcommand:\s*\[[^\]]*\blint\b/.test(allWorkflowText);
  const hasTest = /\bnpm\s+run\s+test\b/.test(allWorkflowText) || /\bcommand:\s*\[[^\]]*\btest\b/.test(allWorkflowText);
  const hasBuild = /\bnpm\s+run\s+build\b/.test(allWorkflowText) || /\bcommand:\s*\[[^\]]*\bbuild\b/.test(allWorkflowText);
  const hasUiAudit = /\bui-audit\b/.test(allWorkflowText) || /polish-ui-audit/.test(allWorkflowText);
  const hasRun = /npm\s+run\s+/.test(allWorkflowText);

  const workflows = workflowFiles.map((file) => ({
    file: path.basename(file),
    hasLint,
    hasTest,
    hasBuild,
    hasUiAudit,
    hasAnyRun: hasRun,
  }));
  fs.writeFileSync(
    PIPELINE_REPORT_PATH,
    JSON.stringify(
      {
        total_count: workflowFiles.length,
        workflows,
      },
      null,
      2
    )
  );

  if (!hasLint || !hasTest || !hasBuild) {
    addDefect(defects, counter, {
      severity: "P2",
      route: "pipeline",
      control_or_component: "CI command coverage",
      reproSteps: [
        "Review workflow files under .github/workflows.",
        "Verify jobs include npm run lint, npm run test, and npm run build.",
      ],
      expected: "lint/test/build jobs must be present in CI workflow file(s).",
      actual: `Detected workflow presence but missing command jobs: lint=${hasLint}, test=${hasTest}, build=${hasBuild}.`,
      evidence: { artifact: PIPELINE_REPORT_PATH },
      recommendation: "Add jobs or matrix entries in CI so npm run lint, npm run test, and npm run build are executed.",
    });
  }

  if (!hasUiAudit) {
    addDefect(defects, counter, {
      severity: "P3",
      route: "pipeline",
      control_or_component: "UI audit coverage",
      reproSteps: [
        "Review workflow files under .github/workflows.",
        "Verify a non-blocking ui-audit job exists and runs POLISH_VIEWPORTS=desktop.",
      ],
      expected: "UI audit should be executed as a dedicated non-blocking job.",
      actual: "No ui-audit workflow command marker found in workflow files.",
      evidence: { artifact: PIPELINE_REPORT_PATH },
      recommendation: "Add a non-blocking ui-audit job in CI for artifacts and manual review.",
    });
  }
}

function slugify(input) {
  return input
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 160) || "untitled";
}

function routeName(route) {
  if (!route || route === "/") return "home";
  return slugify(route.replace(/^\//, "").replace(/\//g, "--"));
}

function discoverRoutes(appDir) {
  const result = [];

  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("_")) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api" || entry.name === "components") continue;
        if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
          walk(full, prefix);
          continue;
        }
        const nextPrefix = prefix === "/" ? `/${entry.name}` : `${prefix}/${entry.name}`;
        walk(full, nextPrefix);
      } else if (entry.isFile() && entry.name === "page.tsx") {
        result.push(prefix || "/");
      }
    }
  };

  walk(appDir, "/");

  return [...new Set(result)]
    .filter((route) => route !== "/_not-found" && route !== "/api")
    .sort((a, b) => (a.length - b.length) || a.localeCompare(b));
}

function createMockData(runId = "run-audit-001") {
  const prompts = [
    { id: 1, name: "Audit Channel", animation_motion: "cinematic", stock_folder: "Audit Stock", video_style: "documentary", voice_id: "audit-voice-1", voice_provider: "elevenlabs", scene_end_pause_seconds: 2, content: "Audit channel prompt text.", voice_style: "default", voice_speed: 1, voice_stability: 0.6, voice_similarity_boost: 0.7, style_preset_id: "", video_model: "v1", aspect_ratio: "16:9", hybrid_fresh_minutes: 120, description: "", created_at: "2026-01-01" },
    { id: 2, name: "Secondary Channel", animation_motion: "cinematic", stock_folder: "Audit Stock", video_style: "minimal", voice_id: "audit-voice-2", voice_provider: "elevenlabs", scene_end_pause_seconds: 1, content: "Secondary channel text.", voice_style: "default", voice_speed: 1, voice_stability: 0.5, voice_similarity_boost: 0.75, style_preset_id: "", video_model: "v1", aspect_ratio: "16:9", hybrid_fresh_minutes: 90, description: "", created_at: "2026-01-01" },
  ];

  const stockClips = Array.from({ length: 42 }).map((_, idx) => ({
    driveFileId: `clip-audit-${String(idx).padStart(2, "0")}`,
    previewFileId: `preview-audit-${String(idx).padStart(2, "0")}`,
    name: `scene-${String(idx).padStart(2, "0")}.mp4`,
    source: idx % 3 === 0 ? "local" : "drive",
  }));

  return {
    prompts,
    runId,
    run: {
      id: runId,
      title: "Audit Run",
      status: "done",
      folder_name: "audit-run",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:01:00.000Z",
      output_path: `/tmp/conveyer-audit/final.mp4`,
      mode: "hybrid",
      db_status: "done",
      worker_active: false,
      needs_recovery: false,
    },
    runsList: [
      {
        id: runId,
        title: "Audit Run",
        folder_name: "audit-run",
        status: "done",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:01:00.000Z",
        output_path: `/tmp/conveyer-audit/final.mp4`,
      },
    ],
    runAssets: {
      runDir: "/tmp/conveyer-audit",
      mode: "hybrid",
      scenes: [{ index: 0, text: "Hook line", duration_hint_sec: 5, stage: "ok", startMs: 0 }, { index: 1, text: "Body section", duration_hint_sec: 8, stage: "ok", startMs: 5000 }],
      freshScenes: [],
      planSceneCount: 2,
      stockSceneCount: 4,
      freshSceneCount: 2,
      finalExists: true,
      finalSize: 12345678,
      finalOnDisk: true,
      finalNeedsRepair: false,
      oldFinalSize: 0,
      scenePlanHealth: { ok: true, issue: null, sceneCount: 20, avgWords: 11, shortScenes: 0, danglingScenes: 0 },
      progress: { total: 2, rendered: 2, withVideo: 2, withAudio: 2 },
      tail: {
        voiceoverReady: true,
        voiceoverFileReady: true,
        voiceoverPartCount: 2,
        expectedVoiceoverPartCount: 2,
        segmentReady: true,
        renderedClipCount: 4,
      },
      hybridProgress: { freshTotal: 2, freshWithVideo: 2, freshRendered: 2, stockSceneCount: 4 },
      exportQuality: {
        overall: "ready",
        checks: [
          { id: "chunking", label: "Chunking", status: "pass", detail: "Chunks are sentence-safe." },
          { id: "duration", label: "Duration", status: "pass", detail: "Final duration normal." },
          { id: "sync", label: "Sync", status: "warn", detail: "Not synced yet." },
        ],
      },
    },
    runLogs: "event:ready\n\n",
    stockClips,
    settings: { STOCK_LIBRARY_FOLDER: "Audit Stock", GDRIVE_SYNC_ENABLED: "1", GDRIVE_CLIENT_ID: "••••••", GDRIVE_CLIENT_SECRET: "••••••", LABS69_API_KEY: "••••••", LABS69_ACCOUNT_ID: "audit-labs69", VOICE_PROVIDER: "elevenlabs", HYBRID_FRESH_MINUTES: "120", VOICE_DEFAULT_STABILITY: "0.55", VOICE_DEFAULT_SIMILARITY: "0.75", VOICE_DEFAULT_STYLE: "1", REEL_SPEED: "1", ANIMATION_MOTION: "cinematic", VIDEO_STYLE: "documentary", ASYNC_BATCH_SIZE: "2", MAX_PARALLEL_FFMPEG: "2" },
    stats: { keyCount: 4, total: { image: 12, tts: 8, anim: 6 }, assembleConcurrency: 2, xfadeChunks: 1 },
    gdriveStatus: { connected: true, email: "audit@example.com", syncEnabled: true, credentialsConfigured: true, autoUpload: true, syncQueueDepth: 0, syncedRuns: 1 },
    voices: { voices: [{ id: "v1", name: "Audit Voice One", gender: "neutral", previewText: "Hello audit one", provider: "elevenlabs" }, { id: "v2", name: "Audit Voice Two", gender: "female", previewText: "Hello audit two", provider: "elevenlabs" }], saved: [{ id: "sv1", name: "Saved Voice", voice_id: "v1", provider: "elevenlabs" }], current: "v1" },
    libraryRuns: { runs: [{ id: runId, title: "Audit Run", created_at: "2026-01-01T00:00:00.000Z", status: "DONE", output_path: "/tmp/conveyer-audit/final.mp4" }], page: 1, total: 1, pageSize: 20, hasMore: false },
  };
}

function buildMockHandlers(page, data) {
  const patterns = ["**/api/**"];
  const handlers = [];

  const fulfillJson = async (route, body, status = 200) => {
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  };
  const fulfillSvg = async (route) => {
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#202020"/><text x="12" y="50" fill="#fefefe" font-size="12">Audit Preview</text></svg>' });
  };

  const handle = async (route) => {
    try {
      const req = route.request();
      const method = req.method();
      const pathname = new URL(req.url()).pathname;

      if (!pathname.startsWith("/api/")) return route.continue();
      if (pathname === "/api/preflight") {
        await fulfillJson(route, { ok: true, ffmpeg: { ok: true }, elevenlabs: { ok: true }, anthropic: { ok: true }, warnings: [] });
        return;
      }
      if (pathname === "/api/settings" || pathname === "/api/settings/") {
        await fulfillJson(route, data.settings);
        return;
      }
      if (pathname === "/api/prompt-presets" && method === "GET") {
        await fulfillJson(route, data.prompts);
        return;
      }
      if (/^\/api\/prompt-presets\/\d+/.test(pathname) && method === "GET") {
        await fulfillJson(route, data.prompts[0]);
        return;
      }
      if (pathname === "/api/stock/list" || pathname === "/api/stock/list/") {
        await fulfillJson(route, { clips: data.stockClips, localFolders: [{ folder: "Audit Stock", count: 42 }] });
        return;
      }
      if (pathname === "/api/stock/delete") {
        await fulfillJson(route, { ok: true, deleted: 1, failed: 0, localDeleted: 0, errors: [] });
        return;
      }
      if (pathname === "/api/stock/generate") {
        await fulfillJson(route, { running: false, total: 2, done: 2, failed: 0, folder: "Audit Stock" });
        return;
      }
      if (pathname.startsWith("/api/stock/poster")) {
        await fulfillSvg(route);
        return;
      }
      if (pathname.startsWith("/api/stock/file")) {
        await route.fulfill({ status: 200, contentType: "video/mp4", body: new Uint8Array(0) });
        return;
      }
      if (pathname === "/api/voices" || pathname === "/api/voices/") {
        await (method === "POST" ? fulfillJson(route, { ok: true, id: "saved-1" }) : fulfillJson(route, data.voices));
        return;
      }
      if (pathname === "/api/voices/saved") {
        await (method === "DELETE" ? fulfillJson(route, { ok: true }) : fulfillJson(route, data.voices.saved));
        return;
      }
      if (pathname === "/api/voices/test") {
        await fulfillJson(route, { ok: true, duration: 1.2, sampleUrl: "data:audio/wav;base64," });
        return;
      }
      if (pathname === "/api/stats") {
        await fulfillJson(route, data.stats);
        return;
      }
      if (pathname === "/api/gdrive/status") {
        await fulfillJson(route, data.gdriveStatus);
        return;
      }
      if (pathname === "/api/runs") {
        await (method === "POST" ? fulfillJson(route, { id: data.runId, folderName: "audit-run" }) : fulfillJson(route, data.runsList));
        return;
      }
      if (pathname.startsWith("/api/library/runs")) {
        await fulfillJson(route, data.libraryRuns);
        return;
      }

      const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)(\/?.*)?$/);
      if (runDetailMatch) {
        const suffix = runDetailMatch[2] || "";
        if (!suffix || suffix === "/") {
          await fulfillJson(route, { run: data.run, logs: [], needs_recovery: false });
          return;
        }
        if (suffix === "/assets") {
          await fulfillJson(route, data.runAssets);
          return;
        }
        if (suffix === "/logs") {
          await route.fulfill({ status: 200, contentType: "text/event-stream", body: data.runLogs });
          return;
        }
        if (suffix === "/file") {
          await route.fulfill({ status: 200, contentType: "video/mp4", headers: { "Content-Disposition": 'inline; filename="final.mp4"' }, body: new Uint8Array(0) });
          return;
        }
        if (["/cancel", "/reassemble", "/open-folder", "/drive"].includes(suffix) && method === "POST") {
          await fulfillJson(route, { ok: true });
          return;
        }
      }

      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mocked: true, pathname }) });
    } catch (err) {
      await route.fulfill({ status: 500, contentType: "text/plain", body: `mock failed: ${String(err)}` });
    }
  };

  for (const pattern of patterns) {
    page.route(pattern, handle);
    handlers.push(pattern);
  }

  return { cleanup: async () => {
    for (const pattern of handlers) {
      await page.unroute(pattern).catch(() => {});
    }
  }};
}

async function detectBaseUrl() {
  const check = (candidate) =>
    new Promise((resolve) => {
      const client = candidate.startsWith("https:") ? https : http;
      const req = client.get(candidate, { timeout: 2000 }, (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          chunks += chunk;
          if (chunks.length > 2048) res.destroy();
        });
        res.on("error", () => resolve({ ok: false }));
        res.on("close", () => {
          resolve({ ok: res.statusCode === 200 || res.statusCode === 404, html: chunks });
        });
        res.on("end", () => {
          resolve({ ok: res.statusCode === 200 || res.statusCode === 404, html: chunks });
        });
      });
      req.on("error", () => resolve({ ok: false }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false });
      });
    });

  for (const candidate of BASE_CANDIDATES) {
    try {
      const { ok, html } = await check(candidate);
      if (!ok) continue;
      if (/Conveyer Hum|conveyer|next/i.test(html || "")) return candidate;
    } catch {
      // ignore
    }
  }
  throw new Error(`No running app found on ${BASE_CANDIDATES.join(", ")}`);
}

function isOverlayLike(label, attrs) {
  if (!label && !attrs) return false;
  const haystack = `${label || ""} ${attrs || ""}`.toLowerCase();
  return STOP_TOKENS.some((token) => haystack.includes(token));
}

function cssPath(el) {
  const getIndex = (node, nodeName) => {
    let i = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === nodeName) i += 1;
      sibling = sibling.previousElementSibling;
    }
    return i;
  };

  const segments = [];
  let current = el;
  while (current && current.nodeType === 1 && current.tagName && segments.length < 7) {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      segments.unshift(`${tag}#${current.id}`);
      break;
    }
    const idx = getIndex(current, current.tagName);
    segments.unshift(`${tag}:nth-of-type(${idx})`);
    current = current.parentElement;
  }
  return segments.join(" > ");
}

async function safeGetAttribute(locator, name) {
  try {
    return await locator.getAttribute(name);
  } catch {
    return null;
  }
}

function quoteForContainsSelector(text) {
  return (text || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function quoteForCssEquals(value) {
  return (value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveLocator(page, control, indexFallback) {
  const fallback = page.locator(CONTROL_SELECTOR).nth(indexFallback);
  const candidates = [];
  if (control.path) candidates.push(page.locator(control.path).first());
  if (control.tag === "A" && control.name) {
    candidates.push(page.locator(`a:has-text("${quoteForContainsSelector(control.name)}")`).first());
    candidates.push(page.locator(`a[href="${quoteForCssEquals(control.href || "")}"]`).first());
  }
  if (control.tag === "BUTTON" && control.name) {
    candidates.push(page.locator(`button:has-text("${quoteForContainsSelector(control.name)}")`).first());
    candidates.push(page.locator(`button[aria-label="${quoteForCssEquals(control.name)}"]`).first());
    candidates.push(page.locator(`button[title="${quoteForCssEquals(control.name)}"]`).first());
  }
  if (control.tag === "SUMMARY" && control.name) {
    candidates.push(page.locator(`summary:has-text("${quoteForContainsSelector(control.name)}")`).first());
  }
  candidates.push(fallback);

  for (const candidate of candidates) {
    if ((await candidate.count()) > 0 && (await candidate.first().isVisible().catch(() => false))) {
      return candidate.first();
    }
  }

  return fallback;
}

async function setInputValue(locator, value) {
  try {
    await locator.evaluate((el, nextValue) => {
      const asString = String(nextValue ?? "");
      el.value = asString;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value);
    return;
  } catch {
    try {
      await locator.fill(String(value ?? ""));
      return;
    } catch {
      await locator
        .evaluate((el, nextValue) => {
          const asString = String(nextValue ?? "");
          el.value = asString;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, value)
        .catch(() => {});
    }
  }
}

async function runRouteAudit(page, route, baseUrl, viewportKey, outBase, matrix, sampleRunId, defects, defectCounter) {
  const outRoute = path.join(outBase, routeName(route));
  fs.mkdirSync(outRoute, { recursive: true });

  const target = route.includes("[id]") ? route.replace("[id]", sampleRunId) : route;
  const routeUrl = `${baseUrl}${target}`;
  const state = { route, target, controls: [], errors: [] };

  const shot = async (name) => {
    await page.screenshot({ path: path.join(outRoute, `${viewportKey}-${slugify(name)}.png`), fullPage: true });
  };

  let navigatedTo = null;
  try {
    await page.goto(routeUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 9000 });
    await page.waitForTimeout(350);
    navigatedTo = new URL(page.url()).pathname;
    await shot(`${routeName(route)}-baseline`);
  } catch (error) {
    state.errors.push({ control: "route-entry", type: "navigation", result: "fail", error: String(error) });
    addDefect(defects, defectCounter, {
      severity: "P1",
      route,
      controlOrComponent: "Route entry",
      reproSteps: [
        `Open ${routeUrl}`,
        `Wait for route to finish baseline load`,
      ],
      expected: "Route should render and report body content within timeout.",
      actual: String(error),
      evidence: {
        logs: path.join(ARTIFACT_ROOT, "ui-audit-matrix.json"),
      },
      recommendation: "Inspect route initialization and mock handlers; fix blocking script/runtime errors on startup.",
    });
    matrix.push(state);
    return;
  }

  const routeControls = await page.$$eval(CONTROL_SELECTOR, (nodes) =>
    nodes
      .map((el, index) => {
        if (!(el instanceof Element)) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return null;
        const tag = el.tagName;
        const role = el.getAttribute("role") || "";
        const text = (el.textContent || "").trim().slice(0, 120);
        const name = (el.getAttribute("aria-label") || el.getAttribute("title") || text || "").trim().slice(0, 120);
        const placeholder = el.getAttribute("placeholder") || "";
        const id = el.getAttribute("id") || "";
        const type = (el.getAttribute("type") || "").toLowerCase();
        const href = el.getAttribute("href") || "";
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        const disabled = !!el.disabled;
        const draggable = el.getAttribute("draggable") || "";
        const className = `${el.className || ""}`.toLowerCase();
        const labelBlob = `${tag} ${role} ${text} ${name} ${placeholder} ${id} ${className} ${ariaLabel} ${title} ${href}`.toLowerCase();

        const isOverlay = /(nextjs|next\.js|open in editor|open-in-editor|copy error|open docs|telemetry|version-staleness|runtime error|component stack)/.test(labelBlob);
        const isDevShell = el.closest(".nextjs-portal") || el.closest("[class*='nextjs-']") || el.closest("[data-nextjs-]") || /nextjs|next-js/i.test(className);
        if (isOverlay || isDevShell) return null;

          return {
            index,
            tag,
            role,
            type,
            text,
            name,
            className,
            id,
            placeholder,
            href,
            disabled,
            draggable,
          path: (() => {
            const getIndex = (node, nodeName) => {
              let i = 1;
              let sibling = node.previousElementSibling;
              while (sibling) {
                if (sibling.tagName === nodeName) i += 1;
                sibling = sibling.previousElementSibling;
              }
              return i;
            };
            const out = [];
            let current = el;
            while (current && current.nodeType === 1 && out.length < 7) {
              const tagName = current.tagName.toLowerCase();
              if (current.id) {
                out.unshift(`${tagName}#${current.id}`);
                break;
              }
              const idx = getIndex(current, current.tagName);
              out.unshift(`${tagName}:nth-of-type(${idx})`);
              current = current.parentElement;
            }
            return out.join(" > ");
          })(),
        };
      })
      .filter(Boolean)
  );

  const filtered = routeControls.filter((control) => {
    if (control.disabled) return false;
    if (control.tag === "A" && !control.href) return false;
    if (isOverlayLike(control.name, `${control.text} ${control.placeholder} ${control.className || ""} ${control.href || ""}`)) return false;
    if (control.tag === "INPUT" && control.type === "checkbox" && !control.name && !control.text && !control.placeholder && !control.id) return false;
    return true;
  });

  const seen = new Set();
  let seq = 0;

  for (const control of filtered) {
    const key = `${control.tag}|${control.type}|${control.name}|${control.text}|${control.id}|${control.href}|${control.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seq += 1;

    const shotSuffix = (seq - 1).toString().padStart(2, "0");
    const beforeFile = `${routeName(route)}-${shotSuffix}-before`;
    const afterFile = `${routeName(route)}-${shotSuffix}-after`;

    const entry = {
      seq,
      control: {
        type: control.tag,
        id: control.id || null,
        role: control.role || null,
        name: control.name || control.text || control.placeholder || control.id || null,
      },
      route,
      expected: "Action should be deterministic or produce a visible non-blocking state change.",
      result: "pass",
      before: path.join(routeName(route), `${viewportKey}-${slugify(`${beforeFile}.png`)}`),
      after: path.join(routeName(route), `${viewportKey}-${slugify(`${afterFile}.png`)}`),
    };

    try {
      await shot(beforeFile);
      if (await page.url() !== routeUrl) {
        await page.goto(routeUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      } else {
        await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 9000 }).catch(() => {});
      }

      let locator = await resolveLocator(page, control, control.index);

      if ((await locator.count()) === 0) {
        entry.result = "warn";
        entry.notes = "Control skipped: selector unresolved";
        const evidence = {
          viewport: viewportKey,
          before: buildEvidencePath(entry.before, routeName(route), viewportKey, ARTIFACT_ROOT),
        };
        addDefect(defects, defectCounter, {
          severity: "P2",
          route,
          controlOrComponent: `${entry.control.type} ${entry.control.name || ""}`.trim(),
          reproSteps: [
            `Open ${routeUrl}.`,
            "Attempt to locate control using stable audit selectors.",
            "No interaction run if locator resolution fails.",
          ],
          expected: "Control should resolve to an interactive element.",
          actual: entry.notes,
          evidence,
          recommendation: "Stabilize the selector or remove non-deterministic repeated controls from the audit set.",
        });
        state.controls.push(entry);
        continue;
      }
      if ((await locator.isVisible().catch(() => false)) === false) {
        entry.result = "warn";
        entry.notes = "Control skipped: not visible";
        const evidence = {
          viewport: viewportKey,
          before: buildEvidencePath(entry.before, routeName(route), viewportKey, ARTIFACT_ROOT),
        };
        addDefect(defects, defectCounter, {
          severity: "P2",
          route,
          controlOrComponent: `${entry.control.type} ${entry.control.name || ""}`.trim(),
          reproSteps: [
            `Open ${routeUrl}.`,
            "Attempt to confirm control is visible in baseline viewport.",
            "No interaction run when control is hidden.",
          ],
          expected: "Control should be visible for interaction.",
          actual: entry.notes,
          evidence,
          recommendation: "Check conditional visibility and provide deterministic test-state visibility.",
        });
        state.controls.push(entry);
        continue;
      }

      if (control.tag === "A") {
        const href = control.href || "";
        const isExternal = /^https?:\/\//i.test(href) && !href.startsWith(baseUrl);
        if (isExternal) {
          const attrs = await locator.evaluate((el) => ({ href: el.href, target: el.target || "", rel: el.rel || "" }));
          entry.result = attrs.href ? "pass" : "warn";
          entry.notes = `External/absolute link observed: ${attrs.href || "missing href"}`;
        } else {
          const beforeUrl = page.url();
          await locator.click({ timeout: CLICK_TIMEOUT, noWaitAfter: true });
          await page.waitForTimeout(350);
          const afterUrl = page.url();
          entry.notes = afterUrl !== beforeUrl ? `Navigated from ${beforeUrl} to ${afterUrl}` : "No immediate navigation";
          if (afterUrl !== beforeUrl) {
            await page.goto(routeUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
          }
        }
      } else if (control.tag === "BUTTON" || control.role === "button" || control.role === "tab" || control.role === "checkbox" || control.role === "radio") {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        if (control.role === "tab") {
          await locator.click({ timeout: CLICK_TIMEOUT });
        } else if (control.role === "checkbox" || control.role === "radio") {
          await locator.click({ timeout: CLICK_TIMEOUT });
        } else {
          await locator.click({ timeout: CLICK_TIMEOUT, force: true });
        }
        await page.waitForTimeout(180);
      } else if (control.tag === "SUMMARY") {
        await locator.click({ timeout: CLICK_TIMEOUT, force: true });
        await page.waitForTimeout(160);
      } else if (control.tag === "INPUT") {
        if (control.type === "range") {
          const min = Number(await locator.getAttribute("min") || 0);
          const max = Number(await locator.getAttribute("max") || 100);
          const mid = Math.round((min + max) / 2);
          await setInputValue(locator, String(min));
          await page.waitForTimeout(90);
          await setInputValue(locator, String(max));
          await page.waitForTimeout(90);
          await setInputValue(locator, String(mid));
          entry.notes = `Range moved min→max→mid (${min}→${max}→${mid})`;
        } else if (control.type === "checkbox") {
          await locator.check({ timeout: CLICK_TIMEOUT }).catch(() => locator.click({ timeout: CLICK_TIMEOUT }));
          await locator.uncheck({ timeout: CLICK_TIMEOUT }).catch(() => locator.click({ timeout: CLICK_TIMEOUT }));
        } else if (control.type === "file") {
          const tmp = path.join(process.cwd(), "artifacts", "tmp-upload-dummy.txt");
          fs.mkdirSync(path.dirname(tmp), { recursive: true });
          fs.writeFileSync(tmp, "audit artifact");
          await locator.setInputFiles(tmp).catch(() => {});
          await page.waitForTimeout(120);
          entry.notes = "Attached dummy file";
        } else if (control.type === "number") {
          await setInputValue(locator, "12");
          await page.waitForTimeout(90);
          await setInputValue(locator, "34");
          await page.waitForTimeout(90);
          await setInputValue(locator, "");
          await page.waitForTimeout(90);
        } else {
          await setInputValue(locator, "audit text");
          await setInputValue(locator, "a");
          await locator.blur().catch(() => {});
          await setInputValue(locator, "");
          await page.waitForTimeout(90);
          await locator.blur().catch(() => {});
          entry.notes = "Text field cycled through short and empty values";
        }
      } else if (control.tag === "TEXTAREA") {
        await setInputValue(locator, "Audit text");
        await page.waitForTimeout(90);
        await setInputValue(locator, "");
        await page.waitForTimeout(90);
      } else if (control.tag === "SELECT") {
        const optionCount = await locator.locator("option").count();
        if (optionCount > 1) {
          await locator.selectOption({ index: 1 });
          await page.waitForTimeout(90);
          if (optionCount > 2) await locator.selectOption({ index: Math.min(2, optionCount - 1) });
        }
      }

      if (control.draggable === "true" || (await safeGetAttribute(locator, "draggable")) === "true") {
        const box = await locator.boundingBox();
        if (box) {
          const centerX = box.x + box.width / 2;
          const centerY = box.y + box.height / 2;
          await page.mouse.move(centerX, centerY);
          await page.mouse.down();
          await page.mouse.move(centerX + Math.min(80, Math.max(40, box.width) + 20), centerY);
          await page.mouse.up();
          await page.mouse.move(centerX, centerY);
          await page.mouse.down();
          await page.mouse.move(centerX - Math.min(80, Math.max(40, box.width) + 20), centerY);
          await page.mouse.up();
          entry.notes = `${entry.notes || ""} | dragged handle both directions`;
        }
      }

      if (seq === 1 && await locator.isVisible().catch(() => false)) {
        await locator.click({ button: "right", timeout: CLICK_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(110);
        await page.keyboard.press("Escape").catch(() => {});
        entry.notes = `${entry.notes || ""} | context menu smoke attempt`;
      }
    } catch (err) {
      entry.result = "fail";
      entry.error = String(err instanceof Error ? err.message : err);
    }

    if (entry.result !== "pass") {
      const evidence = {
        viewport: viewportKey,
        before: buildEvidencePath(entry.before, routeName(route), viewportKey, ARTIFACT_ROOT),
        after: buildEvidencePath(entry.after, routeName(route), viewportKey, ARTIFACT_ROOT),
      };
      addDefect(defects, defectCounter, {
        severity: inferSeverity(entry.result),
        route,
        controlOrComponent: `${entry.control.type} ${entry.control.name || ""}`.trim(),
        reproSteps: [
          `Open ${routeUrl}.`,
          `Interact with control #${seq} and capture before/after screenshots.`,
          "Observe for deterministic visual or state transitions.",
        ],
        expected: entry.expected,
        actual: entry.error || entry.notes || `Control result was ${entry.result}.`,
        evidence,
        recommendation: "Fix control interaction path and avoid partial state that blocks deterministic interaction.",
      });
    }

    await shot(afterFile);
    state.controls.push(entry);
  }

  try {
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return Math.max(0, root.scrollWidth - root.clientWidth);
    });
    if (overflow > 2) {
      state.errors.push({ control: "polish", type: "overflow", result: "fail", details: `${overflow}px overflow` });
      addDefect(defects, defectCounter, {
        severity: "P2",
        route,
        controlOrComponent: "Viewport overflow",
        reproSteps: [
          "Open route in baseline state.",
          "Evaluate document root scroll/visible widths.",
        ],
        expected: "No horizontal overflow beyond viewport width on desktop.",
        actual: `${overflow}px overflow reported from root scroll width calculation.`,
        evidence: {
          viewport: viewportKey,
          screenshot: buildEvidencePath(path.join(routeName(route), `${viewportKey}-${slugify(`${routeName(route)}-baseline`)}.png`), routeName(route), viewportKey, ARTIFACT_ROOT),
        },
        recommendation: "Limit fixed-width content and add responsive constraints to prevent horizontal overflow.",
      });
    }
    state.overflow = overflow;
  } catch {
    // ignore
  }

  if (routeControls.length !== filtered.length) {
    state.skippedControls = routeControls.length - filtered.length;
  }
  if (navigatedTo && navigatedTo !== target && navigatedTo !== routeUrl.replace(baseUrl, "") && !COMPATIBLE_PAGES.has(route)) {
    state.errors.push({ control: "route-entry", type: "redirect", result: "warn", details: `${routeUrl} redirected to ${navigatedTo}` });
    addDefect(defects, defectCounter, {
      severity: "P2",
      route,
      controlOrComponent: "Route entry",
      reproSteps: [
        `Open ${routeUrl}.`,
        `Compare pathname after navigation to expected ${target}.`,
      ],
      expected: "Routes should remain on their entry URL unless intentionally redirected.",
      actual: `${routeUrl} redirected to ${navigatedTo}.`,
      evidence: {
        viewport: viewportKey,
        screenshot: buildEvidencePath(path.join(routeName(route), `${viewportKey}-${slugify(`${routeName(route)}-baseline`)}.png`), routeName(route), viewportKey, ARTIFACT_ROOT),
      },
      recommendation: "Avoid non-essential redirects during route-entry to keep discovery-based audit stable.",
    });
  }

  matrix.push(state);
}

function existsFileCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile()).length;
  } catch {
    return 0;
  }
}

async function run() {
  const baseUrl = (await detectBaseUrl()).replace(/\/$/, "");
  const appDir = path.resolve(process.cwd(), "src", "app");
  const routes = discoverRoutes(appDir).filter((route) => !route.startsWith("/api"));
  const outRoot = ARTIFACT_ROOT;
  const defects = [];
  const defectCounter = [1];
  fs.mkdirSync(outRoot, { recursive: true });

  log("Base URL:", baseUrl);
  log("Discovered routes:", routes.join(", "));

  const browser = await chromium.launch({ headless: true, args: ["--disable-extensions"] });
  const allResults = {
    startedAt: new Date().toISOString(),
    reportDate: DATE,
    baseUrl,
    routes,
    viewports: {},
  };
  const data = createMockData("run-audit-001");
  const sampleRunId = "run-audit-001";
  if (ACTIVE_VIEWPORTS.length === 0) {
    throw new Error(`No matching viewport keys in POLISH_VIEWPORTS/AUDIT_VIEWPORTS. Use desktop,mobile`);
  }

  evaluatePipelineContract(defects, defectCounter);

  try {
    for (const viewport of ACTIVE_VIEWPORTS) {
      const outScreens = path.join(outRoot, "screenshots", viewport.key);
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: viewport.key === "mobile" ? "light" : "dark" });
      const page = await context.newPage();

      page.setDefaultTimeout(12000);
      page.setDefaultNavigationTimeout(18000);
      const logs = [];
      const requests = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") logs.push(`console:${msg.text()}`);
      });
      page.on("requestfailed", (req) => {
        if (req.url().startsWith(baseUrl)) {
          const reason = req.failure()?.errorText || "unknown";
          requests.push(`requestfailed:${req.method()} ${req.url()} ${reason}`);
        }
      });
      page.on("popup", async (popup) => {
        await popup.close().catch(() => {});
      });

      allResults.viewports[viewport.key] = { routeCount: routes.length, controls: [], screenshotSummary: [], consoleIssues: [], requestFailures: [] };

      const api = buildMockHandlers(page, data);

      for (const route of routes) {
        const matrix = [];
        try {
          await runRouteAudit(page, route, baseUrl, viewport.key, outScreens, matrix, sampleRunId, defects, defectCounter);
        } catch (err) {
          matrix.push({ route, target: route, controls: [], errors: [{ control: "route-run", type: "runner", result: "fail", error: String(err) }] });
          addDefect(defects, defectCounter, {
            severity: "P1",
            route,
            controlOrComponent: "Route audit runner",
            reproSteps: [`Run audit function for ${route}.`, "Capture failure and continue to remaining routes."],
            expected: "Route audit loop should complete without unhandled exception.",
            actual: String(err),
            evidence: { route },
            recommendation: "Protect interaction flow with additional state guards and recover to route base URL.",
          });
          await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
        }
        allResults.viewports[viewport.key].controls.push(...matrix);
      }

      await api.cleanup();
      await context.close();

      const screenshotSummary = routes.map((route) => {
        const dirName = routeName(route);
        const dir = path.join(outRoot, "screenshots", viewport.key, dirName);
        return {
          route,
          dir,
          exists: fs.existsSync(dir),
          fileCount: existsFileCount(dir),
        };
      });
      allResults.viewports[viewport.key].screenshotSummary = screenshotSummary;
      allResults.viewports[viewport.key].consoleIssues = logs;
      allResults.viewports[viewport.key].requestFailures = requests;
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(outRoot, "ui-audit-matrix.json"), JSON.stringify(allResults, null, 2));
  fs.writeFileSync(DEFECTS_REPORT_PATH, JSON.stringify(defects, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
