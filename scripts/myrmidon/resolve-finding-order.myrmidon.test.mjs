import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures } from "./check-prod-runtime-resolution.mjs";

const aa = [
  'import "@myrmidon/repeated";',
  'import "@myrmidon/missing";',
  'import "@myrmidon/repeated";',
  'import "@myrmidon/good";',
].join("\n");
const zz = 'import "@myrmidon/missing";\nimport "@myrmidon/repeated";\n';

function withFixture(order, run) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-tests");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "finding-order-"));
  try {
    const dist = path.join(root, "server", "dist");
    fs.mkdirSync(dist, { recursive: true });
    for (const [name, target] of [["repeated", "./src/index.ts"], ["good", "./dist/index.js"]]) {
      const pkg = path.join(root, "node_modules", "@myrmidon", name);
      fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: `@myrmidon/${name}`, exports: target }));
      if (name === "good") fs.writeFileSync(path.join(pkg, "dist", "index.js"), "export {};\n");
    }
    for (const name of order) fs.writeFileSync(path.join(dist, name), name === "aa.js" ? aa : zz);
    run(dist);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rows(dist) {
  return collectFailures(dist).map(({ file, line, specifier, reason, packageName }) => [
    path.relative(dist, file), line, specifier, reason, packageName,
  ]);
}

const expected = [
  ["aa.js", 1, "@myrmidon/repeated", "exports указывает на .ts", "@myrmidon/repeated"],
  ["aa.js", 2, "@myrmidon/missing", "пакет не найден в node_modules", "@myrmidon/missing"],
  ["aa.js", 3, "@myrmidon/repeated", "exports указывает на .ts", "@myrmidon/repeated"],
  ["zz.js", 1, "@myrmidon/missing", "пакет не найден в node_modules", "@myrmidon/missing"],
  ["zz.js", 2, "@myrmidon/repeated", "exports указывает на .ts", "@myrmidon/repeated"],
];

test("all occurrences are ordered by file and line regardless of file creation order", () => {
  let first;
  withFixture(["aa.js", "zz.js"], (dist) => {
    first = rows(dist);
    assert.deepEqual(first, expected);
  });
  withFixture(["zz.js", "aa.js"], (dist) => {
    assert.deepEqual(rows(dist), expected);
    assert.deepEqual(rows(dist), first);
  });
});

test("repairing one import removes only its finding", () => {
  withFixture(["zz.js", "aa.js"], (dist) => {
    assert.deepEqual(rows(dist), expected);
    fs.writeFileSync(path.join(dist, "aa.js"), aa.replace('import "@myrmidon/missing";', 'import "@myrmidon/good";'));
    assert.deepEqual(rows(dist), [
      ["aa.js", 1, "@myrmidon/repeated", "exports указывает на .ts", "@myrmidon/repeated"],
      ["aa.js", 3, "@myrmidon/repeated", "exports указывает на .ts", "@myrmidon/repeated"],
      ["zz.js", 1, "@myrmidon/missing", "пакет не найден в node_modules", "@myrmidon/missing"],
      ["zz.js", 2, "@myrmidon/repeated", "exports указывает на .ts", "@myrmidon/repeated"],
    ]);
  });
});
