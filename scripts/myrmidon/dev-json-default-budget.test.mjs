import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonResponseWithLimit } from "../dev-runner-output.mjs";

const limit = 65536;
const tooLarge = { name: "Error", message: "Response exceeds 65536 bytes" };
const cancel = ["cancel", "response too large"];

function jsonString(size) {
  const value = "x".repeat(size - 2);
  const json = JSON.stringify(value);
  assert.equal(Buffer.byteLength(json, "utf8"), size);
  return { json, value };
}

function fixture(chunks, header = null) {
  const calls = [];
  let index = 0;
  const reader = {
    async read() {
      calls.push("read");
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
    },
    async cancel(reason) { calls.push(["cancel", reason]); },
    releaseLock() { calls.push("releaseLock"); },
  };
  return {
    calls,
    response: {
      headers: { get(name) { assert.equal(name, "content-length"); return header; } },
      body: { getReader() { calls.push("getReader"); return reader; } },
    },
  };
}

for (const withHeader of [false, true]) {
  test(`accepts 65536 bytes ${withHeader ? "with" : "without"} content-length`, async () => {
    const { json, value } = jsonString(limit);
    const f = fixture([Buffer.from(json)], withHeader ? String(limit) : null);
    assert.equal(await parseJsonResponseWithLimit(f.response), value);
    assert.deepEqual(f.calls, ["getReader", "read", "read", "releaseLock"]);
  });

  test(`rejects 65537 bytes ${withHeader ? "with" : "without"} content-length`, async () => {
    const { json } = jsonString(limit + 1);
    const f = fixture([Buffer.from(json)], withHeader ? String(limit + 1) : null);
    await assert.rejects(parseJsonResponseWithLimit(f.response), tooLarge);
    assert.deepEqual(f.calls, withHeader ? [] : ["getReader", "read", cancel, "releaseLock"]);
  });
}

test("understated content-length cannot hide overflow in the final chunk", async () => {
  const { json } = jsonString(limit + 1);
  const bytes = Buffer.from(json);
  const f = fixture([bytes.subarray(0, limit), bytes.subarray(limit)], "1");
  await assert.rejects(parseJsonResponseWithLimit(f.response), tooLarge);
  assert.deepEqual(f.calls, ["getReader", "read", "read", cancel, "releaseLock"]);
});

test("counts UTF-8 bytes rather than characters", async () => {
  const json = JSON.stringify("\u00e9".repeat(32768));
  assert.ok(json.length < limit);
  assert.equal(Buffer.byteLength(json, "utf8"), limit + 2);
  const f = fixture([Buffer.from(json)]);
  await assert.rejects(parseJsonResponseWithLimit(f.response), tooLarge);
  assert.deepEqual(f.calls, ["getReader", "read", cancel, "releaseLock"]);
});

test("explicit smaller maxBytes overrides the default", async () => {
  const { json } = jsonString(101);
  const f = fixture([Buffer.from(json)]);
  await assert.rejects(parseJsonResponseWithLimit(f.response, 100), { name: "Error", message: "Response exceeds 100 bytes" });
  assert.deepEqual(f.calls, ["getReader", "read", cancel, "releaseLock"]);
});

test("undefined maxBytes uses the default limit", async () => {
  const { json } = jsonString(limit + 1);
  const f = fixture([Buffer.from(json)]);
  await assert.rejects(parseJsonResponseWithLimit(f.response, undefined), tooLarge);
  assert.deepEqual(f.calls, ["getReader", "read", cancel, "releaseLock"]);
});
