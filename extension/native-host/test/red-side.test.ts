import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchRaw } from "../src/host.ts";
import { encodeMessage, NativeMessageDecoder } from "../src/wire.ts";
import { createMockMiddleware } from "../src/middleware.ts";
import { SIGN_ACTION_TYPES } from "../src/protocol.ts";

/**
 * Red-side checks: what an attacker (a compromised extension context, an
 * injected page script, a local process trying to talk to the stdio pipe)
 * must NOT be able to make the helper do. Each test names the attack it
 * models.
 */

/** Attack: free text or page content tries to smuggle an arbitrary action type. */
test("red: page-driven free text cannot invent an action type", async () => {
  const injection = JSON.stringify({
    type: "sign",
    id: 99,
    actionType: "sign and also delete everything",
    documentRef: "x",
    document: { kind: "bytes", bytesBase64: "QQ==" },
  });
  let called = false;
  const middleware = {
    name: "spy",
    async sign() {
      called = true;
      return { hashHex: "00" };
    },
  };
  const response = await dispatchRaw(JSON.parse(injection), { middleware });
  // The host answers with an explicit failure (the request id is known) and
  // the middleware is never invoked.
  assert.ok(response);
  assert.equal(response.result.ok, false);
  assert.equal((response.result as { error: string }).error, "invalid_request");
  assert.equal(called, false);
});

/** Attack: prompt injection tries to smuggle a PIN through the bridge. */
test("red: PIN never appears in any host response", async () => {
  const middleware = createMockMiddleware();
  const response = await dispatchRaw(
    {
      type: "sign",
      id: 1,
      actionType: "sign",
      documentRef: "workspace/docs/tender.pdf",
      document: { kind: "bytes", bytesBase64: Buffer.from("pin: 1234").toString("base64") },
    },
    { middleware },
  );
  assert.ok(response);
  const wire = encodeMessage(response);
  const decoder = new NativeMessageDecoder();
  const [decoded] = decoder.push(wire);
  const json = JSON.stringify(decoded);
  assert.doesNotMatch(json, /pin|1234/i);
});

/** Attack: a message with an unknown shape (not "sign") is dropped. */
test("red: non-sign protocol messages are dropped without side effects", async () => {
  let called = false;
  const middleware = {
    name: "spy",
    async sign() {
      called = true;
      return { hashHex: "00" };
    },
  };
  for (const hostile of [
    { type: "exec", command: "calc.exe" },
    { type: "get_pin" },
    { type: "update_settings", mode: "auto" },
    { actionType: "sign", documentRef: "ref", document: { kind: "bytes", bytesBase64: "QQ==" } },
    null,
    42,
    "sign",
  ]) {
    const response = await dispatchRaw(hostile, { middleware });
    assert.equal(response, null, JSON.stringify(hostile));
  }
  assert.equal(called, false);
});

/** Attack: oversized length header (framing bomb). */
test("red: framing bomb header rejected by the decoder", () => {
  const decoder = new NativeMessageDecoder();
  const bomb = Buffer.alloc(4);
  bomb.writeUInt32LE(0xffffffff, 0);
  assert.throws(() => decoder.push(bomb), /invalid message length/);
});

/** Attack: only the enum action types ever reach the middleware. */
test("red: middleware is reachable only through the action type enum", async () => {
  const reached: string[] = [];
  const middleware = {
    name: "rec",
    async sign(input: { actionType: string }) {
      reached.push(input.actionType);
      return { hashHex: "00" };
    },
  };
  for (const actionType of SIGN_ACTION_TYPES) {
    await dispatchRaw(
      {
        type: "sign",
        id: 1,
        actionType,
        documentRef: "ref",
        document: { kind: "bytes", bytesBase64: "QQ==" },
      },
      { middleware },
    );
  }
  for (const actionType of ["execute", "read_pin", "sign\u0000evil"]) {
    await dispatchRaw(
      {
        type: "sign",
        id: 1,
        actionType,
        documentRef: "ref",
        document: { kind: "bytes", bytesBase64: "QQ==" },
      },
      { middleware },
    );
  }
  assert.deepEqual([...reached].sort(), [...SIGN_ACTION_TYPES].sort());
});

/** Attack: empty documentRef (empty command) must not be executable. */
test("red: empty documentRef is rejected before the middleware", async () => {
  let called = false;
  const middleware = {
    name: "spy",
    async sign() {
      called = true;
      return { hashHex: "00" };
    },
  };
  const response = await dispatchRaw(
    { type: "sign", id: 5, actionType: "sign", documentRef: "", document: { kind: "bytes", bytesBase64: "QQ==" } },
    { middleware },
  );
  assert.ok(response);
  assert.equal(response.result.ok, false);
  assert.equal((response.result as { error: string }).error, "invalid_request");
  assert.equal(called, false);
});
