import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonResponseWithLimit } from "../dev-runner-output.mjs";

const bytes = (value) => new TextEncoder().encode(value);

function fixture({ chunks = [], header = null, readError, cancelError, body = true } = {}) {
  const calls = [];
  let index = 0;
  const reader = {
    async read() {
      calls.push("read");
      if (readError && index === chunks.length) throw readError;
      if (index === chunks.length) return { done: true };
      return { done: false, value: chunks[index++] };
    },
    async cancel(reason) {
      calls.push(["cancel", reason]);
      if (cancelError) throw cancelError;
    },
    releaseLock() { calls.push("releaseLock"); },
  };
  return {
    calls,
    response: {
      headers: { get(name) { assert.equal(name, "content-length"); return header; } },
      body: body ? { getReader() { calls.push("getReader"); return reader; } } : null,
    },
  };
}

const oversized = (limit) => ({ name: "Error", message: `Response exceeds ${limit} bytes` });
const cancel = ["cancel", "response too large"];

test("accepts JSON at the exact byte limit without changing the chunks", async () => {
  const chunks = [bytes('{"n":'), bytes('42}')];
  const before = chunks.map((chunk) => [...chunk]);
  const f = fixture({ chunks, header: "8" });
  assert.deepEqual(await parseJsonResponseWithLimit(f.response, 8), { n: 42 });
  assert.deepEqual(f.calls, ["getReader", "read", "read", "read", "releaseLock"]);
  assert.deepEqual(chunks.map((chunk) => [...chunk]), before);
});

test("one extra byte cancels before releasing the reader", async () => {
  const f = fixture({ chunks: [bytes('1234'), bytes('5'), bytes('6')] });
  await assert.rejects(parseJsonResponseWithLimit(f.response, 4), oversized(4));
  assert.deepEqual(f.calls, ["getReader", "read", "read", cancel, "releaseLock"]);
});

test("oversized content-length rejects before acquiring a reader", async () => {
  const f = fixture({ chunks: [bytes('0')], header: "5" });
  await assert.rejects(parseJsonResponseWithLimit(f.response, 4), oversized(4));
  assert.deepEqual(f.calls, []);
});

for (const [name, header] of [["missing", null], ["non-numeric", "not-a-number"], ["understated", "1"]]) {
  test(`${name} content-length cannot bypass the streaming limit`, async () => {
    const f = fixture({ chunks: [bytes('12'), bytes('345')], header });
    await assert.rejects(parseJsonResponseWithLimit(f.response, 4), oversized(4));
    assert.deepEqual(f.calls, ["getReader", "read", "read", cancel, "releaseLock"]);
  });
}

test("decodes a UTF-8 codepoint split between chunks", async () => {
  const encoded = bytes('"\u20ac"');
  const f = fixture({ chunks: [encoded.subarray(0, 2), encoded.subarray(2)] });
  assert.equal(await parseJsonResponseWithLimit(f.response, 5), "\u20ac");
  assert.deepEqual(f.calls, ["getReader", "read", "read", "read", "releaseLock"]);
});

test("invalid JSON rejects after releasing the reader", async () => {
  const f = fixture({ chunks: [bytes('{')] });
  await assert.rejects(parseJsonResponseWithLimit(f.response, 8), { name: "SyntaxError", message: "Expected property name or '}' in JSON at position 1 (line 1 column 2)" });
  assert.deepEqual(f.calls, ["getReader", "read", "read", "releaseLock"]);
});

test("read rejection keeps the original error and releases the reader", async () => {
  const error = new Error("read failed");
  const f = fixture({ chunks: [bytes('1')], readError: error });
  await assert.rejects(parseJsonResponseWithLimit(f.response, 8), (actual) => actual === error);
  assert.deepEqual(f.calls, ["getReader", "read", "read", "releaseLock"]);
});

test("missing body rejects without acquiring a reader", async () => {
  const f = fixture({ body: false });
  await assert.rejects(parseJsonResponseWithLimit(f.response, 8), { name: "SyntaxError", message: "Unexpected end of JSON input" });
  assert.deepEqual(f.calls, []);
});

test("cancel rejection keeps the original error and releases the reader", async () => {
  const error = new Error("cancel failed");
  const f = fixture({ chunks: [bytes('12345')], cancelError: error });
  await assert.rejects(parseJsonResponseWithLimit(f.response, 4), (actual) => actual === error);
  assert.deepEqual(f.calls, ["getReader", "read", cancel, "releaseLock"]);
});
