import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFragment } from "./collect-fragments.mjs";

const families = ["divergence", "settings-en", "settings-ru"];
const positives = [
  { name: "no anchor", lines: "", directives: {} },
  { name: "after", lines: "<!-- after: Existing section -->\n", directives: { after: "Existing section" } },
  { name: "after with second occurrence", lines: "<!-- after: Twin -->\n<!-- occurrence: 2 -->\n", directives: { after: "Twin", occurrence: "2" } },
  { name: "after-line", lines: "<!-- after-line: Marker line -->\n", directives: { "after-line": "Marker line" } },
];
const rejections = [
  { name: "section", lines: "<!-- section: Existing -->\n", message: (key) => `section "${key}" takes "after" or "after-line", not "section"` },
  { name: "occurrence without after", lines: "<!-- occurrence: 2 -->\n", message: (key) => `section "${key}": "occurrence" goes with "after"` },
  { name: "after and after-line", lines: "<!-- after: Existing -->\n<!-- after-line: Marker -->\n", message: (key) => `section "${key}": "after" and "after-line" are mutually exclusive` },
  { name: "non-heading body", lines: "", body: "Plain text\n### Later", message: (key) => `section "${key}" must start with a "### <heading>" line (it becomes a "##" section)` },
];

describe("new-block directive matrix", () => {
  for (const doc of families) {
    const key = `${doc}-new`;
    for (const control of positives) {
      it(`${key}: ${control.name}`, () => {
        const input = `## ${key}\n${control.lines}### ${doc} title\n\nText for ${control.name}.\n#### Detail\n`;
        assert.deepEqual(parseFragment(input, "matrix.md"), {
          meta: {},
          sections: {},
          edits: [{ key, doc, kind: "new", directives: control.directives, body: `## ${doc} title\n\nText for ${control.name}.\n### Detail` }],
        });
      });
    }
    for (const control of rejections) {
      it(`${key}: rejects ${control.name}`, () => {
        const input = `## ${key}\n${control.lines}${control.body ?? "### Valid title"}\n`;
        assert.throws(() => parseFragment(input, "matrix.md"), {
          name: "Error",
          message: `matrix.md: ${control.message(key)}`,
        });
      });
    }
    it(`${key}: keeps paired new blocks isolated`, () => {
      const input = `## ${key}\n<!-- after: Twin -->\n<!-- occurrence: 2 -->\n### First\nFirst body.\n\n## ${key}\n<!-- after-line: Marker -->\n### Second\nSecond body.\n`;
      assert.deepEqual(parseFragment(input, "pair.md"), {
        meta: {},
        sections: {},
        edits: [
          { key, doc, kind: "new", directives: { after: "Twin", occurrence: "2" }, body: "## First\nFirst body." },
          { key, doc, kind: "new", directives: { "after-line": "Marker" }, body: "## Second\nSecond body." },
        ],
      });
    });
  }
});
