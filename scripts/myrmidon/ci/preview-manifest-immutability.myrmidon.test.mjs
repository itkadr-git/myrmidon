import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { previewManifest, assertMetadata, publishPreview } from "../../preview-artifacts.mjs";
import { materializePublishManifest } from "../../prepare-bundled-package.mjs";

const sha = "a".repeat(40);
const version = `0.0.0-preview.g${sha}`;

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fixture(name = "@myrmidon/shared") {
  return {
    name, version: "1.2.3", main: "./source.js", exports: { ".": "./source.js" },
    dependencies: { one: "workspace:*", two: "^2.0.0" },
    optionalDependencies: { three: "workspace:^", four: "~3.0.0" },
    peerDependencies: { five: "workspace:~", six: ">=4" },
    devDependencies: { seven: "workspace:*" },
    publishConfig: { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": { import: "./dist/index.js" } }, bin: { cmd: "./dist/cli.js" }, access: "public" },
    custom: { nested: ["original"] },
  };
}

function pack(pkg) {
  const body = Buffer.from(JSON.stringify(pkg));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write(body.length.toString(8).padStart(11, "0"), 124, 11);
  header[156] = 48;
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

test("preview manifest preserves frozen source and isolates nested output", () => {
  const source = freezeDeep(fixture());
  const snapshot = structuredClone(source);
  const result = previewManifest(source, sha);
  assert.equal(result.name, source.name);
  assert.equal(result.version, version);
  assert.equal(result.gitHead, sha);
  assert.equal(result.paperclipPreviewCommit, sha);
  assert.deepEqual(result.dependencies, { one: version, two: "^2.0.0" });
  assert.deepEqual(result.optionalDependencies, { three: version, four: "~3.0.0" });
  assert.deepEqual(result.peerDependencies, { five: version, six: ">=4" });
  assert.deepEqual(result.devDependencies, { seven: "workspace:*" });
  const materialized = materializePublishManifest(structuredClone(source));
  for (const key of ["main", "types", "exports", "bin"]) assert.deepEqual(result[key], materialized[key]);
  assert.equal(Object.hasOwn(result, "publishConfig"), false);
  result.dependencies.one = "changed";
  result.devDependencies.seven = "changed";
  result.exports["."].import = "changed";
  result.custom.nested.push("changed");
  assert.deepEqual(source, snapshot);
});

test("DB always pins shared even when missing or already specified", () => {
  for (const existing of [undefined, "workspace:^", "^1.0.0", "0.0.0-preview.g" + "b".repeat(40)]) {
    const source = fixture("@myrmidon/db");
    if (existing !== undefined) source.dependencies["@myrmidon/shared"] = existing;
    freezeDeep(source);
    const result = previewManifest(source, sha);
    assert.equal(result.dependencies["@myrmidon/shared"], version);
    assert.equal(source.dependencies["@myrmidon/shared"], existing);
    assert.doesNotThrow(() => assertMetadata(result, source.name, sha));
  }
  const source = freezeDeep({ name: "@myrmidon/db" });
  assert.equal(previewManifest(source, sha).dependencies["@myrmidon/shared"], version);
});

test("unknown packages are rejected", () => {
  assert.throws(() => previewManifest(freezeDeep(fixture("@myrmidon/other")), sha), /Unexpected preview package/);
});

test("metadata accepts both packages and rejects each identity mutation", () => {
  for (const name of ["@myrmidon/shared", "@myrmidon/db"]) {
    const valid = previewManifest(freezeDeep(fixture(name)), sha);
    assert.doesNotThrow(() => assertMetadata(valid, name, sha));
    for (const [key, value] of Object.entries({ name: "@myrmidon/other", version: "1.2.3", gitHead: "b".repeat(40), paperclipPreviewCommit: "b".repeat(40), publishConfig: {} })) {
      const invalid = structuredClone(valid);
      invalid[key] = value;
      assert.throws(() => assertMetadata(invalid, name, sha), /identity or dependency pin mismatch/, `${name}: ${key}`);
    }
    if (name === "@myrmidon/db") {
      for (const pin of [undefined, "workspace:*", "^1.0.0"]) {
        const invalid = structuredClone(valid);
        invalid.dependencies["@myrmidon/shared"] = pin;
        assert.throws(() => assertMetadata(invalid, name, sha), /identity or dependency pin mismatch/);
      }
    }
  }
});

test("publication validates both manifests before any registry or publish side effect", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-immutability-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shared = previewManifest(fixture(), sha);
  const db = previewManifest(fixture("@myrmidon/db"), sha);
  writeFileSync(path.join(dir, "shared.tgz"), pack(shared));
  writeFileSync(path.join(dir, "db.tgz"), pack({ ...db, paperclipPreviewCommit: "b".repeat(40) }));
  const calls = [];
  await assert.rejects(publishPreview(dir, sha, {
    fetchImpl: async () => { calls.push("fetch"); throw new Error("unexpected fetch"); },
    exec: () => { calls.push("publish"); },
    sleep: async () => { calls.push("sleep"); },
  }), /identity or dependency pin mismatch/);
  assert.deepEqual(calls, []);
});
