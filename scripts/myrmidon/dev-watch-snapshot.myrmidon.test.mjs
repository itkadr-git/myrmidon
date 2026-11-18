import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { collectWatchedSnapshot, diffSnapshots, readSignature } from "../dev-runner-snapshot.mjs";

function checkDiff(beforeEntries, afterEntries, expected) {
  const before = new Map(beforeEntries);
  const after = new Map(afterEntries);
  assert.deepEqual(diffSnapshots(before, after), expected);
  assert.deepEqual([...before], beforeEntries);
  assert.deepEqual([...after], afterEntries);
}

test("diff reports additions without changing either map", () => {
  checkDiff([["a", "1:1"]], [["a", "1:1"], ["b", "2:2"]], ["b"]);
});

test("diff reports removals without changing either map", () => {
  checkDiff([["a", "1:1"], ["b", "2:2"]], [["a", "1:1"]], ["b"]);
});

test("diff reports changed signatures but not unchanged entries", () => {
  checkDiff([["a", "1:1"], ["b", "2:2"]], [["a", "1:2"], ["b", "2:2"]], ["a"]);
});

test("diff ignores map insertion order for unchanged entries", () => {
  checkDiff([["a", "1:1"], ["b", "2:2"]], [["b", "2:2"], ["a", "1:1"]], []);
});

test("diff sorts mixed changes once and leaves inputs in their original order", () => {
  checkDiff([["z", "1:1"], ["b", "1:1"], ["same", "3:3"]],
    [["same", "3:3"], ["b", "2:1"], ["a", "4:4"]], ["a", "b", "z"]);
});

test("signature truncates fractional mtime and includes size", () => {
  const fs = { statSync: (name) => name === "first" ? { mtimeMs: 12.99, size: 7 } : { mtimeMs: 12.01, size: 8 } };
  assert.equal(readSignature("first", fs), "12:7");
  assert.equal(readSignature("second", fs), "12:8");
  assert.equal(readSignature("negative", { statSync: () => ({ mtimeMs: -1.9, size: 0 }) }), "-1:0");
});

for (const code of ["ENOENT", "ENOTDIR"]) {
  test(`signature returns null for ${code}`, () => {
    const error = Object.assign(new Error(code), { code });
    assert.equal(readSignature("missing", { statSync() { throw error; } }), null);
    assert.equal(readSignature("present", { statSync: () => ({ mtimeMs: 2, size: 3 }) }), "2:3");
  });
}

for (const error of [Object.assign(new Error("denied"), { code: "EACCES" }), Object.assign(new Error("io"), { code: "EIO" }), "primitive failure"]) {
  test(`signature propagates ${typeof error === "string" ? "primitive error" : error.code} by identity`, () => {
    let caught;
    try { readSignature("failure", { statSync() { throw error; } }); } catch (value) { caught = value; }
    assert.strictEqual(caught, error);
    assert.equal(readSignature("present", { statSync: () => ({ mtimeMs: 4, size: 5 }) }), "4:5");
  });
}

function fakeFileSystem() {
  const root = "/repo";
  const stats = new Map([
    ["/repo/server/app.ts", { mtimeMs: 10.5, size: 4 }],
    ["/repo/server/link.ts", { mtimeMs: 11.5, size: 5 }],
    ["/repo/server/ignored.ts", { mtimeMs: 12, size: 6 }],
    ["/repo/server/__tests__/hidden.ts", { mtimeMs: 13, size: 7 }],
    ["/repo/server/tests/hidden.ts", { mtimeMs: 14, size: 8 }],
    ["/repo/server/test/hidden.ts", { mtimeMs: 15, size: 9 }],
    ["/repo/server/_tests/hidden.ts", { mtimeMs: 16, size: 10 }],
  ]);
  const entry = (name, kind) => ({ name, isDirectory: () => kind === "directory", isFile: () => kind === "file", isSymbolicLink: () => kind === "link" });
  const dirs = new Map([
    ["/repo/server", [entry("app.ts", "file"), entry("link.ts", "link"), entry("ignored.ts", "file"), ...["__tests__", "tests", "test", "_tests"].map((name) => entry(name, "directory"))]],
    ...["__tests__", "tests", "test", "_tests"].map((name) => [`/repo/server/${name}`, [entry("hidden.ts", "file")]]),
  ]);
  const calls = [];
  const fileSystem = {
    existsSync: (name) => dirs.has(name) || stats.has(name),
    readdirSync: (name) => { assert.ok(dirs.has(name)); return dirs.get(name); },
    statSync: (name) => { calls.push(name); assert.ok(stats.has(name), `unexpected stat: ${name}`); return stats.get(name); },
  };
  return { root, calls, fileSystem };
}

function options(fake, overrides = {}) {
  return { repoRoot: fake.root, watchedDirectories: [path.join(fake.root, "server")], watchedFiles: [], ignoredRelativePaths: new Set(), fileSystem: fake.fileSystem, ...overrides };
}

test("ignored relative paths are filtered before stat while nearby files remain", () => {
  const fake = fakeFileSystem();
  const snapshot = collectWatchedSnapshot(options(fake, { ignoredRelativePaths: new Set(["server/ignored.ts"]) }));
  assert.equal(snapshot.has("server/ignored.ts"), false);
  assert.equal(snapshot.get("server/app.ts"), "10:4");
  assert.equal(fake.calls.includes("/repo/server/ignored.ts"), false);
  assert.ok(fake.calls.includes("/repo/server/app.ts"));
});

test("test-directory filters exclude all four names before stat", () => {
  const fake = fakeFileSystem();
  const snapshot = collectWatchedSnapshot(options(fake));
  for (const dir of ["__tests__", "tests", "test", "_tests"]) {
    assert.equal(snapshot.has(`server/${dir}/hidden.ts`), false);
    assert.equal(fake.calls.includes(`/repo/server/${dir}/hidden.ts`), false);
  }
  assert.equal(snapshot.get("server/app.ts"), "10:4");
  assert.ok(fake.calls.includes("/repo/server/app.ts"));
});

test("missing watched files are skipped without stat", () => {
  const fake = fakeFileSystem();
  const snapshot = collectWatchedSnapshot(options(fake, { watchedDirectories: [], watchedFiles: ["/repo/missing.ts", "/repo/server/app.ts"] }));
  assert.deepEqual([...snapshot], [["server/app.ts", "10:4"]]);
  assert.deepEqual(fake.calls, ["/repo/server/app.ts"]);
});

test("regular files and symbolic links enter the snapshot", () => {
  const fake = fakeFileSystem();
  const snapshot = collectWatchedSnapshot(options(fake));
  assert.equal(snapshot.get("server/app.ts"), "10:4");
  assert.equal(snapshot.get("server/link.ts"), "11:5");
  assert.equal(snapshot.has("server/missing.ts"), false);
});

test("a file watched directly and through a directory has one entry", () => {
  const fake = fakeFileSystem();
  const snapshot = collectWatchedSnapshot(options(fake, { watchedFiles: ["/repo/server/app.ts"] }));
  assert.equal([...snapshot.keys()].filter((name) => name === "server/app.ts").length, 1);
  assert.equal(snapshot.get("server/app.ts"), "10:4");
  assert.equal(snapshot.get("server/link.ts"), "11:5");
});
