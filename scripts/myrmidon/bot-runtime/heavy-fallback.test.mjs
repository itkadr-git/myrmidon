// scripts/myrmidon/bot-runtime/heavy-fallback.test.mjs
//
// myrmidon(1.6.5 DEVBUILD-IN-BOTS): heavy build commands that pass the
// devbuild gate still run inside the container's cgroup — they get a heap
// cap (--max-old-space-size) and a stderr warning pointing at devbuild.
// Light probes (version/help) must stay untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The wrapper is CJS by design (it runs from /opt in the image, where no
// package.json reaches), but the repo root is "type": "module", so a direct
// require of the .js file fails. Load a .cjs copy — same bytes, CJS module.
const tmp = mkdtempSync(path.join(tmpdir(), "heavy-fallback-test-"));
copyFileSync(
  path.resolve("docker/bot-runtime/build-wrappers/heavy-fallback.js"),
  path.join(tmp, "heavy-fallback.cjs"),
);
const require = createRequire(import.meta.url);
const { applyHeavyFallback, localNodeHeapMb } = require(path.join(tmp, "heavy-fallback.cjs"));

test("default cap is 2048 MB and appends to NODE_OPTIONS", () => {
  const { env, warning } = applyHeavyFallback("tsc", { PATH: "/bin", NODE_OPTIONS: "--inspect" });
  assert.equal(env.NODE_OPTIONS, "--inspect --max-old-space-size=2048");
  assert.match(warning, /tsc/);
  assert.match(warning, /2048 MB/);
  assert.match(warning, /devbuild/);
});

test("no NODE_OPTIONS set: cap alone, no leading space", () => {
  const { env } = applyHeavyFallback("vitest", {});
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=2048");
});

test("caller's own --max-old-space-size wins: no warning, no change", () => {
  const envIn = { NODE_OPTIONS: "--max-old-space-size=4096" };
  const { env, warning } = applyHeavyFallback("tsc", envIn);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=4096");
  assert.equal(warning, null);
});

test("MYRMIDON_LOCAL_NODE_HEAP_MB overrides the default", () => {
  const { env } = applyHeavyFallback("tsc", { MYRMIDON_LOCAL_NODE_HEAP_MB: "1024" });
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=1024");
});

test("MYRMIDON_LOCAL_NODE_HEAP_MB=0 opts out entirely", () => {
  const { env, warning } = applyHeavyFallback("tsc", { MYRMIDON_LOCAL_NODE_HEAP_MB: "0" });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(warning, null);
});

test("garbage override falls back to the default", () => {
  assert.equal(localNodeHeapMb({ MYRMIDON_LOCAL_NODE_HEAP_MB: "lots" }), 2048);
  assert.equal(localNodeHeapMb({ MYRMIDON_LOCAL_NODE_HEAP_MB: "-5" }), 2048);
  assert.equal(localNodeHeapMb({}), 2048);
});

test("input env is not mutated", () => {
  const envIn = { NODE_OPTIONS: "--inspect" };
  applyHeavyFallback("tsc", envIn);
  assert.equal(envIn.NODE_OPTIONS, "--inspect");
});
