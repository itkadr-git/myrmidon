import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeMessageDecoder, encodeMessage } from "../src/wire.ts";
import type { SignResponseMessage } from "../src/protocol.ts";

function sampleResponse(hash = "ab".repeat(32)): SignResponseMessage {
  return { type: "sign_result", id: 7, result: { ok: true, hash } };
}

test("encodeMessage frames a message with a 4-byte LE length", () => {
  const encoded = encodeMessage(sampleResponse());
  const expectedJson = Buffer.from(JSON.stringify(sampleResponse()), "utf8");
  assert.equal(encoded.readUInt32LE(0), expectedJson.length);
  assert.deepEqual(encoded.subarray(4), expectedJson);
});

test("decoder round-trips a framed message", () => {
  const encoded = encodeMessage(sampleResponse());
  const decoder = new NativeMessageDecoder();
  const decoded = decoder.push(encoded);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], { type: "sign_result", id: 7, result: { ok: true, hash: "ab".repeat(32) } });
});

test("decoder reassembles messages split across chunks", () => {
  const encoded = encodeMessage(sampleResponse());
  const decoder = new NativeMessageDecoder();
  const mid = Math.floor(encoded.length / 2);
  assert.deepEqual(decoder.push(encoded.subarray(0, mid)), []);
  const decoded = decoder.push(encoded.subarray(mid));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]!.type, "sign_result");
});

test("decoder returns multiple messages fed at once", () => {
  const decoder = new NativeMessageDecoder();
  const decoded = decoder.push(
    Buffer.concat([encodeMessage(sampleResponse()), encodeMessage(sampleResponse("cd".repeat(32)))]),
  );
  assert.equal(decoded.length, 2);
  assert.equal((decoded[1] as unknown as { result: { hash: string } }).result.hash, "cd".repeat(32));
});

test("decoder throws on zero length header", () => {
  const decoder = new NativeMessageDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(0, 0);
  assert.throws(() => decoder.push(header), /invalid message length/);
});

test("decoder throws on oversized length header", () => {
  const decoder = new NativeMessageDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
  assert.throws(() => decoder.push(header), /invalid message length/);
});
