import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));

test("checkConfiguration reloads enrollment and recovers after no enabled packages", { concurrency: false }, async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "release-check-reload-"));
  try {
    const files = ["scripts/release-package-map.mjs", "scripts/release-package-manifest.json", "cli/package.json", "packages/alpha/package.json", "packages/beta/package.json"];
    for (const file of files) mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(source, join(root, files[0]));
    for (const [file, name] of [[files[2], "myrmidon"], [files[3], "@myrmidon/alpha"], [files[4], "@myrmidon/beta"]]) {
      writeFileSync(join(root, file), JSON.stringify({ name, version: "1.0.0" }));
    }
    const manifest = [
      { dir: "cli", name: "myrmidon", publishFromCi: true },
      { dir: "packages/alpha", name: "@myrmidon/alpha", publishFromCi: true },
      { dir: "packages/beta", name: "@myrmidon/beta", publishFromCi: true },
    ];
    const save = () => writeFileSync(join(root, files[1]), JSON.stringify(manifest));
    save();
    const { checkConfiguration, buildReleasePackagePlan } = await import(pathToFileURL(join(root, files[0])).href);
    const check = (expected, error = false) => {
      const before = files.map((file) => readFileSync(join(root, file)));
      let output = "";
      const original = process.stdout.write;
      try {
        process.stdout.write = (chunk) => { output += chunk; return true; };
        if (error) assert.throws(() => checkConfiguration(), /no packages are enabled for CI publishing/);
        else assert.equal(checkConfiguration(), undefined);
      } finally {
        process.stdout.write = original;
      }
      assert.equal(output, expected);
      assert.deepEqual(files.map((file) => readFileSync(join(root, file))), before);
    };
    const initial = buildReleasePackagePlan();
    const initialCopy = structuredClone(initial);
    check("Release package manifest OK: 3 enabled for CI publish, 0 disabled pending bootstrap.\n");
    manifest[1].publishFromCi = false;
    save();
    check("Release package manifest OK: 2 enabled for CI publish, 1 disabled pending bootstrap.\n");
    manifest[1].publishFromCi = true;
    save();
    check("Release package manifest OK: 3 enabled for CI publish, 0 disabled pending bootstrap.\n");
    for (const entry of manifest) entry.publishFromCi = false;
    save();
    check("", true);
    for (const entry of manifest) entry.publishFromCi = true;
    save();
    check("Release package manifest OK: 3 enabled for CI publish, 0 disabled pending bootstrap.\n");
    assert.deepEqual(initial, initialCopy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
