import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { generateBarrelContent } from "../generate-shared-exports.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(homedir(), ".cache");

function fixture(t, files = []) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "shared-subdirs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const domain = join(root, "packages/shared/src/myrmidon");
  mkdirSync(domain, { recursive: true });
  for (const file of files) {
    const target = join(domain, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "// fixture\n");
  }
  return root;
}

function statements(root) {
  return generateBarrelContent(root).split("\n").filter((line) => line.startsWith("export "));
}

const cases = [
  ["empty tree", [], []],
  ["direct subdirectory index", ["dir/index.ts"], ['export * from "./dir/index.js";']],
  ["directory without index", ["dir/module.ts"], []],
  ["nested index without parent index", ["dir/nested/index.ts"], []],
  ["test index is not a barrel", ["dir/index.test.ts"], []],
  ["declaration index is not a barrel", ["dir/index.d.ts"], []],
  ["both index variants are not a barrel", ["dir/index.test.ts", "dir/index.d.ts"], []],
  ["root index does not export itself", ["index.ts"], []],
  ["direct TypeScript module", ["module.ts"], ['export * from "./module.js";']],
  ["direct test excluded", ["module.test.ts"], []],
  ["direct declaration excluded", ["module.d.ts"], []],
  ["direct TSX excluded", ["module.tsx"], []],
  ["direct JavaScript excluded", ["module.js"], []],
  ["parent index does not leak descendants", ["dir/index.ts", "dir/nested/index.ts", "dir/internal.ts"], ['export * from "./dir/index.js";']],
  ["only indexed siblings are exported", ["alpha/index.ts", "beta/module.ts", "gamma/index.ts"], ['export * from "./alpha/index.js";', 'export * from "./gamma/index.js";']],
  ["mixed exports are sorted with no duplicates", ["zeta/index.ts", "beta.ts", "alpha/index.ts", "alpha.ts", "zeta/internal.ts"], ['export * from "./alpha.js";', 'export * from "./alpha/index.js";', 'export * from "./beta.js";', 'export * from "./zeta/index.js";']],
];

for (const [name, files, expected] of cases) {
  test(name, (t) => {
    assert.deepEqual(statements(fixture(t, files)), expected);
  });
}

test("consecutive roots do not share discovery state", (t) => {
  const first = fixture(t, ["first/index.ts"]);
  const second = fixture(t, ["second/index.ts"]);
  assert.deepEqual(statements(first), ['export * from "./first/index.js";']);
  assert.deepEqual(statements(second), ['export * from "./second/index.js";']);
  assert.deepEqual(statements(first), ['export * from "./first/index.js";']);
});

test("creation order does not change output bytes", (t) => {
  const files = ["zeta/index.ts", "alpha.ts", "beta/index.ts", "gamma.ts"];
  const first = fixture(t, files);
  const second = fixture(t, [...files].reverse());
  const expected = ['export * from "./alpha.js";', 'export * from "./beta/index.js";', 'export * from "./gamma.js";', 'export * from "./zeta/index.js";'];
  assert.deepEqual(statements(first), expected);
  assert.deepEqual(statements(second), expected);
  assert.equal(generateBarrelContent(first), generateBarrelContent(second));
});
