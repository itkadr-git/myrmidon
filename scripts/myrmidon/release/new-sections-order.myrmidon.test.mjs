import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldNewSections } from "./collect-fragments.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const document = "# Guide\n\n## Alpha\n\nAlpha text.\n\n## Beta\n\nBeta text.\n";

describe("foldNewSections", () => {
  for (const [name, anchor] of [
    ["heading", { after: "Alpha" }],
    ["line", { afterLine: "Alpha text." }],
  ]) {
    it(`preserves item order for a shared ${name} anchor`, () => {
      const items = deepFreeze([
        { ...anchor, body: "## First\n\nFirst text." },
        { ...anchor, body: "## Second\n\nSecond text." },
        { ...anchor, body: "## Third\n\nThird text." },
      ]);
      assert.equal(foldNewSections(document, items), "# Guide\n\n## Alpha\n\nAlpha text.\n\n## First\n\nFirst text.\n\n## Second\n\nSecond text.\n\n## Third\n\nThird text.\n\n## Beta\n\nBeta text.\n");
    });
  }

  it("retains interleaved items at different anchors", () => {
    const items = deepFreeze([
      { after: "Alpha", body: "## First\n\nOne." },
      { after: "Beta", body: "## Later\n\nTwo." },
      { after: "Alpha", body: "## Second\n\nThree." },
    ]);
    assert.equal(foldNewSections(document, items), "# Guide\n\n## Alpha\n\nAlpha text.\n\n## First\n\nOne.\n\n## Second\n\nThree.\n\n## Beta\n\nBeta text.\n\n## Later\n\nTwo.\n");
  });

  it("appends unanchored sections at EOF in input order", () => {
    const items = deepFreeze([{ body: "## First\n\nOne." }, { body: "## Second\n\nTwo." }]);
    assert.equal(foldNewSections(document, items), "# Guide\n\n## Alpha\n\nAlpha text.\n\n## Beta\n\nBeta text.\n\n## First\n\nOne.\n\n## Second\n\nTwo.\n");
  });

  it("requires an occurrence for duplicate headings and targets the selected occurrence", () => {
    const repeated = "# Guide\n\n## Repeat\n\nOne.\n\n## Repeat\n\nTwo.\n";
    const ambiguous = deepFreeze([{ after: "Repeat", body: "## New\n\nAdded." }]);
    assert.throws(() => foldNewSections(repeated, ambiguous, { fileName: "guide.md" }), /guide\.md:.*ambiguous.*occurrence/);
    const selected = deepFreeze([{ after: "Repeat", occurrence: 2, body: "## New\n\nAdded." }]);
    assert.equal(foldNewSections(repeated, selected), "# Guide\n\n## Repeat\n\nOne.\n\n## Repeat\n\nTwo.\n\n## New\n\nAdded.\n");
  });

  for (const [name, anchor] of [["heading", { after: "Missing" }], ["line", { afterLine: "Missing" }]]) {
    it(`rejects a missing ${name} anchor`, () => {
      const items = deepFreeze([{ ...anchor, body: "## New\n\nAdded." }]);
      assert.throws(() => foldNewSections(document, items, { fileName: "guide.md" }), /guide\.md:.*Missing/);
    });
  }
});
