import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFragment } from "./collect-fragments.mjs";

const docs = ["divergence", "settings-en", "settings-ru"];
const file = "matrix.md";
const body = "| alpha\\|beta | first |\n\n   \n  | gamma | second\\|value |";

for (const doc of docs) {
  const key = `${doc}-replace`;
  const fragment = (directives, content = body) =>
    `## ${key}\n${directives}${content}\n`;

  describe(`${key} directive matrix`, () => {
    for (const [name, input, directives] of [
      ["rows without section", "", {}],
      ["rows with section", "<!-- section: Registry A -->\n", { section: "Registry A" }],
      ["rows with section and occurrence", "<!-- section: Registry B -->\n<!-- occurrence: 2 -->\n", { section: "Registry B", occurrence: "2" }],
    ]) {
      it(`accepts ${name} and preserves the complete body`, () => {
        assert.deepEqual(parseFragment(fragment(input), file), {
          meta: {},
          sections: {},
          edits: [{ key, doc, kind: "replace", directives, body }],
        });
      });
    }

    for (const [name, input] of [
      ["after", "<!-- after: Registry A -->\n"],
      ["after-line with section", "<!-- section: Registry A -->\n<!-- after-line: anchor -->\n"],
      ["occurrence without section", "<!-- occurrence: 2 -->\n"],
    ]) {
      it(`rejects ${name} with the exact diagnostic`, () => {
        assert.throws(() => parseFragment(fragment(input), file), {
          name: "Error",
          message: `${file}: section "${key}" accepts only <!-- section: Heading --> (optionally with <!-- occurrence: N -->)`,
        });
      });
    }

    it("rejects prose mixed with rows with the exact diagnostic", () => {
      assert.throws(() => parseFragment(fragment("<!-- section: Registry A -->\n", "| alpha | value |\nnot a row\n| beta | value |"), file), {
        name: "Error",
        message: `${file}: section "${key}" takes only table rows (lines starting with "|")`,
      });
    });
  });
}
