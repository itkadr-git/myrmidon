import assert from "node:assert/strict";
import test from "node:test";

import { reciprocalRankFusion } from "../../packages/corpus/src/search/rrf.ts";

const k0 = 60;

function byId(results) {
  return new Map(results.map((candidate) => [candidate.id, candidate]));
}

function assertCandidate(candidate, expected) {
  assert.ok(candidate, `missing candidate ${expected.id}`);
  assert.equal(candidate.vectorRank, expected.vectorRank);
  assert.equal(candidate.fullTextRank, expected.fullTextRank);
  assert.ok(Math.abs(candidate.score - expected.score) < 1e-12, `${expected.id}: ${candidate.score} !== ${expected.score}`);
}

test("duplicates before and after kCandidates do not consume vector slots", () => {
  const vectorIds = Object.freeze(["dup", "dup", "vector-two", "dup", "vector-three", "outside"]);
  const fullTextIds = Object.freeze([]);
  const results = reciprocalRankFusion(vectorIds, fullTextIds, { k0, kCandidates: 3 });
  const candidates = byId(results);

  assert.deepEqual([...candidates.keys()].sort(), ["dup", "vector-three", "vector-two"]);
  assertCandidate(candidates.get("dup"), { id: "dup", vectorRank: 1, fullTextRank: null, score: 1 / 61 });
  assertCandidate(candidates.get("vector-two"), { id: "vector-two", vectorRank: 2, fullTextRank: null, score: 1 / 62 });
  assertCandidate(candidates.get("vector-three"), { id: "vector-three", vectorRank: 3, fullTextRank: null, score: 1 / 63 });
  assert.deepEqual(vectorIds, ["dup", "dup", "vector-two", "dup", "vector-three", "outside"]);
  assert.deepEqual(fullTextIds, []);
});

test("duplicates before and after kCandidates do not consume full-text slots", () => {
  const results = reciprocalRankFusion(
    [],
    Object.freeze(["text-dup", "text-two", "text-dup", "text-three", "text-dup", "outside"]),
    { k0, kCandidates: 3 },
  );
  const candidates = byId(results);

  assert.deepEqual([...candidates.keys()].sort(), ["text-dup", "text-three", "text-two"].sort());
  assertCandidate(candidates.get("text-dup"), { id: "text-dup", vectorRank: null, fullTextRank: 1, score: 1 / 61 });
  assertCandidate(candidates.get("text-two"), { id: "text-two", vectorRank: null, fullTextRank: 2, score: 1 / 62 });
  assertCandidate(candidates.get("text-three"), { id: "text-three", vectorRank: null, fullTextRank: 3, score: 1 / 63 });
});

test("kCandidates one keeps one unique candidate per ranking and combines overlap", () => {
  const results = reciprocalRankFusion(
    Object.freeze(["shared", "shared", "vector-only", "shared"]),
    Object.freeze(["shared", "shared", "text-only", "shared"]),
    { k0, kCandidates: 1 },
  );
  const candidates = byId(results);

  assert.deepEqual([...candidates.keys()], ["shared"]);
  assertCandidate(candidates.get("shared"), { id: "shared", vectorRank: 1, fullTextRank: 1, score: 2 / 61 });
});

test("kCandidates two handles asymmetric overlap and keeps both ranking contributions", () => {
  const results = reciprocalRankFusion(
    Object.freeze(["shared", "shared", "vector-only", "vector-outside"]),
    Object.freeze(["text-only", "shared", "text-only", "text-outside"]),
    { k0, kCandidates: 2 },
  );
  const candidates = byId(results);

  assert.deepEqual([...candidates.keys()].sort(), ["shared", "text-only", "vector-only"].sort());
  assertCandidate(candidates.get("shared"), { id: "shared", vectorRank: 1, fullTextRank: 2, score: 1 / 61 + 1 / 62 });
  assertCandidate(candidates.get("vector-only"), { id: "vector-only", vectorRank: 2, fullTextRank: null, score: 1 / 62 });
  assertCandidate(candidates.get("text-only"), { id: "text-only", vectorRank: null, fullTextRank: 1, score: 1 / 61 });
});

test("kCandidates three preserves unique ranks with repeated shared ids", () => {
  const results = reciprocalRankFusion(
    Object.freeze(["a", "shared", "shared", "b", "c"]),
    Object.freeze(["x", "shared", "x", "y", "z"]),
    { k0, kCandidates: 3 },
  );
  const candidates = byId(results);

  assert.deepEqual([...candidates.keys()].sort(), ["a", "b", "shared", "x", "y"].sort());
  assertCandidate(candidates.get("a"), { id: "a", vectorRank: 1, fullTextRank: null, score: 1 / 61 });
  assertCandidate(candidates.get("shared"), { id: "shared", vectorRank: 2, fullTextRank: 2, score: 2 / 62 });
  assertCandidate(candidates.get("b"), { id: "b", vectorRank: 3, fullTextRank: null, score: 1 / 63 });
  assertCandidate(candidates.get("x"), { id: "x", vectorRank: null, fullTextRank: 1, score: 1 / 61 });
  assertCandidate(candidates.get("y"), { id: "y", vectorRank: null, fullTextRank: 3, score: 1 / 63 });
});

test("reordering repeated occurrences without changing unique order does not change the result", () => {
  const first = reciprocalRankFusion(["a", "a", "shared", "shared", "b"], ["shared", "shared", "x", "x"], { k0, kCandidates: 3 });
  const reordered = reciprocalRankFusion(["a", "shared", "a", "shared", "b"], ["shared", "x", "shared", "x"], { k0, kCandidates: 3 });

  assert.deepEqual([...byId(first).keys()].sort(), ["a", "b", "shared", "x"]);
  assert.deepEqual(reordered, first);
});
