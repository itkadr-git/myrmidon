import test from "node:test";
import assert from "node:assert/strict";
import { assertSelectedTests } from "../../test-line-shard.mjs";

const file = "/repo/server/example.test.ts";
const item = (name = "case", line = 10, overrides = {}) => ({
  projectName: "@myrmidon/server", file, location: { line }, name, ...overrides,
});
const mismatch = "Vitest filters must select exactly the assigned tests";
function rejects(expected, actual, message = mismatch) {
  assert.throws(() => assertSelectedTests(expected, actual, file), (error) => {
    assert.equal(error.name, "AssertionError");
    assert.equal(error.message.split("\n", 1)[0], message);
    return true;
  });
}

test("permutation preserves identities", () => {
  assert.doesNotThrow(() => assertSelectedTests([item("a"), item("b", 20)], [item("b", 20), item("a")], file));
});

test("canonical file paths compare equal", () => {
  assert.doesNotThrow(() => assertSelectedTests([item()], [item("case", 10, { file: "/repo/server/sub/../example.test.ts" })], file));
});

test("missing case fails", () => {
  rejects([item("a"), item("b", 20)], [item("a")]);
});

test("extra case fails", () => {
  rejects([item("a")], [item("a"), item("b", 20)]);
});

test("different project identity fails validation", () => {
  rejects([item()], [item("case", 10, { projectName: "other" })], "unexpected test project");
});

test("different file identity fails validation", () => {
  rejects([item()], [item("case", 10, { file: "/repo/server/other.test.ts" })], "unexpected test file");
});

test("different line identity fails", () => {
  rejects([item("case", 11)], [item()]);
});

test("different name identity fails", () => {
  rejects([item("other")], [item()]);
});

test("same names on different lines remain distinct", () => {
  rejects([item("same", 10), item("same", 20)], [item("same", 10), item("same", 10)]);
});

test("matching duplicate identities pass", () => {
  assert.doesNotThrow(() => assertSelectedTests([item(), item()], [item(), item()], file));
});

test("duplicate multiplicity must match", () => {
  rejects([item(), item()], [item()]);
});

test("equal counts with one replacement fail", () => {
  rejects([item("a"), item("b")], [item("a"), item("c")]);
});

test("quotes and backslashes cannot collide across identity fields", () => {
  rejects([item('a",10,"b\\c')], [item('a",10,"b\\d')]);
});

test("newline cannot collide with a literal escape", () => {
  rejects([item("a\nb")], [item("a\\nb")]);
});

test("independent calls retain no previous identities", () => {
  assert.doesNotThrow(() => assertSelectedTests([item("first")], [item("first")], file));
  rejects([item("second")], [item("first")]);
  assert.doesNotThrow(() => assertSelectedTests([item("second")], [item("second")], file));
});

test("empty actual collection fails validation", () => {
  rejects([item()], [], "Vitest must collect at least one test");
});

test("unexpected actual project fails validation", () => {
  rejects([item()], [item("case", 10, { projectName: "other" })], "unexpected test project");
});

test("unexpected actual file fails validation", () => {
  rejects([item()], [item("case", 10, { file: "/repo/server/other.test.ts" })], "unexpected test file");
});

test("empty actual name fails validation", () => {
  rejects([item()], [item("")], "missing test name");
});

test("invalid actual line fails validation", () => {
  rejects([item()], [item("case", 0)], "missing test source line");
});
