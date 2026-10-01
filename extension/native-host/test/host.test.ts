import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { dispatchRaw, handleSignRequest, runHost, writeResponse } from "../src/host.ts";
import { createMockMiddleware } from "../src/middleware.ts";
import { encodeMessage, NativeMessageDecoder } from "../src/wire.ts";
import type { SignRequestMessage } from "../src/protocol.ts";

function request(overrides: Partial<SignRequestMessage> = {}): SignRequestMessage {
  return {
    type: "sign",
    id: 1,
    actionType: "sign",
    documentRef: "workspace/docs/tender.pdf",
    document: { kind: "bytes", bytesBase64: Buffer.from("document").toString("base64") },
    ...overrides,
  };
}

test("host answers a valid request with ok:true and a hash", async () => {
  const response = await dispatchRaw(request(), { middleware: createMockMiddleware() });
  assert.ok(response);
  assert.equal(response.type, "sign_result");
  assert.equal(response.result.ok, true);
  assert.match((response.result as { hash: string }).hash, /^[0-9a-f]{64}$/);
});

test("host answers a digest payload request with ok:true", async () => {
  const { createHash } = await import("node:crypto");
  const digestHex = createHash("sha256").update("document").digest("hex");
  const response = await dispatchRaw(
    request({ document: { kind: "digest", digestHex } }),
    { middleware: createMockMiddleware() },
  );
  assert.ok(response);
  assert.equal(response.result.ok, true);
});

test("host rejects an unknown action type with invalid_request and never calls the middleware", async () => {
  let called = false;
  const response = await dispatchRaw(
    { type: "sign", id: 2, actionType: "delete", documentRef: "ref", document: { kind: "bytes", bytesBase64: "QQ==" } },
    {
      middleware: {
        name: "never",
        async sign() {
          called = true;
          return { hashHex: "00" };
        },
      },
    },
  );
  assert.equal(called, false);
  assert.ok(response);
  assert.equal(response.result.ok, false);
  assert.equal((response.result as { error: string }).error, "invalid_request");
  assert.equal(response.id, 2);
});

test("host maps middleware errors to ok:false middleware_error", async () => {
  const response = await dispatchRaw(request(), {
    middleware: {
      name: "broken",
      async sign() {
        throw new Error("middleware exploded");
      },
    },
  });
  assert.ok(response);
  assert.equal(response.result.ok, false);
  const failure = response.result as { error: string; message?: string };
  assert.equal(failure.error, "middleware_error");
  assert.equal(failure.message, "middleware exploded");
});

test("host maps pin_unavailable to ok:false pin_unavailable", async () => {
  const response = await dispatchRaw(request(), {
    middleware: {
      name: "pin",
      async sign() {
        const error = new Error("PIN unavailable") as Error & { code?: string };
        error.code = "pin_unavailable";
        throw error;
      },
    },
  });
  assert.ok(response);
  assert.equal((response.result as { error: string }).error, "pin_unavailable");
});

test("disabled host fails closed with cancelled", async () => {
  const response = await handleSignRequest(request(), {
    middleware: createMockMiddleware(),
    disabled: true,
  });
  assert.equal(response.result.ok, false);
  assert.equal((response.result as { error: string }).error, "cancelled");
});

test("onResult reports the journal tuple (documentRef, hash/error)", async () => {
  const events: Array<{ documentRef: string; hash?: string; error?: string }> = [];
  const response = await handleSignRequest(request(), {
    middleware: createMockMiddleware(),
    onResult(documentRef, result) {
      events.push({ documentRef, ...result });
    },
  });
  assert.equal(response.result.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.documentRef, "workspace/docs/tender.pdf");
  assert.match(events[0]!.hash ?? "", /^[0-9a-f]{64}$/);
});

test("runHost speaks native messaging end to end over streams", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new NativeMessageDecoder();
  const responses: unknown[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) responses.push(message);
  });

  runHost({ input, output }, { middleware: createMockMiddleware() });

  const requestMessage = request({ id: 42 });
  input.write(encodeMessage(requestMessage as unknown as never));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(responses.length, 1);
  const response = responses[0] as { type: string; id: number; result: { ok: boolean; hash?: string } };
  assert.equal(response.type, "sign_result");
  assert.equal(response.id, 42);
  assert.equal(response.result.ok, true);
  assert.match(response.result.hash ?? "", /^[0-9a-f]{64}$/);
});

test("runHost drops malformed framing silently", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new NativeMessageDecoder();
  const responses: unknown[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) responses.push(message);
  });

  runHost({ input, output }, { middleware: createMockMiddleware() });

  const bad = Buffer.alloc(4);
  bad.writeUInt32LE(0, 0);
  input.write(bad);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 0);
});

test("writeResponse output is decodable native messaging", async () => {
  const output = new PassThrough();
  const decoder = new NativeMessageDecoder();
  const responses: unknown[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) responses.push(message);
  });
  writeResponse({ input: new PassThrough(), output }, (await dispatchRaw(request(), { middleware: createMockMiddleware() }))!);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 1);
});
