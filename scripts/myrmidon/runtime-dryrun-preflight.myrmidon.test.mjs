import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

test("dry-run preflights all dependencies without changing the workspace", () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "runtime-preflight-"));
  try {
    const write = (relative, text) => {
      const file = join(root, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    const manifest = (name, extra = {}) => JSON.stringify({
      name, version: "1.0.0", exports: { ".": "./src/index.ts" },
      publishConfig: { exports: { ".": "./dist/index.js" } }, ...extra,
    }, null, 2) + "\n";
    write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write("packages/entry/package.json", manifest("@test/entry", {
      dependencies: { "@test/alpha": "workspace:*", "@test/beta": "workspace:*" },
    }));
    write("packages/alpha/package.json", manifest("@test/alpha"));
    write("packages/beta/package.json", manifest("@test/beta"));
    write("node_modules/.cache/myrmidon-prod-exports/backup.json", '{"version":1,"packages":{}}\n');

    const snapshot = (dir = root) => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = join(dir, entry.name);
      return entry.isDirectory() ? [[file, "directory"], ...Object.entries(snapshot(file))] : [[file, readFileSync(file, "utf8")]];
    }));
    const run = () => {
      const stdout = [];
      const stderr = [];
      const code = main(["apply", "--entry", "@test/entry", "--root", root, "--dry-run"], {
        log: (line) => stdout.push(line), error: (line) => stderr.push(line),
      });
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    };

    let before = snapshot();
    let result = run();
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no dist: @test\/alpha \(packages\/alpha\)/);
    assert.match(result.stderr, /no dist: @test\/beta \(packages\/beta\)/);
    assert.deepEqual(snapshot(), before);

    mkdirSync(join(root, "packages/alpha/dist"));
    before = snapshot();
    result = run();
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /no dist: @test\/alpha/);
    assert.match(result.stderr, /no dist: @test\/beta \(packages\/beta\)/);
    assert.deepEqual(snapshot(), before);

    mkdirSync(join(root, "packages/beta/dist"));
    before = snapshot();
    result = run();
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /@test\/alpha\s+exports\s+dist: yes/);
    assert.match(result.stdout, /@test\/beta\s+exports\s+dist: yes/);
    assert.match(result.stdout, /skipped \(entry package\): @test\/entry/);
    assert.deepEqual(snapshot(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
