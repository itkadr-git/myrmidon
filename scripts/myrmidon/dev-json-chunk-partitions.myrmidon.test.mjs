import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonResponseWithLimit } from "../dev-runner-output.mjs";

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value);

const payloads = [
  ["ASCII scalar", "plain ascii"],
  ["escaped quotes and backslash", 'quote: " and slash: \\'],
  ["two-byte UTF-8 scalar", "cafe\u00e9"],
  ["three-byte UTF-8 scalar", "snowman \u2603"],
  ["four-byte UTF-8 scalar", "emoji \u{1f642}"],
  ["object matrix", { ascii: "ok", quote: '"\\', unicode: "\u00e9\u2603\u{1f642}" }],
  ["array matrix", ["ascii", '"\\', "\u00e9", "\u2603", "\u{1f642}"]],
];

function streamResponse(chunks, { sentinel = false } = {}) {
  const trace = [];
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      trace.push(`pull:${index}`);
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      if (sentinel) {
        trace.push("sentinel");
        controller.enqueue(bytes("sentinel"));
        return;
      }
      controller.close();
    },
    cancel(reason) {
      trace.push(["cancel", reason]);
    },
  }, { highWaterMark: 0 });
  return { response: new Response(stream), trace };
}

function splitVariants(encoded) {
  const variants = [];
  for (let boundary = 1; boundary < encoded.byteLength; boundary += 1) {
    variants.push({
      name: `split at byte ${boundary}`,
      chunks: [encoded.slice(0, boundary), encoded.slice(boundary)],
    });
  }
  variants.push({
    name: "byte-by-byte with empty chunks between data",
    chunks: Array.from(encoded, (byte) => new Uint8Array([byte])).flatMap((chunk) => [chunk, new Uint8Array()]),
  });
  return variants;
}

for (const [name, value] of payloads) {
  test(`exact byte limit preserves ${name} across every chunk partition`, async () => {
    const source = JSON.stringify(value);
    const encoded = bytes(source);
    for (const variant of splitVariants(encoded)) {
      const before = variant.chunks.map((chunk) => [...chunk]);
      const { response } = streamResponse(variant.chunks);
      assert.deepEqual(
        await parseJsonResponseWithLimit(response, encoded.byteLength),
        JSON.parse(source),
        `${name}: ${variant.name}`,
      );
      assert.deepEqual(variant.chunks.map((chunk) => [...chunk]), before, `${name}: input mutated`);
      assert.equal(response.body.locked, false, `${name}: ${variant.name} retained the lock`);
    }
  });

  test(`one byte below limit rejects ${name} without reading a sentinel`, async () => {
    const encoded = bytes(JSON.stringify(value));
    for (const variant of splitVariants(encoded)) {
      const { response, trace } = streamResponse(variant.chunks, { sentinel: true });
      await assert.rejects(
        parseJsonResponseWithLimit(response, encoded.byteLength - 1),
        { name: "Error", message: `Response exceeds ${encoded.byteLength - 1} bytes` },
        `${name}: ${variant.name}`,
      );
      assert.equal(trace.filter((entry) => entry === "sentinel").length, 0, `${name}: sentinel was pulled`);
      assert.equal(trace.filter((entry) => Array.isArray(entry) && entry[0] === "cancel").length, 1, `${name}: cancel count`);
      assert.equal(response.body.locked, false, `${name}: ${variant.name} retained the lock`);
    }
  });
}
