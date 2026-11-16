import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { artifactBase, descriptor, verifyPublished } from "./cloud-migrator-artifacts.mjs";
import { previewManifest, versionFor } from "./preview-artifacts.mjs";

const sha = "a".repeat(40);
const manifestUrl = `${artifactBase}/${sha}/manifest.json`;

function archive(name) {
  const bytes = Buffer.from(JSON.stringify(previewManifest({ name: `@myrmidon/${name}`, dependencies: {} }, sha)));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11);
  header[156] = 48;
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
  bytes.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

function fixture() {
  const archives = Object.fromEntries(["db", "shared"].map((name) => [name, archive(name)]));
  const packages = Object.fromEntries(Object.entries(archives).map(([name, bytes]) => [name, descriptor(bytes, "tgz")]));
  const version = versionFor(sha);
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { "@myrmidon/db": version } },
    "node_modules/@myrmidon/db": { version, resolved: packages.db.url, integrity: packages.db.integrity, dependencies: { "@myrmidon/shared": version } },
    "node_modules/@myrmidon/shared": { version, resolved: packages.shared.url, integrity: packages.shared.integrity },
  } };
  const lockBytes = Buffer.from(JSON.stringify(lock));
  const manifest = { version: 1, sourceSha: sha, packageVersion: version, packages, lockfile: descriptor(lockBytes, "json") };
  const files = new Map([[manifestUrl, Buffer.from(JSON.stringify(manifest))], [packages.db.url, archives.db],
    [packages.shared.url, archives.shared], [manifest.lockfile.url, lockBytes]]);
  return { manifest, files };
}

function stream(chunks) {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index === chunks.length) controller.close();
    else controller.enqueue(chunks[index++]);
  } });
}

function fetchFiles(files, calls, chunkSize = 1) {
  return async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.ok(files.has(url), `unexpected URL: ${url}`);
    const bytes = files.get(url);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
    return new Response(stream(chunks));
  };
}

test("verifies bytewise streamed manifest, archives and lockfile with guarded fetch options", async () => {
  const { manifest, files } = fixture();
  const calls = [];
  let proven;
  const result = await verifyPublished(sha, fetchFiles(files, calls), { verifyProvenance: async (bytes, source) => {
    assert.equal(source, sha);
    proven = Buffer.from(bytes);
  } });
  assert.deepEqual(result, manifest);
  assert.deepEqual(proven, files.get(manifestUrl));
  assert.deepEqual(calls.sort(), [...files.keys()].sort());
});

test("HTTP errors retain their status and abort verification", async () => {
  for (const status of [403, 404, 500]) {
    let calls = 0;
    await assert.rejects(verifyPublished(sha, async (url, options) => {
      calls++;
      assert.equal(url, manifestUrl);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(null, { status });
    }), (error) => error.message === `Artifact download failed: HTTP ${status}` && error.cause?.status === status);
    assert.equal(calls, 1);
  }
});

test("propagates a stream reader failure", async () => {
  const failure = new Error("stream interrupted");
  await assert.rejects(verifyPublished(sha, async () => new Response(new ReadableStream({
    pull(controller) { controller.error(failure); },
  }))), (error) => error === failure);
});

test("rejects corrupt or truncated artifact bytes without changing pins", async () => {
  for (const target of ["db", "shared", "lockfile"]) {
    for (const mutation of ["corrupt", "truncate"]) {
      const { manifest, files } = fixture();
      const url = target === "lockfile" ? manifest.lockfile.url : manifest.packages[target].url;
      const original = files.get(url);
      const bytes = Buffer.from(mutation === "truncate" ? original.subarray(0, -1) : original);
      if (mutation === "corrupt") bytes[0] ^= 1;
      files.set(url, bytes);
      await assert.rejects(verifyPublished(sha, fetchFiles(files, [], 17)), /Artifact bytes do not match their immutable pin/);
    }
  }
});

test("rejects a stream crossing the size limit across chunks and cancels it", async () => {
  let sent = 0;
  let cancelled = false;
  const chunk = Buffer.alloc(1024 * 1024);
  await assert.rejects(verifyPublished(sha, async () => new Response(new ReadableStream({
    pull(controller) { sent++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }))), /Artifact exceeds size limit/);
  assert.ok(sent >= 33);
  assert.equal(cancelled, true);
});
