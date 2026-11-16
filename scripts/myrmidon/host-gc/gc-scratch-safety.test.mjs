import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanScratchDirectory } from "./host-clone-cache-gc.mjs";

const now = Date.UTC(2025, 0, 2);
const ttlMs = 60 * 60 * 1000;
const old = now - ttlMs - 10000;
const fixtureRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();

function setTime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

function snapshot(dir) {
  const st = fs.lstatSync(dir);
  const result = { mode: st.mode, size: st.size, mtimeMs: st.mtimeMs };
  if (st.isSymbolicLink()) result.target = fs.readlinkSync(dir);
  else if (st.isDirectory()) result.children = Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, snapshot(path.join(dir, name))]));
  else if (st.isFile()) result.content = fs.readFileSync(dir, "utf8");
  return result;
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(fixtureRoot, "gc-scratch-safety-"));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function scan(root, openInfo) {
  const before = snapshot(root);
  const result = scanScratchDirectory(root, now, 1, openInfo);
  assert.deepEqual(snapshot(root), before, "scanning must not modify the filesystem");
  return Object.fromEntries(result.map((item) => [item.name, item]));
}

test("scratch TTL boundary and nested freshness", () => withFixture((root) => {
  for (const [name, age] of [["before", ttlMs - 1], ["at", ttlMs], ["after", ttlMs + 1]]) {
    const file = path.join(root, name);
    fs.writeFileSync(file, name);
    setTime(file, now - age);
  }
  const tree = path.join(root, "tree");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "fresh"), "data");
  setTime(path.join(tree, "fresh"), now - ttlMs + 1000);
  setTime(tree, old);
  const result = scan(root);
  assert.equal(result.before.reason, "fresh");
  assert.equal(result.at.reason, "ttl");
  assert.equal(result.after.reason, "ttl");
  assert.equal(result.tree.reason, "fresh");
}));

test("open paths and inodes protect old trees", () => withFixture((root) => {
  for (const name of ["path", "inode", "closed"]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "file"), name);
    setTime(path.join(dir, "file"), old);
    setTime(dir, old);
  }
  const st = fs.statSync(path.join(root, "inode", "file"));
  const result = scan(root, { openPaths: new Set([path.join(root, "path", "file")]), openInodes: new Set([`${st.dev}:${st.ino}`]) });
  assert.equal(result.path.reason, "open-by-process");
  assert.equal(result.inode.reason, "open-by-process");
  assert.equal(result.closed.reason, "ttl");
}));

test("git metadata and symlinks are never deletion candidates", () => withFixture((root) => {
  for (const name of ["git-dir", "git-file", "nested-link", "target"]) fs.mkdirSync(path.join(root, name));
  fs.mkdirSync(path.join(root, "git-dir", ".git"));
  fs.writeFileSync(path.join(root, "git-file", ".git"), "gitdir: elsewhere");
  fs.symlinkSync(path.join(root, "target"), path.join(root, "nested-link", "link"));
  fs.symlinkSync(path.join(root, "target"), path.join(root, "root-link"));
  for (const file of ["git-dir/.git", "git-dir", "git-file/.git", "git-file", "nested-link", "target"]) setTime(path.join(root, file), old);
  for (const file of ["nested-link/link", "root-link"]) fs.lutimesSync(path.join(root, file), old / 1000, old / 1000);
  const result = scan(root);
  for (const name of ["git-dir", "git-file", "nested-link", "root-link"]) assert.equal(result[name].reason, "unsafe-scratch-tree", name);
  assert.equal(result.target.reason, "ttl");
}));

test("gh-cli-cache stays protected and a missing root is empty", () => withFixture((root) => {
  const cache = path.join(root, "gh-cli-cache");
  fs.mkdirSync(cache);
  setTime(cache, old);
  assert.equal(scan(root)["gh-cli-cache"].reason, "protected-gh-cli-cache");
  assert.deepEqual(scanScratchDirectory(path.join(root, "missing"), now, 1), []);
}));
