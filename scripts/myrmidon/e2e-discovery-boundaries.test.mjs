import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listE2eSpecs } from "../e2e-shard.mjs";

function fixture(t) {
  const temp = tmpdir();
  const scratch = temp === "/tmp" ? homedir() : temp;
  const root = mkdtempSync(path.join(scratch, "myrmidon-e2e-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const e2eDir = path.join(root, "tests", "e2e");
  mkdirSync(e2eDir, { recursive: true });
  return { root, e2eDir };
}

function addFile(dir, name) {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

const cases = [
  ["empty directory", [], []],
  ["single spec", ["login.spec.ts"], ["login.spec.ts"]],
  ["another spec", ["smoke.spec.ts"], ["smoke.spec.ts"]],
  ["test suffix", ["login.test.ts"], []],
  ["tsx suffix", ["login.spec.tsx"], []],
  ["uppercase suffix", ["login.SPEC.ts"], []],
  ["backup suffix", ["login.spec.ts.bak"], []],
  ["ignored multi-user", ["multi-user.spec.ts"], []],
  ["ignored authenticated multi-user", ["multi-user-authenticated.spec.ts"], []],
  ["neighbor multi-user extra", ["multi-user-extra.spec.ts"], ["multi-user-extra.spec.ts"]],
  ["neighbor authenticated extra", ["multi-user-authenticated-extra.spec.ts"], ["multi-user-authenticated-extra.spec.ts"]],
  ["nested spec", ["nested/hidden.spec.ts"], []],
  ["ordinary directory", ["folder/readme.txt"], []],
  ["mixed accepted and rejected", ["one.spec.ts", "two.test.ts", "multi-user.spec.ts"], ["one.spec.ts"]],
  ["empty basename", [".spec.ts"], [".spec.ts"]],
  ["extra dot suffix", ["case.spec.ts."], []],
];

for (const [name, files, expected] of cases) {
  test(`discovery: ${name}`, (t) => {
    const { root, e2eDir } = fixture(t);
    for (const file of files) addFile(e2eDir, file);
    assert.deepEqual(listE2eSpecs(e2eDir, root), expected.map((file) => `tests/e2e/${file}`));
  });
}

test("discovery sorts repo-relative paths with localeCompare", (t) => {
  const { root, e2eDir } = fixture(t);
  const names = ["zeta.spec.ts", "Beta.spec.ts", "alpha.spec.ts", "10.spec.ts"];
  for (const file of names) addFile(e2eDir, file);
  const expected = names.map((file) => `tests/e2e/${file}`).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(listE2eSpecs(e2eDir, root), expected);
});

test("discovery uses both explicit directory and repo root", (t) => {
  const { root, e2eDir } = fixture(t);
  addFile(e2eDir, "case.spec.ts");
  assert.deepEqual(listE2eSpecs(e2eDir, path.join(root, "tests")), ["e2e/case.spec.ts"]);
  assert.deepEqual(listE2eSpecs(e2eDir, e2eDir), ["case.spec.ts"]);
});

test("discovery returns parent-relative paths for an external root", (t) => {
  const { root, e2eDir } = fixture(t);
  const repoRoot = path.join(root, "other-repo");
  mkdirSync(repoRoot);
  addFile(e2eDir, "external.spec.ts");
  assert.deepEqual(listE2eSpecs(e2eDir, repoRoot), ["../tests/e2e/external.spec.ts"]);
});

test("sequential roots do not share results", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  addFile(first.e2eDir, "first.spec.ts");
  addFile(second.e2eDir, "second.spec.ts");
  assert.deepEqual(listE2eSpecs(first.e2eDir, first.root), ["tests/e2e/first.spec.ts"]);
  assert.deepEqual(listE2eSpecs(second.e2eDir, second.root), ["tests/e2e/second.spec.ts"]);
  assert.deepEqual(listE2eSpecs(first.e2eDir, first.root), ["tests/e2e/first.spec.ts"]);
});
