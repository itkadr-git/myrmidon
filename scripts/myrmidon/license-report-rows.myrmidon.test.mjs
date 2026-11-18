import assert from "node:assert/strict";
import { test } from "node:test";
import { flattenReport } from "./check-licenses.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const cases = [
  ["null report", null, []],
  ["empty report", {}, []],
  ["missing versions", { MIT: [{ name: "alpha" }] }, [
    { name: "alpha", version: "", license: "MIT" },
  ]],
  ["empty versions", { MIT: [{ name: "alpha", versions: [] }] }, []],
  ["multiple versions", { MIT: [{ name: "alpha", versions: ["2", "1"] }] }, [
    { name: "alpha", version: "1", license: "MIT" },
    { name: "alpha", version: "2", license: "MIT" },
  ]],
  ["license override", { MIT: [{ name: "alpha", versions: ["1"], license: "ISC" }] }, [
    { name: "alpha", version: "1", license: "ISC" },
  ]],
  ["empty override", { MIT: [{ name: "alpha", license: "" }] }, [
    { name: "alpha", version: "", license: "MIT" },
  ]],
  ["non-string override", { MIT: [{ name: "alpha", license: 42 }] }, [
    { name: "alpha", version: "", license: "MIT" },
  ]],
  ["groups, names and versions sort without loss or duplication", {
    MIT: [{ name: "zeta", versions: ["2", "1"] }, { name: "alpha", versions: ["2"] }],
    ISC: [{ name: "alpha", versions: ["1"] }, { name: "beta", versions: ["3", "1"] }],
  }, [
    { name: "alpha", version: "1", license: "ISC" },
    { name: "alpha", version: "2", license: "MIT" },
    { name: "beta", version: "1", license: "ISC" },
    { name: "beta", version: "3", license: "ISC" },
    { name: "zeta", version: "1", license: "MIT" },
    { name: "zeta", version: "2", license: "MIT" },
  ]],
];

for (const [name, report, expected] of cases) {
  test(name, () => {
    const original = structuredClone(report);
    deepFreeze(report);
    const first = flattenReport(report);
    assert.equal(first.length, expected.length);
    assert.deepEqual(first, expected);
    assert.deepEqual(report, original);
    const second = flattenReport(report);
    assert.equal(second.length, expected.length);
    assert.deepEqual(second, expected);
    assert.deepEqual(first, expected);
    assert.deepEqual(report, original);
  });
}
