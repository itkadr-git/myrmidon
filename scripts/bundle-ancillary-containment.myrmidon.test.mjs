import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const names = ["README.md", "LICENSE", "LICENSE.md"];
mkdirSync(scratch, { recursive: true });

function fixture(callback) {
  const root = mkdtempSync(join(scratch, "bundle-ancillary-"));
  const source = join(root, "source"), destination = join(root, "destination"), bin = join(root, "bin");
  const outside = join(root, "outside"), marker = join(root, "npm-called");
  try {
    for (const dir of [source, destination, bin, outside]) mkdirSync(dir);
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", files: [], bundleDependencies: ["fixture-dependency"] }));
    writeFileSync(join(destination, "sentinel"), "destination sentinel\n");
    writeFileSync(join(outside, "file"), "outside sentinel\n");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o755 });
    const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", `import { prepareBundledPackage } from ${JSON.stringify(new URL("./prepare-bundled-package.mjs", import.meta.url).href)}; prepareBundledPackage(process.argv[1], process.argv[2], { sourceRoot: process.argv[3] });`, source, destination, root], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 30000 });
    callback({ source, destination, outside, marker, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const name of names) {
  for (const kind of ["external-file", "external-directory", "external-nested", "dangling"]) {
    test(`rejects ${name} ${kind} before staging or npm`, () => fixture((f) => {
      const target = kind === "external-directory" ? f.outside : kind === "dangling" ? join(f.outside, "missing") : join(f.outside, "file");
      if (kind === "external-nested") {
        symlinkSync(f.outside, join(f.source, "alias"));
        symlinkSync(join(f.source, "alias", "file"), join(f.source, name));
      } else symlinkSync(target, join(f.source, name));
      const result = f.run();
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(f.destination, "sentinel"), "utf8"), "destination sentinel\n");
      assert.equal(readFileSync(join(f.outside, "file"), "utf8"), "outside sentinel\n");
      assert.equal(existsSync(f.marker), false);
    }));
  }
}

test("copies all ordinary ancillary files", () => fixture((f) => {
  for (const name of names) writeFileSync(join(f.source, name), `content ${name}\n`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of names) assert.equal(readFileSync(join(f.destination, name), "utf8"), `content ${name}\n`);
  assert.equal(readFileSync(f.marker, "utf8"), "called");
}));

test("allows absent ancillary files", () => fixture((f) => {
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of names) assert.equal(existsSync(join(f.destination, name)), false);
  assert.equal(readFileSync(f.marker, "utf8"), "called");
}));

test("allows an internal ancillary symlink", () => fixture((f) => {
  writeFileSync(join(f.source, "inside"), "internal\n");
  symlinkSync(join(f.source, "inside"), join(f.source, "README.md"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.destination, "README.md"), "utf8"), "internal\n");
}));
