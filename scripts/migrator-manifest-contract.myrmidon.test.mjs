import test from "node:test";
import assert from "node:assert/strict";
import { descriptor, assertManifest, assertLockfile } from "./cloud-migrator-artifacts.mjs";
import { versionFor } from "./preview-artifacts.mjs";

const sourceSha = "a".repeat(40);
const packageVersion = versionFor(sourceSha);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fixture() {
  const dbBytes = Buffer.from("db fixture");
  const sharedBytes = Buffer.from("shared fixture");
  const lockBytes = Buffer.from('{"lockfileVersion":3}\n');
  const manifest = {
    version: 1,
    sourceSha,
    packageVersion,
    packages: {
      db: descriptor(dbBytes, "tgz"),
      shared: descriptor(sharedBytes, "tgz"),
    },
    lockfile: descriptor(lockBytes, "json"),
  };
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@myrmidon/db": packageVersion } },
      "node_modules/@myrmidon/db": {
        version: packageVersion,
        integrity: manifest.packages.db.integrity,
        resolved: manifest.packages.db.url,
        dependencies: { "@myrmidon/shared": packageVersion },
      },
      "node_modules/@myrmidon/shared": {
        version: packageVersion,
        integrity: manifest.packages.shared.integrity,
        resolved: manifest.packages.shared.url,
      },
      "node_modules/safe-dependency": {
        version: "1.2.3",
        integrity: "sha512-" + "A".repeat(86) + "==",
        resolved: "https://registry.npmjs.org/safe-dependency/-/safe-dependency-1.2.3.tgz",
      },
    },
  };
  return { manifest, lockfile };
}

test("accepts an immutable valid db/shared manifest and matching lockfile", () => {
  const { manifest, lockfile } = fixture();
  deepFreeze(manifest);
  deepFreeze(lockfile);
  assert.doesNotThrow(() => assertManifest(manifest, sourceSha));
  assert.doesNotThrow(() => assertLockfile(lockfile, manifest));
  assert.doesNotThrow(() => assertManifest(manifest, sourceSha));
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.packages.db), true);
  assert.equal(Object.isFrozen(manifest.lockfile), true);
});

test("rejects foreign source identity and package version", () => {
  const { manifest } = fixture();
  for (const mutate of [
    (value) => { value.sourceSha = "b".repeat(40); },
    (value) => { value.packageVersion = "0.0.0"; },
    (value) => { value.version = 2; },
  ]) {
    const bad = structuredClone(manifest);
    mutate(bad);
    assert.throws(() => assertManifest(bad, sourceSha), /source identity/);
  }
});

test("rejects absent packages and lockfile", () => {
  const { manifest } = fixture();
  for (const field of ["db", "shared"]) {
    const bad = structuredClone(manifest);
    delete bad.packages[field];
    assert.throws(() => assertManifest(bad, sourceSha), /integrity or size/);
  }
  const bad = structuredClone(manifest);
  delete bad.lockfile;
  assert.throws(() => assertManifest(bad, sourceSha), /integrity or size/);
});

test("rejects every invalid size boundary", () => {
  const { manifest } = fixture();
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 32 * 1024 * 1024 + 1]) {
    const bad = structuredClone(manifest);
    bad.packages.db.size = size;
    assert.throws(() => assertManifest(bad, sourceSha), /integrity or size/);
  }
});

test("rejects invalid integrity, digest URL, origin, and extension", () => {
  const { manifest } = fixture();
  for (const mutate of [
    (pin) => { pin.integrity = "sha512-not-base64"; },
    (pin) => { pin.integrity = "sha512-" + "A".repeat(86) + "="; },
    (pin) => { pin.integrity = "sha512-" + "A".repeat(85) + "B=="; },
    (pin) => { pin.url = manifest.packages.shared.url; },
    (pin) => { pin.url = `${pin.url.slice(0, -4)}.json`; },
    (pin) => { pin.url = pin.url.replace("https://d1p6rlowie26tp.cloudfront.net", "https://evil.invalid"); },
    (pin) => { pin.url = pin.url.replace(/\.[^.]+$/, ""); },
  ]) {
    const bad = structuredClone(manifest);
    mutate(bad.packages.db);
    assert.throws(() => assertManifest(bad, sourceSha), /integrity|URL/);
  }
});

test("rejects lockfiles with missing, mutable, or mismatched package pins", () => {
  const { manifest, lockfile } = fixture();
  for (const mutate of [
    (value) => { delete value.packages["node_modules/@myrmidon/db"]; },
    (value) => { value.packages["node_modules/@myrmidon/shared"].version = "0.0.0"; },
    (value) => { value.packages["node_modules/@myrmidon/db"].integrity = manifest.packages.shared.integrity; },
    (value) => { value.packages["node_modules/@myrmidon/db"].link = true; },
    (value) => { value.packages["node_modules/unknown" ] = { inBundle: true }; },
  ]) {
    const bad = structuredClone(lockfile);
    mutate(bad);
    assert.throws(() => assertLockfile(bad, manifest));
  }
});
