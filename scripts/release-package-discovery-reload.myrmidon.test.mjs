import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-test-scratch");
const originalModule = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));

function snapshot(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = join(prefix, entry.name);
    return entry.isDirectory() ? snapshot(join(dir, entry.name), name) : [[name, readFileSync(join(dir, entry.name), "utf8")]];
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("discovery reloads added, removed and private packages and recovers from invalid JSON", async () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "release-discovery-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "cli"));
    mkdirSync(join(root, "packages"));
    copyFileSync(originalModule, join(root, "scripts/release-package-map.mjs"));
    writeJson(join(root, "scripts/release-package-manifest.json"), [{ dir: "cli", name: "myrmidon", publishFromCi: true }]);
    writeJson(join(root, "cli/package.json"), { name: "myrmidon", version: "1.2.3", bin: { myrmidon: "src/index.js" } });
    mkdirSync(join(root, "cli/src"));
    writeFileSync(join(root, "cli/src/index.js"), "#!/usr/bin/env node\n");
    const { discoverPublicPackages, getReleasePackages } = await import(pathToFileURL(join(root, "scripts/release-package-map.mjs")).href);
    assert.deepEqual(getReleasePackages().map(({ dir, name, version }) => ({ dir, name, version })), [
      { dir: "cli", name: "myrmidon", version: "1.2.3" },
    ]);
    const expectedBase = [{ dir: "cli", name: "myrmidon", version: "1.2.3" }];
    const expectedAdded = [
      { dir: "packages/added", name: "@myrmidon/added", version: "2.3.4" },
      { dir: "cli", name: "myrmidon", version: "1.2.3" },
    ];
    const project = (items) => items.map(({ dir, name, version }) => ({ dir, name, version }));
    const readOnlyDiscover = () => {
      const before = snapshot(root);
      const result = discoverPublicPackages();
      assert.deepEqual(snapshot(root), before, "discovery must not write fixture files");
      return result;
    };
    const base = readOnlyDiscover();
    const baseCopy = structuredClone(base);
    assert.deepEqual(project(base), expectedBase);

    const addedDir = join(root, "packages/added");
    mkdirSync(addedDir);
    writeJson(join(addedDir, "package.json"), { name: "@myrmidon/added", version: "2.3.4" });
    const added = readOnlyDiscover();
    const addedCopy = structuredClone(added);
    assert.deepEqual(project(added), expectedAdded);
    assert.deepEqual(base, baseCopy);

    rmSync(addedDir, { recursive: true });
    assert.deepEqual(project(readOnlyDiscover()), expectedBase);
    mkdirSync(addedDir);
    writeJson(join(addedDir, "package.json"), { name: "@myrmidon/added", version: "2.3.4", private: true });
    assert.deepEqual(project(readOnlyDiscover()), expectedBase);

    writeFileSync(join(addedDir, "package.json"), "{invalid json");
    const beforeFailure = snapshot(root);
    assert.throws(() => discoverPublicPackages(), SyntaxError);
    assert.deepEqual(snapshot(root), beforeFailure);
    writeJson(join(addedDir, "package.json"), { name: "@myrmidon/added", version: "2.3.4" });
    assert.deepEqual(project(readOnlyDiscover()), expectedAdded);
    assert.deepEqual(base, baseCopy);
    assert.deepEqual(added, addedCopy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
