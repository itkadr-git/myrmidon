import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSqlTemplates, skipExpression, skipTemplate, templateTextParts } from "./sql-template-lint.mjs";

// Each fixture specifies the expression and surrounding literal text independently.
const cases = [
  ["nested object braces", "{a: {b: 1}}", "left", "right"],
  ["single quote and escaped quote", "'a\\' } b'", "before", "after"],
  ["double quote and escaped backslash", '"a\\\\ } b"', "x", "y"],
  ["nested template interpolation", "`inside ${ {x: '}'} .x } end`", "one", "two"],
  ["line comment", "value // } { %\n + other", "a", "b"],
  ["block comment", "value /* } { % */ + other", "a", "b"],
  ["escaped template backtick", "`a\\` } ${value} z`", "pre", "post"],
  ["mixed nested constructs", "({x: `p${{n: '%'}}q`, y: '}' /* { */})", "L", "R"],
];

for (const [name, expression, left, right] of cases) {
  test(`absolute interpolation boundaries: ${name}`, () => {
    const prefix = "const query = sql`";
    const interpolation = "${" + expression + "}";
    const source = prefix + left + interpolation + right + "` trailing";
    const open = prefix.length - 1;
    const brace = prefix.length + left.length + 1;
    const afterExpression = prefix.length + left.length + interpolation.length;
    const close = afterExpression + right.length;
    const expected = [
      { start: prefix.length, end: prefix.length + left.length },
      { start: afterExpression, end: close },
    ];
    const result = templateTextParts(source, open);
    assert.deepEqual(result, { parts: expected, close });
    assert.deepEqual(result.parts.map(({ start, end }) => source.slice(start, end)), [left, right]);
    assert.equal(skipExpression(source, brace), afterExpression);
    assert.equal(source.slice(brace, afterExpression), "{" + expression + "}");
    assert.equal(skipTemplate(source, open), close + 1);
    assert.equal(source.slice(open, close + 1), "`" + left + interpolation + right + "`");
  });
}

test("adjacent interpolations retain the empty text part and absolute offsets", () => {
  const source = "prefix sql`${{x: 1}}${`a${v}`}` suffix";
  const open = "prefix sql".length;
  const first = "${{x: 1}}";
  const second = "${`a${v}`}";
  const start = open + 1;
  const middle = start + first.length;
  const close = middle + second.length;
  const result = templateTextParts(source, open);
  assert.deepEqual(result, { parts: [
    { start, end: start },
    { start: middle, end: middle },
    { start: close, end: close },
  ], close });
  assert.deepEqual(result.parts.map(({ start: a, end }) => source.slice(a, end)), ["", "", ""]);
  assert.equal(skipExpression(source, start + 1), middle);
  assert.equal(skipExpression(source, middle + 1), close);
  assert.equal(skipTemplate(source, open), close + 1);
});

test("lint flags outer percent but ignores percent in nested expressions and comments", () => {
  const expression = "`%${{x: '%'} /* } % */.x}%`";
  const safe = "const q = sql`a${" + expression + "}b`;";
  const after = "const q = sql`a${" + expression + "}%`;";
  const before = "const q = sql`a%${" + expression + "}b`;";
  assert.deepEqual(lintSqlTemplates(safe, "fixture.ts"), []);
  for (const [source, kind, offset] of [
    [after, "after-interpolation", after.lastIndexOf("%")],
    [before, "before-interpolation", before.indexOf("%")],
  ]) {
    assert.deepEqual(lintSqlTemplates(source, "fixture.ts"), [{
      file: "fixture.ts", line: 1, column: offset + 1, kind, snippet: source,
    }]);
  }
});
