import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const version = "2026.11.16";

function snapshot(root, dir = "") {
  const files = new Map();
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [name, bytes] of snapshot(root, path)) files.set(name, bytes);
    } else {
      files.set(path, readFileSync(join(root, path)));
    }
  }
  return files;
}

function exercise(cliEntry, changed) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = realpathSync(mkdtempSync(join(scratch, "myrmidon-version-isolation-")));
  const put = (path, data) => {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  };
  try {
    put("scripts/release-package-manifest.json", JSON.stringify([
      { dir: "cli", name: "myrmidon", publishFromCi: true },
      { dir: "packages/enabled", name: "@myrmidon/enabled", publishFromCi: true },
      { dir: "packages/off", name: "@myrmidon/off", publishFromCi: false },
    ], null, 2) + "\n");
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    put("cli/package.json", '{"name":"myrmidon","version":"1.0.0"}\n');
    put("packages/enabled/package.json", '{"name":"@myrmidon/enabled","version":"1.0.0"}\n');
    put("packages/off/package.json", '{  "version" : "1.0.0",\n "name" : "@myrmidon/off" }\n\n');
    put("packages/private/package.json", '{ "private" : true,\n "version":"1.0.0", "name":"private" }\n\n');
    put("README.md", "fixture readme\n");
    put("cli/src/index.ts", cliEntry);
    const before = snapshot(root);
    const result = spawnSync(process.execPath, [join(root, "scripts/release-package-map.mjs"), "set-version", version], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, `set-version failed: ${result.error || result.stderr}`);
    const after = snapshot(root);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "file inventory changed");
    const actualChanged = [...before.keys()].filter((path) => !before.get(path).equals(after.get(path))).sort();
    assert.deepEqual(actualChanged, changed.sort(), "unexpected file changes");
    for (const path of ["cli/package.json", "packages/enabled/package.json"]) {
      assert.equal(JSON.parse(after.get(path).toString()).version, version, path);
    }
    if (changed.includes("cli/src/index.ts")) {
      assert.equal(after.get("cli/src/index.ts").toString(), `program.version("${version}");\n`);
    } else {
      assert.deepEqual(after.get("cli/src/index.ts"), before.get("cli/src/index.ts"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("set-version writes only enabled packages and the literal CLI version", () => {
  exercise('program.version("1.0.0");\n', ["cli/package.json", "packages/enabled/package.json", "cli/src/index.ts"]);
});

test("set-version preserves a dynamic CLI version entry byte-for-byte", () => {
  exercise("program.version(cliVersion);\n", ["cli/package.json", "packages/enabled/package.json"]);
});
