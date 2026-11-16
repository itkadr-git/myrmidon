import assert from "node:assert/strict";
import { test } from "node:test";
import { findNewNames } from "./paperclip-names-ratchet.mjs";

const vendorPrefix = ["PAPER", "CLIP"].join("");
const unknownName = `${vendorPrefix}_LOCATION_CAP`;
const otherName = `${vendorPrefix}_OTHER_UNKNOWN`;
const baselineName = `${vendorPrefix}_KNOWN_ALIAS`;

function filesWithOccurrences(name, count) {
  const files = [];
  for (let index = 0; index < count; index += 1) {
    files.push({
      path: `fixtures/location-cap-${index + 1}.mjs`,
      text: `line ${index + 1}: ${name}\n`,
    });
  }
  return files;
}

function expectedLocations(count) {
  return Array.from(
    { length: Math.min(count, 5) },
    (_, index) => `fixtures/location-cap-${index + 1}.mjs:1`,
  );
}

test("zero occurrences returns no new names", () => {
  const files = filesWithOccurrences(unknownName, 0);
  const baseline = new Set([baselineName]);

  assert.deepEqual(findNewNames(files, baseline), []);
});

test("one occurrence reports its location", () => {
  const files = filesWithOccurrences(unknownName, 1);

  assert.deepEqual(findNewNames(files, new Set()), [
    { name: unknownName, places: expectedLocations(1) },
  ]);
});

test("five occurrences retain every location", () => {
  const files = filesWithOccurrences(unknownName, 5);

  assert.deepEqual(findNewNames(files, new Set()), [
    { name: unknownName, places: expectedLocations(5) },
  ]);
});

test("six occurrences are capped at the first five locations", () => {
  const files = filesWithOccurrences(unknownName, 6);

  assert.deepEqual(findNewNames(files, new Set()), [
    { name: unknownName, places: expectedLocations(6) },
  ]);
});

test("nine occurrences are capped at the first five locations", () => {
  const files = filesWithOccurrences(unknownName, 9);

  assert.deepEqual(findNewNames(files, new Set()), [
    { name: unknownName, places: expectedLocations(9) },
  ]);
});

test("multiple unknown names sort by name and exclude the baseline", () => {
  const files = [
    { path: "fixtures/z-last.mjs", text: `${otherName}\n${baselineName}\n` },
    { path: "fixtures/a-first.mjs", text: `${unknownName}\n${baselineName}\n` },
  ];
  const baseline = new Set([baselineName]);

  assert.deepEqual(findNewNames(files, baseline), [
    { name: unknownName, places: ["fixtures/a-first.mjs:1"] },
    { name: otherName, places: ["fixtures/z-last.mjs:1"] },
  ]);
});

test("frozen files and baseline are not mutated", () => {
  const files = Object.freeze([
    Object.freeze({ path: "fixtures/frozen.mjs", text: `${unknownName}\n` }),
  ]);
  const baseline = Object.freeze(new Set([baselineName]));
  const originalFiles = files.map((file) => ({ ...file }));
  const originalBaseline = new Set(baseline);

  findNewNames(files, baseline);

  assert.deepEqual(files, originalFiles);
  assert.deepEqual(baseline, originalBaseline);
});

test("a new call does not contain locations from a previous call", () => {
  const firstFiles = filesWithOccurrences(unknownName, 6);
  const secondFiles = [{ path: "fixtures/second-call.mjs", text: `${unknownName}\n` }];

  findNewNames(firstFiles, new Set());

  assert.deepEqual(findNewNames(secondFiles, new Set()), [
    { name: unknownName, places: ["fixtures/second-call.mjs:1"] },
  ]);
});
