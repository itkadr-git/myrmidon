import assert from "node:assert/strict";
import { test } from "node:test";
import { newSplitState, runVerify } from "./split-banks.mjs";

const doc = (id, world, experience) => ({ id, textSha256: `hash-${id}`, units: { world, experience } });
const counts = (a = [2, 3, 5, 2], b = [1, 4, 6, 1]) => ({
  "bank-a.documents": a[0], "bank-a.world": a[1], "bank-a.experience": a[2], "bank-a.expectedDocuments": a[3],
  "bank-b.documents": b[0], "bank-b.world": b[1], "bank-b.experience": b[2], "bank-b.expectedDocuments": b[3],
});

function fixture() {
  const source = [doc("a1", 1, 2), doc("a2", 2, 3), doc("b1", 4, 6), doc("own", 7, 8)];
  const state = newSplitState("source", "2026-01-01T00:00:00Z");
  state.classifications = [
    { documentId: "b1", targetBank: "bank-b" },
    { documentId: "a1", targetBank: "bank-a" },
    { documentId: "a2", targetBank: "bank-a" },
    { documentId: "own", targetBank: "source" },
  ];
  const listings = { "bank-b": [structuredClone(source[2])], "bank-a": structuredClone(source.slice(0, 2)) };
  return { state, source, listings };
}

function check(change, expectedCounts, findings) {
  const f = fixture();
  change(f);
  const before = structuredClone(f);
  assert.deepEqual(runVerify(f.state, f.source, f.listings), { ok: findings.length === 0, counts: expectedCounts, findings });
  assert.deepEqual(f, before, "verify must not mutate inputs");
  assert.equal(f.state.verifiedAt, null);
}

test("valid listings match and verification is read-only", () => check(() => {}, counts(), []));
test("missing bank listing", () => check(({ listings }) => { delete listings["bank-b"]; }, counts(undefined, [0, 0, 0, 1]), [
  "verify: no listing supplied for bank-b", "verify: b1 is missing from bank-b",
  "verify: bank-b has 0 document(s), expected 1", "verify: bank-b has 0 world unit(s), expected 4",
  "verify: bank-b has 0 experience unit(s), expected 6",
]));
test("classified id absent from source", () => check(({ source, listings }) => { source.splice(2, 1); listings["bank-b"] = []; }, counts(undefined, [0, 0, 0, 1]), [
  "verify: b1 is classified to bank-b but is absent from the source listing", "verify: bank-b has 0 document(s), expected 1",
]));
test("missing id", () => check(({ listings }) => { listings["bank-a"].pop(); }, counts([1, 1, 2, 2]), [
  "verify: a2 is missing from bank-a", "verify: bank-a has 1 document(s), expected 2",
  "verify: bank-a has 1 world unit(s), expected 3", "verify: bank-a has 2 experience unit(s), expected 5",
]));
test("hash mismatch with correct counts", () => check(({ listings }) => { listings["bank-a"][0].textSha256 = "different"; }, counts(), [
  "verify: a1 in bank-a differs from the source (textSha256)",
]));
test("duplicate id with preserved document and unit sums", () => check(({ listings }) => {
  listings["bank-a"] = [doc("a1", 1, 2), doc("a1", 2, 3)];
}, counts(), ["verify: a2 is missing from bank-a", "verify: bank-a lists a document id more than once"]));
test("world sum mismatch alone", () => check(({ listings }) => { listings["bank-a"][0].units.world = 9; }, counts([2, 11, 5, 2]), [
  "verify: bank-a has 11 world unit(s), expected 3",
]));
test("experience sum mismatch alone", () => check(({ listings }) => { listings["bank-a"][0].units.experience = 9; }, counts([2, 3, 12, 2]), [
  "verify: bank-a has 12 experience unit(s), expected 5",
]));
test("foreign classified id", () => check(({ listings, source }) => { listings["bank-a"].push(structuredClone(source[2])); }, counts([3, 7, 11, 2]), [
  "verify: b1 in bank-a belongs to bank-b (leak)", "verify: bank-a has 3 document(s), expected 2",
  "verify: bank-a has 7 world unit(s), expected 3", "verify: bank-a has 11 experience unit(s), expected 5",
]));
test("unknown id", () => check(({ listings }) => { listings["bank-a"].push(doc("unknown", 0, 0)); }, counts([3, 3, 5, 2]), [
  "verify: unknown in bank-a is not in the classification (leak)", "verify: bank-a has 3 document(s), expected 2",
]));
test("unexpected nonempty bank", () => check(({ listings }) => { listings["bank-c"] = [doc("unknown", 1, 2)]; }, {
  ...counts(), "bank-c.documents": 1, "bank-c.world": 1, "bank-c.experience": 2, "bank-c.expectedDocuments": 0,
}, ["verify: unknown in bank-c is not in the classification (leak)", "verify: bank-c has 1 document(s), expected 0",
  "verify: bank-c has 1 world unit(s), expected 0", "verify: bank-c has 2 experience unit(s), expected 0"]));
test("unexpected empty bank is not a leak", () => check(({ listings }) => { listings["bank-c"] = []; }, {
  ...counts(), "bank-c.documents": 0, "bank-c.world": 0, "bank-c.experience": 0, "bank-c.expectedDocuments": 0,
}, []));
test("source bank listing is ignored", () => check(({ listings }) => { listings.source = [doc("unknown", 99, 99)]; }, counts(), []));
test("findings use stable sorted bank order regardless of input order", () => check(({ listings }) => {
  listings["bank-b"][0].textSha256 = "wrong";
  listings["bank-a"][0].textSha256 = "wrong";
}, counts(), ["verify: a1 in bank-a differs from the source (textSha256)", "verify: b1 in bank-b differs from the source (textSha256)"]));
