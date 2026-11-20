import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaces = [
  "cli", "packages/db", "packages/shared", "packages/adapter-utils",
  "packages/adapters/claude-local", "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway", "packages/adapters/hermes",
  "packages/adapters/opencode-local", "packages/adapters/openclaw-gateway",
];

function generate(versions, reverseKeys) {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "cli-precedence-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const file of ["generate-npm-package-json.mjs", "cli-bundled-npm-dependencies.mjs"]) {
      copyFileSync(join(repoRoot, "scripts", file), join(root, "scripts", file));
    }
    for (const [index, workspace] of workspaces.entries()) {
      const directory = join(root, workspace);
      mkdirSync(directory, { recursive: true });
      const entries = index < 3 ? [["conflict-example", versions[index]], ["independent-example", "^8.0.0"]] : [];
      if (reverseKeys) entries.reverse();
      writeFileSync(join(directory, "package.json"), JSON.stringify({
        name: `fixture-${index}`, version: "1.0.0", dependencies: Object.fromEntries(entries),
      }));
    }
    const embedded = join(root, "packages/db/node_modules/embedded-postgres");
    mkdirSync(join(embedded, "dist"), { recursive: true });
    writeFileSync(join(embedded, "package.json"), JSON.stringify({ name: "embedded-postgres", main: "dist/index.js" }));
    writeFileSync(join(embedded, "dist/index.js"), "");
    const result = spawnSync(process.execPath, [join(root, "scripts/generate-npm-package-json.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generated publishable package\.json/);
    const bytes = readFileSync(join(root, "cli/package.json"));
    assert.ok(bytes.length > 0);
    return JSON.parse(bytes.toString("utf8")).dependencies;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const { name, versions, expected } of [
  { name: "keeps the first caret against later carets", versions: ["^1.0.0", "^2.0.0", "^3.0.0"], expected: "^1.0.0" },
  { name: "replaces a caret with a later pin", versions: ["^1.0.0", "2.0.0", "^3.0.0"], expected: "2.0.0" },
  { name: "keeps a pin against later carets", versions: ["1.0.0", "^2.0.0", "^3.0.0"], expected: "1.0.0" },
  { name: "uses the last pin in workspace order", versions: ["1.0.0", "^2.0.0", "3.0.0"], expected: "3.0.0" },
]) {
  test(name, () => {
    const dependencies = { "conflict-example": expected, "independent-example": "^8.0.0" };
    assert.deepEqual(generate(versions, false), dependencies);
    assert.deepEqual(generate(versions, true), dependencies);
  });
}
