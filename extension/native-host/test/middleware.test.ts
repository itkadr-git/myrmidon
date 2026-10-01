import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockMiddleware } from "../src/middleware.ts";

test("mock middleware signs bytes deterministically", async () => {
  const middleware = createMockMiddleware();
  const first = await middleware.sign({
    actionType: "sign",
    documentRef: "workspace/docs/tender.pdf",
    bytes: Buffer.from("document"),
  });
  const second = await middleware.sign({
    actionType: "sign",
    documentRef: "workspace/docs/tender.pdf",
    bytes: Buffer.from("document"),
  });
  assert.equal(first.hashHex, second.hashHex);
  assert.match(first.hashHex, /^[0-9a-f]{64}$/);
});

test("mock middleware distinguishes documents", async () => {
  const middleware = createMockMiddleware();
  const a = await middleware.sign({
    actionType: "sign",
    documentRef: "ref",
    bytes: Buffer.from("document-a"),
  });
  const b = await middleware.sign({
    actionType: "sign",
    documentRef: "ref",
    bytes: Buffer.from("document-b"),
  });
  assert.notEqual(a.hashHex, b.hashHex);
});

test("mock middleware signs a pre-computed digest", async () => {
  const middleware = createMockMiddleware();
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update("document").digest();
  const result = await middleware.sign({
    actionType: "sign_attachment",
    documentRef: "ref",
    digest,
  });
  assert.match(result.hashHex, /^[0-9a-f]{64}$/);
});

test("mock middleware fails without bytes or digest", async () => {
  const middleware = createMockMiddleware();
  await assert.rejects(
    () => middleware.sign({ actionType: "sign", documentRef: "ref" }),
    /no document bytes or digest/,
  );
});
