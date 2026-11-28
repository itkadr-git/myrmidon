import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "release-package-map.mjs");

test("release plan rejects a name mismatch and recovers without reimport", async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "release-rename-"));
  try {
    for (const dir of ["scripts", "packages/widget", "cli"]) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    const pkgPath = join(root, "packages/widget/package.json");
    const cliPath = join(root, "cli/package.json");
    const manifestPath = join(root, "scripts/release-package-manifest.json");
    const original = {
      name: "@myrmidon/widget",
      version: "1.0.0",
      dependencies: { zod: "^3.0.0" },
      optionalDependencies: { "@myrmidon/optional": "workspace:*" },
      peerDependencies: { react: "^18.0.0" },
      devDependencies: { vitest: "^4.0.0" },
    };
    const renamed = { ...original, name: "@myrmidon/renamed" };
    const manifest = (name) => [
      { dir: "packages/widget", name, publishFromCi: false },
      { dir: "cli", name: "myrmidon", publishFromCi: true },
    ];
    const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    writeJson(pkgPath, original);
    writeJson(cliPath, { name: "myrmidon", version: "1.0.0" });
    writeJson(manifestPath, manifest(original.name));
    const { buildReleasePackagePlan, getReleasePackages } = await import(pathToFileURL(join(root, "scripts/release-package-map.mjs")).href);
    const files = [pkgPath, cliPath, manifestPath];
    const readOnly = (fn) => {
      const before = files.map((path) => readFileSync(path, "utf8"));
      try { return fn(); } finally {
        assert.deepEqual(files.map((path) => readFileSync(path, "utf8")), before);
      }
    };
    const project = (plan) => plan.map(({ dir, name, publishFromCi }) => ({ dir, name, publishFromCi })).sort((a, b) => a.dir.localeCompare(b.dir));
    const expectedOriginal = [
      { dir: "cli", name: "myrmidon", publishFromCi: true },
      { dir: "packages/widget", name: "@myrmidon/widget", publishFromCi: false },
    ];
    const expectedRenamed = [
      { dir: "cli", name: "myrmidon", publishFromCi: true },
      { dir: "packages/widget", name: "@myrmidon/renamed", publishFromCi: false },
    ];
    const first = readOnly(() => buildReleasePackagePlan());
    const firstSnapshot = structuredClone(first);
    assert.deepEqual(project(first), expectedOriginal);
    assert.deepEqual(project(readOnly(() => getReleasePackages())), [expectedOriginal[0]]);

    writeJson(pkgPath, renamed);
    assert.throws(() => readOnly(() => buildReleasePackagePlan()), /packages\/widget is listed as @myrmidon\/widget .*package\.json declares @myrmidon\/renamed/);
    assert.throws(() => readOnly(() => getReleasePackages()), /package\.json declares @myrmidon\/renamed/);
    assert.deepEqual(first, firstSnapshot);

    writeJson(manifestPath, manifest(renamed.name));
    assert.deepEqual(project(readOnly(() => buildReleasePackagePlan())), expectedRenamed);
    assert.deepEqual(project(readOnly(() => getReleasePackages())), [expectedRenamed[0]]);
    assert.deepEqual(first, firstSnapshot);

    writeJson(pkgPath, original);
    writeJson(manifestPath, manifest(original.name));
    assert.deepEqual(project(readOnly(() => buildReleasePackagePlan())), expectedOriginal);
    assert.deepEqual(project(readOnly(() => getReleasePackages())), [expectedOriginal[0]]);
    assert.deepEqual(first, firstSnapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
