#!/usr/bin/env node
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const DB_PATH = process.env.CONVEYER_HUM_DB || path.join(process.env.HOME, ".conveyer-hum", "hum.db");
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), "tmp", "mode-smoke");
const PRESET_ID = Number(process.env.PRESET_ID || 4);
const STOCK_FOLDER = process.env.STOCK_FOLDER || "Pirates";

fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(DB_PATH, { readonly: true });

const scripts = {
  stock:
    "The old harbor is quiet tonight. Lanterns sway over black water while a forgotten ship bell rings once, then fades into the fog.",
  hybrid:
    "A small pirate sloop drifts past moonlit reeds. The crew whispers over a damp map, watching distant lanterns move along the shore.",
  full:
    "Blackbeard studies a dark horizon from the deck. Smoke curls above the cannons as the sea turns silver before dawn.",
};

async function createRun(mode, script) {
  const title = `__AUDIT_MODE_${mode.toUpperCase()}_${Date.now()}__`;
  const body = {
    title,
    script,
    presetId: PRESET_ID,
    autoReuse: true,
    mode,
    stockFolder: STOCK_FOLDER,
  };
  if (mode === "hybrid") body.hybridFreshMinutes = 1;
  const r = await fetch(`${BASE_URL}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`create ${mode} failed: ${r.status} ${text}`);
  const json = JSON.parse(text);
  return { id: json.id, title };
}

async function assets(id) {
  return fetch(`${BASE_URL}/api/runs/${id}/assets`).then((r) => r.json());
}

function runRow(id) {
  return db.prepare("select status, output_path from runs where id = ?").get(id);
}

function recentLogs(id, limit = 18) {
  return db
    .prepare("select level, stage, message from run_logs where run_id = ? order by id desc limit ?")
    .all(id, limit)
    .reverse();
}

async function waitDone(id, timeoutMs) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const row = runRow(id);
    const a = await assets(id);
    if (row?.status === "done" || a.finalExists) return { row, assets: a, elapsedMs: performance.now() - start };
    if (row?.status === "error" || row?.status === "cancelled") {
      throw new Error(`run ${id} ended ${row.status}: ${JSON.stringify(recentLogs(id, 8))}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`run ${id} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function runMode(mode) {
  const { id, title } = await createRun(mode, scripts[mode]);
  const done = await waitDone(id, mode === "stock" ? 8 * 60_000 : 30 * 60_000);
  return {
    mode,
    id,
    title,
    elapsedSec: Math.round(done.elapsedMs / 1000),
    status: done.row.status,
    finalExists: done.assets.finalExists,
    progress: done.assets.progress,
    tail: done.assets.tail,
    errors: recentLogs(id, 200).filter((l) => l.level === "error" || /failed/i.test(l.message)),
  };
}

async function stopTest() {
  const { id, title } = await createRun("stock", "This run exists only to test the stop button path before real work continues.");
  await new Promise((r) => setTimeout(r, 750));
  const cancelStart = performance.now();
  const cancel = await fetch(`${BASE_URL}/api/runs/${id}/cancel`, { method: "POST" });
  const cancelText = await cancel.text();
  const postCancelMs = performance.now() - cancelStart;
  if (!cancel.ok) throw new Error(`cancel failed: ${cancel.status} ${cancelText}`);

  const settleStart = performance.now();
  let row = runRow(id);
  while (performance.now() - settleStart < 30_000) {
    row = runRow(id);
    if (row?.status === "cancelled") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    mode: "stop",
    id,
    title,
    cancelPostMs: Math.round(postCancelMs),
    settleMs: Math.round(performance.now() - settleStart),
    status: row?.status ?? "unknown",
    logs: recentLogs(id, 10),
  };
}

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  results: [],
};

for (const mode of ["stock", "hybrid", "full"]) {
  const result = await runMode(mode);
  report.results.push(result);
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

const stop = await stopTest();
report.results.push(stop);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(stop, null, 2));

const failed = report.results.some((r) => r.mode !== "stop" && (!r.finalExists || r.errors?.length));
if (failed || stop.status !== "cancelled") process.exit(1);
