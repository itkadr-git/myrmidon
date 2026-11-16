import assert from "node:assert/strict";
import test from "node:test";
import {
  collectInternalDependencyProblems,
  createManifestLookupKey,
  verifyPackageRegistryProblems,
} from "./verify-release-registry-state.mjs";

test("manifest lookup keys distinguish scoped package names and versions", () => {
  assert.equal(createManifestLookupKey("@myrmidon/shared", "1.2.3-beta.1"), "@myrmidon/shared@1.2.3-beta.1");
  const keys = new Set([
    createManifestLookupKey("@myrmidon/shared", "1.2.3-beta.1"),
    createManifestLookupKey("@myrmidon/shared", "1.2.3-beta.2"),
    createManifestLookupKey("@myrmidon/server", "1.2.3-beta.1"),
  ]);
  assert.equal(keys.size, 3);
});

test("exact internal dependency must exist, including optional dependencies", () => {
  const manifest = {
    dependencies: { "@myrmidon/shared": "1.2.3-beta.1", lodash: "4.0.0" },
    optionalDependencies: { "@myrmidon/browser": "1.2.3-beta.1" },
  };
  const docs = new Map([
    ["@myrmidon/shared", { versions: { "1.2.3-beta.1": {} } }],
    ["@myrmidon/browser", { versions: { "1.2.3-beta.2": {} } }],
  ]);
  assert.deepEqual(collectInternalDependencyProblems(manifest, docs), [
    "optionalDependencies requires @myrmidon/browser@1.2.3-beta.1, but npm does not expose that version",
  ]);
  docs.get("@myrmidon/browser").versions["1.2.3-beta.1"] = {};
  assert.deepEqual(collectInternalDependencyProblems(manifest, docs), []);
});

test("missing dependency metadata differs from an explicitly missing manifest", () => {
  const manifest = { dependencies: { "@myrmidon/shared": "1.2.3" } };
  const docs = new Map();
  assert.deepEqual(collectInternalDependencyProblems(manifest, docs), [
    "dependencies requires @myrmidon/shared@1.2.3, but npm publication metadata was not fetched for that dependency",
  ]);
  const manifests = new Map([[createManifestLookupKey("@myrmidon/shared", "1.2.3"), null]]);
  assert.deepEqual(collectInternalDependencyProblems(manifest, docs, manifests), [
    "dependencies requires @myrmidon/shared@1.2.3, but npm does not expose that version",
  ]);
  manifests.set(createManifestLookupKey("@myrmidon/shared", "1.2.3"), { name: "@myrmidon/shared", version: "1.2.3" });
  assert.deepEqual(collectInternalDependencyProblems(manifest, docs, manifests), []);
});

test("missing target manifest is a retriable registry problem", () => {
  const packageDoc = { "dist-tags": { beta: "1.2.3-beta.1", latest: "1.2.2" }, versions: {} };
  assert.deepEqual(verifyPackageRegistryProblems({
    packageName: "@myrmidon/ui", packageDoc, packageDocsByName: new Map(),
    channel: "beta", distTag: "beta", targetVersion: "1.2.3-beta.1", allowCanaryLatest: false,
  }), [{ message: "@myrmidon/ui: npm registry is missing manifest data for 1.2.3-beta.1", retriable: true }]);
});

for (const channel of ["canary", "nightly", "beta"]) {
  test(`${channel} accepts stable latest and rejects prerelease latest`, () => {
    const version = `1.2.3-${channel}.1`;
    const packageDoc = { "dist-tags": { [channel]: version, latest: "1.2.2" }, versions: { [version]: {} } };
    const options = {
      packageName: "@myrmidon/ui", packageDoc, packageDocsByName: new Map(),
      channel, distTag: channel, targetVersion: version, allowCanaryLatest: false,
    };
    assert.deepEqual(verifyPackageRegistryProblems(options), []);
    packageDoc["dist-tags"].latest = version;
    assert.deepEqual(verifyPackageRegistryProblems(options), [{
      message: `@myrmidon/ui: latest dist-tag still resolves to prerelease ${version}; if that state is intentional, rerun the verification script directly with --allow-canary-latest`,
      retriable: false,
    }]);
  });
}
