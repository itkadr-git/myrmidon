import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5-BOT-DISK-H3e): integration test of the botd main loop with
// fake sibling modules and a fake board — the acceptance of the ticket:
// a closing copy is removed and lands in the report's actions; a failed
// desired state (desired.ok=false) removes nothing and the report carries
// the reason; the report passes the C4 schema; disk-state.json is written;
// one failing action never stops the others.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BOTD_DIR = path.join(ROOT, "docker/bot-runtime/botd");
const CONTRACT_DIR = path.join(ROOT, "docs/myrmidon/bot-disk-contract");

const loop = createRequire(import.meta.url)(path.join(BOTD_DIR, "lib/loop.js"));
const report = createRequire(import.meta.url)(path.join(BOTD_DIR, "lib/report.js"));

/** The C4 body must satisfy the strict zod schema of the H0 contract package. */
let wsDiskReportSchema = null;
try {
  // server/node_modules carries zod + @paperclipai/shared after pnpm install;
  // missing deps (bare checkout) degrade to the hand check below
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

function fakeModules(home, boardUrl, { rulesDecide, extra } = {}) {
  return {
    home,
    wsCli: {
      async list() {
        return {
          ok: true,
          entries: [
            { key: "ABC-101", path: "/workspace/ABC-101", class: "E", repo: "acme/widgets", branch: "bot/ABC-101", openedAt: "2026-10-07T00:30:00Z", clean: true, pushed: true },
            { key: "ABC-099", path: "/workspace/ABC-099", class: "E", repo: "acme/widgets", branch: "bot/ABC-099", openedAt: "2026-10-06T20:00:00Z", clean: true, pushed: true },
          ],
        };
      },
    },
    boardClient: {
      desiredState: () => report.fetchDesiredState({ boardUrl, apiKey: "test", fetchImpl: globalThis.fetch }),
      postReport: (body) => report.postReport({ boardUrl, apiKey: "test", fetchImpl: globalThis.fetch, body, retryDelayMs: 0 }),
    },
    rules: {
      decide: rulesDecide,
    },
    remove: async () => {},
    archiveRemove: async () => ({ archivePath: "/data/hermes/.myrmidon/archive/ABC-099-20261007T010000Z.bundle" }),
    prune: async () => {},
    report: {
      build: async ({ inventory, actions, now }) =>
        report.buildReport({ inventory, actions, now, botKey: "bot-001", imageGeneration: "myr-v1.6.5-rc.5" }),
    },
    ...extra,
  };
}

describe("botd main loop (H3e)", () => {
  it("removes the closing copy and reports the action", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const removed = [];
    const modules = fakeModules(home, board.url, {
      rulesDecide: ({ inventory, desired }) =>
        inventory.copies.map((copy) => {
          const want = desired.workspaces.find((w) => w.key === copy.key);
          if (want && want.state === "closing") return { copy, action: "remove" };
          return { copy, action: "keep", reason: "active" };
        }),
      extra: { remove: async (p) => removed.push(p) },
    });

    const result = await loop.runPass(modules, { now: new Date("2026-10-07T01:05:00Z") });

    assert.equal(result.ok, true);
    assert.deepEqual(removed, ["/workspace/ABC-099"]);
    assert.equal(board.received.length, 1);
    const body = board.received[0];
    assertC4Shape(body);
    const removeRow = body.actions.find((a) => a.path === "/workspace/ABC-099");
    assert.ok(removeRow, "the removal must land in actions");
    assert.equal(removeRow.action, "remove");
    assert.equal(removeRow.result, "ok");
    const skipRow = body.actions.find((a) => a.path === "/workspace/ABC-101");
    assert.equal(skipRow.result, "skipped");

    const diskState = JSON.parse(fs.readFileSync(path.join(home, "disk-state.json"), "utf8"));
    assert.deepEqual(diskState, {
      version: 1,
      quotaPercent: 41.2,
      partitionPercent: 55.0,
      pressure: "none",
      updatedAt: "2026-10-07T01:05:00Z",
    });
  });

  it("desired.ok=false removes nothing and the report carries the reason", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { errorStatus: 503 } });
    const removed = [];
    const modules = fakeModules(home, board.url, {
      rulesDecide: () => {
        throw new Error("rules must not run without a desired state");
      },
      extra: { remove: async (p) => removed.push(p) },
    });

    const result = await loop.runPass(modules, { now: new Date("2026-10-07T01:05:00Z") });

    assert.equal(result.ok, false);
    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(path.join(home, "disk-state.json")), false, "no disk-state write without a desired state");
    const body = board.received[0];
    assertC4Shape(body);
    assert.equal(body.actions.length, 2);
    for (const row of body.actions) {
      assert.equal(row.result, "skipped");
      assert.match(row.detail, /desired state unavailable/);
    }
  });

  it("a failing action does not stop the rest", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const modules = fakeModules(home, board.url, {
      rulesDecide: ({ inventory }) => inventory.copies.map((copy) => ({ copy, action: "remove" })),
      extra: {
        remove: async (p) => {
          if (p === "/workspace/ABC-101") throw new Error("simulated removal failure");
        },
      },
    });

    const result = await loop.runPass(modules);
    const body = board.received[0];
    const failed = body.actions.find((a) => a.path === "/workspace/ABC-101");
    const fine = body.actions.find((a) => a.path === "/workspace/ABC-099");
    assert.equal(failed.result, "error");
    assert.match(failed.detail, /simulated removal failure/);
    assert.equal(fine.result, "ok");
    assert.equal(result.actions.length, 2);
  });

  it("archive-remove routes through the archive module", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const archived = [];
    const modules = fakeModules(home, board.url, {
      rulesDecide: ({ inventory }) =>
        inventory.copies.map((copy) => ({ copy, action: copy.key === "ABC-099" ? "archive-remove" : "keep" })),
      extra: {
        archiveRemove: async (p, key) => {
          archived.push([p, key]);
          return { archivePath: "/data/hermes/.myrmidon/archive/ABC-099-20261007T010000Z.bundle" };
        },
      },
    });

    await loop.runPass(modules);
    assert.deepEqual(archived, [["/workspace/ABC-099", "ABC-099"]]);
    const row = board.received[0].actions.find((a) => a.path === "/workspace/ABC-099");
    assert.equal(row.action, "archive");
    assert.equal(row.result, "ok");
  });

  it("the report is capped at 200 actions", async (t) => {
    const home = makeHome(t);
    const board = await fakeBoard(t, { desired: { state: DESIRED_OK } });
    const many = Array.from({ length: 250 }, (_, i) => ({
      key: `ABC-${i}`,
      path: `/workspace/ABC-${i}`,
      class: "G",
      openedAt: "2026-10-07T00:00:00Z",
      clean: null,
      pushed: null,
    }));
    const modules = fakeModules(home, board.url, {
      rulesDecide: ({ inventory }) => inventory.copies.map((copy) => ({ copy, action: "skip", reason: "cap test" })),
    });
    modules.wsCli.list = async () => ({ ok: true, entries: many });

    await loop.runPass(modules);
    assert.equal(board.received[0].actions.length, 200);
  });

  it("report retries a 5xx once and succeeds", async (t) => {
    const home = makeHome(t);
    let calls = 0;
    const board = await fakeBoard(t, {
      desired: { state: DESIRED_OK },
      onReport: () => {},
    });
    // wrap: first POST fails with 500
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

    const modules = fakeModules(home, url, {
      rulesDecide: ({ inventory }) => inventory.copies.map((copy) => ({ copy, action: "skip", reason: "retry test" })),
    });
    const result = await loop.runPass(modules);
    assert.equal(calls, 2);
    assert.equal(result.report.ok, true);
    assert.equal(result.report.nextReportSec, 60);
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

    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "botd-modules-"));
    t.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));
    // stub myr-ws on PATH: answers `list --json` with two copies
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "botd-bin-"));
    t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(binDir, "myr-ws"),
      "#!/bin/sh\nprintf '%s' '{\"ok\":true,\"entries\":[{\"key\":\"ABC-101\",\"path\":\"/workspace/ABC-101\",\"class\":\"E\",\"openedAt\":\"2026-10-07T00:30:00Z\",\"clean\":true,\"pushed\":true}]}'\n",
    );
    fs.chmodSync(path.join(binDir, "myr-ws"), 0o755);

    // spawnSync deadlocks with a fetch-using child on node 24 (libuv);
    // async spawn is what the runtime uses for the daemon anyway
    const proc = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(BOTD_DIR, "botd")], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          BOTD_ONCE: "1",
          BOTD_HOME: home,
          BOTD_BOARD_URL: `http://127.0.0.1:${server.address().port}`,
          PAPERCLIP_API_KEY: "test",
          BOTD_BOT_KEY: "bot-001",
          BOTD_IMAGE_GENERATION: "myr-v1.6.5-rc.5",
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
    assert.match(proc.stdout, /\[botd\] pass ok=true/);
    const diskState = JSON.parse(fs.readFileSync(path.join(home, "disk-state.json"), "utf8"));
    assert.equal(diskState.pressure, "none");
    // stub rules: nothing removed, everything skipped
    assert.match(proc.stdout, /actions=1/);
  });
});
