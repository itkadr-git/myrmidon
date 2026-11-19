import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { collectFailures, resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

const specifier = "@myrmidon/fixture";

function withFixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, ".myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "manifest-failures-"));
  try {
    const dist = path.join(root, "server", "dist");
    const importer = path.join(dist, "index.js");
    const pkgDir = path.join(root, "node_modules", "@myrmidon", "fixture");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(importer, '// fixture importer\nimport "@myrmidon/fixture";\n');
    run({ dist, importer, pkgDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertFailure(fixture, reason) {
  assert.deepEqual(resolveMyrmidonSpecifier(specifier, fixture.dist), {
    failure: reason,
    packageName: "@myrmidon/fixture",
  });
  assert.deepEqual(collectFailures(fixture.dist), [{
    file: fixture.importer,
    line: 2,
    specifier: "@myrmidon/fixture",
    reason,
    packageName: "@myrmidon/fixture",
  }]);
}

it("reports a missing package directory separately", () => {
  withFixture((fixture) => {
    assertFailure(fixture, "пакет не найден в node_modules");
  });
});

it("reports missing and invalid manifests, then resolves a repaired manifest in the same process", () => {
  withFixture((fixture) => {
    const target = path.join(fixture.pkgDir, "dist", "index.js");
    const manifest = path.join(fixture.pkgDir, "package.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export const value = 1;\n");

    assertFailure(fixture, "package.json не читается");
    fs.writeFileSync(manifest, '{ "name": ');
    assertFailure(fixture, "package.json не читается");

    fs.writeFileSync(manifest, JSON.stringify({ name: "@myrmidon/fixture", exports: "./dist/index.js" }));
    assert.deepEqual(resolveMyrmidonSpecifier(specifier, fixture.dist), {
      pkgDir: fixture.pkgDir,
      packageName: "@myrmidon/fixture",
      follow: fs.realpathSync(target),
    });
    assert.deepEqual(collectFailures(fixture.dist), []);
  });
});
