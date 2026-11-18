import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createManifestLookupKey } from "../verify-release-registry-state.mjs";

const scriptPath = fileURLToPath(new URL("../verify-release-registry-state.mjs", import.meta.url));
const name = "@myrmidon/a";
const version = "2026.1116.0";
const documentPath = "/mirror/%40myrmidon%2Fa";
const manifestPath = `${documentPath}/${version}`;
const manifest = { name, version };
const document = { name, "dist-tags": { latest: version }, versions: {} };

async function runCase(registries) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const body = req.url === documentPath ? document : req.url === manifestPath ? manifest : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "unexpected path" }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let child;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/npm|registry|proxy|token|auth/i.test(key),
    ));
    Object.assign(env, registries(origin));
    child = spawn(process.execPath, [scriptPath, "--channel", "stable", "--dist-tag", "latest", "--target-version", version, "--package", name], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    let code, signal;
    try {
      [code, signal] = await once(child, "close");
    } finally {
      clearTimeout(timer);
    }
    assert.equal(signal, null, `child terminated: ${signal}; ${stderr}`);
    assert.equal(code, 0, `CLI failed: ${stderr}`);
    assert.match(stdout, /dist-tag and published internal dependencies are consistent/);
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ["GET", documentPath], ["GET", manifestPath],
    ]);
    for (const request of requests) {
      assert.match(request.headers.accept, /application\/vnd\.npm\.install-v1\+json/);
      assert.equal(request.headers.authorization, undefined);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test("real verifier exports the expected manifest lookup key", () => {
  assert.equal(createManifestLookupKey(name, version), "@myrmidon/a@2026.1116.0");
});

for (const [label, registries] of [
  ["lowercase registry with trailing slash", (origin) => ({ npm_config_registry: `${origin}/mirror/` })],
  ["lowercase registry without trailing slash", (origin) => ({ npm_config_registry: `${origin}/mirror` })],
  ["uppercase registry with trailing slash", (origin) => ({ NPM_CONFIG_REGISTRY: `${origin}/mirror/` })],
  ["uppercase registry without trailing slash", (origin) => ({ NPM_CONFIG_REGISTRY: `${origin}/mirror` })],
  ["lowercase registry takes priority over uppercase", (origin) => ({ npm_config_registry: `${origin}/mirror/`, NPM_CONFIG_REGISTRY: `${origin}/forbidden/` })],
]) {
  test(`CLI uses ${label}`, { timeout: 8000 }, async () => runCase(registries));
}
