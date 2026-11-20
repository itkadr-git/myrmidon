import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { inspectPathTree, isTreeOpen } from "./host-clone-cache-gc.mjs";

function withFixture(fn) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();
  const dir = fs.mkdtempSync(path.join(base, "gc-tree-inspection-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const inode = (file) => {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};

describe("inspectPathTree", () => {
  it("counts each known entry and finds the newest deeply nested file", () => withFixture((dir) => {
    const root = path.join(dir, "tree");
    const nested = path.join(root, "nested");
    const deep = path.join(nested, "deep");
    const first = path.join(root, "first");
    const newest = path.join(deep, "newest");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(first, "abc");
    fs.writeFileSync(newest, "1234567");
    const entries = [root, nested, deep, first, newest];
    const old = new Date("2020-01-01T00:00:00Z");
    const latest = new Date("2021-01-01T00:00:00Z");
    for (const entry of entries) fs.utimesSync(entry, old, old);
    fs.utimesSync(newest, latest, latest);
    const result = inspectPathTree(root);
    assert.equal(result.maxMtimeMs, latest.getTime());
    assert.equal(result.totalSizeBytes, entries.reduce((sum, entry) => sum + fs.lstatSync(entry).size, 0));
    assert.deepEqual(result.inodes, new Set(entries.map(inode)));
  }));

  it("returns zero and no inodes for a missing root", () => withFixture((dir) => {
    assert.deepEqual(inspectPathTree(path.join(dir, "missing")), {
      maxMtimeMs: 0, totalSizeBytes: 0, inodes: new Set(),
    });
  }));

  it("counts a symlink itself without traversing its newer, larger target", () => withFixture((dir) => {
    const root = path.join(dir, "tree");
    const target = path.join(dir, "outside");
    const link = path.join(root, "link");
    const payload = path.join(target, "payload");
    fs.mkdirSync(root);
    fs.mkdirSync(target);
    fs.writeFileSync(payload, Buffer.alloc(1024 * 1024));
    fs.symlinkSync(target, link);
    const old = new Date("2020-01-01T00:00:00Z");
    const newer = new Date("2022-01-01T00:00:00Z");
    fs.utimesSync(root, old, old);
    fs.lutimesSync(link, old, old);
    fs.utimesSync(target, newer, newer);
    fs.utimesSync(payload, newer, newer);
    const result = inspectPathTree(root);
    assert.equal(result.maxMtimeMs, old.getTime());
    assert.equal(result.totalSizeBytes, fs.lstatSync(root).size + fs.lstatSync(link).size);
    assert.deepEqual(result.inodes, new Set([inode(root), inode(link)]));
    assert.equal(result.inodes.has(inode(payload)), false);
  }));
});

describe("isTreeOpen", () => {
  it("matches exact paths and descendants, but not sibling prefixes or empty sets", () => withFixture((dir) => {
    const root = path.join(dir, "tree");
    const empty = new Set();
    assert.equal(isTreeOpen(root, empty, new Set([root]), empty), true);
    assert.equal(isTreeOpen(root, empty, new Set([path.join(root, "nested", "file")]), empty), true);
    assert.equal(isTreeOpen(root, empty, new Set([`${root}-sibling/file`]), empty), false);
    assert.equal(isTreeOpen(root, empty, empty, empty), false);
  }));

  it("matches an open hardlink inode outside the tree", () => withFixture((dir) => {
    const root = path.join(dir, "tree");
    const file = path.join(root, "file");
    const link = path.join(dir, "hardlink");
    fs.mkdirSync(root);
    fs.writeFileSync(file, "content");
    fs.linkSync(file, link);
    const tree = inspectPathTree(root);
    assert.equal(inode(file), inode(link));
    assert.equal(isTreeOpen(root, tree.inodes, new Set(), new Set([inode(link)])), true);
    assert.equal(isTreeOpen(root, tree.inodes, new Set(), new Set([inode(dir)])), false);
  }));
});
