import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveExport } from "./select.mjs";

const pkg = (exports) => ({ name: "fixture", dir: "packages/fixture", exports });

describe("resolveExport conditions and patterns", () => {
  it("resolves a string root", () => {
    assert.equal(resolveExport(pkg("./src/index.js"), "."), "packages/fixture/src/index.js");
  });

  it("does not resolve a subpath from a string root", () => {
    assert.equal(resolveExport(pkg("./src/index.js"), "./other"), null);
  });

  it("prefers import over all other conditions regardless of key order", () => {
    assert.equal(resolveExport(pkg({ require: "./require.js", types: "./types.d.ts", default: "./default.js", import: "./import.js" }), "."), "packages/fixture/import.js");
  });

  it("prefers default over types and require", () => {
    assert.equal(resolveExport(pkg({ require: "./require.js", types: "./types.d.ts", default: "./default.js" }), "."), "packages/fixture/default.js");
  });

  it("prefers types over require", () => {
    assert.equal(resolveExport(pkg({ require: "./require.js", types: "./types.d.ts" }), "."), "packages/fixture/types.d.ts");
  });

  it("uses require when it is the only supported condition", () => {
    assert.equal(resolveExport(pkg({ require: "./require.js" }), "."), "packages/fixture/require.js");
  });

  it("resolves nested conditions before trying an outer fallback", () => {
    assert.equal(resolveExport(pkg({ default: "./fallback.js", import: { require: "./nested.js", types: "./nested.d.ts" } }), "."), "packages/fixture/nested.d.ts");
  });

  it("falls back when a nested condition has no supported target", () => {
    assert.equal(resolveExport(pkg({ import: { browser: "./browser.js" }, default: "./fallback.js" }), "."), "packages/fixture/fallback.js");
  });

  it("skips null and unsupported array entries before a valid target", () => {
    assert.equal(resolveExport(pkg([null, 42, { browser: "./browser.js" }, "./src/valid.js"]), "."), "packages/fixture/src/valid.js");
  });

  it("returns null for an empty array", () => {
    assert.equal(resolveExport(pkg([]), "."), null);
  });

  it("does not resolve a subpath from a conditional root", () => {
    assert.equal(resolveExport(pkg({ import: "./src/index.js" }), "./feature"), null);
  });

  it("prefers an exact subpath over a matching wildcard", () => {
    assert.equal(resolveExport(pkg({ "./*": "./src/*.js", "./feature": "./special.js" }), "./feature"), "packages/fixture/special.js");
  });

  it("selects the longest matching wildcard prefix", () => {
    assert.equal(resolveExport(pkg({ "./*": "./general/*.js", "./deep/*": "./specific/*.js" }), "./deep/item"), "packages/fixture/specific/item.js");
  });

  it("matches a wildcard with a suffix", () => {
    assert.equal(resolveExport(pkg({ "./features/*.js": "./src/*.mjs" }), "./features/item.js"), "packages/fixture/src/item.mjs");
  });

  it("rejects a wildcard when the suffix does not match", () => {
    assert.equal(resolveExport(pkg({ "./features/*.js": "./src/*.mjs" }), "./features/item.css"), null);
  });

  it("replaces every wildcard in the selected target", () => {
    assert.equal(resolveExport(pkg({ "./feature/*": "./src/*/generated/*.js" }), "./feature/widget"), "packages/fixture/src/widget/generated/widget.js");
  });

  it("returns null for an unknown subpath", () => {
    assert.equal(resolveExport(pkg({ "./known": "./known.js" }), "./unknown"), null);
  });

  it("returns null for missing exports", () => {
    assert.equal(resolveExport({ name: "fixture", dir: "packages/fixture" }, "."), null);
  });

  it("returns null for unknown conditions", () => {
    assert.equal(resolveExport(pkg({ browser: "./browser.js" }), "."), null);
  });
});
