// OPE-10256: acceptance coverage for botd clone/cache GC safety.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const { plan, OPS } = require(path.join(ROOT, "docker/bot-runtime/botd/lib/rules.js"));
const { cacheRetentionPass } = require(path.join(ROOT, "docker/bot-runtime/botd/lib/cache-lifecycle.js"));

const NOW = new Date("2026-10-31T00:00:00.000Z");
const old = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000 - 1);
const desired = (overrides = {}) => ({
  workspaces: [],
  protectKeys: [],
  closedKeys: [],
  pressure: { level: "none" },
  ...overrides,
});

describe("OPE-10256 botd GC acceptance", () => {
  it("removes only board-confirmed closed copies and never active copies", () => {
    const inventory = {
      worktrees: [
        { key: "OPE-10256", path: "/workspace/OPE-10256", openedAt: old, clean: true, pushed: true },
        { key: "OPE-10257", path: "/workspace/OPE-10257", openedAt: old, clean: true, pushed: true },
      ],
      scratch: [],
      run: { live: false },
    };
    const state = desired({
      workspaces: [{ key: "OPE-10257", state: "active" }],
      closedKeys: ["OPE-10256"],
    });
    const actions = plan(inventory, state, NOW).actions;
    assert.deepEqual(actions.map(({ op, key }) => ({ op, key })), [
      { op: OPS.remove, key: "OPE-10256" },
    ]);
  });

  it("fails closed when the board does not provide closedKeys", () => {
    const state = desired();
    delete state.closedKeys;
    const actions = plan({
      worktrees: [],
      scratch: [{ name: "OPE-10256", path: "/workspace/OPE-10256", mtime: old, clean: true, pushed: true }],
      run: { live: false },
    }, state, NOW).actions;
    assert.deepEqual(actions, []);
  });

  it("preserves dry-run semantics and emits the cache LRU plan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ope-10256-cache-"));
    try {
      const oldFile = path.join(root, "old.bin");
      const freshFile = path.join(root, "fresh.bin");
      fs.writeFileSync(oldFile, "old");
      fs.writeFileSync(freshFile, "fresh");
      fs.utimesSync(oldFile, old, old);
      fs.utimesSync(freshFile, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000));
      const result = cacheRetentionPass(root, { now: NOW, dryRun: true, capBytes: 1 });
      assert.equal(fs.existsSync(oldFile), true);
      assert.equal(fs.existsSync(freshFile), true);
      assert.deepEqual(result.removed.map((item) => item.name).sort(), ["fresh.bin", "old.bin"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
