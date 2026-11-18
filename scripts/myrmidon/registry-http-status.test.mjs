import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchRegistryJson } from "../verify-release-registry-state.mjs";

const cases = [
  { name: "object", status: 200, body: { name: "@example/pkg", versions: { "1.0.0": {} } }, value: { name: "@example/pkg", versions: { "1.0.0": {} } } },
  { name: "array", status: 200, body: ["one", { version: 2 }], value: ["one", { version: 2 }] },
  { name: "null", status: 200, body: null, value: null },
  { name: "404 allowed", status: 404, allowMissing: true, value: null },
  { name: "404 disallowed", status: 404, allowMissing: false, rejects: true },
  ...[401, 403, 429, 500, 503].flatMap((status) => [false, true].map((allowMissing) => ({
    name: `${status} allowMissing=${allowMissing}`, status, allowMissing, rejects: true,
  }))),
];

for (const fixture of cases) {
  test(`registry HTTP ${fixture.name}`, { timeout: 5000 }, async () => {
    const requests = [];
    const sockets = new Set();
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, accept: request.headers.accept });
      response.writeHead(fixture.status, { "content-type": "application/json" });
      response.end(JSON.stringify(fixture.body ?? null));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const url = `http://127.0.0.1:${server.address().port}/%40example%2Fpkg?fixture=1`;
      const request = fetchRegistryJson(url, { allowMissing: fixture.allowMissing, timeoutMs: 2000 });
      if (fixture.rejects) {
        await assert.rejects(request, (error) => {
          assert.match(error.message, new RegExp(`\\b${fixture.status}\\b`));
          return true;
        });
      } else {
        assert.deepStrictEqual(await request, fixture.value);
      }
      assert.deepStrictEqual(requests, [{
        method: "GET",
        url: "/%40example%2Fpkg?fixture=1",
        accept: "application/vnd.npm.install-v1+json, application/json;q=0.9",
      }]);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
