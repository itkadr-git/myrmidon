import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNameStatus } from "./lib.mjs";

describe("parseNameStatus", () => {
  it("returns no changes for empty output", () => {
    assert.deepEqual(parseNameStatus(""), []);
  });

  it("preserves order, paths and rename/copy origins with or without a final LF", () => {
    const output = [
      "A\tnew file.txt",
      "M\tmodified file.txt",
      "D\tdeleted file.txt",
      "T\ttype changed.txt",
      "R100\told name.txt\tnew name.txt",
      "C087\tsource file.txt\tcopy file.txt",
    ].join("\n");
    const expected = [
      { status: "A", path: "new file.txt", from: null },
      { status: "M", path: "modified file.txt", from: null },
      { status: "D", path: "deleted file.txt", from: null },
      { status: "T", path: "type changed.txt", from: null },
      { status: "R", path: "new name.txt", from: "old name.txt" },
      { status: "C", path: "copy file.txt", from: "source file.txt" },
    ];
    assert.deepEqual(parseNameStatus(output), expected);
    assert.deepEqual(parseNameStatus(`${output}\n`), expected);
    assert.notDeepEqual(parseNameStatus(output), []);
  });
});
