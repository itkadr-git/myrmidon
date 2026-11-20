import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSqlTemplates, formatViolations } from "./sql-template-lint.mjs";

const explanation = "'%' glued to a sql-template interpolation edge (the wildcard leaves the parameter and reaches the wire as bare SQL, e.g. 'like $6%'): ";

const cases = [
  {
    name: "before edge on the first line",
    source: "sql`x %${p}`",
    expected: [{ file: "case.ts", line: 1, column: 7, kind: "before-interpolation", snippet: "sql`x %${p}`" }],
    formatted: ["case.ts:1:7: before-interpolation: " + explanation + "sql`x %${p}`"],
  },
  {
    name: "after edge on the first line",
    source: "sql`x ${p}%`",
    expected: [{ file: "case.ts", line: 1, column: 11, kind: "after-interpolation", snippet: "sql`x ${p}%`" }],
    formatted: ["case.ts:1:11: after-interpolation: " + explanation + "sql`x ${p}%`"],
  },
  {
    name: "both edges and trimmed spaces",
    source: "  sql`%${p}%`  ",
    expected: [
      { file: "case.ts", line: 1, column: 7, kind: "before-interpolation", snippet: "sql`%${p}%`" },
      { file: "case.ts", line: 1, column: 12, kind: "after-interpolation", snippet: "sql`%${p}%`" },
    ],
    formatted: [
      "case.ts:1:7: before-interpolation: " + explanation + "sql`%${p}%`",
      "case.ts:1:12: after-interpolation: " + explanation + "sql`%${p}%`",
    ],
  },
  {
    name: "tab indentation and whitespace after interpolation",
    source: "\tsql`x ${p} %`",
    expected: [{ file: "case.ts", line: 1, column: 13, kind: "after-interpolation", snippet: "sql`x ${p} %`" }],
    formatted: ["case.ts:1:13: after-interpolation: " + explanation + "sql`x ${p} %`"],
  },
  {
    name: "LF and space indentation",
    source: "first\n  sql`x %${p}`",
    expected: [{ file: "case.ts", line: 2, column: 9, kind: "before-interpolation", snippet: "sql`x %${p}`" }],
    formatted: ["case.ts:2:9: before-interpolation: " + explanation + "sql`x %${p}`"],
  },
  {
    name: "CRLF and tab indentation",
    source: "first\r\n\tsql`x ${p}%`",
    expected: [{ file: "case.ts", line: 2, column: 12, kind: "after-interpolation", snippet: "sql`x ${p}%`" }],
    formatted: ["case.ts:2:12: after-interpolation: " + explanation + "sql`x ${p}%`"],
  },
  {
    name: "identical templates on different lines retain order",
    source: "sql`%${p}%`\nsql`%${p}%`",
    expected: [
      { file: "case.ts", line: 1, column: 5, kind: "before-interpolation", snippet: "sql`%${p}%`" },
      { file: "case.ts", line: 1, column: 10, kind: "after-interpolation", snippet: "sql`%${p}%`" },
      { file: "case.ts", line: 2, column: 5, kind: "before-interpolation", snippet: "sql`%${p}%`" },
      { file: "case.ts", line: 2, column: 10, kind: "after-interpolation", snippet: "sql`%${p}%`" },
    ],
    formatted: [
      "case.ts:1:5: before-interpolation: " + explanation + "sql`%${p}%`",
      "case.ts:1:10: after-interpolation: " + explanation + "sql`%${p}%`",
      "case.ts:2:5: before-interpolation: " + explanation + "sql`%${p}%`",
      "case.ts:2:10: after-interpolation: " + explanation + "sql`%${p}%`",
    ],
  },
  {
    name: "shared wildcard is reported at both edges in order",
    source: "sql`%${p} % ${q}%`",
    expected: [
      { file: "case.ts", line: 1, column: 5, kind: "before-interpolation", snippet: "sql`%${p} % ${q}%`" },
      { file: "case.ts", line: 1, column: 11, kind: "after-interpolation", snippet: "sql`%${p} % ${q}%`" },
      { file: "case.ts", line: 1, column: 11, kind: "before-interpolation", snippet: "sql`%${p} % ${q}%`" },
      { file: "case.ts", line: 1, column: 17, kind: "after-interpolation", snippet: "sql`%${p} % ${q}%`" },
    ],
    formatted: [
      "case.ts:1:5: before-interpolation: " + explanation + "sql`%${p} % ${q}%`",
      "case.ts:1:11: after-interpolation: " + explanation + "sql`%${p} % ${q}%`",
      "case.ts:1:11: before-interpolation: " + explanation + "sql`%${p} % ${q}%`",
      "case.ts:1:17: after-interpolation: " + explanation + "sql`%${p} % ${q}%`",
    ],
  },
  {
    name: "snippet is trimmed and limited to 120 characters",
    source: "  sql`%${p}` " + "a".repeat(130) + "  ",
    expected: [{ file: "case.ts", line: 1, column: 7, kind: "before-interpolation", snippet: "sql`%${p}` aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
    formatted: ["case.ts:1:7: before-interpolation: " + explanation + "sql`%${p}` aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  },
  {
    name: "wildcards inside a value are clean",
    source: "sql`where body like ${'%' + term + '%'}`",
    expected: [],
    formatted: [],
  },
];

for (const { name, source, expected, formatted } of cases) {
  test(name, () => {
    const actual = lintSqlTemplates(source, "case.ts");
    assert.deepEqual(actual, expected);
    assert.deepEqual(formatViolations(actual), formatted);
    assert.deepEqual(lintSqlTemplates(source, "case.ts"), expected);
  });
}
