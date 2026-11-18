import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = await readFile(new URL("./dev-runner.mjs", import.meta.url), "utf8");
const bootstrap = "\nawait maybePreflightMigrations();";
assert.notEqual(source.lastIndexOf(bootstrap), -1);
const instrumented = source.slice(0, source.lastIndexOf(bootstrap)) + `
export { maybeAutoRestartChild, getDevHealthPayload };
export function setState(state) {
  if ('child' in state) child = state.child;
  if ('dirty' in state) dirtyPaths = new Set(state.dirty);
  if ('migrations' in state) pendingMigrations = state.migrations;
  if ('inFlight' in state) restartInFlight = state.inFlight;
  if ('exitPromise' in state) childExitPromise = state.exitPromise;
}
export function inFlight() { return restartInFlight; }
`;

async function runner({ mode = "dev", port, fetchImpl, preflightFails = false } = {}) {
  const events = [];
  const fakeChild = { kill(signal) { events.push(`stop:${signal}`); } };
  const fakeProcess = {
    argv: ["node", "runner", mode], env: port ? { PORT: port } : {}, platform: "linux",
    on() {}, exit(code) { events.push(`exit:${code}`); throw new Error(`exit:${code}`); },
    stderr: { write() {} },
  };
  const fail = () => { throw new Error("unexpected external call"); };
  const modules = {
    "node:child_process": { spawn(_bin, args) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      if (args.includes("src/migration-status.ts")) {
        events.push("preflight");
        queueMicrotask(() => {
          if (preflightFails) proc.emit("error", new Error("preflight failed"));
          else { proc.stdout.emit("data", '{"status":"upToDate"}'); proc.emit("exit", 0, null); }
        });
      } else if (args.includes("build")) {
        events.push("build"); queueMicrotask(() => proc.emit("exit", 0, null));
      } else if (args.includes("@myrmidon/server")) {
        events.push("start");
      } else fail();
      return proc;
    } },
    "node:crypto": { randomUUID: () => "test-token" },
    "node:fs": { existsSync: () => false, mkdirSync() {}, readdirSync: fail, rmSync() {}, statSync: fail, writeFileSync() {} },
    "node:path": { default: path },
    "node:readline/promises": { createInterface: fail },
    "node:process": { stdin: {}, stdout: {} },
    "node:url": { fileURLToPath },
    "./dev-runner-output.mjs": {
      createCapturedOutputBuffer() { let text = ""; return { append(chunk) { text += chunk; }, finish() { return { text }; } }; },
      parseJsonResponseWithLimit: async (response) => response.json(),
    },
    "./dev-runner-paths.mjs": { shouldTrackDevServerPath: () => true },
  };
  const context = vm.createContext({ process: fakeProcess, console: { log() {}, error() {} }, queueMicrotask,
    fetch: (...args) => { events.push("fetch"); return fetchImpl(...args); },
    setTimeout: () => 1, clearTimeout() {}, setInterval: fail, clearInterval: fail,
  });
  const mod = new vm.SourceTextModule(instrumented, { context, initializeImportMeta(meta) { meta.url = "file:///virtual/scripts/dev-runner.mjs"; } });
  await mod.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const api = mod.namespace;
  api.setState({ child: fakeChild, dirty: ["server/file.ts"], migrations: [], exitPromise: Promise.resolve({ code: 0, signal: null }) });
  return { api, events };
}

const healthy = { devServer: { enabled: true, autoRestartEnabled: true, activeRunCount: 0 } };
const response = (body = healthy, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });

test("initial guards prevent any health or restart side effects", async () => {
  for (const state of [{ child: null }, { dirty: [], migrations: [] }, { inFlight: true }]) {
    const { api, events } = await runner({ fetchImpl: async () => response() });
    api.setState(state); await api.maybeAutoRestartChild();
    assert.deepEqual(events, []);
  }
  const { api, events } = await runner({ mode: "watch", fetchImpl: async () => response() });
  await api.maybeAutoRestartChild(); assert.deepEqual(events, []);
});

test("health failures and unsafe health never stop the child and release the gate", async () => {
  const cases = [
    async () => { throw new Error("network"); }, async () => response(healthy, false),
    async () => response({}), async () => response({ devServer: { enabled: false, autoRestartEnabled: true } }),
    async () => response({ devServer: { enabled: true, autoRestartEnabled: false } }),
    async () => response({ devServer: { enabled: true, autoRestartEnabled: 1 } }),
    async () => response({ devServer: { ...healthy.devServer, activeRunCount: 1 } }),
  ];
  for (const fetchImpl of cases) {
    const { api, events } = await runner({ fetchImpl });
    await api.maybeAutoRestartChild();
    assert.deepEqual(events, ["fetch"]); assert.equal(api.inFlight(), false);
    await api.maybeAutoRestartChild(); assert.deepEqual(events, ["fetch", "fetch"]);
  }
});

test("concurrent restart waits for one health request", async () => {
  let resolveHealth;
  const pending = new Promise((resolve) => { resolveHealth = resolve; });
  const { api, events } = await runner({ fetchImpl: () => pending });
  const first = api.maybeAutoRestartChild();
  await api.maybeAutoRestartChild(); assert.deepEqual(events, ["fetch"]);
  resolveHealth(response({ devServer: { enabled: false } })); await first;
  assert.equal(api.inFlight(), false);
});

test("dirty and migrations-only restart in preflight, stop, start order", async () => {
  for (const state of [{ dirty: ["server/a"], migrations: [] }, { dirty: [], migrations: ["001"] }]) {
    const { api, events } = await runner({ fetchImpl: async () => response() });
    api.setState(state); await api.maybeAutoRestartChild();
    assert.deepEqual(events, ["fetch", "preflight", "stop:SIGTERM", "build", "start", "preflight"]);
    assert.equal(api.inFlight(), false);
  }
});

test("preflight errors do not stop or start and release the gate", async () => {
  const { api, events } = await runner({ fetchImpl: async () => response(), preflightFails: true });
  await assert.rejects(api.maybeAutoRestartChild(), /exit:1/);
  assert.deepEqual(events, ["fetch", "preflight", "exit:1"]); assert.equal(api.inFlight(), false);
});

test("health uses localhost PORT and sends token only in dev", async () => {
  for (const mode of ["dev", "watch"]) {
    let request;
    const { api } = await runner({ mode, port: "4567", fetchImpl: async (...args) => { request = args; return response(); } });
    await api.getDevHealthPayload();
    assert.equal(request[0], "http://127.0.0.1:4567/api/health");
    assert.equal(request[1].headers?.["x-paperclip-dev-server-status-token"], mode === "dev" ? "test-token" : undefined);
  }
});
