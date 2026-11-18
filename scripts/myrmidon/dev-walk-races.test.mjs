import assert from "node:assert/strict";
import test from "node:test";
import { collectWatchedSnapshot } from "../dev-runner-snapshot.mjs";

const entry = (name, directory = false) => Object.freeze({
  name,
  isDirectory: () => directory,
  isFile: () => !directory,
  isSymbolicLink: () => false,
});

function fixture({ missing = false, readError, statMissing = false } = {}) {
  const calls = [];
  const rootEntries = Object.freeze([entry("gone", true), entry("live", true)]);
  const liveEntries = Object.freeze([entry("vanished.ts"), entry("kept.ts")]);
  const fs = Object.freeze({
    existsSync(name) {
      calls.push(["exists", name]);
      return !(missing && name === "/repo/server/gone");
    },
    readdirSync(name, options) {
      calls.push(["readdir", name, options]);
      if (name === "/repo/server/gone" && readError !== undefined) throw readError;
      if (name === "/repo/server") return rootEntries;
      if (name === "/repo/server/gone") return Object.freeze([]);
      assert.equal(name, "/repo/server/live");
      return liveEntries;
    },
    statSync(name) {
      calls.push(["stat", name]);
      if (statMissing && name.endsWith("/vanished.ts")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      assert.ok(name === "/repo/server/live/vanished.ts" || name === "/repo/server/live/kept.ts");
      return { mtimeMs: 12, size: name.endsWith("kept.ts") ? 7 : 4 };
    },
  });
  const options = Object.freeze({ repoRoot: "/repo", watchedDirectories: Object.freeze(["/repo/server"]), watchedFiles: Object.freeze([]), fileSystem: fs });
  return { calls, options, rootEntries, liveEntries };
}

const rootTrace = [["exists", "/repo/server"], ["readdir", "/repo/server", { withFileTypes: true }], ["exists", "/repo/server/gone"]];
const liveTrace = [["exists", "/repo/server/live"], ["readdir", "/repo/server/live", { withFileTypes: true }], ["stat", "/repo/server/live/vanished.ts"], ["stat", "/repo/server/live/kept.ts"]];
const bothFiles = [["server/live/vanished.ts", "12:4"], ["server/live/kept.ts", "12:7"]];

function assertUnchanged(f) {
  assert.deepEqual(f.rootEntries.map((e) => e.name), ["gone", "live"]);
  assert.deepEqual(f.liveEntries.map((e) => e.name), ["vanished.ts", "kept.ts"]);
  assert.deepEqual(f.options.watchedDirectories, ["/repo/server"]);
  assert.deepEqual(f.options.watchedFiles, []);
}

test("missing directory is not read and its sibling is collected", () => {
  const f = fixture({ missing: true });
  assert.deepEqual([...collectWatchedSnapshot(f.options)], bothFiles);
  assert.deepEqual(f.calls, [...rootTrace, ...liveTrace]);
  assertUnchanged(f);
});

for (const code of ["ENOENT", "ENOTDIR"]) {
  test(`directory disappearing with ${code} preserves its sibling`, () => {
    const f = fixture({ readError: Object.assign(new Error(code), { code }) });
    assert.deepEqual([...collectWatchedSnapshot(f.options)], bothFiles);
    assert.deepEqual(f.calls, [...rootTrace, ["readdir", "/repo/server/gone", { withFileTypes: true }], ...liveTrace]);
    assertUnchanged(f);
  });
}

for (const error of [Object.assign(new Error("denied"), { code: "EACCES" }), Object.assign(new Error("io"), { code: "EIO" }), "primitive failure"]) {
  test(`readdir propagates ${typeof error === "string" ? "primitive" : error.code} by identity`, () => {
    const f = fixture({ readError: error });
    let caught = false;
    try { collectWatchedSnapshot(f.options); } catch (value) { caught = true; assert.strictEqual(value, error); }
    assert.equal(caught, true);
    assert.deepEqual(f.calls, [...rootTrace, ["readdir", "/repo/server/gone", { withFileTypes: true }]]);
    assertUnchanged(f);
    const positive = fixture();
    assert.deepEqual([...collectWatchedSnapshot(positive.options)], bothFiles);
    assert.deepEqual(positive.calls, [...rootTrace, ["readdir", "/repo/server/gone", { withFileTypes: true }], ...liveTrace]);
  });
}

test("file disappearing before stat is skipped and the next file remains", () => {
  const f = fixture({ missing: true, statMissing: true });
  assert.deepEqual([...collectWatchedSnapshot(f.options)], [["server/live/kept.ts", "12:7"]]);
  assert.deepEqual(f.calls, [...rootTrace, ...liveTrace]);
  assertUnchanged(f);
});
