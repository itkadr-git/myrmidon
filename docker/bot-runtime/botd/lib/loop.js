// myrmidon(1.6.5-BOT-DISK-H3e): one botd pass — inventory, desired state,
// rules, action execution, disk-state write and the board report (contract C4,
// docs/myrmidon/bot-disk-contract). CommonJS: the bot runtime runs the daemon
// with the image's /opt/node24 node, outside the workspace type-chain.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Remove `dir` recursively without following a symbolic link at the top. */
function removeTree(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to remove a symbolic link: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** An empty registry when the file is absent; a broken file is an error, not a wipe. */
function loadRegistry(home) {
  const file = path.join(home, "ws-registry.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { version: 1, entries: [] };
  }
  const parsed = JSON.parse(raw);
  if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
    return parsed;
  }
  throw new Error(`ws-registry.json has an unknown shape`);
}

/** Allocated size of `dir` in bytes (`du -sb` semantics, lstat-based). */
function duBytes(dir) {
  let total = 0;
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    visited += 1;
    if (visited > 1_000_000) return null;
    if (st.isSymbolicLink()) continue;
    total += st.blocks ? st.blocks * 512 : st.size;
    if (st.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(path.join(current, name));
    }
  }
  return total;
}

/**
 * Class-D bases as the report lists them: `<git-base>/<owner>/<repo>.git`
 * directories holding HEAD. lastFetchAt comes from FETCH_HEAD's mtime.
 */
function listBases(home) {
  const root = path.join(home, "git-base");
  const bases = [];
  let owners;
  try {
    owners = fs.readdirSync(root).sort();
  } catch {
    return bases;
  }
  for (const owner of owners) {
    const ownerDir = path.join(root, owner);
    let names;
    try {
      if (!fs.statSync(ownerDir).isDirectory()) continue;
      names = fs.readdirSync(ownerDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".git")) continue;
      const basePath = path.join(ownerDir, name);
      try {
        if (!fs.statSync(basePath).isDirectory()) continue;
        if (!fs.existsSync(path.join(basePath, "HEAD"))) continue;
      } catch {
        continue;
      }
      let lastFetchAt = null;
      try {
        const st = fs.statSync(path.join(basePath, "FETCH_HEAD"));
        lastFetchAt = st.mtime.toISOString().replace(/\.\d+Z$/, "Z");
      } catch {
        /* never fetched or mtime unreadable */
      }
      bases.push({
        repo: `${owner}/${name.slice(0, -".git".length)}`,
        path: basePath,
        sizeBytes: duBytes(basePath),
        lastFetchAt,
      });
    }
  }
  return bases;
}

/** Class-F archives under `<home>/archive` (files of one bundle-set count once). */
function listArchives(home) {
  const root = path.join(home, "archive");
  const archives = [];
  let names;
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return archives;
  }
  for (const name of names) {
    if (name === "manifest.json" || name.startsWith(".")) continue;
    const file = path.join(root, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // <KEY>-<ts>.bundle — the companion .patch/.untracked.tar belong to it.
    const m = /^([A-Za-z0-9-]+?)-\d{8}T\d{6}Z\.(bundle|patch|untracked\.tar)$/.exec(name);
    if (!m || m[2] !== "bundle") continue;
    archives.push({
      key: m[1],
      path: file,
      sizeBytes: st.size,
      createdAt: st.mtime.toISOString().replace(/\.\d+Z$/, "Z"),
    });
  }
  return archives;
}

/**
 * One action of the plan. `reason` makes a skipped action self-explanatory in
 * the report; `archive: true` routes a removal through the archive module.
 */
function buildActions(decisions, now) {
  const actions = [];
  for (const d of decisions) {
    if (d.action === "remove") {
      actions.push({ type: "remove", key: d.copy.key, path: d.copy.path });
    } else if (d.action === "archive-remove") {
      actions.push({ type: "archive-remove", key: d.copy.key, path: d.copy.path });
    } else if (d.action === "prune") {
      actions.push({ type: "prune", key: d.copy.key, path: d.copy.path });
    } else {
      actions.push({
        type: "skip",
        key: d.copy.key,
        path: d.copy.path,
        reason: d.reason || "kept by rules",
      });
    }
  }
  return actions;
}

/**
 * Executes the plan; a failing action never stops the rest — its error lands
 * in the report row. Actions run without shell interpolation (spawn-style
 * argv into the injected runner).
 */
async function executeActions(plan, modules) {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return Promise.all(
    plan.map(async (item) => {
      const base = { at, path: item.path };
      try {
        if (item.type === "remove") {
          await modules.remove(item.path);
          return { ...base, action: "remove", result: "ok" };
        }
        if (item.type === "archive-remove") {
          const out = await modules.archiveRemove(item.path, item.key);
          const row = { ...base, action: "archive", result: "ok" };
          if (out && out.archivePath) row.detail = out.archivePath;
          return row;
        }
        if (item.type === "prune") {
          await modules.prune();
          return { ...base, action: "remove", result: "ok", detail: "worktree prune" };
        }
        return { ...base, action: "skip", result: "skipped", detail: item.reason };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        return { ...base, action: item.type === "skip" ? "skip" : item.type === "archive-remove" ? "archive" : "remove", result: "error", detail: message.slice(0, 500) };
      }
    }),
  );
}

/** The report `actions` slice: at most the last 200 rows (contract C4). */
function capActions(rows, limit = 200) {
  return rows.slice(-limit);
}

/**
 * Runs one botd pass. Everything outside the pure flow arrives through
 * `modules` — a sibling BOT-DISK-H module or a test fake; the loop itself
 * never shells out and never decides deletion policy beyond wiring:
 *
 *   inventory (wsCli.list + bases + archives)
 *   → desired (boardClient.desiredState)
 *   → rules.decide (pure rules module)
 *   → execute (remove / archive-remove / prune; one failure skips one action)
 *   → report.build + boardClient.postReport (retry handled by report.js)
 *   → write disk-state.json from the pressure the desired state carried.
 *
 * A pass without `desired.ok` deletes nothing (fail-safe) but still reports
 * and refreshes disk-state when the previous state file is known-good.
 */
async function runPass(modules, env = {}) {
  const home = modules.home;
  const now = env.now ? new Date(env.now) : new Date();

  const registry = loadRegistry(home);
  const listed = await modules.wsCli.list();
  const copies = listed && Array.isArray(listed.entries) ? listed.entries : [];
  const bases = listBases(home);
  const archives = listArchives(home);

  const inventory = { copies, registryEntries: registry.entries, bases, archives };

  const desired = await modules.boardClient.desiredState();

  let decisions = [];
  if (desired.ok) {
    decisions = modules.rules.decide({ inventory, desired: desired.state, now });
  } else {
    decisions = inventory.copies.map((copy) => ({
      copy,
      action: "skip",
      reason: `desired state unavailable (${desired.error || "board error"}); fail-safe keeps everything`,
    }));
  }

  const plan = buildActions(decisions, now);
  const actionRows = capActions(await executeActions(plan, modules));

  const reportBody = await modules.report.build({
    inventory,
    actions: actionRows,
    now,
    desired,
  });
  const reportResult = await modules.boardClient.postReport(reportBody);

  // disk-state.json mirrors the pressure of the desired state; on a board
  // failure the last known file stays (fail-safe), only its writer is botd.
  if (desired.ok) {
    const pressure = desired.state.pressure || {};
    const diskState = {
      version: 1,
      quotaPercent: pressure.quotaPercent ?? null,
      partitionPercent: pressure.partitionPercent ?? 0,
      pressure: pressure.level || "none",
      updatedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
    };
    writeJsonAtomic(path.join(home, "disk-state.json"), diskState);
  }

  return {
    ok: desired.ok,
    desiredError: desired.ok ? null : desired.error || "board error",
    copies: copies.length,
    actions: actionRows,
    report: reportResult,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

module.exports = {
  runPass,
  buildActions,
  executeActions,
  loadRegistry,
  listBases,
  listArchives,
  duBytes,
  removeTree,
  writeJsonAtomic,
};
