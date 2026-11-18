import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as output from "./dev-runner-output.mjs";

async function loadRunner({ statusSignal = null, statusCode = 0, statuses = [], mode = "watch", tty = false, answer = "n", questionError = false, migrateCode = 0, migrateSignal = null, environment = {} } = {}) {
  const calls = [];
  const exits = [];
  const prompts = [];
  const statusWrites = [];
  const fakeProcess = {
    argv: ["node", "runner", mode], env: environment, platform: "linux",
    stdin: { isTTY: tty }, stdout: { isTTY: tty },
    stderr: { write() {} }, on() {},
    exit(code) { exits.push(code); throw new Error(`exit:${code}`); },
  };
  const spawn = (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args[0] === "db:migrate") {
        child.emit("exit", migrateSignal ? null : migrateCode, migrateSignal);
      } else {
        const response = statuses.shift() ?? { status: "current", pendingMigrations: [] };
        const text = typeof response === "string" ? response : JSON.stringify(response);
        child.stdout.emit("data", Buffer.from(text));
        child.emit("exit", statusSignal ? null : statusCode, statusSignal);
      }
    });
    return child;
  };
  const modules = {
    "node:child_process": { spawn },
    "node:crypto": { randomUUID: () => "test" },
    "node:fs": { existsSync: () => false, mkdirSync() {}, readdirSync: () => [], rmSync() {}, statSync() {}, writeFileSync(_path, text) { statusWrites.push(JSON.parse(text)); } },
    "node:path": { default: path },
    "node:readline/promises": { createInterface() { return { async question(text) { prompts.push(text); if (questionError) throw new Error("question failed"); return answer; }, close() { prompts.push("closed"); } }; } },
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
  return { runner: runner.namespace, calls, exits, prompts, statusWrites };
}

test("a signalled migration status command stops preflight", async () => {
  const { runner, calls, exits } = await loadRunner({ statusSignal: "SIGTERM" });
  await assert.rejects(runner.maybePreflightMigrations(), /exit:143/);
  assert.deepEqual(exits, [143]);
  assert.equal(calls.length, 1);
});

test("a failed status command stops preflight", async () => {
  const h = await loadRunner({ statusCode: 9 });
  await assert.rejects(h.runner.maybePreflightMigrations(), /exit:9/);
  assert.deepEqual(h.exits, [9]);
  assert.equal(h.calls.length, 1);
});

const pending = { status: "needsMigrations", pendingMigrations: ["001"] };
const current = { status: "current", pendingMigrations: [] };
const callKinds = (calls) => calls.map((args) => args[0] === "db:migrate" ? "migrate" : "status");

test("current schema and empty or invalid pending lists do not migrate", async () => {
  for (const status of [current, { status: "current", pendingMigrations: ["001"] }, { status: "needsMigrations", pendingMigrations: [] }, { status: "needsMigrations", pendingMigrations: [" ", null, 42] }, { status: "needsMigrations", pendingMigrations: null }]) {
    const h = await loadRunner({ statuses: [status] });
    await h.runner.maybePreflightMigrations();
    assert.deepEqual(callKinds(h.calls), ["status"]);
  }
});

test("auto apply filters pending entries and runs status, migrate, status once", async () => {
  const h = await loadRunner({ mode: "dev", statuses: [{ status: "needsMigrations", pendingMigrations: [null, " ", "001", 42] }, current] });
  await h.runner.maybePreflightMigrations({ autoApply: true });
  assert.deepEqual(callKinds(h.calls), ["status", "migrate", "status"]);
  assert.deepEqual(h.statusWrites.map((s) => s.pendingMigrations), [["001"], []]);
  assert.equal(h.prompts.length, 0);
});

test("interactive affirmative answers apply migrations", async () => {
  for (const answer of [" y ", "YES"]) {
    const h = await loadRunner({ tty: true, answer, statuses: [pending, current] });
    await h.runner.maybePreflightMigrations({ autoApply: false });
    assert.deepEqual(callKinds(h.calls), ["status", "migrate", "status"]);
    assert.match(h.prompts[0], /001/);
    assert.equal(h.prompts[1], "closed");
  }
});

test("watch refuses declined migrations while dev can continue", async () => {
  for (const mode of ["watch", "dev"]) {
    const h = await loadRunner({ mode, tty: true, statuses: [pending] });
    const operation = h.runner.maybePreflightMigrations({ autoApply: false, interactive: true });
    if (mode === "watch") await assert.rejects(operation, /exit:1/);
    else await operation;
    assert.deepEqual(h.exits, mode === "watch" ? [1] : []);
    assert.deepEqual(callKinds(h.calls), ["status"]);
    assert.equal(h.prompts[1], "closed");
  }
});

test("non-interactive terminals apply when prompting is enabled", async () => {
  const h = await loadRunner({ statuses: [pending, current] });
  await h.runner.maybePreflightMigrations({ autoApply: false, interactive: true });
  assert.deepEqual(callKinds(h.calls), ["status", "migrate", "status"]);
  assert.deepEqual(h.prompts, []);
});

test("prompt closes when question fails", async () => {
  const h = await loadRunner({ tty: true, questionError: true, statuses: [pending] });
  await assert.rejects(h.runner.maybePreflightMigrations({ autoApply: false }), /question failed/);
  assert.equal(h.prompts[1], "closed");
  assert.deepEqual(callKinds(h.calls), ["status"]);
});

test("migration failure or signal prevents a second status", async () => {
  for (const options of [{ migrateCode: 7, exit: 7 }, { migrateSignal: "SIGTERM", exit: 143 }]) {
    const h = await loadRunner({ ...options, statuses: [pending] });
    await assert.rejects(h.runner.maybePreflightMigrations(), new RegExp(`exit:${options.exit}`));
    assert.deepEqual(h.exits, [options.exit]);
    assert.deepEqual(callKinds(h.calls), ["status", "migrate"]);
  }
});

test("invalid status JSON rejects rather than treating schema as current", async () => {
  const h = await loadRunner({ statuses: ["not json"] });
  await assert.rejects(h.runner.maybePreflightMigrations());
  assert.deepEqual(callKinds(h.calls), ["status"]);
});
