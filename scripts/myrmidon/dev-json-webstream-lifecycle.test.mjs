import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonResponseWithLimit } from "../dev-runner-output.mjs";

const bytes = (text) => new TextEncoder().encode(text);

function streamResponse(chunks, options = {}) {
  const trace = [];
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      trace.push(`pull:${index}`);
      if (index === chunks.length) {
        if (options.error) controller.error(options.error);
        else controller.close();
      } else {
        controller.enqueue(chunks[index++]);
      }
    },
    cancel(reason) { trace.push(["cancel", reason]); },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers: options.headers }), trace };
}

test("reads multiple native chunks including an empty chunk and releases the lock", async () => {
  const { response } = streamResponse([bytes('{"n":'), new Uint8Array(), bytes('42}')]);
  assert.deepEqual(await parseJsonResponseWithLimit(response, 8), { n: 42 });
  assert.equal(response.body.locked, false);
});

test("decodes a four-byte UTF-8 codepoint split across three chunks", async () => {
  const encoded = bytes('"\u{1f600}"');
  const { response } = streamResponse([encoded.subarray(0, 2), encoded.subarray(2, 3), encoded.subarray(3)]);
  assert.equal(await parseJsonResponseWithLimit(response, 6), "\u{1f600}");
  assert.equal(response.body.locked, false);
});

test("invalid JSON rejects after EOF with the lock released", async () => {
  const { response, trace } = streamResponse([bytes('{')]);
  await assert.rejects(parseJsonResponseWithLimit(response, 8), SyntaxError);
  assert.deepEqual(trace, ["pull:0", "pull:1"]);
  assert.equal(response.body.locked, false);
});

test("native stream errors retain their identity and release the lock", async () => {
  const error = new Error("stream failed");
  const { response } = streamResponse([bytes('1')], { error });
  await assert.rejects(parseJsonResponseWithLimit(response, 8), (actual) => actual === error);
  assert.equal(response.body.locked, false);
});

test("overflow cancels exactly once without pulling the next chunk", async () => {
  const { response, trace } = streamResponse([bytes('1234'), bytes('5'), bytes('6')]);
  await assert.rejects(parseJsonResponseWithLimit(response, 4), { name: "Error", message: "Response exceeds 4 bytes" });
  assert.deepEqual(trace, ["pull:0", "pull:1", ["cancel", "response too large"]]);
  assert.equal(response.body.locked, false);
});

test("oversized content-length rejects before reading or cancelling", async () => {
  const { response, trace } = streamResponse([bytes('12345')], { headers: { "content-length": "5" } });
  await assert.rejects(parseJsonResponseWithLimit(response, 4), { name: "Error", message: "Response exceeds 4 bytes" });
  assert.equal(response.body.locked, false);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(trace, []);
  assert.equal(await response.text(), '12345');
  assert.deepEqual(trace, ["pull:0", "pull:1"]);
});
