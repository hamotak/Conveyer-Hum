#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATE_BASE_URLS = process.env.BASE_URL
  ? [process.env.BASE_URL]
  : ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"];
const OUT_DIR = process.env.OUT_DIR || "";

if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

const scenarios = [
  {
    id: "audit-paused",
    title: "Audit Paused Run",
    kind: "paused",
    action: "resume",
    run: {
      status: "paused",
      output_path: null,
    },
    assets: buildAssets({
      finalExists: false,
      recovery: {
        paused: true,
        canResume: true,
        openingReady: false,
        tailVoiceReady: false,
        tailSegmentReady: false,
        finalReady: false,
        nextAction: "resume",
      },
    }),
    drive: null,
  },
  {
    id: "audit-assemble",
    title: "Audit Assemble Run",
    kind: "paused-assemble-ready",
    action: "assemble",
    run: {
      status: "paused",
      output_path: null,
    },
    assets: buildAssets({
      finalExists: false,
      tail: {
        voiceoverReady: true,
        voiceoverFileReady: true,
        voiceoverPartCount: 2,
        expectedVoiceoverPartCount: 2,
        segmentReady: true,
        renderedClipCount: 8,
      },
      progress: { total: 2, rendered: 2, withVideo: 2, withAudio: 2 },
      hybridProgress: {
        freshTotal: 2,
        freshWithVideo: 2,
        freshRendered: 2,
        stockSceneCount: 8,
      },
      recovery: {
        paused: true,
        canResume: true,
        openingReady: true,
        tailVoiceReady: true,
        tailSegmentReady: true,
        finalReady: false,
        nextAction: "resume",
      },
    }),
    drive: null,
  },
  {
    id: "audit-needs-repair",
    title: "Audit Needs Repair Run",
    kind: "needs-repair",
    action: "repair",
    run: {
      status: "done",
      output_path: "/mock/audit-needs-repair/final.mp4",
    },
    assets: buildAssets({
      finalExists: false,
      finalSize: 0,
      finalOnDisk: true,
      finalNeedsRepair: true,
      oldFinalSize: 38 * 1024 * 1024,
      scenePlanHealth: {
        ok: false,
        issue: "tiny_chunks",
        sceneCount: 64,
        avgWords: 3.2,
        shortScenes: 51,
        danglingScenes: 18,
      },
      exportQuality: {
        overall: "blocked",
        checks: [
          {
            id: "chunking",
            label: "Chunking",
            status: "fail",
            detail: "Old tiny chunks detected; repair before export.",
          },
          { id: "duration", label: "Duration", status: "pending", detail: "Waiting for rebuilt final." },
          { id: "sync", label: "Sync", status: "pending", detail: "Waiting for rebuilt final." },
          { id: "watermark", label: "Watermark", status: "pending", detail: "Waiting for rebuilt final." },
        ],
      },
      recovery: {
        paused: false,
        canResume: true,
        openingReady: true,
        tailVoiceReady: true,
        tailSegmentReady: true,
        finalReady: false,
        nextAction: "repair",
      },
    }),
    drive: {
      syncEnabled: true,
      connected: true,
      synced: false,
      canRetry: true,
      rawClipsRemainCount: 3,
    },
  },
  {
    id: "audit-done",
    title: "Audit Done Run",
    kind: "done",
    action: "done-drive",
    run: {
      status: "done",
      output_path: "/mock/audit-done/final.mp4",
    },
    assets: buildAssets({
      finalExists: true,
      finalSize: 52 * 1024 * 1024,
      finalOnDisk: true,
      finalNeedsRepair: false,
      recovery: {
        paused: false,
        canResume: false,
        openingReady: true,
        tailVoiceReady: true,
        tailSegmentReady: true,
        finalReady: true,
        nextAction: "download",
      },
    }),
    drive: {
      syncEnabled: true,
      connected: true,
      synced: true,
      syncedAt: "2026-05-31T09:00:00.000Z",
      finalVideoLink: "https://drive.google.com/file/d/audit-final/view",
      clipsFolderLink: "https://drive.google.com/drive/folders/audit-clips",
      canRetry: true,
      rawClipsRemainCount: 3,
    },
  },
  {
    id: "audit-done-cleaned",
    title: "Audit Done Cleaned Run",
    kind: "done-cleaned",
    action: "done-drive-cleaned",
    run: {
      status: "done",
      output_path: "/mock/audit-done-cleaned/final.mp4",
    },
    assets: buildAssets({
      finalExists: true,
      finalSize: 52 * 1024 * 1024,
      finalOnDisk: true,
      finalNeedsRepair: false,
      recovery: {
        paused: false,
        canResume: false,
        openingReady: true,
        tailVoiceReady: true,
        tailSegmentReady: true,
        finalReady: true,
        nextAction: "download",
      },
    }),
    drive: {
      syncEnabled: true,
      connected: true,
      synced: true,
      syncedAt: "2026-05-31T09:00:00.000Z",
      finalVideoLink: "https://drive.google.com/file/d/audit-final/view",
      clipsFolderLink: "https://drive.google.com/drive/folders/audit-clips",
      canRetry: false,
      rawClipsRemainCount: 0,
    },
  },
  {
    id: "audit-unsynced",
    title: "Audit Unsynced Run",
    kind: "unsynced",
    action: "upload-drive",
    run: {
      status: "done",
      output_path: "/mock/audit-unsynced/final.mp4",
    },
    assets: buildAssets({
      finalExists: true,
      finalSize: 49 * 1024 * 1024,
      finalOnDisk: true,
      finalNeedsRepair: false,
      recovery: {
        paused: false,
        canResume: false,
        openingReady: true,
        tailVoiceReady: true,
        tailSegmentReady: true,
        finalReady: true,
        nextAction: "download",
      },
    }),
    drive: {
      syncEnabled: true,
      connected: true,
      synced: false,
      canRetry: true,
      rawClipsRemainCount: 3,
    },
  },
];

const baseUrl = await resolveBaseUrl();
const errors = [];
const steps = [];
const requests = [];

const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 1360, height: 940 },
  colorScheme: "dark",
});

try {
  for (const scenario of scenarios) {
    await runScenario(context, scenario);
  }
} finally {
  await browser.close();
}

const report = {
  baseUrl,
  scenarios: steps,
  requests,
  errors,
  ok: errors.length === 0,
};

if (OUT_DIR) {
  fs.writeFileSync(path.join(OUT_DIR, "ui-run-actions-audit.json"), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
process.exit(errors.length === 0 ? 0 : 1);

function buildAssets(overrides = {}) {
  const finalExists = overrides.finalExists ?? false;
  const finalSize = overrides.finalSize ?? 0;
  const base = {
    runDir: path.join(os.tmpdir(), "conveyer-hum-ui-audit"),
    mode: "hybrid",
    scenes: [
      {
        index: 0,
        text: "A clean opening beat introduces the topic.",
        duration_hint_sec: 6,
        stage: "pending",
      },
      {
        index: 1,
        text: "The second beat gives the viewer a concrete hook.",
        duration_hint_sec: 6,
        stage: "pending",
      },
    ],
    freshScenes: [],
    planSceneCount: 10,
    stockSceneCount: 8,
    freshSceneCount: 2,
    finalExists,
    finalSize,
    finalOnDisk: finalExists,
    finalNeedsRepair: false,
    oldFinalSize: 0,
    tail: {
      voiceoverReady: false,
      voiceoverFileReady: false,
      voiceoverPartCount: 0,
      expectedVoiceoverPartCount: 2,
      segmentReady: false,
      renderedClipCount: 0,
    },
    progress: { total: 2, rendered: 0, withVideo: 0, withAudio: 0 },
    hybridProgress: {
      freshTotal: 2,
      freshWithVideo: 0,
      freshRendered: 0,
      stockSceneCount: 8,
    },
    recovery: {
      paused: false,
      canResume: false,
      openingReady: false,
      tailVoiceReady: false,
      tailSegmentReady: false,
      finalReady: finalExists,
      nextAction: finalExists ? "download" : "inspect",
    },
    scenePlanHealth: {
      ok: true,
      issue: null,
      sceneCount: 10,
      avgWords: 11.5,
      shortScenes: 0,
      danglingScenes: 0,
    },
    exportQuality: {
      overall: finalExists ? "ready" : "pending",
      checks: [
        { id: "chunking", label: "Chunking", status: "pass", detail: "Scene chunks are sentence-safe." },
        {
          id: "duration",
          label: "Duration",
          status: finalExists ? "pass" : "pending",
          detail: finalExists ? "Final export exists." : "Waiting for final export.",
        },
        {
          id: "sync",
          label: "Sync",
          status: finalExists ? "warn" : "pending",
          detail: finalExists ? "Sync proof is checked separately." : "Waiting for final export.",
        },
        {
          id: "watermark",
          label: "Watermark",
          status: finalExists ? "pass" : "pending",
          detail: finalExists ? "Cleanup completed." : "Waiting for cleanup.",
        },
      ],
    },
    syncReport: finalExists ? { totalSec: 120, freshMaxDriftSec: 0.05, continuousTail: true } : null,
  };

  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function resolveBaseUrl() {
  for (const candidate of CANDIDATE_BASE_URLS) {
    if (await canReach(candidate)) return candidate.replace(/\/$/, "");
  }
  throw new Error(
    `No running Conveyer Hum app found. Start it with npm run dev, then retry with BASE_URL set if needed. Tried: ${CANDIDATE_BASE_URLS.join(", ")}`
  );
}

async function launchBrowser() {
  const channels = process.env.PLAYWRIGHT_CHANNEL ? [process.env.PLAYWRIGHT_CHANNEL] : [undefined, "chrome"];
  const failures = [];
  for (const channel of channels) {
    try {
      const options = {
        headless: process.env.HEADLESS !== "0",
        args: ["--disable-extensions"],
      };
      if (channel) options.channel = channel;
      return await chromium.launch(options);
    } catch (err) {
      failures.push(`${channel || "bundled chromium"}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Could not launch a Playwright browser.\n${failures.join("\n")}`);
}

async function canReach(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status >= 500) return false;
    const html = await response.text();
    return /Conveyer Hum|conveyer-hum/i.test(html);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(context, scenario) {
  const page = await context.newPage();
  const state = {
    reassembleCalls: 0,
    drivePosts: 0,
    fileRequests: [],
    drive: scenario.drive ? { ...scenario.drive } : null,
  };
  const localErrors = [];
  let browserDialogCount = 0;

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/hydration-mismatch/i.test(text) && /caret-color/i.test(text)) return;
    localErrors.push(`console: ${text}`);
  });
  page.on("pageerror", (err) => localErrors.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (!url.startsWith(baseUrl)) return;
    const reason = req.failure()?.errorText ?? "";
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(reason)) return;
    localErrors.push(`requestfailed: ${req.method()} ${url} ${reason}`.trim());
  });
  page.on("dialog", async (dialog) => {
    browserDialogCount++;
    localErrors.push(`browser dialog used: ${dialog.type()} ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });

  await page.addInitScript(() => {
    class AuditEventSource {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.listeners = new Map();
        setTimeout(() => this.dispatch("open", new Event("open")), 0);
      }
      addEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      removeEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        this.listeners.set(type, list.filter((item) => item !== listener));
      }
      dispatch(type, event) {
        for (const listener of this.listeners.get(type) || []) listener.call(this, event);
        const handler = this[`on${type}`];
        if (typeof handler === "function") handler.call(this, event);
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = AuditEventSource;
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    requests.push(`${scenario.id} ${req.method()} ${url.pathname}${url.search}`);

    if (!url.pathname.startsWith(`/api/runs/${scenario.id}`)) {
      localErrors.push(`unexpected API call blocked: ${req.method()} ${url.pathname}`);
      return fulfillJson(route, { error: "blocked by ui-run-actions-audit" }, 418);
    }

    const suffix = url.pathname.slice(`/api/runs/${scenario.id}`.length).replace(/^\/+/, "");
    if (!suffix) {
      return fulfillJson(route, {
        run: {
          id: scenario.id,
          title: scenario.title,
          mode: scenario.assets.mode,
          status: scenario.run.status,
          output_path: scenario.run.output_path,
          db_status: scenario.run.status,
          worker_active: false,
          needs_recovery: scenario.run.status === "paused",
        },
        logs: [],
      });
    }

    if (suffix === "assets") return fulfillJson(route, scenario.assets);
    if (suffix === "logs") {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: "event: ready\ndata: {}\n\n",
      });
    }
    if (suffix === "drive") {
      if (req.method() === "POST") {
        state.drivePosts++;
        state.drive = {
          ...(state.drive || {}),
          syncEnabled: true,
          connected: true,
          synced: true,
          syncedAt: "2026-05-31T09:30:00.000Z",
          finalVideoLink: "https://drive.google.com/file/d/audit-final-updated/view",
          clipsFolderLink: "https://drive.google.com/drive/folders/audit-clips-updated",
          canRetry: true,
          rawClipsRemainCount: 3,
        };
        return fulfillJson(route, { ok: true, ...state.drive });
      }
      return fulfillJson(route, state.drive || { syncEnabled: false, connected: false, synced: false, canRetry: false });
    }
    if (suffix === "reassemble") {
      state.reassembleCalls++;
      return fulfillJson(route, { ok: true, started: true, alreadyRunning: false });
    }
    if (suffix === "open-folder") return fulfillJson(route, { ok: true });
    if (suffix === "file") {
      const rel = url.searchParams.get("p") || "final.mp4";
      const download = url.searchParams.get("download") === "1";
      state.fileRequests.push({ rel, download });
      if (scenario.kind === "needs-repair" && rel === "final.mp4") {
        localErrors.push(`old final file was requested while gated: download=${download}`);
      }
      if (rel === "final-poster.jpg") return fulfillSvg(route);
      return route.fulfill({
        status: 200,
        contentType: rel.endsWith(".mp4") ? "video/mp4" : "application/octet-stream",
        body: Buffer.alloc(0),
      });
    }

    localErrors.push(`unhandled run API route: ${req.method()} ${url.pathname}`);
    return fulfillJson(route, { error: "unhandled audit route" }, 404);
  });

  try {
    await page.goto(`${baseUrl}/runs/${scenario.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (title) => document.body && document.body.innerText.includes(title),
      scenario.title,
      { timeout: 20000 }
    );
    await page.waitForTimeout(300);

    await assertNoRawErrors(page, scenario.id);
    await assertNoHorizontalOverflow(page, scenario.id);
    await assertScenario(page, scenario, state);
    await assertNoRawErrors(page, `${scenario.id} after action`);

    if (browserDialogCount !== 0) throw new Error(`${scenario.id} used ${browserDialogCount} browser dialogs`);
    if (localErrors.length) throw new Error(localErrors.join(" | "));

    await shot(page, scenario.id);
    steps.push({ id: scenario.id, kind: scenario.kind, ok: true });
  } catch (err) {
    await shot(page, `${scenario.id}-failure`).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${scenario.id}: ${message}`);
    steps.push({ id: scenario.id, kind: scenario.kind, ok: false, error: message });
  } finally {
    await page.close().catch(() => {});
  }
}

async function assertScenario(page, scenario, state) {
  const status = page.getByText(statusPatternFor(scenario.run.status), { exact: false });
  await requireVisible(status, `${scenario.id} status`);

  if (scenario.action === "resume") {
    const resume = await requireVisible(page.getByRole("button", { name: /^Resume run$/i }), "Resume run button");
    await resume.click();
    await page.getByRole("status").filter({ hasText: /Resume started/i }).waitFor({ timeout: 5000 });
    if (state.reassembleCalls !== 1) throw new Error(`Resume action posted ${state.reassembleCalls} times`);
    return;
  }

  if (scenario.action === "assemble") {
    const assemble = await requireVisible(
      page.getByRole("button", { name: /^Assemble final video$/i }),
      "Assemble final video button"
    );
    await assemble.click();
    await page.getByRole("status").filter({ hasText: /Resume started/i }).waitFor({ timeout: 5000 });
    if (state.reassembleCalls !== 1) throw new Error(`Assemble action posted ${state.reassembleCalls} times`);
    return;
  }

  if (scenario.action === "repair") {
    await assertOldFinalGated(page, state);
    const repair = await requireVisible(
      page.getByRole("button", { name: /^Repair chunks \+ rebuild$/i }),
      "Repair chunks + rebuild button"
    );
    await repair.click();
    const dialog = page.getByRole("dialog", { name: /Repair chunks and rebuild/i });
    await requireVisible(dialog, "in-app repair dialog");
    await dialog.getByRole("button", { name: /^Repair and rebuild$/i }).click();
    await page.getByRole("status").filter({ hasText: /Resume started/i }).waitFor({ timeout: 5000 });
    if (state.reassembleCalls !== 1) throw new Error(`Repair action posted ${state.reassembleCalls} times`);
    return;
  }

  if (scenario.action === "done-drive") {
    await requireVisible(page.getByRole("link", { name: /^Download$/i }), "final download link");
    await requireVisible(page.locator('video[src*="final.mp4"]'), "final video element");
    const drive = await requireVisible(page.getByRole("link", { name: /^Open in Drive$/i }), "Open in Drive link");
    const href = await drive.getAttribute("href");
    if (!href?.startsWith("https://drive.google.com/")) throw new Error(`Unexpected Drive href: ${href}`);
    await requireVisible(page.getByRole("button", { name: /^Sync again$/i }), "Sync again button");
    return;
  }

  if (scenario.action === "done-drive-cleaned") {
    await requireVisible(page.getByRole("link", { name: /^Download$/i }), "final download link");
    const syncAgain = await requireVisible(page.getByRole("button", { name: /^Sync again$/i }), "disabled Sync again button");
    if (!(await syncAgain.isDisabled())) throw new Error("Sync again should be disabled after raw clips are cleaned");
    await requireVisible(page.getByText(/nothing safe to re-sync/i), "cleaned raw clips hint");
    return;
  }

  if (scenario.action === "upload-drive") {
    await requireVisible(page.getByRole("link", { name: /^Download$/i }), "final download link");
    const upload = await requireVisible(page.getByRole("button", { name: /^Upload to Drive$/i }), "Upload to Drive button");
    await upload.click();
    await page.getByRole("heading", { name: /Saved to Google Drive/i }).waitFor({ timeout: 5000 });
    await requireVisible(page.getByRole("button", { name: /^Sync again$/i }), "post-upload Sync again button");
    if (state.drivePosts !== 1) throw new Error(`Drive upload posted ${state.drivePosts} times`);
    return;
  }

  throw new Error(`Unknown scenario action: ${scenario.action}`);
}

async function assertOldFinalGated(page, state) {
  const body = await page.locator("body").innerText();
  if (!/not treated as export-ready/i.test(body) || !/old render hidden/i.test(body)) {
    throw new Error("Needs-repair page did not explain that the old final render is gated.");
  }
  if ((await page.getByRole("link", { name: /^Download$/i }).count()) > 0) {
    throw new Error("Needs-repair page exposed the primary Download link.");
  }
  if ((await page.locator('a[href*="final.mp4"][href*="download=1"]').count()) > 0) {
    throw new Error("Needs-repair page exposed a final.mp4 download href.");
  }
  if ((await page.locator('video[src*="final.mp4"]').count()) > 0) {
    throw new Error("Needs-repair page rendered the old final video player.");
  }
  if (state.fileRequests.some((req) => req.rel === "final.mp4")) {
    throw new Error("Needs-repair page requested final.mp4 despite gated finalExists=false.");
  }
}

function statusPatternFor(status) {
  if (status === "paused") return /needs resume/i;
  if (status === "done") return /\bdone\b/i;
  return new RegExp(status, "i");
}

async function assertNoRawErrors(page, name) {
  const report = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const matches = [];
    for (const pattern of [
      /invalid_grant/i,
      /Unhandled Runtime Error/i,
      /Internal Server Error/i,
      /\bTypeError\b/i,
      /\bReferenceError\b/i,
      /\bSyntaxError\b/i,
      /\bError:/i,
      /\bNaN\b/,
      /\bundefined\b/i,
      /\[object Object\]/i,
      /Cannot read properties/i,
      /ECONNREFUSED/i,
      /ENOENT/i,
    ]) {
      if (pattern.test(text)) matches.push(String(pattern));
    }
    return matches;
  });
  if (report.length) throw new Error(`${name} shows raw errors: ${report.join(", ")}`);
}

async function assertNoHorizontalOverflow(page, name) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
  if (overflow > 2) throw new Error(`${name} has ${overflow}px horizontal overflow`);
}

async function requireVisible(locator, label) {
  if ((await locator.count()) === 0) throw new Error(`Missing ${label}`);
  const first = locator.first();
  await first.waitFor({ state: "visible", timeout: 5000 });
  return first;
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function fulfillSvg(route) {
  await route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#050505"/><circle cx="80" cy="45" r="18" fill="#e23636"/></svg>`,
  });
}

async function shot(page, name) {
  if (!OUT_DIR) return;
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
}
