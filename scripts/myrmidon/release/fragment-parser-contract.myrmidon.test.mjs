import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFragment } from "./collect-fragments.mjs";

function expectResultTwice(input, expected) {
  const original = input;
  const first = parseFragment(input, "matrix.md");
  assert.deepStrictEqual(first, expected);
  assert.deepStrictEqual(parseFragment(input, "matrix.md"), expected);
  assert.equal(input, original);
}

function expectErrorTwice(input, message) {
  const original = input;
  for (let i = 0; i < 2; i += 1) {
    assert.throws(() => parseFragment(input, "matrix.md"), { name: "Error", message });
    assert.equal(input, original);
  }
}

test("normalizes CRLF while preserving the input", () => {
  expectResultTwice("---\r\nsettings-section: Operations\r\n---\r\n## changelog-en\r\n### Change\r\n- Detail\r\n", {
    meta: { "settings-section": "Operations" },
    sections: { "changelog-en": "### Change\n- Detail" },
    edits: [],
  });
});

test("rejects an unknown front matter key", () => {
  expectErrorTwice("---\nunknown-key: value\n---\n## changelog-en\nText\n", 'matrix.md: unknown front-matter key "unknown-key"');
});

test("rejects an unclosed front matter block", () => {
  expectErrorTwice("---\nsettings-section: Operations\n## changelog-en\nText\n", "matrix.md: front matter opened but never closed");
});

test("rejects duplicate ordinary sections", () => {
  expectErrorTwice("## changelog-en\nFirst\n## changelog-en\nSecond\n", 'matrix.md: duplicate section "## changelog-en"');
});

test("retains repeatable edit sections in order", () => {
  expectResultTwice("## settings-en-new\n### First\nFirst text\n## settings-en-new\n### Second\nSecond text\n", {
    meta: {},
    sections: {},
    edits: [
      { key: "settings-en-new", doc: "settings-en", kind: "new", directives: {}, body: "## First\nFirst text" },
      { key: "settings-en-new", doc: "settings-en", kind: "new", directives: {}, body: "## Second\nSecond text" },
    ],
  });
});

test("keeps fenced headings as content rather than sections", () => {
  expectResultTwice("## changelog-en\n### Example\n```md\n## changelog-ru\n# Sample\n```\n~~~md\n## unknown\n~~~\n", {
    meta: {},
    sections: { "changelog-en": "### Example\n```md\n## changelog-ru\n# Sample\n```\n~~~md\n## unknown\n~~~" },
    edits: [],
  });
});
