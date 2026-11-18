import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = fileURLToPath(new URL("../", import.meta.url));
const workspaces = [
  "packages/db", "packages/shared", "packages/adapter-utils",
  "packages/adapters/claude-local", "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway", "packages/adapters/hermes",
  "packages/adapters/opencode-local", "packages/adapters/openclaw-gateway",
];
const current = {
  name: "current-cli", version: "1.2.3", description: "Current CLI", type: "module",
  bin: { current: "./current.js" }, keywords: ["current", "cli"], license: "MIT",
  repository: { type: "git", url: "https://example.test/current.git", directory: "cli" },
  homepage: "https://example.test/current", bugs: { url: "https://example.test/current/issues" },
  files: ["current.js", "dist"], scripts: { test: "bad" },
  devDependencies: { "dev-only": "1" }, custom: { excluded: true },
  dependencies: { zebra: "3", alpha: "1", "@myrmidon/server": "workspace:*", zod: "4" },
  optionalDependencies: { yak: "8", beta: "2" },
};
const backup = {
  name: "backup-cli", version: "9.8.7", description: "Backup CLI", type: "commonjs",
  bin: { backup: "./backup.js", tool: "./tool.js" }, keywords: ["backup", "release"], license: "Apache-2.0",
  repository: { type: "git", url: "https://example.test/backup.git", directory: "packages/cli" },
  homepage: "https://example.test/backup", bugs: { url: "https://example.test/backup/issues", email: "bugs@example.test" },
  files: ["backup.js", "lib"], scripts: { build: "bad" },
  devDependencies: { "backup-dev": "2" }, custom: { excluded: true },
  dependencies: { "backup-only": "9" },
};

function expected(metadata) {
  return {
    name: metadata.name, version: metadata.version, description: metadata.description,
    type: metadata.type, bin: metadata.bin, keywords: metadata.keywords,
    license: metadata.license, repository: metadata.repository, homepage: metadata.homepage,
    bugs: metadata.bugs, files: metadata.files, engines: { node: ">=24.11.0" },
    dependencies: { "@myrmidon/server": "7.6.5", alpha: "1", middle: "2", zebra: "3" },
    optionalDependencies: { beta: "2", native: "6", yak: "8" },
  };
}

function fixture(fn) {
  const base = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "cli-metadata-"));
  const put = (path, value) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const json = (path, value) => put(path, JSON.stringify(value));
  try {
    mkdirSync(join(root, "scripts"));
    for (const name of ["generate-npm-package-json.mjs", "cli-bundled-npm-dependencies.mjs"]) {
      copyFileSync(join(scripts, name), join(root, "scripts", name));
    }
    for (const path of workspaces) json(`${path}/package.json`, {});
    json("packages/shared/package.json", { dependencies: { middle: "2", "@myrmidon/shared": "workspace:*" } });
    json("server/package.json", { version: "7.6.5" });
    json("packages/db/node_modules/embedded-postgres/package.json", {
      main: "dist/index.js", optionalDependencies: { native: "6" },
    });
    put("packages/db/node_modules/embedded-postgres/dist/index.js", "");
    fn({ root, json });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function generate(root) {
  const result = spawnSync(process.execPath, [join(root, "scripts/generate-npm-package-json.mjs")], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, `generator failed: ${result.error ?? result.stderr}`);
  return readFileSync(join(root, "cli/package.json"), "utf8");
}

function assertManifest(bytes, metadata) {
  assert.deepEqual(JSON.parse(bytes), expected(metadata));
  assert.equal(bytes, `${JSON.stringify(expected(metadata), null, 2)}\n`);
}

test("backup supplies metadata while current workspace supplies dependencies", () => {
  fixture(({ root, json }) => {
    json("cli/package.json", current);
    json("cli/package.dev.json", backup);
    assertManifest(generate(root), backup);
  });
});

test("current manifest supplies metadata when the backup is absent", () => {
  fixture(({ root, json }) => {
    json("cli/package.json", current);
    assertManifest(generate(root), current);
  });
});

test("dependency and optional dependency output order is stable across input order", () => {
  const outputs = [];
  for (const reversed of [false, true]) {
    fixture(({ root, json }) => {
      const deps = reversed ? { zod: "4", "@myrmidon/server": "workspace:*", alpha: "1", zebra: "3" } : current.dependencies;
      const optional = reversed ? { beta: "2", yak: "8" } : current.optionalDependencies;
      json("cli/package.json", { ...current, dependencies: deps, optionalDependencies: optional });
      json("cli/package.dev.json", backup);
      const bytes = generate(root);
      assertManifest(bytes, backup);
      const manifest = JSON.parse(bytes);
      assert.deepEqual(Object.keys(manifest.dependencies), ["@myrmidon/server", "alpha", "middle", "zebra"]);
      assert.deepEqual(Object.keys(manifest.optionalDependencies), ["beta", "native", "yak"]);
      outputs.push(bytes);
    });
  }
  assert.equal(outputs[0], outputs[1]);
});

test("the exact oracle rejects current metadata and leaked dev dependencies", () => {
  fixture(({ root, json }) => {
    json("cli/package.json", current);
    json("cli/package.dev.json", backup);
    const bytes = generate(root);
    assertManifest(bytes, backup);
    const script = join(root, "scripts/generate-npm-package-json.mjs");
    const original = readFileSync(script, "utf8");
    const wrongMetadata = original.replace("const cliPkg = existsSync(devPkgPath)", "const cliPkg = false && existsSync(devPkgPath)");
    assert.notEqual(wrongMetadata, original);
    json("cli/package.json", current);
    writeFileSync(script, wrongMetadata);
    assert.throws(() => assertManifest(generate(root), backup), assert.AssertionError);
    json("cli/package.json", current);
    const leakedDev = original.replace("  engines: { node:", "  devDependencies: cliPkg.devDependencies,\n  engines: { node:");
    assert.notEqual(leakedDev, original);
    writeFileSync(script, leakedDev);
    assert.throws(() => assertManifest(generate(root), backup), assert.AssertionError);
    writeFileSync(script, original);
  });
});
