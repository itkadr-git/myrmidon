import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultSuiteWeight,
  partitionGeneralServerSuites,
  selectGeneralServerShard,
} from "../../general-server-shard.mjs";

test("equal weights assign paths in sorted order", () => {
  assert.deepEqual(partitionGeneralServerSuites(["d", "b", "c", "a"], 2, { a: 3, b: 3, c: 3, d: 3 }), [
    { files: ["a", "c"], totalWeight: 6 },
    { files: ["b", "d"], totalWeight: 6 },
  ]);
});

test("equal shard loads choose the first shard", () => {
  assert.deepEqual(partitionGeneralServerSuites(["a", "b", "c"], 2, { a: 4, b: 4, c: 1 }), [
    { files: ["a", "c"], totalWeight: 5 },
    { files: ["b"], totalWeight: 4 },
  ]);
});

test("zero duration is retained instead of median", () => {
  assert.deepEqual(partitionGeneralServerSuites(["a", "b", "c"], 2, { a: 8, b: 4, c: 0 }), [
    { files: ["a"], totalWeight: 8 },
    { files: ["b", "c"], totalWeight: 4 },
  ]);
});

test("zero-weight ties repeatedly choose the first shard", () => {
  assert.deepEqual(partitionGeneralServerSuites(["c", "b", "a"], 2, { a: 0, b: 0, c: 0 }), [
    { files: ["a", "b", "c"], totalWeight: 0 },
    { files: [], totalWeight: 0 },
  ]);
});

test("odd median uses the middle sorted duration", () => {
  assert.equal(defaultSuiteWeight({ a: 9, b: 1, c: 5 }), 5);
});

test("even median averages the middle durations", () => {
  assert.equal(defaultSuiteWeight({ a: 9, b: 1, c: 3, d: 6 }), 4.5);
});

test("empty durations use the fixed fallback", () => {
  assert.equal(defaultSuiteWeight({}), 1000);
  assert.deepEqual(partitionGeneralServerSuites(["b", "a"], 2), [
    { files: ["a"], totalWeight: 1000 },
    { files: ["b"], totalWeight: 1000 },
  ]);
});

test("missing suite receives the median, not zero or a mean", () => {
  assert.deepEqual(partitionGeneralServerSuites(["known", "missing"], 2, { known: 9, other: 1, third: 5 }), [
    { files: ["known"], totalWeight: 9 },
    { files: ["missing"], totalWeight: 5 },
  ]);
});

test("single shard contains all suites and summed weights", () => {
  assert.deepEqual(partitionGeneralServerSuites(["b", "a", "c"], 1, { a: 1, b: 3, c: 2 }), [
    { files: ["a", "b", "c"], totalWeight: 6 },
  ]);
});

test("more shards than positive-weight suites leaves empty shards", () => {
  assert.deepEqual(partitionGeneralServerSuites(["b", "a"], 4, { a: 2, b: 1 }), [
    { files: ["a"], totalWeight: 2 },
    { files: ["b"], totalWeight: 1 },
    { files: [], totalWeight: 0 },
    { files: [], totalWeight: 0 },
  ]);
});

test("empty files yield one empty bucket per shard", () => {
  assert.deepEqual(partitionGeneralServerSuites([], 3, { a: 7 }), [
    { files: [], totalWeight: 0 },
    { files: [], totalWeight: 0 },
    { files: [], totalWeight: 0 },
  ]);
});

test("permuted inputs produce the same exact buckets", () => {
  const durations = { a: 4, b: 4, c: 2, d: 1 };
  const expected = [
    { files: ["a", "c"], totalWeight: 6 },
    { files: ["b", "d"], totalWeight: 5 },
  ];
  assert.deepEqual(partitionGeneralServerSuites(["a", "b", "c", "d"], 2, durations), expected);
  assert.deepEqual(partitionGeneralServerSuites(["d", "c", "b", "a"], 2, durations), expected);
  assert.deepEqual(partitionGeneralServerSuites(["c", "a", "d", "b"], 2, durations), expected);
});

test("selection matches each literal bucket including an empty one", () => {
  const files = ["d", "b", "a", "c"];
  const durations = { a: 5, b: 4, c: 3, d: 2 };
  assert.deepEqual(partitionGeneralServerSuites(files, 5, durations), [
    { files: ["a"], totalWeight: 5 },
    { files: ["b"], totalWeight: 4 },
    { files: ["c"], totalWeight: 3 },
    { files: ["d"], totalWeight: 2 },
    { files: [], totalWeight: 0 },
  ]);
  assert.deepEqual(selectGeneralServerShard(files, 0, 5, durations), ["a"]);
  assert.deepEqual(selectGeneralServerShard(files, 1, 5, durations), ["b"]);
  assert.deepEqual(selectGeneralServerShard(files, 2, 5, durations), ["c"]);
  assert.deepEqual(selectGeneralServerShard(files, 3, 5, durations), ["d"]);
  assert.deepEqual(selectGeneralServerShard(files, 4, 5, durations), []);
});

test("partition and selection leave input files and durations unchanged", () => {
  const files = Object.freeze(["c", "a", "b"]);
  const durations = Object.freeze({ a: 4, b: 2, c: 1 });
  assert.deepEqual(partitionGeneralServerSuites(files, 2, durations), [
    { files: ["a"], totalWeight: 4 },
    { files: ["b", "c"], totalWeight: 3 },
  ]);
  assert.deepEqual(selectGeneralServerShard(files, 1, 2, durations), ["b", "c"]);
  assert.deepEqual(files, ["c", "a", "b"]);
  assert.deepEqual(durations, { a: 4, b: 2, c: 1 });
});
