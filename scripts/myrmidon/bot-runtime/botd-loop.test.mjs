import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H3e): the botd loop with fake modules and a fake board.
// The report must pass the C4 schema (hand-mirrored in report.js, checked here
// against the contract fixtures); disk-state.json is written; a failing action
// does not stop the others; without desired state nothing is removed.
// Placeholder keys and repositories only.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { createLoop } = await import(path.join(ROOT, "docker/bot-runtime/botd/lib/loop.js"));
const { buildReport, createReporter, validateReport, MAX_ACTIONS } = await import(
  path.join(ROOT, "docker/bot-runtime/botd/lib/report.js")
);
const FIXTURES = path.join(ROOT, "docs/myrmidon/bot-disk-contract");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

const NOW = new Date("2026-10-06T15:00:00Z");
const API_KEY = "test-key-never-logged";

function desiredState(over = {}) {
  return { ...fixture("desired-state.json"), ...over };
}

/** Fake board: the C4 route with a switchable behaviour. */
function fakeBoard(script = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = script[Math.min(calls.length - 1, script.length - 1)] ?? { status: 200 };
    if (step.throw) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
    const body = step.body ?? fixture("disk-report-response.json");
    return { status: step.status ?? 200, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

function rig({ desired, plan, executor, gatherParts, board = fakeBoard(), settings } = {}) {
  const logs = [];
  const states = [];
  const executed = [];
  const reporter = createReporter({
    env: { PAPERCLIP_API_URL: "http://board.test", PAPERCLIP_API_KEY: API_KEY },
    fetchImpl: board.fetchImpl,
    sleep: async () => {},
    log: (l) => logs.push(l),
  });
  const closingPath = "/workspace/ABC-099";
  const loop = createLoop({
    desired: { poll: async () => desired ?? { ok: true, state: desiredState() } },
    gather: async () => ({
      inventory: { worktrees: [{ key: "ABC-099", path: closingPath }], scratch: [], bases: [], archives: [] },
      parts: gatherParts ?? {
        copies: [{ path: closingPath, class: "E", key: "ABC-099", clean: true, pushed: true, sizeBytes: 1000, ageSec: 3600 }],
        foreign: [],
        bases: [],
        archives: [],
        selfChecks: { reflink: true, gitref: true, wsCli: true },
      },
    }),
    rules: {
      plan: plan ?? (() => ({ actions: [{ op: "remove", path: closingPath, reason: "closing-clean-pushed", key: "ABC-099" }] })),
    },
    executor: executor ?? {
      remove: async (a) => {
        executed.push(a);
        return "closed";
      },
    },
    report: { build: buildReport, send: reporter.send },
    writeDiskState: async (s) => states.push(s),
    log: (l) => logs.push(l),
    now: () => NOW,
    botKey: "bot-001",
    imageGeneration: "myr-v1.6.5-rc.5",
    settings,
  });
  return { loop, logs, states, executed, board };
}

describe("botd loop: one pass", () => {
  it("removes the closing copy, reports it in actions, writes disk-state.json and sends a C4 report", async () => {
    const r = rig();
    const out = await r.loop.runOnce();
    assert.equal(out.desiredOk, true);
    assert.deepEqual(r.executed.map((a) => a.path), ["/workspace/ABC-099"]);
    assert.equal(r.board.calls.length, 1);
    const call = r.board.calls[0];
    assert.equal(call.url, "http://board.test/api/myrmidon/bots/me/disk-report");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(validateReport(call.body), { ok: true });
    assert.equal(call.body.botKey, "bot-001");
    assert.equal(call.body.actions.length, 1);
    assert.deepEqual(
      { action: call.body.actions[0].action, path: call.body.actions[0].path, result: call.body.actions[0].result },
      { action: "remove", path: "/workspace/ABC-099", result: "ok" },
    );
    assert.equal(r.states.length, 1);
    assert.deepEqual(r.states[0], { version: 1, quotaPercent: 41.2, partitionPercent: 55, pressure: "none", updatedAt: "2026-10-06T15:00:00Z" });
    assert.equal(out.sent.ok, true);
  });

  it("archive-remove is reported as the contract action `archive`", async () => {
    const r = rig({
      plan: () => ({ actions: [{ op: "archive-remove", path: "/workspace/ABC-099", reason: "closing-unpushed", key: "ABC-099" }] }),
      executor: { "archive-remove": async () => ({ detail: "archived to /x.bundle" }) },
    });
    await r.loop.runOnce();
    assert.equal(r.board.calls[0].body.actions[0].action, "archive");
    assert.match(r.board.calls[0].body.actions[0].detail, /archived to/);
  });

  it("desired.ok=false: 0 removals, a report with the reason, no disk-state, rules not asked", async () => {
    let planned = 0;
    const r = rig({
      desired: { ok: false, reason: "auth rejected: HTTP 403" },
      plan: () => {
        planned += 1;
        return { actions: [{ op: "remove", path: "/workspace/ABC-099", reason: "x", key: "ABC-099" }] };
      },
    });
    const out = await r.loop.runOnce();
    assert.equal(out.desiredOk, false);
    assert.equal(planned, 0);
    assert.deepEqual(r.executed, []);
    assert.deepEqual(r.states, []);
    const body = r.board.calls[0].body;
    assert.deepEqual(validateReport(body), { ok: true });
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].action, "skip");
    assert.equal(body.actions[0].result, "skipped");
    assert.match(body.actions[0].detail, /auth rejected: HTTP 403/);
  });

  it("a failing action does not stop the others and is reported as error", async () => {
    const calls = [];
    const r = rig({
      plan: () => ({
        actions: [
          { op: "remove", path: "/workspace/ABC-001", reason: "closing-clean-pushed", key: "ABC-001" },
          { op: "archive-remove", path: "/workspace/ABC-002", reason: "closing-unpushed", key: "ABC-002" },
          { op: "delete-archive", path: "/data/hermes/.myrmidon/archive/old.bundle", reason: "archive-30d" },
          { op: "delete-base", path: "/data/hermes/.myrmidon/git-base/a/b.git", reason: "base-idle-30d" },
        ],
      }),
      executor: {
        remove: async (a) => {
          calls.push(a.path);
          throw new Error("myr-ws close exit 7: unpushed work");
        },
        "archive-remove": async (a) => {
          calls.push(a.path);
          return "ok";
        },
        "delete-archive": async (a) => {
          calls.push(a.path);
        },
        // no executor for delete-base: skipped, never guessed
      },
    });
    await r.loop.runOnce();
    assert.deepEqual(calls, ["/workspace/ABC-001", "/workspace/ABC-002", "/data/hermes/.myrmidon/archive/old.bundle"]);
    const results = r.board.calls[0].body.actions.map((a) => a.result);
    assert.deepEqual(results, ["error", "ok", "ok", "skipped"]);
    assert.match(r.board.calls[0].body.actions[0].detail, /exit 7/);
    assert.deepEqual(validateReport(r.board.calls[0].body), { ok: true });
  });

  it("an inventory failure removes nothing and still reports", async () => {
    const board = fakeBoard();
    const executed = [];
    const reporter = createReporter({ env: { PAPERCLIP_API_URL: "http://b", PAPERCLIP_API_KEY: API_KEY }, fetchImpl: board.fetchImpl, sleep: async () => {} });
    const loop = createLoop({
      desired: { poll: async () => ({ ok: true, state: desiredState() }) },
      gather: async () => {
        throw new Error("disk walk failed");
      },
      rules: { plan: () => ({ actions: [{ op: "remove", path: "/workspace/ABC-099", reason: "x" }] }) },
      executor: { remove: async (a) => executed.push(a) },
      report: { build: buildReport, send: reporter.send },
      now: () => NOW,
      botKey: "bot-001",
      imageGeneration: "g",
    });
    await loop.runOnce();
    assert.deepEqual(executed, []);
    assert.equal(board.calls.length, 1);
    assert.match(board.calls[0].body.actions[0].detail, /inventory failed/);
  });

  it("a throwing rules module removes nothing and the pass still reports", async () => {
    const r = rig({
      plan: () => {
        throw new Error("rules broke");
      },
    });
    const out = await r.loop.runOnce();
    assert.deepEqual(r.executed, []);
    assert.equal(out.sent.ok, true);
    assert.match(r.board.calls[0].body.actions[0].detail, /rules failed/);
  });
});

describe("botd loop: report delivery", () => {
  it("retries a 503 with backoff and succeeds; nextReportSec only speeds the loop up", async () => {
    const board = fakeBoard([{ status: 503 }, { throw: true }, { status: 200, body: { ok: true, nextReportSec: 20 } }]);
    const r = rig({ board });
    const out = await r.loop.runOnce();
    assert.equal(board.calls.length, 3);
    assert.equal(out.sent.ok, true);
    assert.equal(out.sent.nextReportSec, 20);
  });

  it("gives up after three attempts, does not throw and does not leak the key", async () => {
    const board = fakeBoard([{ status: 500 }]);
    const r = rig({ board });
    const out = await r.loop.runOnce();
    assert.equal(board.calls.length, 3);
    assert.equal(out.sent.ok, false);
    assert.ok(!JSON.stringify(r.logs).includes(API_KEY));
  });

  it("does not retry a refused body (400) and never sends an invalid report", async () => {
    const board = fakeBoard([{ status: 400 }]);
    const reporter = createReporter({ env: { PAPERCLIP_API_URL: "http://b", PAPERCLIP_API_KEY: API_KEY }, fetchImpl: board.fetchImpl, sleep: async () => {} });
    assert.equal((await reporter.send(fixture("disk-report.json"))).ok, false);
    assert.equal(board.calls.length, 1);
    const bad = { ...fixture("disk-report.json"), schema: 2 };
    const res = await reporter.send(bad);
    assert.equal(res.ok, false);
    assert.match(res.reason, /invalid report/);
    assert.equal(board.calls.length, 1);
  });
});

describe("botd loop: SIGUSR1 and timer", () => {
  it("runs at start, wakes on SIGUSR1, and stop() detaches the handler", async () => {
    let passes = 0;
    const handlers = new Map();
    const proc = { on: (n, f) => handlers.set(n, f), off: (n) => handlers.delete(n) };
    const timers = [];
    const loop = createLoop({
      desired: { poll: async () => ((passes += 1), { ok: false, reason: "down" }) },
      gather: async () => ({ inventory: {}, parts: {} }),
      rules: { plan: () => ({ actions: [] }) },
      report: { build: buildReport, send: async () => ({ ok: true, nextReportSec: 300 }) },
      now: () => NOW,
      botKey: "bot-001",
      imageGeneration: "g",
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => {},
    });
    loop.start(proc);
    await loop.trigger();
    await new Promise((r) => setImmediate(r));
    assert.ok(passes >= 1);
    assert.equal(timers.at(-1).ms, 60_000); // nextReportSec 300 does not slow the 60 s tick
    const before = passes;
    handlers.get("SIGUSR1")();
    await new Promise((r) => setImmediate(r));
    await loop.trigger();
    assert.ok(passes > before);
    await loop.stop();
    assert.equal(handlers.size, 0);
  });
});

describe("botd report: contract", () => {
  it("the C4 fixture and a built report pass the mirrored schema; broken ones do not", () => {
    assert.deepEqual(validateReport(fixture("disk-report.json")), { ok: true });
    const r = fixture("disk-report.json");
    assert.equal(validateReport({ ...r, copies: [{ ...r.copies[0], class: "Z" }] }).ok, false);
    assert.equal(validateReport({ ...r, actions: [{ ...r.actions[0], result: "done" }] }).ok, false);
    assert.equal(validateReport({ ...r, foreign: [{ path: "/x", sign: "weird" }] }).ok, false);
    assert.equal(validateReport({ ...r, at: "2026-10-06T14:07:00+03:00" }).ok, false);
  });

  it("buildReport keeps the last 200 actions, clips long text and stays under 1 MiB", () => {
    const actions = Array.from({ length: 250 }, (_, i) => ({
      at: "2026-10-06T15:00:00Z",
      action: "remove",
      path: `/workspace/ABC-${i}`,
      result: "ok",
      detail: "d".repeat(900),
    }));
    const copies = Array.from({ length: 9000 }, (_, i) => ({ path: `/scratch/${"x".repeat(200)}${i}`, class: "G", clean: null, pushed: null, sizeBytes: null, ageSec: 1, reason: "r".repeat(600) }));
    const rep = buildReport({ botKey: "bot-001", imageGeneration: "g", at: NOW, actions, copies });
    assert.equal(rep.actions.length, MAX_ACTIONS);
    assert.equal(rep.actions[0].path, "/workspace/ABC-50");
    assert.ok(rep.actions[0].detail.length <= 500);
    assert.ok(Buffer.byteLength(JSON.stringify(rep)) <= 1024 * 1024);
    assert.deepEqual(validateReport(rep), { ok: true });
  });
});

describe("botd entry", () => {
  it("is CommonJS with a shebang, executable-intent, and parses", async () => {
    const entry = path.join(ROOT, "docker/bot-runtime/botd/botd");
    const text = fs.readFileSync(entry, "utf8");
    assert.match(text, /^#!\/usr\/bin\/env node\n"use strict";/);
    assert.ok(!/^\s*import\s/m.test(text), "entry must not use static ESM imports");
    const { spawnSync } = await import("node:child_process");
    const tmp = path.join(os.tmpdir(), `botd-check-${process.pid}.cjs`);
    fs.writeFileSync(tmp, text.replace(/^#!.*\n/, ""));
    try {
      const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
