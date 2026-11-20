import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "release-package-map.mjs");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-test-scratch");

function snapshot(dir, root = dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path, root)) : [[path.slice(root.length + 1), readFileSync(path, "utf8")]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

test("reloads the publication graph and recovers after a cycle in one module instance", async () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(resolve(scratch), "release-order-"));
  try {
    for (const dir of ["scripts", "packages/a", "packages/b", "cli"]) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    const writeJson = (path, data) => writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`);
    const writePackage = (dir, name, dependencies = {}) => writeJson(`${dir}/package.json`, { name, version: "1.0.0", dependencies });
    writeJson("scripts/release-package-manifest.json", [
      { dir: "packages/a", name: "@myrmidon/a", publishFromCi: true },
      { dir: "packages/b", name: "@myrmidon/b", publishFromCi: true },
      { dir: "cli", name: "myrmidon", publishFromCi: true },
    ]);
    writePackage("cli", "myrmidon");
    writePackage("packages/a", "@myrmidon/a", { "@myrmidon/b": "workspace:*" });
    writePackage("packages/b", "@myrmidon/b");
    const { getReleasePackages } = await import(pathToFileURL(join(root, "scripts/release-package-map.mjs")).href);
    const read = () => {
      const before = snapshot(root);
      try { return getReleasePackages(); } finally { assert.deepEqual(snapshot(root), before, "reading must not write fixture files"); }
    };
    const first = read();
    assert.deepEqual(first.map((pkg) => pkg.name), ["@myrmidon/b", "@myrmidon/a", "myrmidon"]);
    const firstCopy = structuredClone(first);

    writePackage("packages/a", "@myrmidon/a");
    writePackage("packages/b", "@myrmidon/b", { "@myrmidon/a": "workspace:*" });
    const second = read();
    assert.deepEqual(second.map((pkg) => pkg.name), ["@myrmidon/a", "@myrmidon/b", "myrmidon"]);
    const secondCopy = structuredClone(second);
    assert.deepEqual(first, firstCopy);

    writePackage("packages/a", "@myrmidon/a", { "@myrmidon/b": "workspace:*" });
    assert.throws(read, /cycle detected in release package graph/);
    assert.deepEqual(first, firstCopy);
    assert.deepEqual(second, secondCopy);

    writePackage("packages/b", "@myrmidon/b");
    const recovered = read();
    assert.deepEqual(recovered.map((pkg) => pkg.name), ["@myrmidon/b", "@myrmidon/a", "myrmidon"]);
    assert.deepEqual(first, firstCopy);
    assert.deepEqual(second, secondCopy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
