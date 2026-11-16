import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverBotScratchDirs } from "./host-clone-cache-gc.mjs";

const fixtureBase = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();
const sorted = (paths) => [...new Set(paths)].sort();

test("discovers only real, visible scratch directory chains without caching", () => {
  const fixture = fs.mkdtempSync(path.join(fixtureBase, "gc-discovery-"));
  try {
    const root = path.join(fixture, "bots");
    const outside = path.join(fixture, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "untouched");
    const sentinelBefore = fs.statSync(sentinel);
    const chain = (agent) => path.join(root, agent, "hermes", "cache", "scratch");
    for (const agent of ["alpha", "beta", ".hidden"]) fs.mkdirSync(chain(agent), { recursive: true });
    fs.writeFileSync(path.join(root, "agent-file"), "not a directory");
    for (const [agent, parts] of [
      ["hermes-file", ["hermes"]],
      ["cache-file", ["hermes", "cache"]],
      ["scratch-file", ["hermes", "cache", "scratch"]],
    ]) {
      const file = path.join(root, agent, ...parts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "not a directory");
    }
    fs.mkdirSync(path.join(outside, "hermes", "cache", "scratch"), { recursive: true });
    fs.mkdirSync(path.join(outside, "cache", "scratch"), { recursive: true });
    fs.mkdirSync(path.join(outside, "scratch"));
    fs.symlinkSync(outside, path.join(root, "agent-link"));
    for (const [agent, parts] of [
      ["hermes-link", ["hermes"]],
      ["cache-link", ["hermes", "cache"]],
      ["scratch-link", ["hermes", "cache", "scratch"]],
    ]) {
      const link = path.join(root, agent, ...parts);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link);
    }
    assert.deepEqual(sorted(discoverBotScratchDirs(path.join(fixture, "missing"))), []);
    assert.deepEqual(sorted(discoverBotScratchDirs(root)), sorted([chain("alpha"), chain("beta")]));
    fs.renameSync(chain("alpha"), path.join(root, "alpha", "hermes", "cache", "old"));
    assert.deepEqual(sorted(discoverBotScratchDirs(root)), [chain("beta")]);
    const sentinelAfter = fs.statSync(sentinel);
    assert.equal(sentinelAfter.size, sentinelBefore.size);
    assert.equal(sentinelAfter.mtimeMs, sentinelBefore.mtimeMs);
    assert.equal(sentinelAfter.atimeMs, sentinelBefore.atimeMs);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
