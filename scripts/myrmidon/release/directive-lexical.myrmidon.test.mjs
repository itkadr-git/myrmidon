import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFragment } from "./collect-fragments.mjs";

const fileName = "lexical-controls.md";
const key = "settings-ru-new";
const fragment = (lines) => [`## ${key}`, ...lines, "### New", "Content."].join("\n");

function expectError(text, message) {
  assert.throws(() => parseFragment(text, fileName), { name: "Error", message });
}

describe("parseFragment directive lexical boundaries", () => {
  for (const directive of ["section", "after", "after-line", "occurrence"]) {
    it(`rejects duplicate ${directive} before semantic validation`, () => {
      const value = directive === "occurrence" ? "1" : "Anchor";
      expectError(fragment([`<!-- ${directive}: ${value} -->`, "", `<!-- ${directive}: ${value} -->`]),
        `${fileName}: section "${key}": duplicate directive "${directive}"`);
    });

    it(`rejects empty ${directive}`, () => {
      expectError(fragment([`<!-- ${directive}:   -->`]),
        `${fileName}: section "${key}": directive "${directive}" has no value`);
    });
  }

  it("names an unknown directive after blank lines and a valid directive", () => {
    expectError(fragment(["", "<!-- after: Anchor -->", "", "<!-- placement: here -->"]),
      `${fileName}: section "${key}": unknown directive "placement" (known: section, after, after-line, occurrence)`);
  });

  for (const value of ["0", "-1", "1.0", "01", "x"]) {
    it(`rejects occurrence ${value}`, () => {
      expectError(fragment(["<!-- after: Anchor -->", `<!-- occurrence: ${value} -->`]),
        `${fileName}: section "${key}": "occurrence" must be a positive integer, got "${value}"`);
    });
  }

  for (const value of ["1", "12"]) {
    it(`accepts occurrence ${value} with after`, () => {
      assert.deepEqual(parseFragment(fragment(["", "<!-- after: Anchor -->", "", `<!-- occurrence: ${value} -->`, ""]), fileName), {
        meta: {}, sections: {}, edits: [{
          key, doc: "settings-ru", kind: "new",
          directives: { after: "Anchor", occurrence: value }, body: "## New\nContent.",
        }],
      });
    });
  }

  it("leaves directive-shaped comments after prose in the body", () => {
    const text = ["## divergence-append", "", "<!-- section: Anchor -->", "", "Prose.",
      "<!-- occurrence: 0 -->", "<!-- unknown: value -->"].join("\n");
    assert.deepEqual(parseFragment(text, fileName), {
      meta: {}, sections: {}, edits: [{
        key: "divergence-append", doc: "divergence", kind: "append",
        directives: { section: "Anchor" },
        body: "Prose.\n<!-- occurrence: 0 -->\n<!-- unknown: value -->",
      }],
    });
  });
});
