import assert from "node:assert/strict";
import test from "node:test";
import { extractImportSpecifiers } from "../../check-module-boundaries.mjs";

const cases = [
  ["default import", 'import value from "alpha";', ["alpha"]],
  ["named import", "import { one, two } from './named.js';", ["./named.js"]],
  ["namespace import", 'import * as all from "pkg/subpath";', ["pkg/subpath"]],
  ["type import", 'import type { Shape } from "./types.js";', ["./types.js"]],
  ["side-effect import", "import './setup.js';", ["./setup.js"]],
  ["named export", 'export { value } from "./value.js";', ["./value.js"]],
  ["star export", "export * from './all.js';", ["./all.js"]],
  ["type export", 'export type { Shape } from "./shape.js";', ["./shape.js"]],
  ["dynamic import", 'const x = import("./lazy.js");', ["./lazy.js"]],
  ["require", "const x = require('./legacy.js');", ["./legacy.js"]],
  ["TypeScript import require", 'import db = require("db");', ["db"]],
  ["empty source", "", []],
  ["computed dynamic import", 'const x = import(prefix + "/module.js");', []],
  ["computed require", 'const x = require(prefix + "/module.js");', []],
  ["ordinary strings", 'const name = "not-a-dependency";', []],
  ["duplicates across forms", [
    'const x = require("shared");',
    'export { item } from "shared";',
    'const y = import("shared");',
    'import "shared";',
  ].join("\n"), ["shared"]],
  ["group order and first occurrence within groups", [
    'const r1 = require("require-first");',
    'const d1 = import("dynamic-first");',
    'export { a } from "export-first";',
    'import "import-first";',
    'const r2 = require("require-second");',
    'const d2 = import("dynamic-second");',
    'export { b } from "export-second";',
    'import "import-second";',
    'export { c } from "import-first";',
    'const r3 = require("dynamic-first");',
  ].join("\n"), [
    "import-first", "import-second", "export-first", "export-second",
    "dynamic-first", "dynamic-second", "require-first", "require-second",
  ]],
];

for (const [name, source, expected] of cases) {
  test(`extractImportSpecifiers: ${name}`, () => {
    assert.deepEqual(extractImportSpecifiers(source), expected);
  });
}
