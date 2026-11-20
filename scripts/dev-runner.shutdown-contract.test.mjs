import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

const sourceUrl = new URL("./dev-runner.mjs", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const bootstrap = "\nawait maybePreflightMigrations();";
assert.equal(source.split(bootstrap).length, 2);

async function runner() {
  const events = [];
  const timeouts = new Map();
  let nextId = 0;
  const proc = new EventEmitter();
  Object.assign(proc, {
    argv: ["node", "dev-runner.mjs"], env: {}, platform: "linux",
    stderr: { write: () => assert.fail("unexpected stderr") },
    exit(code) { events.push(["exit", code]); throw new Exit(code); },
  });
  const forbidden = () => assert.fail("unexpected external call");
  const modules = {
    "node:child_process": { spawn: forbidden },
    "node:crypto": { randomUUID: () => "test-token" },
    "node:fs": {
      existsSync: () => false, mkdirSync: forbidden, readdirSync: forbidden,
      rmSync: () => events.push(["status-cleared"]), statSync: forbidden, writeFileSync: forbidden,
    },
    "node:path": { default: path },
    "node:readline/promises": { createInterface: forbidden },
    "node:process": { stdin: {}, stdout: {} },
    "node:url": { fileURLToPath },
    "./dev-runner-output.mjs": { createCapturedOutputBuffer: forbidden, parseJsonResponseWithLimit: forbidden },
    "./dev-runner-paths.mjs": { shouldTrackDevServerPath: forbidden },
  };
  const context = createContext({
    process: proc, console: { log() {}, error: forbidden }, fetch: forbidden,
    setTimeout(fn, delay) { const id = ++nextId; timeouts.set(id, { fn, delay }); events.push(["timeout", id, delay]); return id; },
    clearTimeout(id) { events.push(["clear-timeout", id]); timeouts.delete(id); },
    setInterval(fn, delay) { const id = ++nextId; events.push(["interval", id, delay]); return id; },
    clearInterval(id) { events.push(["clear-interval", id]); },
  });
  const code = source.slice(0, source.indexOf(bootstrap)) + `
export { stopChildForRestart, shutdown, installDevIntervals };
export function setChildForTest(value, exitPromise) { child = value; childExitPromise = exitPromise; }
`;
  const mod = new SourceTextModule(code, { context, initializeImportMeta(meta) { meta.url = sourceUrl.href; } });
  await mod.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `unexpected import ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await mod.evaluate();
  return { api: mod.namespace, events, timeouts };
}

class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

function childFixture(events) {
  const child = new EventEmitter();
  child.kill = (signal) => { events.push(["kill", signal]); };
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { child, promise, resolve, reject };
}

test("restart returns immediately with no child", async () => {
  const { api, events, timeouts } = await runner();
  const result = await api.stopChildForRestart();
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(events, []);
  assert.equal(timeouts.size, 0);
});

test("restart sends TERM and clears timeout after early exit", async () => {
  const { api, events, timeouts } = await runner();
  const c = childFixture(events);
  api.setChildForTest(c.child, c.promise);
  const stopped = api.stopChildForRestart();
  assert.deepEqual(events, [["kill", "SIGTERM"], ["timeout", 1, 10000]]);
  c.resolve({ code: 7, signal: null });
  assert.equal((await stopped).code, 7);
  assert.deepEqual(events.at(-1), ["clear-timeout", 1]);
  assert.equal(timeouts.size, 0);
});

test("restart escalates only while a child exists", async () => {
  for (const alive of [true, false]) {
    const { api, events, timeouts } = await runner();
    const c = childFixture(events);
    api.setChildForTest(c.child, c.promise);
    const stopped = api.stopChildForRestart();
    if (!alive) api.setChildForTest(null, c.promise);
    timeouts.get(1).fn();
    assert.deepEqual(events.filter(([kind]) => kind === "kill"), alive ? [["kill", "SIGTERM"], ["kill", "SIGKILL"]] : [["kill", "SIGTERM"]]);
    c.resolve({ code: 0, signal: null });
    await stopped;
    assert.equal(timeouts.size, 0);
  }
});

test("restart clears its timeout when waiting rejects", async () => {
  const { api, events, timeouts } = await runner();
  const c = childFixture(events);
  api.setChildForTest(c.child, c.promise);
  const stopped = api.stopChildForRestart();
  const error = new Error("child error");
  c.reject(error);
  await assert.rejects(stopped, (actual) => actual === error);
  assert.deepEqual(events.at(-1), ["clear-timeout", 1]);
  assert.equal(timeouts.size, 0);
});

test("shutdown cleans up once, forwards signal and preserves child exit code", async () => {
  const { api, events } = await runner();
  api.installDevIntervals();
  const c = childFixture(events);
  api.setChildForTest(c.child, c.promise);
  const stopped = api.shutdown("SIGTERM");
  await api.shutdown("SIGINT");
  assert.deepEqual(events, [["interval", 1, 1500], ["interval", 2, 2500], ["clear-interval", 1], ["clear-interval", 2], ["status-cleared"], ["kill", "SIGTERM"]]);
  c.resolve({ code: 42, signal: null });
  await assert.rejects(stopped, (error) => error instanceof Exit && error.code === 42);
  assert.deepEqual(events.at(-1), ["exit", 42]);
});

test("shutdown maps child signals to conventional exit codes", async () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 1]]) {
    const { api, events } = await runner();
    const c = childFixture(events);
    api.setChildForTest(c.child, c.promise);
    const stopped = api.shutdown(signal);
    c.resolve({ code: null, signal });
    await assert.rejects(stopped, (error) => error instanceof Exit && error.code === code);
    assert.deepEqual(events, [["status-cleared"], ["kill", signal], ["exit", code]]);
  }
});

test("shutdown without child exits without waiting", async () => {
  for (const [signal, code] of [[undefined, 0], ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 1]]) {
    const { api, events } = await runner();
    await assert.rejects(api.shutdown(signal), (error) => error instanceof Exit && error.code === code);
    assert.deepEqual(events, [["status-cleared"], ["exit", code]]);
  }
});
