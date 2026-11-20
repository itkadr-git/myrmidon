import { test } from "node:test";
import assert from "node:assert/strict";
import { postOverrideComment } from "./cut-rc.mjs";

const api = { companyId: "fixture-company" };
const identifier = "REL-42";
const uuid = "12345678-1234-4123-8123-123456789abc";
const payload = "Override: \"quoted\"\n\u041f\u0440\u0438\u0447\u0438\u043d\u0430: \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\nSecond line\\end";

test("routes the exact override payload to the resolved journal UUID", async () => {
  const calls = [];
  const response = { id: "comment-1" };
  const fetchBoard = async (...args) => {
    calls.push(args);
    if (calls.length === 1) return { id: uuid, identifier };
    if (calls.length === 2) return response;
    throw new Error("unexpected board call");
  };

  assert.strictEqual(await postOverrideComment(api, identifier, payload, fetchBoard), response);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [api, "/api/issues/REL-42"]);
  assert.equal(calls[1][0], api);
  assert.equal(calls[1][1], "/api/issues/12345678-1234-4123-8123-123456789abc/comments");
  assert.equal(calls[1][2].method, "POST");
  assert.deepEqual(JSON.parse(calls[1][2].body), { body: payload });
  assert.deepEqual(Buffer.from(JSON.parse(calls[1][2].body).body), Buffer.from(payload));
});

test("lookup failure propagates without posting a comment", async () => {
  const calls = [];
  const failure = new Error("lookup failed");
  const fetchBoard = async (...args) => {
    calls.push(args);
    throw failure;
  };
  await assert.rejects(postOverrideComment(api, identifier, payload, fetchBoard), (error) => error === failure);
  assert.deepEqual(calls, [[api, "/api/issues/REL-42"]]);
});

test("POST failure propagates after UUID lookup", async () => {
  const calls = [];
  const failure = new Error("comment failed");
  const fetchBoard = async (...args) => {
    calls.push(args);
    if (calls.length === 1) return { id: uuid, identifier };
    throw failure;
  };
  await assert.rejects(postOverrideComment(api, identifier, payload, fetchBoard), (error) => error === failure);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [api, "/api/issues/REL-42"]);
  assert.equal(calls[1][1], "/api/issues/12345678-1234-4123-8123-123456789abc/comments");
  assert.equal(calls[1][2].method, "POST");
});
