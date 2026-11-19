import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as url from "node:url";
import vm from "node:vm";

const sourceUrl = new URL("./dev-runner.mjs", import.meta.url);
const statusPath = path.join(path.dirname(path.dirname(url.fileURLToPath(sourceUrl))), ".paperclip", "dev-server-status.json");
const forbidden = (name) => () => { throw new Error(`Unexpected external call: ${name}`); };

async function loadRunner(mode) {
  const calls = [];
  const fs = {
    existsSync: () => false,
    mkdirSync: (...args) => calls.push(["mkdir", ...args]),
    writeFileSync: (...args) => calls.push(["write", ...args]),
    rmSync: (...args) => calls.push(["rm", ...args]),
    readdirSync: forbidden("readdir"), statSync: forbidden("stat"),
  };
  const fakeProcess = {
    argv: ["node", "dev-runner.mjs", mode], env: {}, platform: "linux",
    on: () => {}, exit: forbidden("exit"), stderr: { write: forbidden("stderr") },
  };
  const context = vm.createContext({
    process: fakeProcess, console: { log: () => {} },
    fetch: forbidden("fetch"), setTimeout: forbidden("setTimeout"),
    clearTimeout: forbidden("clearTimeout"), setInterval: forbidden("setInterval"),
    clearInterval: forbidden("clearInterval"),
  });
  const modules = {
    "node:fs": fs,
    "node:child_process": { spawn: forbidden("spawn") },
    "node:crypto": { randomUUID: () => "test-token" },
    "node:path": { default: path },
    "node:url": { fileURLToPath: url.fileURLToPath },
    "node:readline/promises": { createInterface: forbidden("readline") },
    "node:process": { stdin: {}, stdout: {} },
    "./dev-runner-output.mjs": { createCapturedOutputBuffer: forbidden("output"), parseJsonResponseWithLimit: forbidden("json") },
    "./dev-runner-paths.mjs": { shouldTrackDevServerPath: forbidden("paths") },
  };
  const source = await readFile(sourceUrl, "utf8");
  const marker = "await maybePreflightMigrations();";
  const boundary = source.lastIndexOf(marker);
  assert.notEqual(boundary, -1, "runner bootstrap must exist");
  const runner = new vm.SourceTextModule(`${source.slice(0, boundary)}\nexport { writeDevServerStatus, clearDevServerStatus, formatPendingMigrationSummary };\nexport function setState(paths, migrations, changed, restarted) { dirtyPaths = paths; pendingMigrations = migrations; lastChangedAt = changed; lastRestartAt = restarted; }`, {
    context, identifier: sourceUrl.href, initializeImportMeta(meta) { meta.url = sourceUrl.href; },
  });
  await runner.link((specifier) => {
    assert.ok(Object.hasOwn(modules, specifier), `Unexpected import: ${specifier}`);
    const exports = modules[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await runner.evaluate();
  return { calls, runner: runner.namespace };
}

test("dev status writes exact sorted snapshot after directory creation without mutating paths", async () => {
  const { calls, runner } = await loadRunner("dev");
  const paths = new Set(["z.ts", "b.ts", "f.ts", "a.ts", "e.ts", "c.ts"]);
  const original = [...paths];
  runner.setState(paths, ["004", "002"], "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  runner.writeDevServerStatus();
  assert.deepEqual(calls.map((call) => call[0]), ["mkdir", "write"]);
  assert.equal(calls[0][1], path.dirname(statusPath));
  assert.equal(calls[0][2].recursive, true);
  assert.equal(calls[1][1], statusPath);
  assert.equal(calls[1][3], "utf8");
  assert.ok(calls[1][2].endsWith("\n"));
  const expected = { dirty: true, lastChangedAt: "2026-01-01T00:00:00.000Z", changedPathCount: 6, changedPathsSample: ["a.ts", "b.ts", "c.ts", "e.ts", "f.ts"], pendingMigrations: ["004", "002"], lastRestartAt: "2026-01-02T00:00:00.000Z" };
  assert.equal(calls[1][2], `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepEqual([...paths], original);
});

test("dirty is independently set by paths and migrations", async () => {
  const { calls, runner } = await loadRunner("dev");
  for (const [paths, migrations, dirty] of [[[], [], false], [["a"], [], true], [[], ["001"], true]]) {
    runner.setState(new Set(paths), migrations, null, null);
    runner.writeDevServerStatus();
    const actual = JSON.parse(calls.at(-1)[2]);
    assert.deepEqual(actual, { dirty, lastChangedAt: null, changedPathCount: paths.length, changedPathsSample: paths, pendingMigrations: migrations, lastRestartAt: null });
  }
});

test("clear removes only the status path with force", async () => {
  const { calls, runner } = await loadRunner("dev");
  runner.clearDevServerStatus();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "rm");
  assert.equal(calls[0][1], statusPath);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { force: true });
});

test("watch neither creates nor clears a status file", async () => {
  const { calls, runner } = await loadRunner("watch");
  runner.setState(new Set(["a"]), ["001"], null, null);
  runner.writeDevServerStatus();
  runner.clearDevServerStatus();
  assert.deepEqual(calls, []);
});

test("migration summaries handle 0, 1, 3 and 4 entries without mutation", async () => {
  const { runner } = await loadRunner("dev");
  for (const [input, expected] of [[[], "none"], [["a"], "a"], [["a", "b", "c"], "a, b, c"], [["a", "b", "c", "d"], "a, b, c (+1 more)"]]) {
    const before = [...input];
    assert.equal(runner.formatPendingMigrationSummary(input), expected);
    assert.deepEqual(input, before);
  }
});
