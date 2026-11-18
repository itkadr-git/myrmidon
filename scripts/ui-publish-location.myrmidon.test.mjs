import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const generator = join(dirname(fileURLToPath(import.meta.url)), "generate-ui-package-json.mjs");

describe("UI publish generator location", () => {
  it("uses the script location rather than cwd or argv, and writes stable formatted bytes", () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test-scratch");
    mkdirSync(scratch, { recursive: true });
    const fixture = mkdtempSync(join(scratch, "ui publish location "));
    try {
      const root = join(fixture, "actual repo");
      const decoyRoot = join(fixture, "unrelated cwd");
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "ui"), { recursive: true });
      mkdirSync(join(decoyRoot, "ui"), { recursive: true });
      const script = join(root, "scripts", "generate-ui-package-json.mjs");
      const manifestPath = join(root, "ui", "package.json");
      const decoyPath = join(decoyRoot, "ui", "package.json");
      cpSync(generator, script);
      const input = { name: "actual-ui", version: "1.2.3", private: true };
      const initial = JSON.stringify(input);
      const decoy = '{ "name": "decoy", "version": "9.9.9", "private": true }\n';
      writeFileSync(manifestPath, initial);
      writeFileSync(decoyPath, decoy);

      const run = () => spawnSync(process.execPath, [script, decoyRoot], { cwd: decoyRoot, encoding: "utf8" });
      const first = run();
      assert.ifError(first.error);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stderr, "");
      assert.equal(first.stdout, "  ✓ Generated publishable UI package.json\n");
      const bytes = readFileSync(manifestPath, "utf8");
      assert.notEqual(bytes, initial);
      assert.deepEqual(JSON.parse(bytes), { name: "actual-ui", version: "1.2.3", files: ["dist"], publishConfig: { access: "public" } });
      assert.equal(bytes, `${JSON.stringify(JSON.parse(bytes), null, 2)}\n`);
      assert.equal(readFileSync(decoyPath, "utf8"), decoy);

      const second = run();
      assert.ifError(second.error);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stderr, "");
      assert.equal(second.stdout, first.stdout);
      assert.equal(readFileSync(manifestPath, "utf8"), bytes);
      assert.equal(readFileSync(decoyPath, "utf8"), decoy);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
