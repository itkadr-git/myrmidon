import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNames, NAME_PATTERN } from "./paperclip-names-ratchet.mjs";

const PREFIX = ["PAPER", "CLIP_"].join("");

function name(suffix) {
  return PREFIX + suffix;
}

test("accepts digits and underscores inside a name", () => {
  const text = `env.${name("V2_EDGE_CASE")}`;

  assert.deepEqual(extractNames(text), [
    { name: name("V2_EDGE_CASE"), line: 1 },
  ]);
});

test("stops before a trailing underscore", () => {
  const text = name("TRAILING_");

  assert.deepEqual(extractNames(text), [
    { name: name("TRAILING"), line: 1 },
  ]);
});

test("stops at a lowercase delimiter", () => {
  const text = name("UPPER_lower");

  assert.deepEqual(extractNames(text), [
    { name: name("UPPER"), line: 1 },
  ]);
});

test("returns two matches in source order on one line", () => {
  const first = name("FIRST");
  const second = name("SECOND2");

  assert.deepEqual(extractNames(`${first} = ${second}`), [
    { name: first, line: 1 },
    { name: second, line: 1 },
  ]);
});

test("counts CRLF lines and empty lines", () => {
  const first = name("FIRST");
  const second = name("SECOND");
  const text = `${first}\r\n\r\n${second}\r\n`;

  assert.deepEqual(extractNames(text), [
    { name: first, line: 1 },
    { name: second, line: 3 },
  ]);
});

test("matches inside a longer identifier", () => {
  const embedded = name("EMBEDDED");

  assert.deepEqual(extractNames(`prefix_${embedded}_suffix`), [
    { name: embedded, line: 1 },
  ]);
});

test("repeated extraction is ordered and does not mutate the global regexp", () => {
  const text = `${name("FIRST")}\n${name("SECOND")}`;
  const before = NAME_PATTERN.lastIndex;

  const first = extractNames(text);
  const afterFirst = NAME_PATTERN.lastIndex;
  const second = extractNames(text);
  const afterSecond = NAME_PATTERN.lastIndex;

  assert.deepEqual(first, [
    { name: name("FIRST"), line: 1 },
    { name: name("SECOND"), line: 2 },
  ]);
  assert.deepEqual(second, first);
  assert.equal(afterFirst, before);
  assert.equal(afterSecond, before);
});
