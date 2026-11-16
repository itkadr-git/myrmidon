import test from "node:test";
import assert from "node:assert/strict";
import { assertLockfile } from "./cloud-migrator-artifacts.mjs";

const version = "1.7.0-test";
const integrity = `sha512-${"A".repeat(86)}==`;
const manifest = {
  packageVersion: version,
  packages: {
    db: { url: "https://artifacts.example/db.tgz", integrity },
    shared: { url: "https://artifacts.example/shared.tgz", integrity },
  },
};

function fixture() {
  return {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@myrmidon/db": version } },
      "node_modules/@myrmidon/db": {
        version, ...manifest.packages.db,
        resolved: manifest.packages.db.url,
        dependencies: { "@myrmidon/shared": version },
      },
      "node_modules/@myrmidon/shared": {
        version, ...manifest.packages.shared, resolved: manifest.packages.shared.url,
      },
      "node_modules/external": {
        version: "1.0.0", resolved: "https://registry.npmjs.org/external/-/external-1.0.0.tgz", integrity,
      },
      "node_modules/@myrmidon/db/node_modules/bundled": { version: "1.0.0", inBundle: true },
    },
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function check(lock, error) {
  const original = structuredClone(lock);
  const originalManifest = structuredClone(manifest);
  freeze(lock);
  freeze(manifest);
  if (error) assert.throws(() => assertLockfile(lock, manifest), error);
  else assert.equal(assertLockfile(lock, manifest), undefined);
  assert.deepEqual(lock, original);
  assert.deepEqual(manifest, originalManifest);
}

test("accepts an immutable v3 lockfile including a db-bundled dependency", () => {
  check(fixture());
});

const cases = [
  ["lockfile version", (l) => { l.lockfileVersion = 2; }, /lockfile root/],
  ["root dependency", (l) => { l.packages[""].dependencies["@myrmidon/db"] = "latest"; }, /lockfile root/],
  ["db version", (l) => { l.packages["node_modules/@myrmidon/db"].version = "0.0.0"; }, /package pin mismatch/],
  ["shared version", (l) => { l.packages["node_modules/@myrmidon/shared"].version = "0.0.0"; }, /package pin mismatch/],
  ["db shared dependency", (l) => { l.packages["node_modules/@myrmidon/db"].dependencies["@myrmidon/shared"] = "latest"; }, /shared dependency mismatch/],
  ["linked dependency", (l) => { l.packages["node_modules/external"].link = true; }, /lockfile entry/],
  ["foreign internal package", (l) => { l.packages["node_modules/@myrmidon/foreign"] = { integrity, resolved: "https://registry.npmjs.org/foreign.tgz" }; }, /Unexpected internal/],
  ["bundled outside db", (l) => { l.packages["node_modules/external"].inBundle = true; }, /Unexpected bundled/],
  ["credentials", (l) => { l.packages["node_modules/external"].resolved = "https://user:pass@registry.npmjs.org/external.tgz"; }, /resolve to npm/],
  ["query", (l) => { l.packages["node_modules/external"].resolved = "https://registry.npmjs.org/external.tgz?tag=latest"; }, /resolve to npm/],
  ["fragment", (l) => { l.packages["node_modules/external"].resolved = "https://registry.npmjs.org/external.tgz#latest"; }, /resolve to npm/],
  ["foreign origin", (l) => { l.packages["node_modules/external"].resolved = "https://evil.invalid/external.tgz"; }, /resolve to npm/],
  ["weak integrity", (l) => { l.packages["node_modules/external"].integrity = "sha1-weak"; }, /strong integrity/],
];

for (const [name, mutate, error] of cases) {
  test(`rejects ${name} without mutating input`, () => {
    const lock = fixture();
    mutate(lock);
    check(lock, error);
  });
}
