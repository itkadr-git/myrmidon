import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures } from "./check-prod-runtime-resolution.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-graph-"));
  const dist = path.join(dir, "server", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), 'import "@myrmidon/a";\nimport "@myrmidon/b";\n');
  function pkg(name, body) {
    const root = path.join(dir, "node_modules", "@myrmidon", name);
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: `@myrmidon/${name}`, type: "module", exports: "./dist/index.js",
    }));
    const file = path.join(root, "dist", "index.js");
    fs.writeFileSync(file, body);
    return file;
  }
  return { dir, dist, pkg };
}

function leafFailure(file, line) {
  return {
    file: fs.realpathSync(file),
    line,
    specifier: "@myrmidon/leaf",
    reason: "пакет не найден в node_modules",
    packageName: "@myrmidon/leaf",
  };
}

test("cycle and diamond visit shared once and see changes on each call", () => {
  const { dir, dist, pkg } = fixture();
  try {
    pkg("a", 'import "@myrmidon/b";\nimport "@myrmidon/shared";\n');
    pkg("b", 'import "@myrmidon/a";\nimport "@myrmidon/shared";\n');
    const shared = pkg("shared", 'export const shared = true;\nimport "@myrmidon/leaf";\n');
    const expected = [leafFailure(shared, 2)];
    assert.deepEqual(collectFailures(dist), expected);
    assert.deepEqual(collectFailures(dist), expected);
    fs.writeFileSync(shared, "export const shared = true;\n");
    assert.deepEqual(collectFailures(dist), []);
    fs.writeFileSync(shared, 'export const shared = true;\nimport "@myrmidon/leaf";\n');
    assert.deepEqual(collectFailures(dist), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("distinct missing import occurrences in a shared file are reported separately", () => {
  const { dir, dist, pkg } = fixture();
  try {
    pkg("a", 'import "@myrmidon/shared";\n');
    pkg("b", 'import "@myrmidon/shared";\n');
    const shared = pkg("shared", 'import "@myrmidon/leaf";\nimport "@myrmidon/leaf";\n');
    assert.deepEqual(collectFailures(dist), [leafFailure(shared, 1), leafFailure(shared, 2)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
