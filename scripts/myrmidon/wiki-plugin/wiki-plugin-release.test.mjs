import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Static contract test for the LLM Wiki plugin release wiring.
// The cheap CI "checks" tier runs `node --test scripts/myrmidon/**/*.test.mjs`
// without installing workspace dependencies, so this file must never invoke
// pnpm build/test or any network/dependency-heavy step. It verifies the
// plugin's build wiring and packaging contract from files alone; the actual
// build runs in the typecheck/build jobs and the plugin compatibility checks.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "packages", "plugins", "plugin-llm-wiki");
const INSTALL_GUIDE = path.join(REPO_ROOT, "docs", "wiki-plugin-install-guide.md");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readText = (file) => fs.readFileSync(file, "utf8");

describe("plugin-llm-wiki release wiring", () => {
  it("declares the esbuild build script and the SDK dependency the release build needs", () => {
    const pkg = readJson(path.join(PLUGIN_DIR, "package.json"));
    assert.equal(pkg.name, "@paperclipai/plugin-llm-wiki");
    assert.ok(pkg.version, "plugin must carry a version for release artifacts");
    assert.match(pkg.scripts.build, /esbuild\.config\.mjs/, "build must run the esbuild config");
    assert.equal(
      pkg.devDependencies?.["@paperclipai/plugin-sdk"],
      "workspace:*",
      "SDK must come from the repository workspace so releases build from fork sources",
    );
    assert.ok(pkg.scripts.prebuild?.includes("ensure-build-deps"), "prebuild must bootstrap SDK build deps");
  });

  it("declares the paperclipPlugin entry points the loader expects from the built artifact", () => {
    const pkg = readJson(path.join(PLUGIN_DIR, "package.json"));
    const entries = pkg.paperclipPlugin ?? {};
    assert.equal(entries.manifest, "./dist/manifest.js");
    assert.equal(entries.worker, "./dist/worker.js");
    assert.equal(entries.ui, "./dist/ui/");
    assert.deepEqual(
      (pkg.files ?? []).filter((f) => f !== "README.md").sort(),
      ["agents", "dist", "migrations", "skills", "templates"].sort(),
      "packaged files must cover the entry points plus runtime assets",
    );
  });

  it("has the esbuild config that produces the declared entry points", () => {
    const esbuildConfig = readText(path.join(PLUGIN_DIR, "esbuild.config.mjs"));
    assert.match(esbuildConfig, /manifest/, "esbuild config must build the manifest entry");
    assert.match(esbuildConfig, /worker/, "esbuild config must build the worker entry");
    assert.match(esbuildConfig, /ui/, "esbuild config must build the UI bundle");
  });

  it("ships the install/upgrade guide referenced by the release runbook", () => {
    const guide = readText(INSTALL_GUIDE);
    assert.match(guide, /plugin-llm-wiki/, "guide must name the plugin package");
    assert.match(guide, /## (Install|Installation)/i, "guide must have an installation section");
    assert.match(guide, /## (Upgrade|Update)/i, "guide must have an upgrade section");
  });
});
