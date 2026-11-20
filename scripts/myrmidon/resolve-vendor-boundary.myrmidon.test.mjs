import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { collectFailures, walkJsFiles } from "./check-prod-runtime-resolution.mjs";

const cli = fileURLToPath(new URL("./check-prod-runtime-resolution.mjs", import.meta.url));
const sources = {
  "vendor/paperclip-runner/index.js": 'import "./vendor.ts";\n',
  "vendor/paperclip-runner/deep/nested.js": 'import "./deep.ts";\n',
  "vendor/paperclip-runner-extra/index.js": 'import "./extra.ts";\n',
  "other/paperclip-runner/index.js": 'import "./other.ts";\n',
  "index.js": "export {};\n",
};

function withFixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const dist = mkdtempSync(path.join(scratch, "vendor-boundary-"));
  try {
    for (const [name, body] of Object.entries(sources)) {
      const file = path.join(dist, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    run(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

it("walks only outside the exact vendor runner subtree when skipping", () => {
  withFixture((dist) => {
    const names = (skip) => walkJsFiles(dist, skip).map((file) => path.relative(dist, file)).sort();
    assert.deepEqual(names(false), [
      "index.js", "other/paperclip-runner/index.js", "vendor/paperclip-runner-extra/index.js",
      "vendor/paperclip-runner/deep/nested.js", "vendor/paperclip-runner/index.js",
    ]);
    assert.deepEqual(names(true), [
      "index.js", "other/paperclip-runner/index.js", "vendor/paperclip-runner-extra/index.js",
    ]);
  });
});

it("reports each bad import and excludes only vendor failures when skipping", () => {
  withFixture((dist) => {
    const failures = (skip) => collectFailures(dist, { skipVendorRunner: skip })
      .map(({ file, specifier }) => [path.relative(dist, file), specifier]);
    assert.deepEqual(failures(false), [
      ["other/paperclip-runner/index.js", "./other.ts"],
      ["vendor/paperclip-runner-extra/index.js", "./extra.ts"],
      ["vendor/paperclip-runner/deep/nested.js", "./deep.ts"],
      ["vendor/paperclip-runner/index.js", "./vendor.ts"],
    ]);
    assert.deepEqual(failures(true), [
      ["other/paperclip-runner/index.js", "./other.ts"],
      ["vendor/paperclip-runner-extra/index.js", "./extra.ts"],
    ]);
  });
});

it("CLI keeps sibling failures with the skip flag", () => {
  withFixture((dist) => {
    const result = spawnSync(process.execPath, [cli, "--dist", dist, "--skip-vendor-runner"], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\.\/extra\.ts/);
    assert.match(result.stderr, /\.\/other\.ts/);
    assert.doesNotMatch(result.stderr, /\.\/vendor\.ts|\.\/deep\.ts/);
  });
});

it("CLI succeeds when the only failures are inside vendor runner", () => {
  withFixture((dist) => {
    rmSync(path.join(dist, "vendor", "paperclip-runner-extra"), { recursive: true });
    rmSync(path.join(dist, "other"), { recursive: true });
    const withoutSkip = spawnSync(process.execPath, [cli, "--dist", dist], { encoding: "utf8" });
    const withSkip = spawnSync(process.execPath, [cli, "--dist", dist, "--skip-vendor-runner"], { encoding: "utf8" });
    assert.equal(withoutSkip.status, 1, withoutSkip.stderr);
    assert.match(withoutSkip.stderr, /\.\/vendor\.ts/);
    assert.match(withoutSkip.stderr, /\.\/deep\.ts/);
    assert.equal(withSkip.status, 0, withSkip.stderr);
  });
});
