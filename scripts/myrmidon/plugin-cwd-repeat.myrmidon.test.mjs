import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const generator = fileURLToPath(new URL("../generate-plugin-package-json.mjs", import.meta.url));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

test("plugin generation is isolated by cwd and repeatable", () => {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "plugin cwd "));
  try {
    const script = join(root, "scripts", "generate-plugin-package-json.mjs");
    const sdk = join(root, "packages", "plugins", "sdk", "package.json");
    const a = join(root, "plugin A", "package.json");
    const b = join(root, "plugin B", "package.json");
    const rootManifest = join(root, "package.json");
    for (const path of [script, sdk, a, b]) mkdirSync(dirname(path), { recursive: true });
    copyFileSync(generator, script);
    const sdkBytes = json({ name: "@myrmidon/plugin-sdk", version: "4.2.0" });
    const rootBytes = '{"name":"fixture-root"}\n';
    const inputA = json({ name: "plugin-a", version: "1.0.0", exports: "./src/a.js", publishConfig: { exports: "./dist/a.js" }, dependencies: { "@myrmidon/plugin-sdk": "workspace:*", alpha: "^1.0.0" }, devDependencies: { ignored: "1.0.0" } });
    const inputB = json({ name: "plugin-b", version: "2.0.0", exports: "./src/b.js", publishConfig: { exports: "./dist/b.js" }, dependencies: { beta: "~2.0.0", "@myrmidon/plugin-sdk": "workspace:^" }, devDependencies: { ignored: "2.0.0" } });
    const expectedA = json({ name: "plugin-a", version: "1.0.0", exports: "./dist/a.js", publishConfig: { exports: "./dist/a.js" }, dependencies: { "@myrmidon/plugin-sdk": "4.2.0", alpha: "^1.0.0" } });
    const expectedB = json({ name: "plugin-b", version: "2.0.0", exports: "./dist/b.js", publishConfig: { exports: "./dist/b.js" }, dependencies: { beta: "~2.0.0", "@myrmidon/plugin-sdk": "4.2.0" } });
    for (const [path, bytes] of [[sdk, sdkBytes], [rootManifest, rootBytes], [a, inputA], [b, inputB]]) writeFileSync(path, bytes);
    const read = (path) => readFileSync(path, "utf8");
    const run = (path) => execFileSync(process.execPath, [script], { cwd: dirname(path), encoding: "utf8" });
    const unchanged = () => {
      assert.equal(read(sdk), sdkBytes);
      assert.equal(read(rootManifest), rootBytes);
    };

    assert.match(run(a), /Generated publishable plugin package\.json for plugin-a/);
    assert.equal(read(a), expectedA);
    assert.equal(read(b), inputB);
    unchanged();
    assert.match(run(b), /Generated publishable plugin package\.json for plugin-b/);
    assert.equal(read(a), expectedA);
    assert.equal(read(b), expectedB);
    unchanged();
    run(a);
    assert.equal(read(a), expectedA);
    assert.equal(read(b), expectedB);
    unchanged();
    run(b);
    assert.equal(read(a), expectedA);
    assert.equal(read(b), expectedB);
    unchanged();

    // Mutate only the fixture copy to prove the isolation check detects a wrong cwd.
    const original = read(script);
    const fixedCwd = original.replace("const packageDir = process.cwd();", `const packageDir = ${JSON.stringify(dirname(b))};`);
    assert.notEqual(fixedCwd, original);
    writeFileSync(script, fixedCwd);
    writeFileSync(a, inputA);
    run(a);
    assert.throws(() => assert.equal(read(a), expectedA), assert.AssertionError);
    assert.equal(read(b), expectedB);
    unchanged();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
