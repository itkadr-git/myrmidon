import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

const runnerPath = path.resolve("scripts/dev-runner.mjs");

async function loadRunner({ platform = "linux", mode = "dev", args = [] } = {}) {
  const children = [];
  const exits = [];
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, {
    argv: ["node", runnerPath, mode, ...args], platform,
    env: { SENTINEL: "preserved" },
    stderr: { write() {} }, stdin: {}, stdout: {},
    exit(code) { exits.push(code); throw new Error(`process.exit:${code}`); },
  });
  const fs = {
    existsSync: () => false,
    mkdirSync() {}, readdirSync: () => [], rmSync() {}, statSync() { throw Error("unexpected stat"); }, writeFileSync() {},
  };
  function spawn(command, argv, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => { child.killedWith = signal; };
    children.push({ command, args: Array.from(argv), options, child });
    return child;
  }
  const context = vm.createContext({
    process: fakeProcess, console: { log() {}, error() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    fetch() { throw Error("unexpected fetch"); },
  });
  const source = await readFile(runnerPath, "utf8");
  const boundary = source.lastIndexOf("\nawait maybePreflightMigrations();");
  assert.notEqual(boundary, -1);
  const module = new vm.SourceTextModule(source.slice(0, boundary) + `\nexport { runPnpm, buildPluginSdk, startServerChild, waitForChildExit, stopChildForRestart };\nexport function state() { return { child, childExitPromise }; }\nexport function flags(values) { if ('restartInFlight' in values) restartInFlight = values.restartInFlight; if ('shuttingDown' in values) shuttingDown = values.shuttingDown; }`, {
    context, initializeImportMeta(meta) { meta.url = pathToFileURL(runnerPath).href; },
  });
  await module.link(async (specifier) => {
    let exports;
    if (specifier === "node:child_process") exports = { spawn };
    else if (specifier === "node:fs") exports = fs;
    else if (specifier === "node:process") exports = { stdin: fakeProcess.stdin, stdout: fakeProcess.stdout };
    else if (specifier === "node:readline/promises") exports = { createInterface() { throw Error("unexpected readline"); } };
    else exports = await import(specifier.startsWith(".") ? new URL(specifier, pathToFileURL(runnerPath)).href : specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const key of Object.keys(exports)) this.setExport(key, exports[key]);
    }, { context });
  });
  await module.evaluate();
  return { runner: module.namespace, children, exits };
}

async function start(h) {
  const pending = h.runner.startServerChild();
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.children[0].args, ["--filter", "@myrmidon/plugin-sdk", "build"]);
  h.children[0].child.emit("exit", 0, null);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.children.length, 3);
  const migration = h.children[2].child;
  migration.stdout.emit("data", Buffer.from('{"status":"ready"}'));
  migration.emit("exit", 0, null);
  await pending;
  return h.children[1].child;
}

test("runPnpm captures streams, exit signal, options and spawn errors", async () => {
  const h = await loadRunner({ platform: "win32" });
  const promise = h.runner.runPnpm(["test"], { cwd: "/work", env: { CUSTOM: "yes" }, stdio: "pipe" });
  const call = h.children[0];
  assert.equal(call.command, "pnpm.cmd");
  assert.equal(call.options.shell, true);
  assert.equal(call.options.cwd, "/work");
  assert.equal(call.options.env.CUSTOM, "yes");
  assert.equal(call.options.stdio, "pipe");
  call.child.stdout.emit("data", Buffer.from("out"));
  call.child.stderr.emit("data", Buffer.from("err"));
  call.child.emit("exit", null, "SIGTERM");
  const result = await promise;
  assert.deepEqual([result.code, result.signal, result.stdout, result.stderr], [null, "SIGTERM", "out", "err"]);
  const failed = h.runner.runPnpm([]);
  const error = new Error("spawn failed");
  h.children[1].child.emit("error", error);
  await assert.rejects(failed, error);
});

for (const [platform, mode, script] of [["linux", "dev", "dev"], ["win32", "watch", "dev:watch"]]) {
  test(`SDK precedes ${mode} server on ${platform}, preserving options and arguments`, async () => {
    const h = await loadRunner({ platform, mode, args: ["--tailscale-auth", "--port", "7777"] });
    const child = await start(h);
    const call = h.children[1];
    assert.equal(call.command, platform === "win32" ? "pnpm.cmd" : "pnpm");
    assert.deepEqual(call.args, ["--filter", "@myrmidon/server", script, "--port", "7777"]);
    assert.equal(call.options.shell, platform === "win32");
    assert.equal(call.options.stdio, "inherit");
    assert.equal(call.options.env.SENTINEL, "preserved");
    assert.equal(call.options.env.PAPERCLIP_UI_DEV_MIDDLEWARE, "true");
    h.runner.flags({ shuttingDown: true });
    child.emit("exit", 0, null);
  });
}

test("SDK failure prevents server spawn", async () => {
  const h = await loadRunner();
  const pending = h.runner.startServerChild();
  h.children[0].child.emit("exit", 12, null);
  await assert.rejects(pending, /process.exit:12/);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.exits, [12]);
});

test("SDK signal propagates and prevents server spawn", async () => {
  const h = await loadRunner();
  const pending = h.runner.startServerChild();
  h.children[0].child.emit("exit", null, "SIGTERM");
  await assert.rejects(pending, /process.exit:143/);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.exits, [143]);
});

test("waiting without child and expected restart clear the child", async () => {
  const h = await loadRunner();
  const empty = await h.runner.waitForChildExit();
  assert.deepEqual([empty.code, empty.signal], [0, null]);
  const child = await start(h);
  const waiting = h.runner.waitForChildExit();
  const stopping = h.runner.stopChildForRestart();
  assert.equal(child.killedWith, "SIGTERM");
  child.emit("exit", null, "SIGTERM");
  const result = await waiting;
  await stopping;
  assert.deepEqual([result.code, result.signal], [0, "SIGTERM"]);
  assert.equal(h.runner.state().child, null);
  assert.equal(h.runner.state().childExitPromise, null);
  assert.deepEqual(h.exits, []);
});

for (const flag of ["restartInFlight", "shuttingDown"]) {
  test(`${flag} suppresses unexpected child exit`, async () => {
    const h = await loadRunner();
    const child = await start(h);
    h.runner.flags({ [flag]: true });
    child.emit("exit", 7, null);
    assert.deepEqual(h.exits, []);
    assert.equal(h.runner.state().child, null);
  });
}

for (const [code, signal, expected] of [[9, null, 9], [null, "SIGINT", 130], [null, "SIGTERM", 143], [null, "SIGHUP", 1]]) {
  test(`unexpected server exit ${signal ?? code} propagates`, async () => {
    const h = await loadRunner();
    const child = await start(h);
    const waiting = h.runner.waitForChildExit();
    assert.throws(() => child.emit("exit", code, signal), new RegExp(`process.exit:${expected}`));
    const result = await waiting;
    assert.deepEqual([result.code, result.signal], [code ?? 0, signal]);
    assert.equal(h.runner.state().child, null);
    assert.deepEqual(h.exits, [expected]);
  });
}

test("server spawn error rejects the child exit wait", async () => {
  const h = await loadRunner();
  const child = await start(h);
  const waiting = h.runner.waitForChildExit();
  const error = new Error("server spawn failed");
  child.emit("error", error);
  await assert.rejects(waiting, error);
});
