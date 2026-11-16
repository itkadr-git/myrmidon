import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import { EventEmitter } from "node:events";

async function runner(mode = "dev") {
  const files = new Map([["server/a.ts", 1]]);
  const statuses = [];
  const intervals = [];
  const requests = [];
  let scans = 0;
  let failScan = false;
  let now = 1000;
  const root = "/fixture";
  const absolute = (p) => path.join(root, p);
  const fs = {
    existsSync(p) {
      if (p === absolute("server")) { scans++; if (failScan) { failScan = false; throw new Error("scan failed"); } return true; }
      return files.has(path.relative(root, p));
    },
    readdirSync() {
      return [...files.keys()].filter((p) => p.startsWith("server/")).map((p) => ({ name: p.slice(7), isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }));
    },
    statSync(p) { return { mtimeMs: files.get(path.relative(root, p)), size: 1 }; },
    mkdirSync() {}, rmSync() {},
    writeFileSync(_p, data) { statuses.push(JSON.parse(data)); },
  };
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    requests.push({ resolve(payload = { status: "ready" }) { proc.stdout.emit("data", JSON.stringify(payload)); proc.emit("exit", 0, null); } });
    return proc;
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const fakeProcess = { argv: ["node", "runner", mode], env: {}, platform: "linux", on() {}, stderr: { write() {} }, exit() { throw new Error("unexpected exit"); } };
  const context = vm.createContext({ process: fakeProcess, Date: Clock, console: { log() {}, error() {} }, setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, setTimeout() { throw new Error("unexpected timeout"); }, clearTimeout() {}, fetch() { throw new Error("unexpected fetch"); } });
  const modules = {
    "node:child_process": { spawn }, "node:crypto": { randomUUID: () => "fixture" }, "node:fs": fs,
    "node:path": { default: path }, "node:readline/promises": { createInterface() { throw new Error("unexpected prompt"); } },
    "node:process": { stdin: {}, stdout: {} }, "node:url": url,
    "./dev-runner-paths.mjs": { shouldTrackDevServerPath: () => true },
    "./dev-runner-output.mjs": { createCapturedOutputBuffer() { let text = ""; return { append(chunk) { text += chunk; }, finish() { return { text }; } }; }, parseJsonResponseWithLimit() { throw new Error("unexpected response"); } },
  };
  const source = await readFile(new URL("./dev-runner.mjs", import.meta.url), "utf8");
  const marker = "\nawait maybePreflightMigrations();";
  const end = source.lastIndexOf(marker);
  assert.notEqual(end, -1);
  const module = new vm.SourceTextModule(source.slice(0, end) + `\nexport { scanForBackendChanges, markChildAsCurrent, installDevIntervals };\nexport function setRestart(value) { restartInFlight = value; }\n`, { context, initializeImportMeta(meta) { meta.url = "file:///fixture/scripts/dev-runner.mjs"; } });
  await module.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  return { api: module.namespace, files, statuses, intervals, requests, scans: () => scans, failNextScan() { failScan = true; }, clock(value) { now = value; } };
}

test("overlapping scans serialize refresh and preserve accumulated additions and deletions", async () => {
  const r = await runner();
  const initial = r.scans();
  r.files.set("server/b.ts", 2);
  const first = r.api.scanForBackendChanges();
  assert.equal(r.requests.length, 1);
  r.files.delete("server/a.ts");
  await r.api.scanForBackendChanges();
  assert.equal(r.scans(), initial + 1);
  r.requests.shift().resolve(); await first;
  r.clock(2000);
  const second = r.api.scanForBackendChanges();
  assert.equal(r.scans(), initial + 2);
  r.requests.shift().resolve(); await second;
  assert.deepEqual(r.statuses.at(-1).changedPathsSample, ["server/a.ts", "server/b.ts"]);
  assert.equal(r.statuses.at(-1).lastChangedAt, new Date(2000).toISOString());
  const count = r.statuses.length;
  await r.api.scanForBackendChanges();
  assert.equal(r.requests.length, 0); assert.equal(r.statuses.length, count);
});

test("restart replaces baseline and clears dirty state before refreshing status", async () => {
  const r = await runner();
  r.files.set("server/a.ts", 2);
  let pending = r.api.scanForBackendChanges(); r.requests.shift().resolve(); await pending;
  r.files.set("server/c.ts", 3); r.clock(3000);
  pending = r.api.markChildAsCurrent();
  r.requests.shift().resolve(); await pending;
  const status = r.statuses.at(-1);
  assert.equal(status.dirty, false); assert.equal(status.lastChangedAt, null);
  assert.equal(status.lastRestartAt, new Date(3000).toISOString());
  assert.deepEqual(status.changedPathsSample, []);
  await r.api.scanForBackendChanges(); assert.equal(r.requests.length, 0);
  r.files.delete("server/c.ts");
  pending = r.api.scanForBackendChanges(); r.requests.shift().resolve(); await pending;
  assert.deepEqual(r.statuses.at(-1).changedPathsSample, ["server/c.ts"]);
});

test("restart guard and failed scan allow a later scan", async () => {
  const r = await runner();
  r.files.set("server/a.ts", 2);
  const count = r.scans(); r.api.setRestart(true);
  await r.api.scanForBackendChanges(); assert.equal(r.scans(), count);
  r.api.setRestart(false); r.failNextScan();
  await assert.rejects(r.api.scanForBackendChanges(), /scan failed/);
  const pending = r.api.scanForBackendChanges();
  assert.equal(r.requests.length, 1); r.requests.shift().resolve(); await pending;
  assert.deepEqual(r.statuses.at(-1).changedPathsSample, ["server/a.ts"]);
});

test("watch skips scanning and timers; dev installs both intervals", async () => {
  const watch = await runner("watch"); const count = watch.scans();
  watch.files.set("server/a.ts", 4);
  await watch.api.scanForBackendChanges(); watch.api.installDevIntervals();
  assert.equal(watch.scans(), count); assert.equal(watch.requests.length, 0); assert.equal(watch.intervals.length, 0);
  const dev = await runner(); dev.api.installDevIntervals();
  assert.deepEqual(dev.intervals.map((item) => item.ms), [1500, 2500]);
  dev.files.set("server/a.ts", 4); dev.intervals[0].fn();
  assert.equal(dev.requests.length, 1); dev.requests.shift().resolve();
});
