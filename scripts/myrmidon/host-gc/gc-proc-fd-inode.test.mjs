import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { collectOpenProcInfo } from "./host-clone-cache-gc.mjs";

function withFixture(run) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  const root = fs.mkdtempSync(path.join(base, "gc-proc-fd-"));
  try {
    return run(root, path.join(root, "proc"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function inode(target) {
  const { dev, ino } = fs.statSync(target);
  return `${dev}:${ino}`;
}

describe("collectOpenProcInfo", () => {
  it("collects absolute and resolved fd and cwd paths and deduplicates inode targets", () => withFixture((root, proc) => {
    const fd = path.join(proc, "123", "fd");
    const target = path.join(root, "file");
    const alias = path.join(root, "file-alias");
    const cwd = path.join(root, "directory");
    const cwdAlias = path.join(root, "directory-alias");
    fs.mkdirSync(fd, { recursive: true });
    fs.writeFileSync(target, "fixture");
    fs.mkdirSync(cwd);
    fs.symlinkSync(target, alias);
    fs.symlinkSync(cwd, cwdAlias);
    fs.symlinkSync(alias, path.join(fd, "1"));
    fs.symlinkSync(target, path.join(fd, "2"));
    fs.symlinkSync(cwdAlias, path.join(proc, "123", "cwd"));

    const { openPaths, openInodes } = collectOpenProcInfo(proc);
    assert.deepEqual(openPaths, new Set([alias, target, cwdAlias, cwd]));
    assert.deepEqual(openInodes, new Set([inode(target), inode(cwd)]));
  }));

  it("ignores nonnumeric pids and non-absolute paths, tolerating broken and missing fds", () => withFixture((root, proc) => {
    const fd = path.join(proc, "456", "fd");
    const relativeTarget = path.join(fd, "relative-target");
    const broken = path.join(root, "missing-target");
    const ignored = path.join(root, "ignored");
    fs.mkdirSync(fd, { recursive: true });
    fs.writeFileSync(relativeTarget, "relative");
    fs.writeFileSync(ignored, "ignored");
    fs.symlinkSync("relative-target", path.join(fd, "1"));
    fs.symlinkSync(broken, path.join(fd, "2"));
    fs.symlinkSync("relative-cwd", path.join(proc, "456", "cwd"));
    fs.mkdirSync(path.join(proc, "789"));
    fs.mkdirSync(path.join(proc, "not-a-pid", "fd"), { recursive: true });
    fs.symlinkSync(ignored, path.join(proc, "not-a-pid", "fd", "1"));

    const { openPaths, openInodes } = collectOpenProcInfo(proc);
    assert.deepEqual(openPaths, new Set([broken]));
    assert.deepEqual(openInodes, new Set([inode(relativeTarget)]));
    assert.ok(!openPaths.has("relative-target"));
    assert.ok(!openPaths.has("relative-cwd"));
    assert.ok(!openInodes.has(inode(ignored)));
  }));

  it("continues collecting when an fd disappears after enumeration", (t) => withFixture((root, proc) => {
    const fd = path.join(proc, "123", "fd");
    const vanished = path.join(fd, "1");
    const survivor = path.join(root, "survivor");
    const goneTarget = path.join(root, "gone-target");
    fs.mkdirSync(fd, { recursive: true });
    fs.writeFileSync(survivor, "survivor");
    fs.writeFileSync(goneTarget, "gone");
    fs.symlinkSync(goneTarget, vanished);
    fs.symlinkSync(survivor, path.join(fd, "2"));
    const readdir = fs.readdirSync;
    let removed = false;
    const mock = t.mock.method(fs, "readdirSync", (...args) => {
      const entries = readdir(...args);
      if (args[0] === fd) {
        assert.ok(entries.includes("1"));
        fs.unlinkSync(vanished);
        removed = true;
      }
      return entries;
    });
    try {
      const { openPaths, openInodes } = collectOpenProcInfo(proc);
      assert.equal(removed, true);
      assert.deepEqual(openPaths, new Set([survivor]));
      assert.deepEqual(openInodes, new Set([inode(survivor)]));
    } finally {
      mock.mock.restore();
    }
  }));

  it("returns empty sets for a missing proc root", () => withFixture((_root, proc) => {
    assert.deepEqual(collectOpenProcInfo(proc), { openPaths: new Set(), openInodes: new Set() });
  }));
});
