import assert from "node:assert/strict";
import test from "node:test";
import { parseShareLine } from "./vendor-share-notes.mjs";

test("share is derived from counts, not the printed percentage", () => {
  for (const percent of ["33.33", "99.99", "33"]) {
    assert.deepEqual(parseShareLine(`Vendor-derived files: 1 of 3 (${percent}%)`), {
      inherited: 1,
      totalFiles: 3,
      share: 1 / 3,
    });
  }
});

test("zero and full shares use their counts", () => {
  assert.deepEqual(parseShareLine("Vendor-derived files: 0 of 3 (0%)"), {
    inherited: 0, totalFiles: 3, share: 0,
  });
  assert.deepEqual(parseShareLine("Vendor-derived files: 3 of 3 (100%)"), {
    inherited: 3, totalFiles: 3, share: 1,
  });
});

test("parses whitespace and a line embedded in a release body", () => {
  const body = "## Changes\nEarlier text\nVendor-derived files:\t1 \t of\t 3  (33.33 \t% \t) trailing text\n## Other\nMore text";
  const original = body;
  assert.deepEqual(parseShareLine(body), { inherited: 1, totalFiles: 3, share: 1 / 3 });
  assert.equal(body, original);
});

test("rejects absent and malformed markers without retaining previous results", () => {
  assert.deepEqual(parseShareLine("Vendor-derived files: 1 of 3 (33.33%)"), {
    inherited: 1, totalFiles: 3, share: 1 / 3,
  });
  for (const body of [null, "", "release without a marker", "Vendor-derived files: 1 of 3 (abc%)", "Vendor-derived files: 1 of 3 (33.33%"]) {
    assert.equal(parseShareLine(body), null);
  }
  assert.deepEqual(parseShareLine("Vendor-derived files: 3 of 3 (100%)"), {
    inherited: 3, totalFiles: 3, share: 1,
  });
});
