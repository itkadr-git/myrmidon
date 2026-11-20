import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const timeout = 10_000;

function snapshot(root, dir = "") {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? snapshot(root, path) : [[path, readFileSync(join(root, path))]];
  }).sort(([a], [b]) => a.localeCompare(b));
}

function fixture(enabled, disabled, run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = realpathSync(mkdtempSync(join(scratch, "myrmidon-check-counts-")));
  try {
    const put = (path, data) => {
      const dest = join(root, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    };
    const entries = Array.from({ length: enabled + disabled }, (_, index) => ({
      dir: `packages/pkg-${index}`,
      name: `@fixture/pkg-${index}`,
      publishFromCi: index < enabled,
    }));
    put("scripts/release-package-manifest.json", `${JSON.stringify(entries, null, 2)}\n`);
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    for (const { dir, name } of entries) {
      put(`${dir}/package.json`, `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`);
    }
    const before = snapshot(root);
    try {
      run(root);
    } finally {
      assert.deepEqual(snapshot(root), before, "fixture files must remain unchanged");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [enabled, disabled] of [[1, 0], [1, 2], [3, 1]]) {
  test(`check reports ${enabled} enabled and ${disabled} disabled packages`, () => {
    fixture(enabled, disabled, (root) => {
      const result = spawnSync(process.execPath, [join(root, "scripts/release-package-map.mjs"), "check"], { encoding: "utf8", timeout });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `Release package manifest OK: ${enabled} enabled for CI publish, ${disabled} disabled pending bootstrap.\n`);
    });
  });
}

test("check rejects a valid manifest with no enabled packages", () => {
  fixture(0, 2, (root) => {
    const result = spawnSync(process.execPath, [join(root, "scripts/release-package-map.mjs"), "check"], { encoding: "utf8", timeout });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no packages are enabled for CI publishing/);
  });
});

test("importing the module does not run the CLI or print usage", () => {
  fixture(1, 0, (root) => {
    const moduleUrl = pathToFileURL(join(root, "scripts/release-package-map.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(moduleUrl)};`], { encoding: "utf8", timeout });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
