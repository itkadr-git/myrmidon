import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDocumentStatusTransition,
  canTransitionDocumentStatus,
  isCorpusParseJobStatus,
  isCorpusParseStatus,
  isTerminalParseStatus,
} from "../../packages/corpus/src/domain.ts";

// Columns and rows follow the documented lifecycle, including re-queueing.
const states = ["queued", "parsing", "embedding", "ready", "failed"];
const transitions = [
  [true,  true,  false, false, true],
  [true,  false, true,  false, true],
  [true,  false, false, true,  true],
  [true,  false, false, false, false],
  [true,  false, false, false, false],
];

for (const [row, from] of states.entries()) {
  for (const [column, to] of states.entries()) {
    const allowed = transitions[row][column];
    test(`document transition ${from} -> ${to}`, () => {
      assert.equal(canTransitionDocumentStatus(from, to), allowed);
      if (allowed) {
        assert.equal(assertDocumentStatusTransition(from, to), undefined);
      } else {
        assert.throws(() => assertDocumentStatusTransition(from, to), {
          name: "Error",
          message: `corpus: illegal document status transition ${from} -> ${to}`,
        });
      }
    });
  }
}

for (const [status, terminal] of [
  ["queued", false], ["parsing", false], ["embedding", false],
  ["ready", true], ["failed", true],
]) {
  test(`terminal status ${status}`, () => {
    assert.equal(isTerminalParseStatus(status), terminal);
  });
}

const membershipCases = [
  ["queued", true, false], ["parsing", true, false],
  ["embedding", true, false], ["ready", true, false],
  ["failed", true, true], ["pending", false, true],
  ["running", false, true], ["done", false, true],
  ["QUEUED", false, false], ["Pending", false, false],
  [" queued", false, false], ["running ", false, false],
  ["\tfailed\n", false, false], ["", false, false],
  ["unknown", false, false],
];
for (const [value, parse, job] of membershipCases) {
  test(`status membership ${JSON.stringify(value)}`, () => {
    assert.equal(isCorpusParseStatus(value), parse);
    assert.equal(isCorpusParseJobStatus(value), job);
  });
}
