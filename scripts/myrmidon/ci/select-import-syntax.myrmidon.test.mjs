import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importSpecifiers, selectTests } from "./select.mjs";

const forms = [
  ["from single quotes", "import x from './target.js';"],
  ["from double quotes", 'import x from "./target.js";'],
  ["from backticks", "import x from `./target.js`;"],
  ["side-effect import", "import './target.js';"],
  ["dynamic import", "const x = import('./target.js');"],
  ["dynamic import with whitespace", "const x = import (  './target.js' );"],
  ["dynamic import with newline", "const x = import(\n './target.js'\n);"],
  ["require", "const x = require('./target.js');"],
  ["vi.mock", "vi.mock('./target.js');"],
  ["vi.doMock", "vi.doMock('./target.js');"],
  ["vi.importActual", "vi.importActual('./target.js');"],
];

const packages = [{ name: "@myrmidon/server", dir: "server", vitestProject: true }];
const importer = "server/src/services/importer.test.ts";
const unrelated = { file: "server/src/services/unrelated.test.ts", source: "import './other.js';" };

describe("supported import syntax", () => {
  for (const [name, source] of forms) {
    it(`extracts and selects a direct importer for ${name}`, () => {
      assert.deepEqual(importSpecifiers(source), ["./target.js"]);
      assert.deepEqual(selectTests(["server/src/services/target.ts"], packages, [
        { file: importer, source }, unrelated,
      ]), { wholePackages: [], files: [{ package: "@myrmidon/server", files: [importer] }] });
    });
  }

  it("preserves the first occurrence of duplicate specifiers", () => {
    const source = "import './first'; require('./second'); vi.mock('./first'); import './third'; require('./second');";
    assert.deepEqual(importSpecifiers(source), ["./first", "./second", "./third"]);
  });

  it("returns no specifiers for an empty source", () => {
    assert.deepEqual(importSpecifiers(""), []);
  });

  it("does not retain specifiers between calls", () => {
    assert.deepEqual(importSpecifiers("import './previous';"), ["./previous"]);
    assert.deepEqual(importSpecifiers("import './next';"), ["./next"]);
    assert.deepEqual(importSpecifiers(""), []);
  });

  it("selects a direct importer of a scoped package subpath", () => {
    const source = "import x from '@scope/adapter/server';";
    assert.deepEqual(importSpecifiers(source), ["@scope/adapter/server"]);
    assert.deepEqual(selectTests(["packages/adapter/src/server.ts"], [
      ...packages, { name: "@scope/adapter", dir: "packages/adapter" },
    ], [{ file: importer, source }, unrelated]), {
      wholePackages: ["@scope/adapter"],
      files: [{ package: "@myrmidon/server", files: [importer] }],
    });
  });

  it("ignores a dynamic import without a string specifier", () => {
    const source = "const x = import(target);";
    assert.deepEqual(importSpecifiers(source), []);
    assert.deepEqual(selectTests(["server/src/services/target.ts"], packages, [
      { file: importer, source }, unrelated,
    ]), { wholePackages: [], files: [] });
  });

  it("ignores unsupported vi methods", () => {
    const source = "vi.other('./target.js');";
    assert.deepEqual(importSpecifiers(source), []);
    assert.deepEqual(selectTests(["server/src/services/target.ts"], packages, [
      { file: importer, source }, unrelated,
    ]), { wholePackages: [], files: [] });
  });
});
