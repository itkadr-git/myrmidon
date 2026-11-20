import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFragment } from "./collect-fragments.mjs";

const docs = ["divergence", "settings-en", "settings-ru"];
const prose = "A first paragraph.\n\nA second paragraph.";
const mixed = "Notes before rows.\n\n| alpha | beta |\n| gamma | delta |";
const rows = "| alpha | beta |\n\n  | gamma | delta |";

function fragment(doc, directives, body) {
  return `## ${doc}-append\n${directives.join("\n")}\n${body}\n`;
}

for (const doc of docs) {
  describe(`${doc} append directive matrix`, () => {
    const key = `${doc}-append`;
    const filename = `matrix-${doc}.md`;
    const valid = [
      ["prose with section", ["<!-- section: Track 7 -->"], prose, { section: "Track 7" }],
      ["prose with section and occurrence", ["<!-- section: Twin -->", "<!-- occurrence: 2 -->"], prose, { section: "Twin", occurrence: "2" }],
      ["prose with after-line", ["<!-- after-line: Exact line. -->"], prose, { "after-line": "Exact line." }],
      ["mixed prose and rows with after-line", ["<!-- after-line: Exact line. -->"], mixed, { "after-line": "Exact line." }],
      ["rows only with section", ["<!-- section: Table -->"], rows, { section: "Table" }],
      ["rows only with section and occurrence", ["<!-- section: Table -->", "<!-- occurrence: 3 -->"], rows, { section: "Table", occurrence: "3" }],
    ];
    for (const [name, directives, body, expectedDirectives] of valid) {
      it(name, () => {
        assert.deepEqual(parseFragment(fragment(doc, directives, body), filename), {
          meta: {}, sections: {}, edits: [{ key, doc, kind: "append", directives: expectedDirectives, body }],
        });
      });
    }

    const anchorError = `${filename}: section "${key}" needs exactly one of <!-- section: Heading --> / <!-- after-line: text -->`;
    const invalid = [
      ["missing anchor", [], prose, anchorError],
      ["section and after-line together", ["<!-- section: A -->", "<!-- after-line: B -->"], prose, anchorError],
      ["after alone", ["<!-- after: A -->"], prose, anchorError],
      ["after with section", ["<!-- section: A -->", "<!-- after: B -->"], prose, anchorError],
      ["after with after-line", ["<!-- after-line: A -->", "<!-- after: B -->"], prose, anchorError],
      ["occurrence with after-line", ["<!-- after-line: A -->", "<!-- occurrence: 2 -->"], prose, `${filename}: section "${key}": "occurrence" goes with "section"`],
      ["rows only with after-line", ["<!-- after-line: A -->"], rows, `${filename}: section "${key}": a rows-only block needs <!-- section: Heading -->`],
    ];
    for (const [name, directives, body, message] of invalid) {
      it(`rejects ${name}`, () => {
        assert.throws(() => parseFragment(fragment(doc, directives, body), filename), { name: "Error", message });
      });
    }
  });
}
