import test from "node:test";
import assert from "node:assert/strict";
import { createCapturedOutputBuffer } from "../dev-runner-output.mjs";

const LIMIT = 262144;

function expectOutput(capture, chunks, total, truncated) {
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.equal(Buffer.byteLength(bytes), total);
  const tail = bytes.subarray(-LIMIT).toString("utf8");
  assert.deepEqual(capture.finish(), {
    text: truncated ? `[output truncated to last 262144 bytes; total ${total} bytes]\n${tail}` : tail,
    truncated,
    totalBytes: total,
  });
}

test("a single chunk at the default boundary is not truncated", () => {
  const capture = createCapturedOutputBuffer();
  const chunks = ["a".repeat(262144)];
  capture.append(chunks[0]);
  expectOutput(capture, chunks, 262144, false);
});

test("a single chunk one byte over the default retains the exact tail", () => {
  const capture = createCapturedOutputBuffer();
  const chunks = ["x".repeat(262144)];
  capture.append(chunks[0]);
  expectOutput(capture, chunks, 262144, false);
  chunks.push("y");
  capture.append(chunks[1]);
  expectOutput(capture, chunks, 262145, true);
});

test("one oversized chunk retains its last 262144 bytes", () => {
  const capture = createCapturedOutputBuffer();
  expectOutput(capture, [], 0, false);
  const chunks = ["a".repeat(123) + "b".repeat(262145)];
  capture.append(chunks[0]);
  expectOutput(capture, chunks, 262268, true);
});

test("successive chunks discard old bytes while counting all input", () => {
  const capture = createCapturedOutputBuffer();
  const chunks = ["a".repeat(100000), "b".repeat(100000)];
  chunks.forEach((chunk) => capture.append(chunk));
  expectOutput(capture, chunks, 200000, false);
  chunks.push("c".repeat(100000), "d".repeat(100000));
  capture.append(chunks[2]);
  capture.append(chunks[3]);
  expectOutput(capture, chunks, 400000, true);
});

test("mixed buffers and UTF-8 strings use bytes, including a split character", () => {
  const capture = createCapturedOutputBuffer();
  const chunks = [Buffer.from("é"), "a".repeat(262142)];
  chunks.forEach((chunk) => capture.append(chunk));
  expectOutput(capture, chunks, 262144, false);
  chunks.push(Buffer.from("z"));
  capture.append(chunks[2]);
  expectOutput(capture, chunks, 262145, true);
});

test("finish returns a snapshot before and after later overflow", () => {
  const capture = createCapturedOutputBuffer();
  const chunks = ["p".repeat(262144)];
  capture.append(chunks[0]);
  const earlier = capture.finish();
  expectOutput(capture, chunks, 262144, false);
  chunks.push("q".repeat(20));
  capture.append(chunks[1]);
  expectOutput(capture, chunks, 262164, true);
  assert.deepEqual(earlier, { text: chunks[0], truncated: false, totalBytes: 262144 });
});

test("explicit undefined uses the default byte budget", () => {
  const capture = createCapturedOutputBuffer(undefined);
  const chunks = ["u".repeat(262144)];
  capture.append(chunks[0]);
  expectOutput(capture, chunks, 262144, false);
  chunks.push("v");
  capture.append(chunks[1]);
  expectOutput(capture, chunks, 262145, true);
});

test("instances keep independent tails and total byte counts", () => {
  const first = createCapturedOutputBuffer();
  const second = createCapturedOutputBuffer();
  const firstChunks = ["1".repeat(262144)];
  const secondChunks = ["2".repeat(42)];
  first.append(firstChunks[0]);
  second.append(secondChunks[0]);
  expectOutput(first, firstChunks, 262144, false);
  expectOutput(second, secondChunks, 42, false);
  firstChunks.push("A");
  first.append(firstChunks[1]);
  secondChunks.push("B".repeat(262144));
  second.append(secondChunks[1]);
  expectOutput(first, firstChunks, 262145, true);
  expectOutput(second, secondChunks, 262186, true);
});
