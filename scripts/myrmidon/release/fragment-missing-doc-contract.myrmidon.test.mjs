import assert from "node:assert/strict";
import { test } from "node:test";
import { convert } from "./fragments-from-diff.mjs";

const docs = [
  "docs/myrmidon/CHANGELOG.md",
  "docs/myrmidon/CHANGELOG.ru.md",
  "docs/myrmidon/DIVERGENCE.md",
  "docs/myrmidon/SETTINGS.md",
  "docs/myrmidon/SETTINGS.ru.md",
];
const baseText = "# Registry\n\n## Unreleased\n\n### Old\n\n- Old.\n";
const headText = `${baseText}\n### New\n\n- New.\n`;
const change = { oldStart: 7, oldCount: 0, newStart: 8, newCount: 3, removed: [], added: ["### New", "", "- New."] };

function inputs() {
  return {
    base: Object.fromEntries(docs.map((rel) => [rel, baseText])),
    head: Object.fromEntries(docs.map((rel) => [rel, baseText])),
    hunks: {},
  };
}

function checkedConvert(data, options) {
  const before = structuredClone(data);
  const result = convert(data.base, data.head, data.hunks, options);
  assert.deepStrictEqual(data, before, "convert must not mutate input documents or hunks");
  return result;
}

for (const rel of docs) {
  for (const missing of ["base", "head"]) {
    test(`${rel}: missing ${missing} with a hunk fails closed`, () => {
      const data = inputs();
      data[missing][rel] = null;
      data.hunks[rel] = [structuredClone(change)];
      assert.deepStrictEqual(checkedConvert(data), {
        fragment: null,
        unsupported: [`${rel}: the file is added or removed by the branch`],
        warnings: [],
        verify: null,
      });
    });
  }
}

test("a missing document blocks a valid edit in another document", () => {
  const data = inputs();
  const missing = docs[4];
  data.base[missing] = null;
  data.hunks[missing] = [structuredClone(change)];
  data.head[docs[0]] = headText;
  data.hunks[docs[0]] = [structuredClone(change)];
  assert.deepStrictEqual(checkedConvert(data), {
    fragment: null,
    unsupported: [`${missing}: the file is added or removed by the branch`],
    warnings: [],
    verify: null,
  });
});

test("missing documents without hunks are ignored even beside a valid edit", () => {
  const data = inputs();
  data.base[docs[4]] = null;
  data.head[docs[0]] = headText;
  data.hunks[docs[0]] = [structuredClone(change)];
  const result = checkedConvert(data, { verify: false });
  assert.deepStrictEqual(result.unsupported, []);
  assert.deepStrictEqual(result.warnings, []);
  assert.equal(result.verify, null);
  assert.equal(result.fragment, "## changelog-en\n\n### New\n\n- New.\n");
});

test("existing documents produce a verified fragment for a supported edit", () => {
  const data = inputs();
  data.head[docs[0]] = headText;
  data.hunks[docs[0]] = [structuredClone(change)];
  const result = checkedConvert(data);
  assert.equal(result.fragment, "## changelog-en\n\n### New\n\n- New.\n");
  assert.deepStrictEqual(result.unsupported, []);
  assert.deepStrictEqual(result.warnings, []);
  assert.deepStrictEqual(result.verify, { level: "exact", details: [] });
});
