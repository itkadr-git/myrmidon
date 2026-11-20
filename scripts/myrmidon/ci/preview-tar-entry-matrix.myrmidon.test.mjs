import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { previewManifest, publishPreview, tarManifest } from "../../preview-artifacts.mjs";

const sha = "a".repeat(40);
const manifest = { name: "fixture", version: "1.2.3", nested: { value: 42 } };
const json = (value) => Buffer.from(JSON.stringify(value));

function entry(name, { type = "0", body = Buffer.alloc(0), sizeText } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(sizeText ?? body.length.toString(8).padStart(11, "0"), 124, 11);
  header[156] = type.charCodeAt(0);
  const padding = Buffer.alloc((512 - body.length % 512) % 512);
  return Buffer.concat([header, body, padding]);
}
const archive = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const manifestEntry = (value = manifest) => entry("package/package.json", { body: json(value) });
const expectError = (bytes, message) => assert.throws(() => tarManifest(bytes), { name: "Error", message });

test("missing and duplicate manifests are rejected", () => {
  expectError(archive(entry("package/readme", { body: Buffer.from("hello") })), "Missing package manifest.");
  expectError(archive(manifestEntry(), manifestEntry()), "Invalid package manifest entry.");
});

test("manifest directory and symlink have distinct rejection categories", () => {
  expectError(archive(entry("package/package.json", { type: "5" })), "Invalid package manifest entry.");
  expectError(archive(entry("package/package.json", { type: "2" })), "Unsupported package archive entry.");
});

test("regular files and directories including names containing two dots are accepted", () => {
  const bytes = archive(entry("package/dist/", { type: "5" }), entry("package/dist/file..json", { body: Buffer.from("data") }), manifestEntry());
  assert.deepEqual(tarManifest(bytes), manifest);
});

test("dot and dot-dot path segments are rejected", () => {
  for (const name of ["package/./file", "package/a/../file"]) {
    expectError(archive(manifestEntry(), entry(name)), "Unsupported package archive entry.");
  }
});

test("invalid octal size and truncated body are rejected", () => {
  expectError(archive(entry("package/file", { sizeText: "00000000008" })), "Invalid package archive.");
  const truncated = entry("package/file", { body: Buffer.from("x"), sizeText: "00000002000" }).subarray(0, 513);
  expectError(gzipSync(truncated), "Truncated package archive.");
});

test("publication validates both archives before registry or npm side effects", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-entry-matrix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shared = previewManifest({ name: "@myrmidon/shared", version: "0.0.0" }, sha);
  writeFileSync(path.join(dir, "shared.tgz"), archive(manifestEntry(shared)));
  writeFileSync(path.join(dir, "db.tgz"), archive(entry("package/package.json", { type: "5" })));
  const effects = [];
  await assert.rejects(publishPreview(dir, sha, {
    fetchImpl: async () => { effects.push("fetch"); throw new Error("unexpected fetch"); },
    exec: () => { effects.push("exec"); throw new Error("unexpected exec"); },
    sleep: async () => { effects.push("sleep"); },
  }), { name: "Error", message: "Invalid package manifest entry." });
  assert.deepEqual(effects, []);
});
