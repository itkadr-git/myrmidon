import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetchTransport } from "./split-banks.mjs";

const base = "https://api.example.test";
const token = "synthetic-sentinel-not-a-real-token";
const auth = `Bearer ${token}`;

async function intercept(response, action) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response();
  };
  try {
    await action(calls);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = () => new Response('{"ok":true}', { status: 201 });

test("request serializes JSON and supplies content type", async () => {
  await intercept(jsonResponse, async (calls) => {
    const result = await createFetchTransport(base, token).request("POST", "/items", { count: 3 });
    assert.equal(calls[0].url, `${base}/items`);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body, '{"count":3}');
    assert.equal(calls[0].options.headers["content-type"], "application/json");
    assert.equal(calls[0].options.headers.authorization, auth);
    assert.deepEqual(result, { status: 201, json: { ok: true } });
  });
});

test("request without body omits content type and body", async () => {
  await intercept(jsonResponse, async (calls) => {
    await createFetchTransport(base, token).request("GET", "/items");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(new Headers(calls[0].options.headers).has("content-type"), false);
  });
});

test("request with null body sends JSON null", async () => {
  await intercept(jsonResponse, async (calls) => {
    await createFetchTransport(base, token).request("POST", "/items", null);
    assert.equal(calls[0].options.body, "null");
    assert.equal(new Headers(calls[0].options.headers).get("content-type"), "application/json");
  });
});

test("malformed JSON response returns null with status", async () => {
  await intercept(() => new Response("not json", { status: 502 }), async () => {
    assert.deepEqual(await createFetchTransport(base, token).request("GET", "/items"), { status: 502, json: null });
  });
});

test("upload sends file bytes and filename in FormData without manual content type", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  await intercept(jsonResponse, async (calls) => {
    const result = await createFetchTransport(base, token).upload("/upload", { data: bytes, fileName: "fixture.bin" });
    const { url, options } = calls[0];
    assert.equal(url, `${base}/upload`);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, auth);
    assert.equal(new Headers(options.headers).has("content-type"), false);
    assert.ok(options.body instanceof FormData);
    assert.deepEqual([...options.body.keys()], ["file"]);
    const file = options.body.get("file");
    assert.equal(file.name, "fixture.bin");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    assert.deepEqual(result, { status: 201, json: { ok: true } });
  });
});

for (const [name, location, expectedUrl, expectedAuth] of [
  ["relative path", "/files/a", `${base}/files/a`, auth],
  ["absolute same origin", `${base}/files/a`, `${base}/files/a`, auth],
  ["different hostname", "https://storage.example.test/a?signature=fake", "https://storage.example.test/a?signature=fake", null],
  ["different scheme", "http://api.example.test/a", "http://api.example.test/a", null],
  ["different port", "https://api.example.test:444/a", "https://api.example.test:444/a", null],
  ["equivalent default port", "https://api.example.test:443/a", "https://api.example.test:443/a", auth],
]) {
  test(`download ${name} scopes authorization`, async () => {
    await intercept(() => new Response(new Uint8Array([0, 255]), { status: 206 }), async (calls) => {
      await createFetchTransport(base, token).download(location);
      assert.equal(calls[0].url, expectedUrl);
      assert.equal(new Headers(calls[0].options.headers).get("authorization"), expectedAuth);
    });
  });
}

test("download without token omits authorization even on same origin", async () => {
  await intercept(jsonResponse, async (calls) => {
    await createFetchTransport(base).download("/files/a");
    assert.equal(new Headers(calls[0].options.headers).has("authorization"), false);
  });
});

test("request and upload without token omit authorization", async () => {
  for (const action of [
    (transport) => transport.request("GET", "/items"),
    (transport) => transport.upload("/upload", { data: new Uint8Array([1]), fileName: "x" }),
  ]) {
    await intercept(jsonResponse, async (calls) => {
      await action(createFetchTransport(base));
      assert.equal(new Headers(calls[0].options.headers).has("authorization"), false);
    });
  }
});

test("download preserves binary bytes and HTTP status", async () => {
  const bytes = new Uint8Array([0, 10, 127, 128, 254, 255]);
  await intercept(() => new Response(bytes, { status: 404 }), async () => {
    const result = await createFetchTransport(base, token).download("/missing");
    assert.equal(result.status, 404);
    assert.ok(result.data instanceof Uint8Array);
    assert.deepEqual(result.data, bytes);
  });
});
