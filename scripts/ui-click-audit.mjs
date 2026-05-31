#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), "tmp", "ui-audit");

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  headless: process.env.HEADLESS !== "0",
  args: ["--disable-extensions"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 980 },
  colorScheme: "dark",
});
const page = await context.newPage();

const errors = [];
const steps = [];
let dialogCount = 0;
let expectedStartFailureConsoleErrors = 0;

page.on("console", (msg) => {
  if (msg.type() === "error") {
    const text = msg.text();
    if (/hydration-mismatch/i.test(text) && /caret-color/i.test(text)) return;
    if (expectedStartFailureConsoleErrors > 0 && /status of 500|Internal Server Error/i.test(text)) {
      expectedStartFailureConsoleErrors--;
      return;
    }
    errors.push(`console: ${text}`);
  }
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => {
  const url = req.url();
  if (!url.startsWith(BASE_URL)) return;
  const reason = req.failure()?.errorText ?? "";
  if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(reason)) return;
  errors.push(`requestfailed: ${req.method()} ${url} ${reason}`.trim());
});
page.on("dialog", async (dialog) => {
  dialogCount++;
  steps.push(`dialog:${dialog.type()}:${dialog.message().slice(0, 120)}`);
  await dialog.accept();
});

async function step(name, fn) {
  try {
    await fn();
    steps.push(`ok:${name}`);
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    steps.push(`fail:${name}`);
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
}

async function assertNoHorizontalOverflow(name) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
  if (overflow > 2) throw new Error(`${name} has ${overflow}px horizontal overflow`);
}

async function assertPagePolish(name) {
  const report = await page.evaluate(() => {
    const body = document.body.innerText || "";
    const rawErrors = [];
    for (const pattern of [
      /invalid_grant/i,
      /\bTypeError\b/,
      /Unhandled Runtime Error/i,
      /Internal Server Error/i,
      /\bNaN\b/,
      /undefined\s*\/\s*undefined/i,
    ]) {
      if (pattern.test(body)) rawErrors.push(String(pattern));
    }

    const tinyTargets = [];
    const unlabeledActions = [];
    const unlabeledFields = [];
    const clippedControls = [];
    const controls = [
      ...document.querySelectorAll("button,a,input,select,textarea,[role='button'],[role='tab'],summary"),
    ];

    for (const el of controls) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width < 1 || rect.height < 1) continue;

      const name =
        (el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.textContent ||
          el.getAttribute("placeholder") ||
          "").trim();
      const isSmall = rect.width < 32 || rect.height < 32;
      if (isSmall) {
        tinyTargets.push({
          tag: el.tagName,
          role: el.getAttribute("role"),
          name: name.slice(0, 64),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
      if ((el.tagName === "BUTTON" || el.getAttribute("role") === "button") && !name) {
        unlabeledActions.push({ tag: el.tagName, html: el.outerHTML.slice(0, 120) });
      }
      if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && el.getAttribute("type") !== "hidden") {
        const id = el.id;
        const hasLabel =
          !!(id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
          !!el.closest("label") ||
          !!el.getAttribute("aria-label") ||
          !!el.getAttribute("aria-labelledby");
        if (!hasLabel) {
          unlabeledFields.push({
            tag: el.tagName,
            id,
            placeholder: el.getAttribute("placeholder"),
            type: el.getAttribute("type"),
          });
        }
      }
      if ((el.tagName === "BUTTON" || el.tagName === "A") && el.scrollWidth > el.clientWidth + 2) {
        clippedControls.push({
          tag: el.tagName,
          name: name.slice(0, 64),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }

    return {
      rawErrors,
      tinyTargets: tinyTargets.slice(0, 10),
      unlabeledActions: unlabeledActions.slice(0, 10),
      unlabeledFields: unlabeledFields.slice(0, 10),
      clippedControls: clippedControls.slice(0, 10),
    };
  });

  const issues = [];
  if (report.rawErrors.length) issues.push(`raw errors visible: ${report.rawErrors.join(", ")}`);
  if (report.tinyTargets.length) issues.push(`tiny targets: ${JSON.stringify(report.tinyTargets)}`);
  if (report.unlabeledActions.length) issues.push(`unlabeled actions: ${JSON.stringify(report.unlabeledActions)}`);
  if (report.unlabeledFields.length) issues.push(`unlabeled fields: ${JSON.stringify(report.unlabeledFields)}`);
  if (report.clippedControls.length) issues.push(`clipped controls: ${JSON.stringify(report.clippedControls)}`);
  if (issues.length) throw new Error(`${name} polish issues: ${issues.join(" | ")}`);
}

async function assertVideoFrameVisible() {
  const videos = page.locator("video");
  const count = await videos.count();
  if (count === 0) return;
  let box = null;
  for (let i = count - 1; i >= 0; i--) {
    const candidate = videos.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      box = await candidate.boundingBox();
      if (box) break;
    }
  }
  if (!box || box.width < 320 || box.height < 180) {
    throw new Error(`Final video frame is not visibly reserved: ${JSON.stringify(box)}`);
  }
}

async function goto(pathname, name = pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home") {
  await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 8000 });
  await page.waitForTimeout(350);
  await assertNoHorizontalOverflow(name);
  await assertPagePolish(name);
  await shot(name);
}

async function clickByRole(role, name, opts = {}) {
  const locator = page.getByRole(role, { name });
  await locator.first().click(opts);
  await page.waitForTimeout(350);
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
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#18181b"/><path d="M18 68h124L105 35 82 56 66 43z" fill="#334155"/></svg>`,
  });
}

function requestJson(route) {
  try {
    return route.request().postDataJSON() || {};
  } catch {
    return {};
  }
}

async function clickSidebar(name, pathname) {
  const link = page.getByRole("link", { name });
  await Promise.all([
    page.waitForURL((url) => url.origin === BASE_URL && url.pathname === pathname, { timeout: 7000 }).catch(() => null),
    link.first().click(),
  ]);
  if (new URL(page.url()).pathname !== pathname) {
    throw new Error(`Expected ${pathname}, got ${page.url()}`);
  }
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 8000 });
  await page.waitForTimeout(350);
  await assertNoHorizontalOverflow(pathname);
  await assertPagePolish(pathname);
}

await step("open create", async () => goto("/", "01-create"));
await step("legacy routes redirect cleanly", async () => {
  const redirects = [
    ["/stock", "/clips"],
    ["/reassembly", "/"],
    ["/advanced", "/settings"],
  ];
  for (const [from, to] of redirects) {
    await page.goto(`${BASE_URL}${from}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 8000 });
    await page.waitForTimeout(350);
    const url = new URL(page.url());
    if (url.pathname !== to) throw new Error(`${from} should redirect to ${to}, got ${url.pathname}`);
    await assertNoHorizontalOverflow(from);
    await assertPagePolish(from);
  }
});
await step("sidebar create", async () => clickByRole("link", "Create"));
await step("sidebar clips", async () => {
  await clickSidebar("Clips", "/clips");
  await shot("02-clips");
});
await step("clips load", async () => {
  const btn = page.getByRole("button", { name: /load clips/i });
  if ((await btn.count()) > 0) await btn.first().click();
  await page.waitForTimeout(900);
  await shot("03-clips-loaded");
});
await step("clips mocked delete and generate", async () => {
  const patterns = [
    "**/api/prompt-presets",
    "**/api/prompt-presets/1",
    "**/api/settings**",
    "**/api/stock/list**",
    "**/api/stock/delete",
    "**/api/stock/generate**",
    "**/api/stock/poster**",
  ];
  let clips = Array.from({ length: 52 }, (_, i) => ({
    driveFileId: `audit-clip-${String(i).padStart(2, "0")}`,
    previewFileId: `audit-preview-${String(i).padStart(2, "0")}`,
    name: `audit_scene_${String(i).padStart(2, "0")}.mp4`,
    source: i % 9 === 0 ? "local" : "drive",
  }));
  try {
    await page.route("**/api/prompt-presets", (route) =>
      fulfillJson(route, [{ id: 1, name: "Audit Channel", video_style: "cinematic", stock_folder: "Audit-Clips" }])
    );
    await page.route("**/api/prompt-presets/1", async (route) => {
      if (route.request().method() === "PUT") {
        await fulfillJson(route, { id: 1, name: "Audit Channel", stock_folder: "Audit-Clips-More" });
      } else {
        await fulfillJson(route, { id: 1, name: "Audit Channel", video_style: "cinematic", stock_folder: "Audit-Clips" });
      }
    });
    await page.route("**/api/settings**", (route) => fulfillJson(route, { STOCK_LIBRARY_FOLDER: "Audit-Clips" }));
    await page.route("**/api/stock/list**", (route) =>
      fulfillJson(route, {
        clips,
        localFolders: clips.length ? [{ folder: "Audit-Clips-More", count: 80 }] : [],
      })
    );
    await page.route("**/api/stock/delete", async (route) => {
      const payload = requestJson(route);
      const ids = Array.isArray(payload.ids) ? payload.ids : [];
      clips = clips.filter((clip) => !ids.includes(clip.driveFileId));
      await fulfillJson(route, { deleted: ids.length, failed: 0, localDeleted: 6, errors: [] });
    });
    await page.route("**/api/stock/generate**", async (route) => {
      if (route.request().method() === "POST") {
        await fulfillJson(route, { running: false, total: 2, done: 2, failed: 0, folder: "Audit-Clips" });
      } else {
        await fulfillJson(route, { running: false, total: 2, done: 2, failed: 0, folder: "Audit-Clips" });
      }
    });
    await page.route("**/api/stock/poster**", fulfillSvg);

    await goto("/clips", "03b-clips-mocked");
    await page.getByLabel("Channel", { exact: true }).selectOption("1");
    await page.getByText(/52 (?:Drive )?clips/i).first().waitFor({ timeout: 6000 });
    const showMore = page.getByRole("button", { name: /show more clips/i });
    if ((await showMore.count()) > 0) {
      await showMore.first().click();
      await page.waitForTimeout(250);
    }
    await page.getByRole("button", { name: /^select all$/i }).click();
    await page.getByText("52 selected").first().waitFor({ timeout: 3000 });
    await page.getByRole("button", { name: /delete selected/i }).first().click();
    const modal = page.getByRole("dialog", { name: /delete selected clips/i });
    await modal.waitFor({ timeout: 3000 });
    await modal.getByRole("button", { name: /^delete clips$/i }).click();
    await page.getByText(/clips removed/i).first().waitFor({ timeout: 5000 });
    await page.getByText(/no (?:drive )?clips in this folder yet/i).first().waitFor({ timeout: 5000 });
    await Promise.all([
      page.waitForURL((url) => url.origin === BASE_URL && url.pathname === "/clips/generate", { timeout: 7000 }),
      page.getByRole("link", { name: /^generate b-roll$/i }).click(),
    ]);
    await page.getByRole("link", { name: /^Back$/ }).waitFor({ timeout: 5000 });
    if ((await page.getByText(/Back to Clips|Back to Studio/i).count()) > 0) {
      throw new Error("B-roll Studio still has legacy back-button copy.");
    }
    await assertNoHorizontalOverflow("clips mocked actions");
    await assertPagePolish("clips mocked actions");
    await shot("03b-clips-generate-studio");
  } finally {
    for (const pattern of patterns) await page.unroute(pattern).catch(() => {});
  }
});
await step("sidebar saved videos", async () => {
  await clickSidebar("Saved Videos", "/library");
  const body = await page.locator("body").innerText();
  if (!/Saved Videos/i.test(body)) throw new Error("Library page should be named Saved Videos.");
  if (/Clip Library/i.test(body)) throw new Error("Old confusing 'Clip Library' naming is visible.");
  await shot("04-saved-videos");
});
await step("sidebar runs", async () => {
  await clickSidebar("Runs", "/runs");
  await shot("05-runs");
});
await step("runs show hide test runs", async () => {
  const btn = page.getByRole("button", { name: /show .*test runs|hide test runs/i });
  if ((await btn.count()) > 0) {
    await btn.first().click();
    await page.waitForTimeout(300);
    await btn.first().click().catch(() => {});
  }
});
await step("latest run detail", async () => {
  const runId = await page.evaluate(async () => {
    const runs = await fetch("/api/runs").then((r) => r.json());
    const isAuditRun = (run) => {
      const title = String(run.title || "").trim();
      return title.startsWith("__AUDIT_") || /^__V\d+_/i.test(title) || /\bTEST\b/i.test(title);
    };
    return runs.find((run) => !isAuditRun(run))?.id ?? runs[0]?.id ?? null;
  });
  if (!runId) return;
  await page.goto(`${BASE_URL}/runs/${runId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      /Script mapped|Final video|Old chunking detected|Run failed|Saved work found/.test(document.body.innerText) &&
      /DONE|WORKING|NEEDS REVIEW|STOPPED|NEEDS RESUME|QUEUED/i.test(document.body.innerText),
    { timeout: 12000 }
  );
  await page.waitForTimeout(600);
  const body = await page.locator("body").innerText();
  if (/shuffled stock|shuffled B-roll|shuffle stock clips/i.test(body)) {
    throw new Error("Run page still describes stock clips as shuffled instead of narration-matched.");
  }
  const assets = await page.evaluate(async (id) => fetch(`/api/runs/${id}/assets`).then((r) => r.json()), runId);
  if (assets.finalNeedsRepair) {
    if (!/old render hidden|not treated as export-ready/i.test(body)) {
      throw new Error("Old chunked final exists but the run page does not clearly hide/gate it.");
    }
    if ((await page.locator("video:visible").count()) > 0) {
      throw new Error("Old chunked final should not be shown in the final video player before repair.");
    }
    if ((await page.getByRole("link", { name: /^Download$/i }).count()) > 0) {
      throw new Error("Old chunked final should not expose the primary Download action before repair.");
    }
  }
  await assertVideoFrameVisible();
  await assertNoHorizontalOverflow("run detail");
  await assertPagePolish("run detail");
  await shot("05b-run-detail");
});
await step("sidebar channels", async () => {
  await clickSidebar("Channels", "/prompts");
  await shot("06-channels");
});
await step("channels new cancel", async () => {
  const newBtn = page.getByRole("button", { name: /\+?\s*new channel/i });
  if ((await newBtn.count()) > 0) {
    await newBtn.first().click();
    await page.waitForTimeout(250);
    const cancel = page.getByRole("button", { name: /^cancel$/i });
    if ((await cancel.count()) > 0) await cancel.first().click();
  }
});
await step("channels edit cancel", async () => {
  const edit = page.getByRole("button", { name: /^edit$/i });
  if ((await edit.count()) > 0) {
    await edit.first().click();
    await page.waitForTimeout(250);
    const cancel = page.getByRole("button", { name: /^cancel$/i });
    if ((await cancel.count()) > 0) await cancel.first().click();
  }
});
await step("sidebar settings", async () => {
  await clickSidebar("Settings", "/settings");
  await shot("07-settings");
});
await step("settings tabs", async () => {
  for (const name of ["Connections", "Speed & Quality", "Files"]) {
    const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
    if ((await tab.count()) === 0) throw new Error(`Missing settings tab: ${name}`);
    await tab.first().click();
    await page.waitForTimeout(200);
    const selected = await tab.first().getAttribute("aria-selected");
    if (selected !== "true") throw new Error(`Settings tab did not select: ${name}`);
    await assertNoHorizontalOverflow(`settings ${name}`);
    await assertPagePolish(`settings ${name}`);
  }
  await shot("08-settings-tabs");
});
await step("settings reveal hide", async () => {
  const reveal = page.getByRole("button", { name: /reveal|hide saved secrets/i });
  if ((await reveal.count()) > 0) {
    await reveal.first().click();
    await page.waitForTimeout(200);
    const hide = page.getByRole("button", { name: /hide secrets/i });
    if ((await hide.count()) > 0) {
      await hide.first().click();
      await page.waitForTimeout(500);
    }
  }
});
await step("settings secrets hidden", async () => {
  const hide = page.getByRole("button", { name: /hide secrets/i });
  if ((await hide.count()) > 0) {
    await hide.first().click();
    await page.waitForTimeout(500);
  }
  await page.goto(`${BASE_URL}/settings?tab=keys`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
});
await step("settings drive actions mocked", async () => {
  const patterns = [
    "**/api/settings**",
    "**/api/stats",
    "**/api/gdrive/status",
    "**/api/gdrive/disconnect",
  ];
  let connected = false;
    let syncEnabled = "1";
    try {
    await page.route("**/api/settings**", async (route) => {
      if (route.request().method() === "POST") {
        const payload = requestJson(route);
        syncEnabled = payload.GDRIVE_SYNC_ENABLED === "1" ? "1" : "";
        await fulfillJson(route, { ok: true });
      } else {
        await fulfillJson(route, {
          GDRIVE_SYNC_ENABLED: syncEnabled,
          GDRIVE_CLIENT_ID: "audit.apps.googleusercontent.com",
          GDRIVE_CLIENT_SECRET: "••••••••",
          LABS69_API_KEY: "••••••••",
        });
      }
    });
    await page.route("**/api/stats", (route) =>
      fulfillJson(route, { keyCount: 1, total: { image: 7, tts: 5, anim: 5 }, assembleConcurrency: 4, xfadeChunks: 2 })
    );
    await page.route("**/api/gdrive/status", (route) =>
      fulfillJson(route, {
        connected,
        email: connected ? "audit@example.com" : undefined,
        syncEnabled: syncEnabled === "1",
        credentialsConfigured: true,
      })
    );
    await page.route("**/api/gdrive/disconnect", async (route) => {
      connected = false;
      await fulfillJson(route, { ok: true });
    });

    await goto("/settings?tab=keys", "08b-settings-drive-mocked");
    await page.getByRole("button", { name: /^connect google drive$/i }).click();
    await page.getByText(/before google opens/i).first().waitFor({ timeout: 3000 });
    await page.getByRole("button", { name: /copy callback url/i }).click();
    await page.getByRole("button", { name: /^cancel$/i }).click();

    connected = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/connected as audit@example.com/i).first().waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: /^refresh google login$/i }).click();
    await page.getByText(/before google opens/i).first().waitFor({ timeout: 3000 });
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await page.getByRole("button", { name: /^disconnect$/i }).click();
    const modal = page.getByRole("dialog", { name: /disconnect google drive/i });
    await modal.waitFor({ timeout: 3000 });
    await modal.getByRole("button", { name: /^disconnect$/i }).click();
    await page.getByText(/google drive disconnected/i).first().waitFor({ timeout: 5000 });
    await page.getByLabel(/auto-upload finished runs/i).click();
    await page.getByRole("button", { name: /save all changes/i }).click();
    await page.getByRole("button", { name: /saved/i }).waitFor({ timeout: 5000 });
    await assertNoHorizontalOverflow("settings mocked drive actions");
    await assertPagePolish("settings mocked drive actions");
    await shot("08b-settings-drive-actions");
  } finally {
    for (const pattern of patterns) await page.unroute(pattern).catch(() => {});
  }
});
await step("theme toggle twice", async () => {
  const toggle = page.getByRole("button", { name: /toggle theme|switch to light theme|switch to dark theme/i });
  if ((await toggle.count()) > 0) {
    await toggle.first().click();
    await page.waitForTimeout(250);
    await toggle.first().click();
    await page.waitForTimeout(250);
  }
  await shot("09-theme-restored");
});
await step("create mode buttons", async () => {
  await goto("/", "10-create-before-modes");
  for (const name of ["Select Full Render mode", "Select Hybrid mode", "Select Stock Cut mode", "Select Hybrid mode"]) {
    const button = page.getByRole("button", { name });
    if ((await button.count()) > 0) {
      await button.first().click();
      await page.waitForTimeout(200);
    }
  }
  await shot("11-create-modes");
});
await step("create start error is inline", async () => {
  await goto("/", "12-create-inline-error-before");
  await page.waitForFunction(() => {
    const select = document.querySelector("#newrun-channel");
    return select && select.value;
  }, { timeout: 8000 });
  const beforeDialogs = dialogCount;
  const routePattern = "**/api/runs";
  await page.route(routePattern, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "text/plain",
        body: "Simulated audit start failure",
      });
    } else {
      await route.continue();
    }
  });
  await page.locator("#newrun-title").fill("__UI_AUDIT_INLINE_ERROR__");
  await page.locator("#newrun-script").fill("Tiny draft text for a no-cost inline error check.");
  expectedStartFailureConsoleErrors++;
  try {
    await page.getByRole("button", { name: /^Run$/ }).click();
    await page.getByRole("alert").filter({ hasText: /Run could not start/i }).waitFor({ timeout: 5000 });
    if (dialogCount !== beforeDialogs) throw new Error("Start error used a browser dialog instead of inline UI.");
    await shot("12-create-inline-error");
  } finally {
    await page.unroute(routePattern);
  }
});
await step("create clear draft", async () => {
  await page.locator("#newrun-title").fill("__UI_AUDIT_DRAFT__");
  await page.locator("#newrun-script").fill("Tiny draft text for a no-cost clear-draft button check.");
  const beforeDialogs = dialogCount;
  const clear = page.getByRole("button", { name: /clear draft/i });
  if ((await clear.count()) > 0) await clear.first().click();
  const modal = page.getByRole("dialog", { name: /clear this draft/i });
  await modal.waitFor({ timeout: 3000 });
  await modal.getByRole("button", { name: /^clear draft$/i }).click();
  await page.waitForTimeout(250);
  if (dialogCount !== beforeDialogs) throw new Error("Clear draft used a browser confirm instead of the app dialog.");
});

await step("mobile polish spot check", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [pathname, name] of [
    ["/", "mobile-create"],
    ["/clips", "mobile-clips"],
    ["/library", "mobile-library"],
    ["/runs", "mobile-runs"],
    ["/prompts", "mobile-channels"],
    ["/settings", "mobile-settings"],
  ]) {
    await goto(pathname, name);
  }
});

if (dialogCount > 0) errors.push(`browser dialogs appeared: ${dialogCount}`);

await browser.close();

const report = {
  baseUrl: BASE_URL,
  outDir: OUT_DIR,
  steps,
  errors,
  ok: errors.length === 0,
};
fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
