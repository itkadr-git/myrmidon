import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const source = join(dirname(fileURLToPath(import.meta.url)), "generate-ui-package-json.mjs");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test");

function withFixture(manifest, check) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "ui-publish-failstop-"));
  try {
    const scripts = join(root, "scripts");
    const ui = join(root, "ui");
    const decoy = join(root, "decoy");
    mkdirSync(scripts);
    mkdirSync(ui);
    mkdirSync(decoy);
    const script = join(scripts, "generate-ui-package-json.mjs");
    const path = join(ui, "package.json");
    const sentinel = join(ui, "sentinel.txt");
    const sentinelBytes = Buffer.from("unchanged sentinel\n");
    copyFileSync(source, script);
    writeFileSync(sentinel, sentinelBytes);
    if (manifest !== undefined) writeFileSync(path, manifest);
    const result = spawnSync(process.execPath, [script], { cwd: decoy, encoding: "utf8" });
    assert.ifError(result.error);
    assert.deepEqual(readFileSync(sentinel), sentinelBytes);
    check({ result, path });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("UI publish generator fail-stop contract", () => {
  for (const [name, input] of [["missing", undefined], ["malformed", Buffer.from('{"name":\n')], ["null", Buffer.from("null\n")]]) {
    it(`fails without publishing when the manifest is ${name}`, () => {
      withFixture(input, ({ result, path }) => {
        assert.notEqual(result.status, 0);
        assert.notEqual(result.status, null);
        assert.notEqual(result.stderr.trim(), "");
        assert.doesNotMatch(result.stdout + result.stderr, /Generated publishable UI package\.json/);
        if (input === undefined) assert.equal(existsSync(path), false);
        else assert.deepEqual(readFileSync(path), input);
      });
    });
  }

  it("publishes a nonempty manifest from a valid fixture", () => {
    withFixture(Buffer.from('{"name":"fixture-ui","version":"1.2.3","private":true}\n'), ({ result, path }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Generated publishable UI package\.json/);
      const output = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(output.name, "fixture-ui");
      assert.equal(output.version, "1.2.3");
      assert.deepEqual(output.files, ["dist"]);
      assert.deepEqual(output.publishConfig, { access: "public" });
      assert.equal(Object.hasOwn(output, "private"), false);
    });
  });
});
