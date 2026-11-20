import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { artifactBase, buildBundle, descriptor, publishBundle } from "./cloud-migrator-artifacts.mjs";
import { previewManifest, versionFor } from "./preview-artifacts.mjs";

const sha = "b".repeat(40);
const marker = `cloud-migrators/v1/${sha}/manifest.json`;

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migrator-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["db", "shared"]) {
    const bytes = Buffer.from(JSON.stringify(previewManifest({ name: `@myrmidon/${name}`, dependencies: {} }, sha)));
    const header = Buffer.alloc(512);
    header.write("package/package.json");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11);
    header[156] = 48;
    header.fill(32, 148, 156);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
    bytes.copy(padded);
    writeFileSync(path.join(dir, `${name}.tgz`), gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)])));
  }
  const manifest = buildBundle(dir, sha, { exec: (_cmd, _args, { cwd }) => {
    const packages = { "": JSON.parse(readFileSync(path.join(cwd, "package.json"))) };
    for (const name of ["db", "shared"]) packages[`node_modules/@myrmidon/${name}`] = {
      version: versionFor(sha), integrity: descriptor(readFileSync(path.join(dir, `${name}.tgz`)), "tgz").integrity,
      resolved: `file:${name}.tgz`, ...(name === "db" ? { dependencies: { "@myrmidon/shared": versionFor(sha) } } : {}),
    };
    writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  } });
  const files = new Map([[`${artifactBase}/${sha}/manifest.json`, readFileSync(path.join(dir, "manifest.json"))]]);
  for (const name of ["db", "shared"]) files.set(manifest.packages[name].url, readFileSync(path.join(dir, `${name}.tgz`)));
  files.set(manifest.lockfile.url, readFileSync(path.join(dir, "package-lock.json")));
  const calls = [], downloads = [], sleeps = [], objects = new Set();
  const exec = (cmd, args) => {
    assert.equal(cmd, "aws");
    calls.push(args);
    const arg = (key) => args[args.indexOf(key) + 1];
    if (args[1] === "list-objects-v2") return JSON.stringify({ Contents: objects.has(arg("--prefix")) ? [{ Key: arg("--prefix") }] : [] });
    assert.equal(args[1], "put-object");
    objects.add(arg("--key"));
    return "{}";
  };
  const fetchImpl = async (url, options) => {
    downloads.push(url);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.ok(files.has(url), `unexpected URL ${url}`);
    return new Response(files.get(url));
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  return { dir, manifest, files, calls, downloads, sleeps, objects, exec, fetchImpl, sleep };
}

test("publishes immutable blobs before the marker and preserves an existing marker", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await publishBundle(f.dir, sha, f), f.manifest);
  const puts = f.calls.filter((args) => args[1] === "put-object");
  const arg = (args, key) => args[args.indexOf(key) + 1];
  assert.deepEqual(puts.map((args) => arg(args, "--key")), [
    ...[f.manifest.packages.db.url, f.manifest.packages.shared.url, f.manifest.lockfile.url].map((url) => `cloud-migrators/v1/${url.slice(artifactBase.length + 1)}`), marker,
  ]);
  for (const args of puts) assert.equal(arg(args, "--if-none-match"), "*");
  assert.deepEqual(f.sleeps, []);
  f.calls.length = 0;
  assert.deepEqual(await publishBundle(f.dir, sha, f), f.manifest);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], "list-objects-v2");
});

for (const status of [403, 404]) {
  test(`visibility ${status} retries at most six times and can recover`, async (t) => {
    const f = fixture(t);
    let attempts = 0;
    const fetchImpl = async (url, options) => {
      if (url.endsWith("/manifest.json") && ++attempts <= 6) return new Response(null, { status });
      return f.fetchImpl(url, options);
    };
    assert.deepEqual(await publishBundle(f.dir, sha, { ...f, fetchImpl }), f.manifest);
    assert.equal(attempts, 7);
    assert.deepEqual(f.sleeps, Array(6).fill(2000));
    attempts = 0; f.sleeps.length = 0;
    const unavailable = async () => { attempts++; return new Response(null, { status }); };
    await assert.rejects(publishBundle(f.dir, sha, { ...f, fetchImpl: unavailable }), (error) => error.cause?.status === status);
    assert.equal(attempts, 7);
    assert.deepEqual(f.sleeps, Array(6).fill(2000));
  });
}

test("server errors and corrupted published bytes fail without retries", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  await assert.rejects(publishBundle(f.dir, sha, { ...f, fetchImpl: async () => { attempts++; return new Response(null, { status: 500 }); } }), (error) => error.cause?.status === 500);
  assert.equal(attempts, 1);
  assert.deepEqual(f.sleeps, []);
  f.files.set(f.manifest.packages.db.url, Buffer.from("corrupt"));
  f.downloads.length = 0;
  await assert.rejects(publishBundle(f.dir, sha, f), /immutable pin/);
  assert.equal(f.downloads.filter((url) => url.endsWith("/manifest.json")).length, 1);
  assert.equal(f.downloads.filter((url) => url === f.manifest.packages.db.url).length, 1);
  assert.deepEqual(f.sleeps, []);
});

for (const operation of ["list-objects-v2", "put-object"]) {
  test(`${operation} errors propagate without visibility checks`, async (t) => {
    const f = fixture(t);
    const failure = new Error(`${operation} denied`);
    const exec = (cmd, args) => { if (args[1] === operation) throw failure; return f.exec(cmd, args); };
    await assert.rejects(publishBundle(f.dir, sha, { ...f, exec }), (error) => error === failure);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.sleeps, []);
  });
}
