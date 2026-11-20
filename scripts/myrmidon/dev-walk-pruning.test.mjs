import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { collectWatchedSnapshot } from "../dev-runner-snapshot.mjs";

const root = "/repo";
const server = path.join(root, "server");
const entry = (name, kind) => Object.freeze({
  name,
  isDirectory: () => kind === "directory",
  isFile: () => kind === "file",
  isSymbolicLink: () => kind === "link",
});

function fixture() {
  const calls = [];
  const dirs = new Map([
    [server, [entry("cache", "directory"), entry("cache-more", "directory"), entry("main.ts", "file"), entry("link.ts", "link"), entry("socket.ts", "special")]],
    [path.join(server, "cache-more"), [entry("nested", "directory")]],
    [path.join(server, "cache-more/nested"), [entry("inside.ts", "file")]],
  ]);
  const stats = new Map([
    [path.join(server, "main.ts"), { mtimeMs: 10, size: 1 }],
    [path.join(server, "link.ts"), { mtimeMs: 20, size: 2 }],
    [path.join(server, "cache-more/nested/inside.ts"), { mtimeMs: 30, size: 3 }],
  ]);
  function record(op, name) {
    calls.push([op, name]);
    assert.ok(name !== `${server}/cache` && !name.startsWith(`${server}/cache/`), `ignored branch accessed: ${name}`);
  }
  const fileSystem = {
    existsSync(name) { record("exists", name); return dirs.has(name) || stats.has(name); },
    readdirSync(name, options) { record("readdir", name); assert.deepEqual(options, { withFileTypes: true }); assert.ok(dirs.has(name)); return dirs.get(name); },
    statSync(name) { record("stat", name); assert.ok(stats.has(name), `unexpected stat: ${name}`); return stats.get(name); },
  };
  return { calls, fileSystem };
}

const expected = [
  ["server/cache-more/nested/inside.ts", "30:3"],
  ["server/main.ts", "10:1"],
  ["server/link.ts", "20:2"],
];
const walkTrace = [
  ["exists", server], ["readdir", server],
  ["exists", `${server}/cache-more`], ["readdir", `${server}/cache-more`],
  ["exists", `${server}/cache-more/nested`], ["readdir", `${server}/cache-more/nested`],
  ["stat", `${server}/cache-more/nested/inside.ts`],
  ["stat", `${server}/main.ts`], ["stat", `${server}/link.ts`],
];

test("prunes exact directory names before filesystem access and dispatches dirent types", () => {
  const fake = fixture();
  const ignoredDirectoryNames = new Set(["cache"]);
  const snapshot = collectWatchedSnapshot({ repoRoot: root, watchedDirectories: [server], watchedFiles: [], ignoredDirectoryNames, fileSystem: fake.fileSystem });
  assert.deepEqual([...snapshot], expected);
  assert.deepEqual(fake.calls, walkTrace);
  assert.deepEqual([...ignoredDirectoryNames], ["cache"]);
});

test("duplicate inputs collapse entries without mutation and snapshots are independent", () => {
  const fake = fixture();
  const watchedDirectories = Object.freeze([server, server]);
  const watchedFiles = Object.freeze([`${server}/main.ts`, `${server}/main.ts`]);
  const ignoredDirectoryNames = new Set(["cache"]);
  const ignoredRelativePaths = new Set();
  const options = Object.freeze({ repoRoot: root, watchedDirectories, watchedFiles, ignoredDirectoryNames, ignoredRelativePaths, fileSystem: fake.fileSystem });
  const first = collectWatchedSnapshot(options);
  const second = collectWatchedSnapshot(options);
  const directTrace = [["exists", `${server}/main.ts`], ["stat", `${server}/main.ts`]];
  assert.deepEqual([...first], expected);
  assert.deepEqual([...second], expected);
  assert.notStrictEqual(first, second);
  first.set("extra", "1:1");
  assert.deepEqual([...second], expected);
  assert.deepEqual(fake.calls, [...walkTrace, ...walkTrace, ...directTrace, ...directTrace, ...walkTrace, ...walkTrace, ...directTrace, ...directTrace]);
  assert.deepEqual(watchedDirectories, [server, server]);
  assert.deepEqual(watchedFiles, [`${server}/main.ts`, `${server}/main.ts`]);
  assert.deepEqual([...ignoredDirectoryNames], ["cache"]);
  assert.deepEqual([...ignoredRelativePaths], []);
});
