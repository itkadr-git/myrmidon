import assert from "node:assert/strict";
import test from "node:test";

import { validateScenario } from "../../check-acceptance-scenarios.mjs";

const scenario = { id: "S", title: "Scenario", falsifiedWhen: "Failure" };
const path = "does-not-need-to-exist.test.mjs";
const refError = 'scenario[3].testRefs[0]';

const cases = [
  ["omitted testRefs", {}, []],
  ["empty testRefs", { testRefs: [] }, []],
  ["string ref", { testRefs: [path] }, []],
  ["structured path", { testRefs: [{ path }] }, []],
  ["structured optional names", { testRefs: [{ path, testName: "test", suite: "suite" }] }, []],
  ["non-array testRefs", { testRefs: path }, ['scenario[3]: "testRefs" must be an array']],
  ["blank string ref", { testRefs: ["  "] }, [`${refError}: must be a non-empty string`]],
  ...[ ["null", null], ["array", []], ["number", 7] ].map(([name, value]) =>
    [`${name} ref`, { testRefs: [value] }, [`${refError}: must be a string or an object with "path"`]]),
  ...[ ["missing", {}], ["blank", { path: " " }], ["nonstring", { path: 1 }] ].map(([name, ref]) =>
    [`${name} path`, { testRefs: [ref] }, [`${refError}: "path" must be a non-empty string`]]),
  ...["testName", "suite"].flatMap((field) =>
    [ ["blank", " "], ["nonstring", 1] ].map(([name, value]) =>
      [`${name} ${field}`, { testRefs: [{ path, [field]: value }] }, [`${refError}: "${field}" must be a non-empty string`]])),
  ...[1, 42].map((line) => [`line ${line}`, { testRefs: [{ path, line }] }, []]),
  ...[ ["zero", 0], ["negative", -1], ["fraction", 1.5], ["string", "1"], ["NaN", NaN], ["Infinity", Infinity] ].map(([name, line]) =>
    [`${name} line`, { testRefs: [{ path, line }] }, [`${refError}: "line" must be a positive integer`]]),
  ["unknown structured key", { testRefs: [{ path, extra: true }] }, [`${refError}: unknown field "extra"`]],
  ["second ref reports its exact location", { testRefs: [path, { path, line: 0 }] }, ['scenario[3].testRefs[1]: "line" must be a positive integer']],
];

for (const [name, overrides, expected] of cases) {
  test(`validateScenario testRefs: ${name}`, () => {
    assert.deepEqual(validateScenario({ ...scenario, ...overrides }, 3), expected);
  });
}
