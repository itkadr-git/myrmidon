import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { generateBarrelContent } from "../generate-shared-exports.mjs";

const contracts = [
  "blocker-graph.ts",
  "continuation-key.ts",
  "interaction-routing.ts",
  "recovery-factory.ts",
  "task-card-readiness.ts",
];

function fixture(t, files = []) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "standalone-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "packages/shared/src");
  mkdirSync(src, { recursive: true });
  for (const file of files) {
    const path = join(src, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `// fixture ${file}\n`);
  }
  return { root, src };
}

function exportsOf(content) {
  return content.split("\n").filter((line) => line.startsWith("export "));
}

function statement(specifier) {
  return `export * from "${specifier}";`;
}

for (const file of contracts) {
  test(`exports the standalone ${file} on its own`, (t) => {
    const { root } = fixture(t, [file]);
    assert.deepEqual(exportsOf(generateBarrelContent(root)), [statement(`../${file.replace(/\.ts$/, ".js")}`)]);
  });
  test(`omits absent standalone ${file}`, (t) => {
    const { root } = fixture(t, contracts.filter((name) => name !== file));
    const expected = contracts.filter((name) => name !== file)
      .map((name) => statement(`../${name.replace(/\.ts$/, ".js")}`));
    assert.deepEqual(exportsOf(generateBarrelContent(root)), expected);
  });
}

test("exports all five standalone contracts exactly once", (t) => {
  const { root } = fixture(t, contracts);
  assert.deepEqual(exportsOf(generateBarrelContent(root)), contracts.map((file) => statement(`../${file.replace(/\.ts$/, ".js")}`)));
});

for (const [file, expected] of [
  ["foo.ts", []],
  ["myrmidon-foo.ts", [statement("../myrmidon-foo.js")]],
  ["myrmidon-foo.test.ts", []],
  ["myrmidon-foo.d.ts", []],
  ["myrmidon-foo.tsx", []],
  ["myrmidon-foo.js", []],
  ["myrmidon.ts", []],
  ["myrmidonfoo.ts", []],
]) {
  test(`applies prefix and extension boundary to ${file}`, (t) => {
    const { root } = fixture(t, [file]);
    assert.deepEqual(exportsOf(generateBarrelContent(root)), expected);
  });
}

test("sorts mixed domain and standalone specifiers and ends with a newline", (t) => {
  const { root } = fixture(t, ["myrmidon/zeta.ts", "myrmidon/alpha.ts", "task-card-readiness.ts", "myrmidon-beta.ts", "blocker-graph.ts"]);
  const content = generateBarrelContent(root);
  const expected = ["../blocker-graph.js", "../myrmidon-beta.js", "../task-card-readiness.js", "./alpha.js", "./zeta.js"];
  assert.deepEqual(expected, [...expected].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(exportsOf(content), expected.map(statement));
  assert.ok(content.endsWith(`${statement("./zeta.js")}\n`));
});

test("does not create a barrel or change fixture bytes", (t) => {
  const files = ["blocker-graph.ts", "myrmidon-foo.ts", "myrmidon/alpha.ts"];
  const { root, src } = fixture(t, files);
  const snapshot = () => files.map((file) => readFileSync(join(src, file)));
  const before = snapshot();
  const entries = readdirSync(join(src, "myrmidon"));
  assert.deepEqual(exportsOf(generateBarrelContent(root)), [statement("../blocker-graph.js"), statement("../myrmidon-foo.js"), statement("./alpha.js")]);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readdirSync(join(src, "myrmidon")), entries);
});

test("does not retain exports across root A, B, A calls", (t) => {
  const a = fixture(t, ["blocker-graph.ts"]);
  const b = fixture(t, ["myrmidon-beta.ts"]);
  assert.deepEqual(exportsOf(generateBarrelContent(a.root)), [statement("../blocker-graph.js")]);
  assert.deepEqual(exportsOf(generateBarrelContent(b.root)), [statement("../myrmidon-beta.js")]);
  assert.deepEqual(exportsOf(generateBarrelContent(a.root)), [statement("../blocker-graph.js")]);
});
