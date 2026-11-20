import test from "node:test";
import assert from "node:assert/strict";
import { partitionTestLines } from "../../test-line-shard.mjs";

const file = "/project/server/example.test.ts";
const makeCase = (line, name) => ({
  projectName: "@myrmidon/server", file, name, location: { line, column: 1 },
});
const identity = (item) => `${item.location.line}:${item.name}`;

function checkPartition(input, count, expectedLines, expectedCases) {
  const before = structuredClone(input);
  const shards = partitionTestLines(input, count, file);
  assert.deepEqual(input, before);
  assert.deepEqual(shards.map((shard) => shard.lines), expectedLines);
  assert.deepEqual(shards.map((shard) => shard.tests.map(identity).sort()), expectedCases.map((items) => [...items].sort()));
  assert.deepEqual(shards.flatMap((shard) => shard.tests.map(identity)).sort(), input.map(identity).sort());
  const assignedLines = shards.flatMap((shard) => shard.lines);
  assert.equal(new Set(assignedLines).size, assignedLines.length);
  for (const shard of shards) {
    assert.deepEqual([...new Set(shard.tests.map((item) => item.location.line))].sort((a, b) => a - b), shard.lines);
  }
}

const cases = [
  {
    name: "parameterized cases on one line remain atomic",
    input: [makeCase(10, "each 1"), makeCase(10, "each 2"), makeCase(20, "other")], count: 2,
    lines: [[10], [20]], identities: [["10:each 1", "10:each 2"], ["20:other"]],
  },
  {
    name: "case count rather than line count determines the next bucket",
    input: [makeCase(10, "a"), makeCase(10, "b"), makeCase(10, "c"), makeCase(20, "d"), makeCase(30, "e"), makeCase(40, "f")], count: 2,
    lines: [[10], [20, 30, 40]], identities: [["10:a", "10:b", "10:c"], ["20:d", "30:e", "40:f"]],
  },
  {
    name: "equal sized groups are processed by ascending line",
    input: [makeCase(30, "c"), makeCase(10, "a"), makeCase(20, "b")], count: 2,
    lines: [[10, 30], [20]], identities: [["10:a", "30:c"], ["20:b"]],
  },
  {
    name: "equal bucket loads choose the lowest bucket index",
    input: [makeCase(10, "a"), makeCase(20, "b"), makeCase(30, "c"), makeCase(40, "d")], count: 3,
    lines: [[10, 40], [20], [30]], identities: [["10:a", "40:d"], ["20:b"], ["30:c"]],
  },
  {
    name: "returned lines are numeric sorted rather than assignment order",
    input: [makeCase(90, "a"), makeCase(90, "b"), makeCase(90, "c"), makeCase(10, "d"), makeCase(20, "e")], count: 2,
    lines: [[90], [10, 20]], identities: [["90:a", "90:b", "90:c"], ["10:d", "20:e"]],
  },
  {
    name: "one shard receives every line and case",
    input: [makeCase(7, "z"), makeCase(2, "x"), makeCase(7, "y")], count: 1,
    lines: [[2, 7]], identities: [["2:x", "7:y", "7:z"]],
  },
  {
    name: "one unique line per shard when line count equals shard count",
    input: [makeCase(8, "a"), makeCase(8, "b"), makeCase(3, "c"), makeCase(15, "d")], count: 3,
    lines: [[8], [3], [15]], identities: [["8:a", "8:b"], ["3:c"], ["15:d"]],
  },
  {
    name: "nested names and duplicate names on different lines are preserved",
    input: [makeCase(4, "outer inner same"), makeCase(9, "outer inner same"), makeCase(4, "outer deeper case")], count: 2,
    lines: [[4], [9]], identities: [["4:outer inner same", "4:outer deeper case"], ["9:outer inner same"]],
  },
  {
    name: "duplicate identities retain their multiplicity",
    input: [makeCase(2, "same"), makeCase(2, "same"), makeCase(5, "other")], count: 2,
    lines: [[2], [5]], identities: [["2:same", "2:same"], ["5:other"]],
  },
  {
    name: "heavier higher line sorts before lighter lower lines",
    input: [makeCase(1, "a"), makeCase(2, "b"), makeCase(50, "c"), makeCase(50, "d"), makeCase(50, "e"), makeCase(3, "f")], count: 3,
    lines: [[50], [1, 3], [2]], identities: [["50:c", "50:d", "50:e"], ["1:a", "3:f"], ["2:b"]],
  },
];

for (const fixture of cases) {
  test(fixture.name, () => checkPartition(fixture.input, fixture.count, fixture.lines, fixture.identities));
}

test("reversed and shuffled collections preserve line distribution and identities", () => {
  const original = [makeCase(30, "a"), makeCase(10, "b"), makeCase(30, "c"), makeCase(20, "d"), makeCase(40, "e")];
  const expectedLines = [[30, 40], [10, 20]];
  const expectedCases = [["30:a", "30:c", "40:e"], ["10:b", "20:d"]];
  for (const input of [original, [...original].reverse(), [original[3], original[0], original[4], original[2], original[1]]]) {
    checkPartition(input, 2, expectedLines, expectedCases);
  }
});
