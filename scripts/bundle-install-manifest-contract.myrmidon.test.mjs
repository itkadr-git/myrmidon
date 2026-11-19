import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBundledInstallManifest } from "./prepare-bundled-package.mjs";

describe("createBundledInstallManifest", () => {
  it("intersects each production section with the allowlist and removes dev dependencies", () => {
    const manifest = {
      name: "fixture",
      dependencies: { shared: "^1", ordinary: "2", excluded: "3" },
      optionalDependencies: { shared: "^4", optional: "5", excluded: "6" },
      peerDependencies: { shared: "^7", peer: "8", excluded: "9" },
      devDependencies: { shared: "10", dev: "11" },
    };
    assert.deepEqual(createBundledInstallManifest(manifest, ["shared", "ordinary", "optional", "peer", "dev", "shared", "unknown"]), {
      name: "fixture",
      dependencies: { shared: "^1", ordinary: "2" },
      optionalDependencies: { shared: "^4", optional: "5" },
      peerDependencies: { shared: "^7", peer: "8" },
    });
  });

  it("removes empty and fully filtered sections without creating absent sections", () => {
    assert.deepEqual(createBundledInstallManifest({
      name: "fixture",
      dependencies: {},
      optionalDependencies: { excluded: "1" },
      peerDependencies: {},
      devDependencies: {},
    }, ["unknown", "unknown"]), { name: "fixture" });
    assert.deepEqual(createBundledInstallManifest({ name: "fixture", dependencies: { a: "1" } }, []), { name: "fixture" });
  });

  it("preserves unrelated fields and isolates nested output from the input", () => {
    const manifest = {
      name: "fixture",
      version: "1.0.0",
      exports: { ".": { import: "./index.js" } },
      keywords: ["one", "two"],
      custom: { nested: [{ enabled: true }] },
      dependencies: { kept: "1", dropped: "2" },
      devDependencies: { test: "3" },
    };
    const before = structuredClone(manifest);
    const result = createBundledInstallManifest(manifest, ["kept"]);
    assert.deepEqual(result, {
      name: "fixture",
      version: "1.0.0",
      exports: { ".": { import: "./index.js" } },
      keywords: ["one", "two"],
      custom: { nested: [{ enabled: true }] },
      dependencies: { kept: "1" },
    });
    result.exports["."].import = "./changed.js";
    result.keywords.push("changed");
    result.custom.nested[0].enabled = false;
    result.dependencies.kept = "changed";
    assert.deepEqual(manifest, before);
  });
});
