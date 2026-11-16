import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("./generate-ui-package-json.mjs", import.meta.url));
const fields = ["name", "version", "description", "license", "homepage", "bugs", "repository", "type"];

function generate(input) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "ui-publish-metadata-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "ui"));
    mkdirSync(join(root, "decoy"));
    const script = join(root, "scripts", "generate-ui-package-json.mjs");
    const manifest = join(root, "ui", "package.json");
    cpSync(generator, script);
    writeFileSync(manifest, JSON.stringify(input));
    const result = spawnSync(process.execPath, [script], { cwd: join(root, "decoy"), encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /Generated publishable UI package\.json/);
    assert.equal(result.stderr, "");
    const bytes = readFileSync(manifest);
    assert.ok(bytes.length > 0, "generated manifest must not be empty");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("UI publish metadata", () => {
  it("preserves all metadata including nested bugs and repository", () => {
    const input = {
      name: "@example/ui",
      version: "1.2.3-beta.4",
      description: "UI package fixture",
      license: "MIT",
      homepage: "https://example.test/ui",
      bugs: { url: "https://example.test/issues", email: "bugs@example.test" },
      repository: { type: "git", url: "https://example.test/repo.git", directory: "ui" },
      type: "module",
    };
    const output = generate(input);
    for (const field of fields) assert.deepEqual(output[field], input[field], field);
  });

  it("does not create absent optional metadata", () => {
    const output = generate({ name: "ui", version: "2.0.0" });
    assert.equal(output.name, "ui");
    assert.equal(output.version, "2.0.0");
    for (const field of fields.slice(2)) assert.equal(Object.hasOwn(output, field), false, field);
  });

  it("preserves empty strings instead of dropping or replacing them", () => {
    const input = Object.fromEntries(fields.map((field) => [field, ""]));
    const output = generate(input);
    for (const field of fields) {
      assert.equal(Object.hasOwn(output, field), true, field);
      assert.equal(output[field], "", field);
    }
  });
});
