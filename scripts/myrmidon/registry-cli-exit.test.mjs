import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyPackageRegistryProblems } from "../verify-release-registry-state.mjs";

const scriptPath = fileURLToPath(new URL("../verify-release-registry-state.mjs", import.meta.url));
const stable = "2026.430.0";
const canary = `${stable}-canary.0`;
const app = "@myrmidon/app";
const other = "@myrmidon/other";
const dep = "@myrmidon/shared";
const root = (name) => `/${encodeURIComponent(name)}`;
const direct = (name, version) => `${root(name)}/${encodeURIComponent(version)}`;
const manifest = (name, version, dependencies = {}) => ({ name, version, dependencies });
const doc = (tag, version, latest = version, embedded = {}) => ({
  "dist-tags": { [tag]: version, latest }, versions: embedded,
});

async function runFixture({ channel = "stable", version = stable, packages = [app], docs, manifests, allow = false }) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const response = docs[req.url] ?? manifests[req.url];
    res.writeHead(response === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response ?? { error: "not found" }));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  let child;
  try {
    server.listen(0, "127.0.0.1");
    await Promise.race([once(server, "listening"), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("server listen timeout")), 5000); timer.unref();
    })]);
    const registry = `http://127.0.0.1:${server.address().port}/`;
    const tag = channel === "stable" ? "latest" : channel;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/npm|registry|token|auth|proxy|node_options/i.test(key)));
    env.npm_config_registry = registry;
    const args = [scriptPath, "--channel", channel, "--dist-tag", tag, "--target-version", version,
      ...packages.flatMap((name) => ["--package", name]), ...(allow ? ["--allow-canary-latest"] : [])];
    child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    let code; let signal;
    try { [code, signal] = await once(child, "close"); } finally { clearTimeout(timeout); }
    assert.equal(signal, null, `child terminated: ${signal}`);
    return { code, stdout, stderr, requests };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

function check(result, { code, problems = [], success = [], paths }) {
  assert.equal(result.code, code, result.stderr);
  const lines = result.stderr.split("\n").filter((line) => line.includes("✗"));
  assert.equal(lines.length, problems.length, result.stderr);
  for (const text of problems) assert.equal(lines.filter((line) => line.includes(text)).length, 1, result.stderr);
  if (problems.length) assert.match(result.stderr, new RegExp(`verification failed for ${problems.length} problem\\(s\\)`));
  else assert.equal(result.stderr, "");
  const successNames = [...result.stdout.matchAll(/Verifying ([^ ]+) on dist-tag [^\n]+\n\s+✓/g)].map((m) => m[1]);
  assert.deepEqual(successNames, success);
  assert.deepEqual(result.requests.map((r) => r.url).sort(), [...paths].sort());
  for (const request of result.requests) {
    assert.equal(request.method, "GET");
    assert.match(request.headers.accept, /application\/vnd\.npm\.install-v1\+json/);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
  }
}

const packageFixture = (version, tag = "latest", latest = version) => ({
  docs: { [root(app)]: doc(tag, version, latest) },
  manifests: { [direct(app, version)]: manifest(app, version) },
});

test("stable consistent exits 0", async () => {
  const fixture = packageFixture(stable);
  check(await runFixture(fixture), { code: 0, success: [app], paths: [root(app), direct(app, stable)] });
});

test("stale target tag exits 1", async () => {
  const fixture = packageFixture(stable);
  fixture.docs[root(app)]["dist-tags"].latest = "2026.429.0";
  check(await runFixture(fixture), { code: 1, problems: [`${app}: dist-tag latest resolves to 2026.429.0`], paths: [root(app), direct(app, stable)] });
});

test("missing direct manifest overrides embedded metadata and exits 1", async () => {
  const fixture = packageFixture(stable);
  fixture.docs[root(app)].versions[stable] = manifest(app, stable);
  delete fixture.manifests[direct(app, stable)];
  check(await runFixture(fixture), { code: 1, problems: [`${app}: npm registry is missing manifest data for ${stable}`], paths: [root(app), direct(app, stable)] });
});

test("canary latest drift exits 2", async () => {
  const fixture = packageFixture(canary, "canary");
  check(await runFixture({ ...fixture, channel: "canary", version: canary }), { code: 2, problems: [`${app}: latest dist-tag still resolves to prerelease ${canary}`], paths: [root(app), direct(app, canary)] });
});

test("mixed retriable and non-retriable package problems exit 2", async () => {
  const fixture = packageFixture(canary, "canary");
  fixture.docs[root(other)] = doc("canary", "2026.429.0", stable);
  fixture.manifests[direct(other, canary)] = manifest(other, canary);
  check(await runFixture({ ...fixture, channel: "canary", version: canary, packages: [app, other] }), {
    code: 2, problems: [`${app}: latest dist-tag still resolves to prerelease`, `${other}: dist-tag canary resolves to 2026.429.0`],
    paths: [root(app), root(other), direct(app, canary), direct(other, canary)],
  });
});

for (const missing of [false, true]) {
  test(`allow canary latest ${missing ? "still rejects missing dependency" : "accepts published dependency"}`, async () => {
    const fixture = packageFixture(canary, "canary");
    fixture.manifests[direct(app, canary)] = manifest(app, canary, { [dep]: stable });
    if (!missing) fixture.manifests[direct(dep, stable)] = manifest(dep, stable);
    const result = await runFixture({ ...fixture, channel: "canary", version: canary, allow: true });
    check(result, { code: missing ? 1 : 0, success: missing ? [] : [app],
      problems: missing ? [`${app}@${canary}: dependencies requires ${dep}@${stable}`, `${app}@${canary} via latest: dependencies requires ${dep}@${stable}`] : [],
      paths: [root(app), direct(app, canary), direct(dep, stable)] });
  });
}

test("real verifier export classifies latest drift as non-retriable", () => {
  const packageDoc = doc("canary", canary);
  const problems = verifyPackageRegistryProblems({ packageName: app, packageDoc,
    packageDocsByName: new Map([[app, packageDoc]]),
    packageManifestsByKey: new Map([[`${app}@${canary}`, manifest(app, canary)]]),
    channel: "canary", distTag: "canary", targetVersion: canary, allowCanaryLatest: false });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].retriable, false);
  assert.match(problems[0].message, /@myrmidon\/app: latest dist-tag/);
});
