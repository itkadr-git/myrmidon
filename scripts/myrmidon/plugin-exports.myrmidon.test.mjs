import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const generator = resolve(dirname(fileURLToPath(import.meta.url)), "../generate-plugin-package-json.mjs");
const devMap = { ".": { types: "./src/index.d.ts", import: "./src/index.js" }, "./extra": "./src/extra.js" };
const publishedMap = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" },
  "./extra": { types: "./dist/extra.d.ts", import: "./dist/extra.js", require: "./dist/extra.cjs" },
};
const conditional = { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" };
const cases = [
  { name: "absent publish exports falls back to string", dev: "./src/index.js", publish: {}, expected: "./src/index.js" },
  { name: "absent publish exports falls back to subpath map", dev: devMap, publish: {}, expected: devMap },
  { name: "null publish exports falls back to string", dev: "./src/index.js", publish: { exports: null }, expected: "./src/index.js" },
  { name: "null publish exports falls back to subpath map", dev: devMap, publish: { exports: null }, expected: devMap },
  { name: "publish string overrides dev string", dev: "./src/index.js", publish: { exports: "./dist/index.js" }, expected: "./dist/index.js" },
  { name: "publish string overrides dev map", dev: devMap, publish: { exports: "./dist/index.js" }, expected: "./dist/index.js" },
  { name: "publish conditions override dev string", dev: "./src/index.js", publish: { exports: conditional }, expected: conditional },
  { name: "publish subpaths override dev map", dev: devMap, publish: { exports: publishedMap }, expected: publishedMap },
];

for (const entry of cases) {
  for (const withPublishEntryPoints of [false, true]) {
    test(`${entry.name}; publish main/types ${withPublishEntryPoints ? "present" : "absent"}`, () => {
      const base = join(homedir(), ".cache", "myrmidon-tests");
      mkdirSync(base, { recursive: true });
      const root = mkdtempSync(join(base, "plugin-exports-"));
      try {
        const scripts = join(root, "scripts");
        const sdk = join(root, "packages", "plugins", "sdk");
        const plugin = join(root, "plugin");
        for (const dir of [scripts, sdk, plugin]) mkdirSync(dir, { recursive: true });
        copyFileSync(generator, join(scripts, "generate-plugin-package-json.mjs"));
        writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: "1.0.0" }));
        const publishConfig = {
          access: "public",
          registry: "https://registry.example.invalid/",
          ...entry.publish,
          ...(withPublishEntryPoints ? { main: "./dist/index.cjs", types: "./dist/index.d.ts" } : {}),
        };
        const manifestPath = join(plugin, "package.json");
        writeFileSync(manifestPath, JSON.stringify({
          name: "fixture-plugin", version: "1.0.0", exports: entry.dev,
          main: "./src/dev.cjs", types: "./src/dev.d.ts", publishConfig,
        }));
        const result = spawnSync(process.execPath, [join(scripts, "generate-plugin-package-json.mjs")], { cwd: plugin, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const bytes = readFileSync(manifestPath, "utf8");
        assert.ok(bytes.endsWith("\n"));
        const output = JSON.parse(bytes);
        assert.deepEqual(output.exports, entry.expected);
        assert.deepEqual(output.publishConfig, publishConfig);
        if (withPublishEntryPoints) {
          assert.equal(output.main, "./dist/index.cjs");
          assert.equal(output.types, "./dist/index.d.ts");
        } else {
          assert.equal(Object.hasOwn(output, "main"), false);
          assert.equal(Object.hasOwn(output, "types"), false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
