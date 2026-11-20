import test from "node:test";
import assert from "node:assert/strict";
import { resolveTestRefFile, checkTestRef, TEST_SUFFIXES } from "../../check-acceptance-scenarios.mjs";

const base = "examples/widget";
const suffixes = ["", ".test.ts", ".test.tsx", ".test.mjs", ".test.js", ".spec.ts", ".spec.tsx", ".spec.mjs", ".spec.js"];
const candidates = suffixes.map((suffix) => base + suffix);

function spy(files) {
  const calls = [];
  return {
    calls,
    read(path) {
      calls.push(path);
      return Object.hasOwn(files, path) ? { ok: true, content: files[path] } : { ok: false };
    },
  };
}

test("suffix order is the published contract", () => {
  assert.deepEqual(TEST_SUFFIXES, suffixes);
});

test("literal wins over suffixes and stops reading", () => {
  const reader = spy({ [base]: "literal", [candidates[1]]: "suffix" });
  assert.deepEqual(resolveTestRefFile(base, reader.read), { ok: true, path: base, content: "literal" });
  assert.deepEqual(reader.calls, [base]);
});

for (const [index, candidate] of candidates.entries()) {
  test(`resolves only available candidate ${suffixes[index] || "literal"}`, () => {
    const reader = spy({ [candidate]: `content ${index}` });
    assert.deepEqual(resolveTestRefFile(base, reader.read), { ok: true, path: candidate, content: `content ${index}` });
    assert.deepEqual(reader.calls, candidates.slice(0, index + 1));
  });
}

test("first matching suffix wins over later matches", () => {
  const reader = spy({ [candidates[2]]: "first", [candidates[5]]: "later" });
  assert.deepEqual(resolveTestRefFile(base, reader.read), { ok: true, path: candidates[2], content: "first" });
  assert.deepEqual(reader.calls, candidates.slice(0, 3));
});

test("miss reports all tried paths in order", () => {
  const reader = spy({});
  assert.deepEqual(resolveTestRefFile(base, reader.read), { ok: false, tried: candidates });
  assert.deepEqual(reader.calls, candidates);
});

test("testName wins over suite when both exist", () => {
  const reader = spy({ [candidates[1]]: "only chosen name here" });
  assert.deepEqual(checkTestRef({ path: base, testName: "chosen name", suite: "absent suite" }, reader.read), { ok: true, path: candidates[1] });
  assert.deepEqual(reader.calls, candidates.slice(0, 2));
});

test("missing testName fails even when suite matches", () => {
  const reader = spy({ [candidates[1]]: "present suite" });
  assert.deepEqual(checkTestRef({ path: base, testName: "absent name", suite: "present suite" }, reader.read), { ok: false, reason: `test name "absent name" not found in ${candidates[1]}` });
  assert.deepEqual(reader.calls, candidates.slice(0, 2));
});

test("suite matches as a substring when testName is absent", () => {
  const reader = spy({ [base]: "prefix suite name suffix" });
  assert.deepEqual(checkTestRef({ path: base, suite: "suite name" }, reader.read), { ok: true, path: base });
  assert.deepEqual(reader.calls, [base]);
});

test("missing suite reports exact reason", () => {
  const reader = spy({ [base]: "different name" });
  assert.deepEqual(checkTestRef({ path: base, suite: "missing suite" }, reader.read), { ok: false, reason: `test name "missing suite" not found in ${base}` });
  assert.deepEqual(reader.calls, [base]);
});

test("string ref passes without a name hint", () => {
  const reader = spy({ [base]: "" });
  assert.deepEqual(checkTestRef(base, reader.read), { ok: true, path: base });
  assert.deepEqual(reader.calls, [base]);
});

test("missing string ref reports all candidates", () => {
  const reader = spy({});
  assert.deepEqual(checkTestRef(base, reader.read), { ok: false, reason: `test file not found in the selected tree (tried: ${candidates.join(", ")})` });
  assert.deepEqual(reader.calls, candidates);
});
