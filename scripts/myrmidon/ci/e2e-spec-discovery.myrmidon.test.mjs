import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { listE2eSpecs } from "../../e2e-shard.mjs";

function withFixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), "cache", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "e2e-discovery-"));
  const dir = path.join(root, "tests", "e2e");
  mkdirSync(dir, { recursive: true });
  const add = (name) => writeFileSync(path.join(dir, name), "");
  try {
    run({ root, dir, add });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("returns a top-level spec relative to the private repository", () => withFixture(({ root, dir, add }) => {
  add("smoke.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/smoke.spec.ts"]);
}));

test("excludes the exact multi-user spec", () => withFixture(({ root, dir, add }) => {
  add("multi-user.spec.ts");
  add("smoke.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/smoke.spec.ts"]);
}));

test("excludes the exact authenticated multi-user spec", () => withFixture(({ root, dir, add }) => {
  add("multi-user-authenticated.spec.ts");
  add("smoke.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/smoke.spec.ts"]);
}));

test("keeps names resembling the excluded multi-user spec", () => withFixture(({ root, dir, add }) => {
  add("multi-user-extra.spec.ts");
  add("multi-user.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/multi-user-extra.spec.ts"]);
}));

test("keeps names resembling the excluded authenticated spec", () => withFixture(({ root, dir, add }) => {
  add("multi-user-authenticated-extra.spec.ts");
  add("multi-user-authenticated.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/multi-user-authenticated-extra.spec.ts"]);
}));

test("does not include test.ts files", () => withFixture(({ root, dir, add }) => {
  add("smoke.test.ts");
  add("smoke.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/smoke.spec.ts"]);
}));

test("does not include backup suffixes", () => withFixture(({ root, dir, add }) => {
  add("smoke.spec.ts.bak");
  add("smoke.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/smoke.spec.ts"]);
}));

test("matches spec extensions case sensitively", () => withFixture(({ root, dir, add }) => {
  add("smoke.SPEC.TS");
  add("smoke.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/smoke.spec.ts"]);
}));

test("does not descend into nested directories", () => withFixture(({ root, dir, add }) => {
  mkdirSync(path.join(dir, "nested"));
  writeFileSync(path.join(dir, "nested", "hidden.spec.ts"), "");
  add("visible.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/visible.spec.ts"]);
}));

test("sorts specs independently of creation order", () => withFixture(({ root, dir, add }) => {
  add("zulu.spec.ts");
  add("alpha.spec.ts");
  add("middle.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/alpha.spec.ts", "tests/e2e/middle.spec.ts", "tests/e2e/zulu.spec.ts"]);
}));

test("uses the supplied repository root for deeply nested directories", () => withFixture(({ root, dir }) => {
  const nested = path.join(dir, "other", "specs");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, "case.spec.ts"), "");
  assert.deepEqual(listE2eSpecs(nested, root), ["tests/e2e/other/specs/case.spec.ts"]);
}));

test("returns an empty list for an empty directory", () => withFixture(({ root, dir }) => {
  assert.deepEqual(listE2eSpecs(dir, root), []);
}));

test("propagates ENOENT for a missing directory", () => withFixture(({ root, dir }) => {
  assert.throws(() => listE2eSpecs(path.join(dir, "missing"), root), { code: "ENOENT" });
}));

test("reflects additions on a subsequent call", () => withFixture(({ root, dir, add }) => {
  add("first.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/first.spec.ts"]);
  add("second.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/first.spec.ts", "tests/e2e/second.spec.ts"]);
}));

test("reflects removals on a subsequent call", () => withFixture(({ root, dir, add }) => {
  add("first.spec.ts");
  add("second.spec.ts");
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/first.spec.ts", "tests/e2e/second.spec.ts"]);
  rmSync(path.join(dir, "first.spec.ts"));
  assert.deepEqual(listE2eSpecs(dir, root), ["tests/e2e/second.spec.ts"]);
}));
