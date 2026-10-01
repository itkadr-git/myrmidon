import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSignActionType,
  isDocumentPayload,
  isSignRequestMessage,
  SIGN_ACTION_TYPES,
} from "../src/protocol.ts";

test("valid action types are recognized", () => {
  for (const actionType of SIGN_ACTION_TYPES) {
    assert.equal(isSignActionType(actionType), true);
  }
});

test("unknown action types are rejected", () => {
  assert.equal(isSignActionType("delete"), false);
  assert.equal(isSignActionType(""), false);
  assert.equal(isSignActionType(42), false);
  assert.equal(isSignActionType(null), false);
});

test("document payload bytes requires non-empty base64", () => {
  assert.equal(isDocumentPayload({ kind: "bytes", bytesBase64: "QUJD" }), true);
  assert.equal(isDocumentPayload({ kind: "bytes", bytesBase64: "" }), false);
  assert.equal(isDocumentPayload({ kind: "bytes" }), false);
});

test("document payload digest requires sha-256 hex", () => {
  assert.equal(isDocumentPayload({ kind: "digest", digestHex: "a".repeat(64) }), true);
  assert.equal(isDocumentPayload({ kind: "digest", digestHex: "a".repeat(63) }), false);
  assert.equal(isDocumentPayload({ kind: "digest", digestHex: "xyz" }), false);
  assert.equal(isDocumentPayload({ kind: "other" }), false);
});

function baseMessage() {
  return {
    type: "sign",
    id: 1,
    actionType: "sign",
    documentRef: "workspace/docs/tender.pdf",
    document: { kind: "bytes", bytesBase64: "QUJD" },
  };
}

test("valid sign request accepted", () => {
  assert.equal(isSignRequestMessage(baseMessage()), true);
});

test("missing or empty documentRef rejected", () => {
  const message = baseMessage();
  message.documentRef = "";
  assert.equal(isSignRequestMessage(message), false);
  delete (message as Partial<typeof message>).documentRef;
  assert.equal(isSignRequestMessage(message), false);
});

test("unknown actionType rejected", () => {
  const message = baseMessage();
  (message as { actionType: string }).actionType = "delete";
  assert.equal(isSignRequestMessage(message), false);
});

test("missing id rejected", () => {
  const message = baseMessage();
  delete (message as Partial<typeof message>).id;
  assert.equal(isSignRequestMessage(message), false);
});

test("non-object values rejected", () => {
  assert.equal(isSignRequestMessage("sign"), false);
  assert.equal(isSignRequestMessage(null), false);
  assert.equal(isSignRequestMessage(undefined), false);
});
