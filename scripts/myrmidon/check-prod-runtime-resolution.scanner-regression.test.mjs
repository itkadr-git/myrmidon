import assert from "node:assert/strict";
import { test } from "node:test";
import { scanImports } from "./check-prod-runtime-resolution.mjs";

const cases = [
  {
    name: "comments and strings do not create dependencies",
    lines: [
      '// import "./comment.js";',
      '/* export { x } from "./block.js"; */',
      'const text = "escaped \\\" import(\\\"./fake.js\\\") \\\" quote";',
      "const other = 'from \"./fake-from.js\"';",
    ],
    expected: [],
  },
  {
    name: "multiline imports and comments between declarations",
    lines: [
      'import {',
      '  alpha,',
      '} from',
      '  "./same.js";',
      '// between declarations',
      'export {',
      '  beta,',
      '} from "./export.js";',
      '/* between declarations */',
      'import "./side.js";',
      'const module = await import(',
      '  "./same.js"',
      ');',
      'const asset = new URL(',
      '  "./asset.js", import.meta.url',
      ');',
    ],
    expected: [
      { kind: "from", specifier: "./same.js", line: 4 },
      { kind: "from", specifier: "./export.js", line: 8 },
      { kind: "import", specifier: "./side.js", line: 10 },
      { kind: "import", specifier: "./same.js", line: 12 },
      { kind: "url", specifier: "./asset.js", line: 15 },
    ],
  },
  {
    name: "ordinary strings after unrelated identifiers are not imports",
    lines: [
      'const from = "./not-a-dependency.js";',
      '// from',
      '"./also-not.js";',
    ],
    expected: [],
  },
];

for (const newline of ["\n", "\r\n"]) {
  for (const { name, lines, expected } of cases) {
    test(`${name} (${newline === "\n" ? "LF" : "CRLF"})`, () => {
      const source = lines.join(newline);
      const original = source;
      assert.deepEqual(scanImports(source), expected);
      assert.equal(source, original);
    });
  }
}
