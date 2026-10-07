import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5-BOT-DISK-H3e): integration test of the botd main loop with
// fake sibling modules and a fake board — the acceptance of the ticket:
// a closing copy is removed and lands in the report's actions; a failed
// desired state (desired.ok=false) removes nothing and the report carries
// the reason; the report passes the C4 schema; disk-state.json is written;
// one failing action never stops the others.
//
// The loop is wired by contract to the sibling modules:
//   classify (#745) — classifyAll / toReportParts / toInventory,
//   desired (#740) — createDesiredClient().getLast,
//   rules (#742) — plan(inventory, desired, now).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BOTD_DIR = path.join(ROOT, "docker/bot-runtime/botd");
const CONTRACT_DIR = path.join(ROOT, "docs/myrmidon/bot-disk-contract");

const loop = await import(path.join(BOTD_DIR, "lib/loop.js"));
const report = await import(path.join(BOTD_DIR, "lib/report.js"));

/** The C4 body must satisfy the strict zod schema of the H0 contract package. */
let wsDiskReportSchema = null;
try {
  // server/node_modules carries zod + @paperclipai/shared after pnpm install;
  // missing deps (bare checkout) degrade to the hand check below
  const { createRequire } = await import("node:module");
  const requireShared = createRequire(path.join(ROOT, "server/package.json"));
  ({ wsDiskReportSchema } = requireShared("@paperclipai/shared/myrmidon-bot-workspace"));
} catch {
  /* hand check below */
}
function assertC4Shape(body) {
  if (wsDiskReportSchema) {
    const parsed = wsDiskReportSchema.safeParse(body);
    assert.ok(parsed.success, `C4 schema violation: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))}`);
  } else {
    assert.equal(body.schema, 1);
    assert.ok(body.botKey && body.imageGeneration, "identity fields");
    for (const copy of body.copies) assert.ok(["E", "G", "X"].includes(copy.class));
    for (const action of body.actions) {
      assert.ok(["remove", "archive", "restore", "open", "skip"].includes(action.action));
      assert.ok(["ok", "error", "skipped"].includes(action.result));
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") <= 1024 * 1024, "report over the 1 MiB body cap");
}

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "botd-loop-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A fake board serving desired state + receiving reports. */
function fakeBoard(t, { desired, onReport }) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/myrmidon/bots/me/workspaces") {
      if (desired.errorStatus) {
        res.writeHead(desired.errorStatus).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(desired.state));
      return;
    }
    if (req.method === "POST" && req.url === "/api/myrmidon/bots/me/disk-report") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        received.push(body);
        if (onReport) onReport(body);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nextReportSec: 60 }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve({ url: `http://127.0.0.1:${server.address().port}`, received });
    });
  });
}

const DESIRED_OK = {
  generatedAt: "2026-10-07T01:00:00Z",
  grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24 },
  pressure: { quotaPercent: 41.2, partitionPercent: 55.0, level: "none" },
  workspaces: [
    { key: "ABC-101", repo: "acme/widgets", state: "active", since: "2026-10-07T00:30:00Z", prState: "open", branch: "bot/ABC-101" },
    { key: "ABC-099", repo: "acme/widgets", state: "closing", since: "2026-10-07T00:20:00Z", prState: "merged", branch: "bot/ABC-099" },
  ],
};

/** Fake sibling modules wired to the loop by contract. */
function fakeModules({ classifyAll, plan, removeWorktree, archiveRemove, prune, deleteBase, deleteArchive }) {
  return {
    classify: {
      classifyAll: classifyAll || (() => ({ items: [], bases: [], archives: [] })),
      toReportParts: (items, actions = []) => ({
        copies: items.map((it) => ({
          path: it.path,
          class: it.class,
          key: path.basename(it.path),
          clean: null,
          pushed: null,
          sizeBytes: it.sizeBytes ?? null,
          ageSec: it.ageSec ?? 0,
          ...(it.class === "X" ? { reason: `foreign (${it.sign})` } : {}),
        })),
        foreign: items.filter((it) => it.class === "X").map((it) => ({ path: it.path, sign: it.sign })),
      }),
      toInventory: (items) => ({
        worktrees: items.filter((it) => it.class === "E").map((it) => ({
          key: path.basename(it.path),
          path: it.path,
          dirMissing: false,
          clean: null,
          pushed: null,
          openedAt: new Date().toISOString(),
        })),
        scratch: items.filter((it) => it.class === "G" || it.class === "X").map((it) => ({
          name: path.basename(it.path),
          path: it.path,
          mtime: new Date().toISOString(),
          isGit: false,
          clean: null,
          pushed: null,
        })),
        bases: [],
        archives: [],
      }),
    },
    desiredClient: null, // set per test
    rules: { plan: plan || (() => ({ actions: [], pressure: "none", blockOpen: false })) },
    removeWorktree: removeWorktree || null,
    archiveRemove: archiveRemove || null,
    prune: prune || null,
    deleteBase: deleteBase || null,
    deleteArchive: deleteArchive || null,
  };
}

function makeConfig(home, boardUrl) {
  return {
    board: { url: boardUrl, apiKey: "test" },
    identity: { botKey: "bot-001", imageGeneration: "myr-v1.6.5-rc.5" },
    roots: {
      worktreesRoot: path.join(home, "worktrees"),
      scratchRoot: path.join(home, "scratch"),
      basesRoot: path.join(home, "bases"),
      archivesRoot: path.join(home, "archives"),
      scanRoots: [path.join(home, "worktrees"), path.join(home, "scratch")],
    },
    stateDir: home,
    intervalMs: 60_000,
    reportRetryDelayMs: 0,
    selfChecks: { reflink: true, gitref: true, wsCli: null },
  };
}

describe("botd main loop (H3e)", () => {
  it("removes the closing copy and reports the action", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const removed = [];
    const modules = fakeModules({
      classifyAll: () => ({
        items: [
          { path: "/workspace/ABC-101", class: "E", sizeBytes: 100, ageSec: 3600 },
          { path: "/workspace/ABC-099", class: "E", sizeBytes: 200, ageSec: 7200 },
        ],
        bases: [],
        archives: [],
      }),
      plan: (inventory, desired, now) => ({
        actions: inventory.worktrees
          .filter((wt) => {
            const want = desired.workspaces.find((w) => w.key === wt.key);
            return want && want.state === "closing";
          })
          .map((wt) => ({ op: "remove", path: wt.path, reason: "closing", key: wt.key })),
        pressure: "none",
        blockOpen: false,
      }),
      removeWorktree: async (p) => { removed.push(p); return { freedBytes: 200 }; },
    });
    modules.desiredClient = { getLast: () => ({ ok: true, state: DESIRED_OK }) };

    const config = makeConfig(home, board.url);
    const deps = loop.defaultDeps(modules);
    const result = await loop.runPass(config, deps);

    assert.equal(result.posted.ok, true);
    assert.deepEqual(removed, ["/workspace/ABC-099"]);
    assert.equal(board.received.length, 1);
    const body = board.received[0];
    assertC4Shape(body);
    const removeRow = body.actions.find((a) => a.path === "/workspace/ABC-099");
    assert.ok(removeRow, "the removal must land in actions");
    assert.equal(removeRow.action, "remove");
    assert.equal(removeRow.result, "ok");

    const diskState = JSON.parse(fs.readFileSync(path.join(home, "disk-state.json"), "utf8"));
    assert.equal(diskState.ok, true);
    assert.equal(body.schema, 1);
  });

  it("desired.ok=false removes nothing and the report carries the reason", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { errorStatus: 503 } });
    const removed = [];
    const modules = fakeModules({
      classifyAll: () => ({
        items: [{ path: "/workspace/ABC-101", class: "E", sizeBytes: 100, ageSec: 3600 }],
        bases: [],
        archives: [],
      }),
      plan: () => { throw new Error("rules must not run without a desired state"); },
      removeWorktree: async (p) => { removed.push(p); },
    });
    modules.desiredClient = { getLast: () => ({ ok: false, reason: "HTTP 503" }) };

    const config = makeConfig(home, board.url);
    const deps = loop.defaultDeps(modules);
    const result = await loop.runPass(config, deps);

    assert.equal(result.posted.ok, true); // report still delivered
    assert.deepEqual(removed, []);
    const body = board.received[0];
    assertC4Shape(body);
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].result, "error");
    assert.match(body.actions[0].reason, /desired\.ok=false/);
  });

  it("a failing action does not stop the rest", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const removed = [];
    const modules = fakeModules({
      classifyAll: () => ({
        items: [
          { path: "/workspace/ABC-101", class: "E", sizeBytes: 100, ageSec: 3600 },
          { path: "/workspace/ABC-099", class: "E", sizeBytes: 200, ageSec: 7200 },
        ],
        bases: [],
        archives: [],
      }),
      plan: (inventory) => ({
        actions: inventory.worktrees.map((wt) => ({ op: "remove", path: wt.path, reason: "test", key: wt.key })),
        pressure: "none",
        blockOpen: false,
      }),
      removeWorktree: async (p) => {
        if (p === "/workspace/ABC-101") throw new Error("simulated removal failure");
        removed.push(p);
      },
    });
    modules.desiredClient = { getLast: () => ({ ok: true, state: DESIRED_OK }) };

    const config = makeConfig(home, board.url);
    const deps = loop.defaultDeps(modules);
    const result = await loop.runPass(config, deps);

    assert.equal(result.posted.ok, true);
    assert.deepEqual(removed, ["/workspace/ABC-099"]);
    const body = board.received[0];
    const failed = body.actions.find((a) => a.path === "/workspace/ABC-101");
    const fine = body.actions.find((a) => a.path === "/workspace/ABC-099");
    assert.equal(failed.result, "error");
    assert.match(failed.reason, /simulated removal failure/);
    assert.equal(fine.result, "ok");
    assert.equal(result.actions.length, 2);
  });

  it("archive-remove routes through the archive module", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const archived = [];
    const modules = fakeModules({
      classifyAll: () => ({
        items: [
          { path: "/workspace/ABC-101", class: "E", sizeBytes: 100, ageSec: 3600 },
          { path: "/workspace/ABC-099", class: "E", sizeBytes: 200, ageSec: 7200 },
        ],
        bases: [],
        archives: [],
      }),
      plan: (inventory) => ({
        actions: inventory.worktrees.map((wt) => ({
          op: wt.key === "ABC-099" ? "archive-remove" : "remove",
          path: wt.path,
          reason: "test",
          key: wt.key,
        })),
        pressure: "none",
        blockOpen: false,
      }),
      removeWorktree: async () => {},
      archiveRemove: async (p, key) => {
        archived.push([p, key]);
        return { archivePath: "/data/hermes/.myrmidon/archive/ABC-099-20261007T010000Z.bundle" };
      },
    });
    modules.desiredClient = { getLast: () => ({ ok: true, state: DESIRED_OK }) };

    const config = makeConfig(home, board.url);
    const deps = loop.defaultDeps(modules);
    await loop.runPass(config, deps);

    assert.deepEqual(archived, [["/workspace/ABC-099", "ABC-099"]]);
    const row = board.received[0].actions.find((a) => a.path === "/workspace/ABC-099");
    assert.equal(row.action, "archive");
    assert.equal(row.result, "ok");
  });

  it("the report is capped at 200 actions", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const many = Array.from({ length: 250 }, (_, i) => ({
      path: `/workspace/ABC-${i}`,
      class: "G",
      sizeBytes: 100,
      ageSec: 3600,
    }));
    const modules = fakeModules({
      classifyAll: () => ({ items: many, bases: [], archives: [] }),
      plan: (inventory) => ({
        actions: inventory.scratch.map((s) => ({ op: "remove", path: s.path, reason: "cap test", key: s.name })),
        pressure: "none",
        blockOpen: false,
      }),
      removeWorktree: async () => {},
    });
    modules.desiredClient = { getLast: () => ({ ok: true, state: DESIRED_OK }) };

    const config = makeConfig(home, board.url);
    const deps = loop.defaultDeps(modules);
    await loop.runPass(config, deps);
    assert.equal(board.received[0].actions.length, 200);
  });

  it("report retries a 5xx once and succeeds", async (t) => {
    const home = makeHome(t);
    let calls = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "POST") {
        calls += 1;
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
          if (calls === 1) {
            res.writeHead(500).end("boom");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nextReportSec: 60 }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(DESIRED_OK));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}`;

    const modules = fakeModules({
      classifyAll: () => ({ items: [], bases: [], archives: [] }),
      plan: () => ({ actions: [], pressure: "none", blockOpen: false }),
    });
    modules.desiredClient = { getLast: () => ({ ok: true, state: DESIRED_OK }) };

    const config = makeConfig(home, url);
    const deps = loop.defaultDeps(modules);
    const result = await loop.runPass(config, deps);
    assert.equal(calls, 2);
    assert.equal(result.posted.ok, true);
    assert.equal(result.posted.nextReportSec, 60);
  });

  it("the shipped C4 fixture passes the shape check and report cap", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "disk-report.json"), "utf8"));
    assertC4Shape(fixture);
  });
});

describe("botd entrypoint", () => {
  it("runs one pass with BOTD_ONCE=1 against a fake board", async (t) => {
    const home = makeHome(t);
    const server = http.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(DESIRED_OK));
        return;
      }
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nextReportSec: 60 }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());

    // spawnSync deadlocks with a fetch-using child on node 24 (libuv);
    // async spawn is what the runtime uses for the daemon anyway
    const proc = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(BOTD_DIR, "botd")], {
        env: {
          ...process.env,
          BOTD_ONCE: "1",
          BOTD_STATE_DIR: home,
          BOTD_WORKTREES_ROOT: path.join(home, "worktrees"),
          BOTD_SCRATCH_ROOT: path.join(home, "scratch"),
          PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`,
          PAPERCLIP_API_KEY: "test",
          PAPERCLIP_BOT_KEY: "bot-001",
          PAPERCLIP_IMAGE_GENERATION: "myr-v1.6.5-rc.5",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("exit", (status, signal) => {
        clearTimeout(killer);
        resolve({ status, signal, stdout, stderr });
      });
    });
    assert.equal(proc.status, 0, `botd exit ${proc.status}/${proc.signal}: ${proc.stderr.slice(0, 500)}`);
    assert.match(proc.stdout, /botd single pass done/);
    assert.match(proc.stdout, /reportOk":true/);
    const diskState = JSON.parse(fs.readFileSync(path.join(home, "disk-state.json"), "utf8"));
    assert.equal(diskState.ok, true);
  });
});
