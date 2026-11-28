import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldTableRows } from "./collect-fragments.mjs";

const document = [
  "# Registry",
  "",
  "## Repeated",
  "| Key | Value |",
  "| --- | --- |",
  "| first | untouched |",
  "",
  "## Repeated",
  "| Key | Value |",
  "| --- | --- |",
  "| second | existing |",
  "",
  "Second section note.",
  "",
  "## Following",
  "| Key | Value |",
  "| --- | --- |",
  "| tail | unchanged |",
  "",
  "End of document.",
  "",
].join("\n");

describe("foldTableRows occurrence isolation", () => {
  it("appends multiple nonblank rows only to the second matching section", () => {
    const input = Object.freeze({
      sectionHeading: "Repeated",
      occurrence: 2,
      rows: "\n| added-a | one |\n  \n| added-b | two |\n\n",
    });
    const expected = document.replace(
      "| second | existing |\n",
      "| second | existing |\n| added-a | one |\n| added-b | two |\n",
    );
    assert.equal(foldTableRows(document, input, Object.freeze({ fileName: "registry.md" })), expected);
  });

  it("leaves the document unchanged when all incoming rows are blank", () => {
    assert.equal(foldTableRows(document, Object.freeze({
      sectionHeading: "Repeated", occurrence: 2, rows: "\n  \n\t\n",
    })), document);
  });

  it("reports the file when the selected occurrence has no table", () => {
    const text = "## Repeated\n| first |\n\n## Repeated\nNo table here.\n\n## Following\n| other |\n";
    assert.throws(
      () => foldTableRows(text, { sectionHeading: "Repeated", occurrence: 2, rows: "| new |" }, { fileName: "empty-table.md" }),
      /empty-table\.md:.*has no table/,
    );
  });

  it("reports the file when the section is missing", () => {
    assert.throws(
      () => foldTableRows(document, { sectionHeading: "Absent", rows: "| new |" }, { fileName: "missing-section.md" }),
      /missing-section\.md:.*no "## Absent" section/,
    );
  });

  it("reports the file when the requested occurrence is out of range", () => {
    assert.throws(
      () => foldTableRows(document, { sectionHeading: "Repeated", occurrence: 3, rows: "| new |" }, { fileName: "missing-occurrence.md" }),
      /missing-occurrence\.md:.*no "## Repeated" section/,
    );
  });
});
