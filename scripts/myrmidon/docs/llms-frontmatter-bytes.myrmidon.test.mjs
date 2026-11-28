import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontMatter } from "./generate-llms-txt.mjs";

const cases = [
  ["absent block", "title: body", { title: null, summary: null }],
  ["unclosed block", "---\ntitle: T\nsummary: S", { title: null, summary: null }],
  ["title only", "---\ntitle: T\n---", { title: "T", summary: null }],
  ["summary only", "---\nsummary: S\n---", { title: null, summary: "S" }],
  ["empty values", "---\ntitle:\nsummary:   \n---", { title: "", summary: "" }],
  ["double quotes", '---\ntitle: "Title"\nsummary: "Summary"\n---', { title: "Title", summary: "Summary" }],
  ["single quotes", "---\ntitle: 'Title'\nsummary: 'Summary'\n---", { title: "Title", summary: "Summary" }],
  ["quotes stripped once", `---\ntitle: "'Title'"\nsummary: '"Summary"'\n---`, { title: "'Title'", summary: '"Summary"' }],
  ["unmatched quotes", `---\ntitle: "Title\nsummary: Summary'\n---`, { title: '"Title', summary: "Summary'" }],
  ["mismatched quotes", `---\ntitle: "Title'\nsummary: 'Summary"\n---`, { title: `"Title'`, summary: `'Summary"` }],
  ["trim value padding", "---\ntitle:   padded title  \nsummary: \t padded summary \t\n---", { title: "padded title", summary: "padded summary" }],
  ["colon retained", "---\ntitle: One: Two\nsummary: A: B: C\n---", { title: "One: Two", summary: "A: B: C" }],
  ["Unicode retained", "---\ntitle: \u041f\u0440\u0438\u0432\u0435\u0442 \ud83c\udf0d\nsummary: caf\u00e9 \u6771\u4eac\n---", { title: "\u041f\u0440\u0438\u0432\u0435\u0442 \ud83c\udf0d", summary: "caf\u00e9 \u6771\u4eac" }],
  ["unknown key ignored", "---\nother: X\ntitle: T\n---", { title: "T", summary: null }],
  ["indented keys ignored", "---\n title: X\n\tsummary: Y\n---", { title: null, summary: null }],
  ["last values win", "---\ntitle: first\nsummary: first\ntitle: last\nsummary: last\n---", { title: "last", summary: "last" }],
  ["body cannot override front matter", "---\ntitle: T\nsummary: S\n---\ntitle: body\nsummary: body", { title: "T", summary: "S" }],
];

for (const [name, content, expected] of cases) {
  test(`parseFrontMatter: ${name}`, () => {
    assert.deepEqual(parseFrontMatter(content), expected);
  });
}
