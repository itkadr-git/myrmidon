import assert from "node:assert/strict";
import test from "node:test";

import { validateDocument } from "../../check-acceptance-scenarios.mjs";

const scenario = { id: "SCEN-001", title: "Example" };
const versionProblem = 'document: "version" must be a positive integer';
const scenariosProblem = 'document: "scenarios" must be an array';
const documentProblem = 'document: expected an object with a "scenarios" array or a bare scenario array';

const cases = [
  ["bare empty array", [], [], []],
  ["bare scenario array", [scenario], [scenario], []],
  ["object with empty scenarios and omitted version", { scenarios: [] }, [], []],
  ["object preserves scenarios", { scenarios: [scenario] }, [scenario], []],
  ["version 1", { version: 1, scenarios: [] }, [], []],
  ["version 2", { version: 2, scenarios: [] }, [], []],
  ["version zero", { version: 0, scenarios: [scenario] }, [scenario], [versionProblem]],
  ["negative version", { version: -1, scenarios: [] }, [], [versionProblem]],
  ["fractional version", { version: 1.5, scenarios: [] }, [], [versionProblem]],
  ["string version", { version: "1", scenarios: [] }, [], [versionProblem]],
  ["null version", { version: null, scenarios: [] }, [], [versionProblem]],
  ["missing scenarios", { version: 1 }, [], [scenariosProblem]],
  ["null scenarios", { scenarios: null }, [], [scenariosProblem]],
  ["object scenarios", { scenarios: {} }, [], [scenariosProblem]],
  ["null document", null, [], [documentProblem]],
  ["string document", "document", [], [documentProblem]],
  ["number document", 1, [], [documentProblem]],
  ["boolean document", false, [], [documentProblem]],
  ["unknown field", { scenarios: [scenario], extra: true }, [scenario], ['document: unknown field "extra"']],
  ["allowed metadata", { scenarios: [], epicKey: "EPIC", epicIdentifier: "E-1", issueIdentifier: "I-1", updatedAt: "2026-01-01", notes: "note" }, [], []],
  ["multiple problems retain order", { extra: true, version: 0, scenarios: null }, [], ['document: unknown field "extra"', versionProblem, scenariosProblem]],
];

for (const [name, doc, scenarios, problems] of cases) {
  test(`validateDocument: ${name}`, () => {
    const before = structuredClone(doc);
    assert.deepEqual(validateDocument(doc), { scenarios, problems });
    assert.deepEqual(doc, before);
  });
}
