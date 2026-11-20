import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchRegistryJson } from "../verify-release-registry-state.mjs";

const fixtures = [
  { name: "malformed token", body: "not-json", invalid: true },
  { name: "empty body", body: "", invalid: true },
  { name: "truncated object", body: '{"name":"package"', invalid: true },
  { name: "trailing comma", body: '{"name":"package",}', invalid: true },
  { name: "unterminated string", body: '"unfinished', invalid: true },
  { name: "unicode string", body: '"caf\u00e9 \ud83d\ude80"', expected: "caf\u00e9 \ud83d\ude80" },
  { name: "escaped string", body: '"line\\nquote\\\"slash\\\\"', expected: 'line\nquote"slash\\' },
  { name: "nested object", body: '{"a":{"b":[1,true,null]}}', expected: { a: { b: [1, true, null] } } },
  { name: "array", body: '[1,"two",{"three":3}]', expected: [1, "two", { three: 3 }] },
  { name: "null", body: "null", expected: null },
  { name: "boolean", body: "false", expected: false },
  { name: "number", body: "42", expected: 42 },
];

test("registry HTTP JSON decoding and recovery", { timeout: 10_000 }, async () => {
  const requests = [];
  const responses = fixtures.flatMap((fixture) => fixture.invalid
    ? [fixture.body, '{"recovered":true}']
    : [fixture.body]);
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const body = responses.shift();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body ?? "unexpected request");
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/registry%2Ffixture?source=test`;
  try {
    for (const fixture of fixtures) {
      if (fixture.invalid) {
        await assert.rejects(fetchRegistryJson(url), SyntaxError, fixture.name);
        assert.deepEqual(await fetchRegistryJson(url), { recovered: true }, `recovery after ${fixture.name}`);
      } else {
        assert.deepEqual(await fetchRegistryJson(url), fixture.expected, fixture.name);
      }
    }
    assert.equal(responses.length, 0, "all fixture responses consumed");
    assert.equal(requests.length, fixtures.length + fixtures.filter((fixture) => fixture.invalid).length);
    for (const request of requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/registry%2Ffixture?source=test");
      assert.equal(request.headers.accept, "application/vnd.npm.install-v1+json, application/json;q=0.9");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
