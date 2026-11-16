import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as output from "./dev-runner-output.mjs";

async function loadRunner({ statusSignal = null } = {}) {
  const calls = [];
  const exits = [];
  const fakeProcess = {
    argv: ["node", "runner", "watch"], env: {}, platform: "linux",
    stdin: { isTTY: false }, stdout: { isTTY: false },
    stderr: { write() {} }, on() {},
    exit(code) { exits.push(code); throw new Error(`exit:${code}`); },
  };
  const spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"status":"current","pendingMigrations":[]}'));
      child.emit("exit", statusSignal ? null : 0, statusSignal);
    });
    return child;
  };
  const modules = {
    "node:child_process": { spawn },
    "node:crypto": { randomUUID: () => "test" },
    "node:fs": { existsSync: () => false, mkdirSync() {}, readdirSync: () => [], rmSync() {}, statSync() {}, writeFileSync() {} },
    "node:path": { default: path },
    "node:readline/promises": { createInterface() { throw new Error("unexpected prompt"); } },
    "node:process": { stdin: fakeProcess.stdin, stdout: fakeProcess.stdout },
    "node:url": { fileURLToPath },
    "./dev-runner-output.mjs": output,
    "./dev-runner-paths.mjs": { shouldTrackDevServerPath: () => false },
  };
  const context = vm.createContext({ process: fakeProcess, console: { log() {}, error() {} }, Buffer, URL,
    fetch() { throw new Error("unexpected fetch"); },
    setTimeout() { throw new Error("unexpected timer"); }, clearTimeout() {},
    setInterval() { throw new Error("unexpected timer"); }, clearInterval() {},
  });
  const url = new URL("./dev-runner.mjs", import.meta.url);
  const source = await readFile(url, "utf8");
  const marker = "await maybePreflightMigrations();";
  const index = source.lastIndexOf(marker);
  assert.notEqual(index, -1);
  const runner = new vm.SourceTextModule(source.slice(0, index) + "\nexport { maybePreflightMigrations };", {
    context, initializeImportMeta(meta) { meta.url = url.href; },
  });
  await runner.link((specifier) => {
    assert.ok(modules[specifier], `unexpected import ${specifier}`);
    const exports = modules[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await runner.evaluate();
  return { runner: runner.namespace, calls, exits };
}

test("a signalled migration status command stops preflight", async () => {
  const { runner, calls, exits } = await loadRunner({ statusSignal: "SIGTERM" });
  await assert.rejects(runner.maybePreflightMigrations(), /exit:143/);
  assert.deepEqual(exits, [143]);
  assert.equal(calls.length, 1);
});
