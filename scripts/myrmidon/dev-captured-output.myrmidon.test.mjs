import assert from "node:assert/strict";
import test from "node:test";
import { createCapturedOutputBuffer } from "../dev-runner-output.mjs";

function capture(limit, chunks) {
  const output = createCapturedOutputBuffer(limit);
  for (const chunk of chunks) output.append(chunk);
  return output.finish();
}

function truncated(limit, totalBytes, tail) {
  return {
    text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${tail}`,
    truncated: true,
    totalBytes,
  };
}

test("empty capture has no output or truncation", () => {
  assert.deepEqual(capture(4, []), { text: "", truncated: false, totalBytes: 0 });
});

test("null, undefined, and empty chunks do not change a nonempty capture", () => {
  assert.deepEqual(capture(4, [null, "a", undefined, "", Buffer.alloc(0)]), {
    text: "a", truncated: false, totalBytes: 1,
  });
});

test("exact byte limit does not truncate", () => {
  assert.deepEqual(capture(4, ["ab", "cd"]), { text: "abcd", truncated: false, totalBytes: 4 });
});

test("one byte over the limit truncates with the exact prefix", () => {
  assert.deepEqual(capture(4, ["abcd", "e"]), truncated(4, 5, "bcde"));
});

test("a single oversized chunk keeps its last bytes", () => {
  assert.deepEqual(capture(3, ["abcdef"]), truncated(3, 6, "def"));
});

test("partial eviction retains the suffix of the oldest chunk", () => {
  assert.deepEqual(capture(6, ["abcd", "ef", "g"]), truncated(6, 7, "bcdefg"));
});

test("full eviction removes multiple old chunks", () => {
  assert.deepEqual(capture(4, ["ab", "cd", "efgh"]), truncated(4, 8, "efgh"));
});

test("eviction can remove whole chunks and part of the next", () => {
  assert.deepEqual(capture(5, ["ab", "cde", "fghi"]), truncated(5, 9, "efghi"));
});

test("interleaved Buffer and string chunks count bytes and preserve byte tail", () => {
  const chunks = [Buffer.from("a"), "é", Buffer.from("猫"), "z"];
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.equal(bytes.length, 7);
  assert.deepEqual(capture(5, chunks), truncated(5, 7, bytes.subarray(-5).toString("utf8")));
});

test("a tail starting inside a UTF-8 character decodes the retained bytes", () => {
  const bytes = Buffer.from("a€b");
  assert.deepEqual(capture(3, [bytes]), truncated(3, 5, bytes.subarray(-3).toString("utf8")));
});

test("zero byte limit is normalized to one", () => {
  assert.deepEqual(capture(0, ["ab"]), truncated(1, 2, "b"));
});

test("negative byte limit is normalized to one", () => {
  assert.deepEqual(capture(-5, ["xy"]), truncated(1, 2, "y"));
});

test("fractional byte limit is truncated", () => {
  assert.deepEqual(capture(2.9, ["abcd"]), truncated(2, 4, "cd"));
});

test("fractional limit below one is normalized to one", () => {
  assert.deepEqual(capture(0.5, ["pq"]), truncated(1, 2, "q"));
});

test("repeated finish returns equal independent results", () => {
  const output = createCapturedOutputBuffer(2);
  output.append("abc");
  const first = output.finish();
  const second = output.finish();
  assert.deepEqual(first, truncated(2, 3, "bc"));
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  first.text = "changed";
  assert.deepEqual(second, truncated(2, 3, "bc"));
  assert.deepEqual(output.finish(), truncated(2, 3, "bc"));
});

test("append after finish changes later output but not earlier results", () => {
  const output = createCapturedOutputBuffer(3);
  output.append("ab");
  const before = output.finish();
  output.append("cd");
  assert.deepEqual(before, { text: "ab", truncated: false, totalBytes: 2 });
  assert.deepEqual(output.finish(), truncated(3, 4, "bcd"));
});
