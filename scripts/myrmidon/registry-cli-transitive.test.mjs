import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createManifestLookupKey } from "../verify-release-registry-state.mjs";

const scriptPath = fileURLToPath(new URL("../verify-release-registry-state.mjs", import.meta.url));
const target = "2026.430.0";
const other = "2026.429.0";
const a = "@myrmidon/a";
const b = "@myrmidon/b";
const shared = "@myrmidon/shared";
const pathFor = (name, version) => `/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}`;

async function exercise({ aDeps = {}, bDeps = {}, sharedVersions = [target] }) {
  const manifests = new Map([
    [createManifestLookupKey(a, target), { name: a, version: target, ...aDeps }],
    [createManifestLookupKey(b, target), { name: b, version: target, ...bDeps }],
    ...sharedVersions.map((version) => [createManifestLookupKey(shared, version), { name: shared, version }]),
  ]);
  const documents = new Map([
    [pathFor(a), { "dist-tags": { latest: target }, versions: {} }],
    [pathFor(b), { "dist-tags": { latest: target }, versions: {} }],
    ...[...manifests].map(([key, manifest]) => [pathFor(manifest.name, manifest.version), manifest]),
  ]);
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const document = documents.get(req.url);
    res.writeHead(document ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(document ?? { error: "not found" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let child;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: AbortSignal.timeout(5000) });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/npm|node_options|node_extra_ca_certs|proxy|registry|token|auth/i.test(key),
    ));
    env.npm_config_registry = `http://127.0.0.1:${server.address().port}/`;
    child = spawn(process.execPath, [scriptPath, "--channel", "stable", "--dist-tag", "latest", "--target-version", target, "--package", a, "--package", b], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    let code;
    let signal;
    try {
      [code, signal] = await once(child, "close");
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(signal, null, `CLI terminated: ${signal}\n${stderr}`);
    assert.equal(code, 0, `CLI exited ${code}\n${stdout}\n${stderr}`);
    for (const request of requests) {
      assert.equal(request.method, "GET");
      assert.match(request.headers.accept, /application\/vnd\.npm\.install-v1\+json/);
      assert.equal(request.headers.authorization, undefined);
    }
    return requests.map(({ url }) => url).sort();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const baseRequests = [pathFor(a), pathFor(b), pathFor(a, target), pathFor(b, target)];
const expectRequests = (actual, extra) => assert.deepEqual(actual, [...baseRequests, ...extra].sort());

test("deduplicates a shared dependency across dependencies and optionalDependencies", async () => {
  const requests = await exercise({ aDeps: { dependencies: { [shared]: target } }, bDeps: { optionalDependencies: { [shared]: target } } });
  expectRequests(requests, [pathFor(shared, target)]);
});

test("fetches distinct versions of the same shared dependency separately", async () => {
  const requests = await exercise({ aDeps: { dependencies: { [shared]: target } }, bDeps: { optionalDependencies: { [shared]: other } }, sharedVersions: [target, other] });
  expectRequests(requests, [pathFor(shared, target), pathFor(shared, other)]);
});

test("does not refetch a target manifest already loaded as a release package", async () => {
  const requests = await exercise({ aDeps: { dependencies: { [b]: target, [shared]: target } }, bDeps: { optionalDependencies: { [shared]: target } } });
  expectRequests(requests, [pathFor(shared, target)]);
});

test("does not fetch external dependencies", async () => {
  const requests = await exercise({ aDeps: { dependencies: { [shared]: target, lodash: "4.17.21" } }, bDeps: { optionalDependencies: { [shared]: target, external: "1.0.0" } } });
  expectRequests(requests, [pathFor(shared, target)]);
});

test("does not fetch internal peer ranges", async () => {
  const requests = await exercise({ aDeps: { dependencies: { [shared]: target }, peerDependencies: { "@myrmidon/peer": `^${target}` } }, bDeps: { optionalDependencies: { [shared]: target }, peerDependencies: { [shared]: `^${target}` } } });
  expectRequests(requests, [pathFor(shared, target)]);
});
