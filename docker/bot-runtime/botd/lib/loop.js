// myrmidon(1.6.5-BOT-DISK-H3e): the main loop of botd — one pass per tick
// (60 s by default, an extra pass on SIGUSR1):
//   inventory (#745 toReportParts/toInventory) → desired (#740
//   createDesiredClient().getLast) → rules.plan (#742, inventory
//   {worktrees, scratch, bases, archives}) → execution of the plan actions
//   (a single failed action is skipped and lands in the report, it does not
//   stop the rest) → disk-state.json (from the board reply) → the disk
//   report (C4) with a retry.
// The modules of the siblings are plugged in by contract; fakes are
// supported for the tests and every dependency is injectable. Nothing is
// deleted when desired.ok=false.
//
// ESM, like every module of docker/bot-runtime/botd (package.json
// {"type":"module"}).

import fs from "node:fs";
import path from "node:path";
import { buildReport, postReport } from "./report.js";

export const DEFAULT_INTERVAL_MS = 60_000;
export const REPORT_RETRY_DELAY_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 15 * 60_000;

function errorMessage(err) {
  if (!err) return "unknown error";
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.slice(0, 500);
}

function iso(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Executes one plan action; a failure is returned, never thrown.
 * Action shape from rules.plan (#742): { op, path, reason, key? }.
 */
export async function executeAction(action, { deps, roots }) {
  const startedAt = Date.now();
  try {
    let freedBytes = 0;
    switch (action.op) {
      case "remove": {
        const executor = deps.removeWorktree || ((p) => fs.promises.rm(p, { recursive: true, force: true }));
        const result = (await executor(action.path, action.key, action)) || {};
        freedBytes = result.freedBytes ?? 0;
        break;
      }
      case "archive-remove": {
        if (!deps.archiveRemove) throw new Error("archiveRemove dependency missing");
        const result = (await deps.archiveRemove(action.path, action.key, action)) || {};
        freedBytes = result.freedBytes ?? 0;
        break;
      }
      case "prune": {
        if (!deps.prune) throw new Error("prune dependency missing");
        const result = (await deps.prune(action.path, action.key, action)) || {};
        freedBytes = result.freedBytes ?? 0;
        break;
      }
      case "delete-base": {
        if (!deps.deleteBase) throw new Error("deleteBase dependency missing");
        const result = (await deps.deleteBase(action.path, action)) || {};
        freedBytes = result.freedBytes ?? 0;
        break;
      }
      case "delete-archive": {
        if (!deps.deleteArchive) throw new Error("deleteArchive dependency missing");
        const result = (await deps.deleteArchive(action.path, action)) || {};
        freedBytes = result.freedBytes ?? 0;
        break;
      }
      default:
        throw new Error(`unknown op: ${action.op}`);
    }
    return {
      at: iso(new Date(startedAt)),
      action: action.op === "archive-remove" ? "archive" : action.op,
      path: action.path,
      result: "ok",
      reason: action.reason || "",
    };
  } catch (err) {
    return {
      at: iso(new Date(startedAt)),
      action: action.op === "archive-remove" ? "archive" : action.op,
      path: action.path,
      result: "error",
      reason: errorMessage(err),
    };
  }
}

/** The single-pass dependency bundle the tests and the entrypoint can override. */
export function defaultDeps(overrides = {}) {
  const deps = {
    classify: null, // the #745 module: { classifyAll, toReportParts, toInventory }
    desiredClient: null, // the #740 client ({start, getLast, stop}) or a plain {ok, state?}
    rules: null, // the #742 module: { plan } — rules-shape inventory in, actions out
    removeWorktree: null, // (path, key, action) => {freedBytes?} — #745 remove or fs.rm
    archiveRemove: null, // (path, key, action) => {archivePath?}
    prune: null, // (path, key, action) => {}
    deleteBase: null, // (path, action) => {freedBytes?}
    deleteArchive: null, // (path, action) => {freedBytes?}
    fetchImpl: null,
    now: () => new Date(),
    ...overrides,
  };
  if (!deps.classify) {
    deps.classify = {
      classifyAll: async () => ({ items: [], bases: [], archives: [] }),
      toReportParts: () => ({ copies: [], foreign: [] }),
      toInventory: () => ({ worktrees: [], scratch: [], bases: [], archives: [] }),
    };
  }
  if (!deps.rules) deps.rules = { plan: () => ({ actions: [], pressure: "none", blockOpen: false }) };
  return deps;
}

function desiredResolution(desiredClient) {
  if (desiredClient && typeof desiredClient.getLast === "function") return desiredClient.getLast();
  return desiredClient || { ok: false, reason: "desired client missing" };
}

/** The full tick, exactly once. Returns the report body and its delivery. */
export async function runPass(config, deps) {
  const startedAt = deps.now();
  const classifyItems = await deps.classify.classifyAll({
    roots: config.roots.scanRoots || [config.roots.worktreesRoot, config.roots.scratchRoot].filter(Boolean),
    gitBaseDir: config.roots.basesRoot,
    now: startedAt.getTime(),
  });
  const reportParts = deps.classify.toReportParts(classifyItems.items || [], classifyItems.actions || []);
  const rulesInventory = deps.classify.toInventory(classifyItems.items || [], { now: startedAt.getTime() });

  const desired = desiredResolution(deps.desiredClient);
  const actions = [];
  let plan = { actions: [], pressure: "none", blockOpen: false };
  if (desired.ok) {
    plan = deps.rules.plan(rulesInventory, desired.state, startedAt);
    for (const action of plan.actions) {
      // A single failed action is skipped with its reason recorded — it does
      // not stop the remaining actions of the pass.
      actions.push(await executeAction(action, { deps, roots: config.roots }));
    }
  } else {
    actions.push({
      at: iso(startedAt),
      action: "skip",
      path: "desired",
      result: "error",
      reason: `desired.ok=false: ${desired.reason || "unknown"}`,
    });
  }
  const report = buildReport({
    inventory: {
      bases: classifyItems.bases || [],
      copies: reportParts.copies,
      archives: classifyItems.archives || [],
      foreign: reportParts.foreign,
    },
    actions,
    now: deps.now(),
    selfChecks: config.selfChecks,
    botKey: config.identity.botKey,
    imageGeneration: config.identity.imageGeneration,
  });
  const posted = await postReport({
    boardUrl: config.board.url,
    apiKey: config.board.apiKey,
    fetchImpl: deps.fetchImpl,
    body: report,
    retryDelayMs: config.reportRetryDelayMs ?? REPORT_RETRY_DELAY_MS,
  });
  let nextIntervalMs = null;
  if (posted.ok) {
    const statePath = path.join(config.stateDir, "disk-state.json");
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ ok: true, at: report.at, report })}\n`);
    const next = Number(posted.nextReportSec);
    if (Number.isFinite(next) && next > 0) {
      nextIntervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, next * 1000));
    }
  }
  return { report, actions, plan, posted, nextIntervalMs };
}

/**
 * The daemon supervisor: a tick every `intervalMs` (the board's
 * nextReportSec can move it), an extra tick on SIGUSR1, SIGTERM/SIGINT for
 * a clean stop.
 */
export async function runDaemon(config, deps) {
  let running = true;
  let wake = null;
  let tick = Promise.resolve();
  const requestTick = () => {
    if (wake) wake();
  };
  const stop = () => {
    running = false;
    requestTick();
  };
  process.on("SIGUSR1", requestTick);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    let intervalMs = config.intervalMs || DEFAULT_INTERVAL_MS;
    while (running) {
      const pass = runPass(config, deps).catch((err) => {
        process.stderr.write(`botd pass failed: ${errorMessage(err)}\n`);
        return null;
      });
      tick = pass;
      await pass;
      const waited = new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, intervalMs);
        timer.unref();
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
      const result = await tick;
      if (result && result.nextIntervalMs) intervalMs = result.nextIntervalMs;
      await waited;
    }
  } finally {
    process.removeListener("SIGUSR1", requestTick);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
