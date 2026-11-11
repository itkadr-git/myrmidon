import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  applyToText,
  buildPackageIndex,
  globToRegExp,
  collectWorkspaceClosure,
  main,
  parseWorkspaceGlobs,
  selectSubstitutions,
  publishOverrides,
  workspacePackageDirs,
} from "./prod-runtime-exports.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REAL_ROOT = path.resolve(HERE, "..", "..");

function silentLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
}

let workDir;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

function writePackage(dir, manifest, { dist = false, extraFile = "" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), manifest);
  if (dist) fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  if (extraFile) write(path.join(dir, extraFile), "keep\n");
}

const MANIFEST_NO_PC = JSON.stringify(
  {
    name: "@test/no-publish-config",
    version: "1.0.0",
    exports: { ".": "./src/index.ts" },
  },
  null,
  2,
) + "\n";

const MANIFEST_TRANSITIVE = JSON.stringify(
  {
    name: "@test/transitive",
    version: "1.0.0",
    exports: { ".": "./src/index.ts", "./extra": "./src/extra.ts" },
    publishConfig: {
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./extra": "./dist/extra.js" },
    },
    customField: "keep-me",
    nested: { untouched: true },
  },
  null,
  2,
) + "\n";

const MANIFEST_DIRECT = JSON.stringify(
  {
    name: "@test/direct",
    version: "2.0.0",
    exports: { ".": "./src/index.ts" },
    publishConfig: { exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } },
    private: true,
  },
  null,
  2,
) + "\n";

const MANIFEST_OFF_CLOSURE = JSON.stringify(
  {
    name: "@test/off-closure",
    version: "1.0.0",
    exports: { ".": "./src/index.ts" },
    publishConfig: { exports: { ".": { import: "./dist/index.js" } } },
  },
  null,
  2,
) + "\n";

const MANIFEST_DEVONLY = JSON.stringify(
  {
    name: "@test/dev-only",
    version: "1.0.0",
    exports: { ".": "./src/index.ts" },
    publishConfig: { exports: { ".": { import: "./dist/index.js" } } },
  },
  null,
  2,
) + "\n";
const MANIFEST_PC_MAIN_TYPES = JSON.stringify(
  {
    name: "@test/pc-main-types",
    version: "1.0.0",
    exports: { ".": "./src/index.ts" },
    publishConfig: { main: "./dist/index.js", types: "./dist/index.d.ts" },
  },
  null,
  2,
) + "\n";

const MANIFEST_SAME_EXPORTS = JSON.stringify(
  {
    name: "@test/same-exports",
    version: "1.0.0",
    exports: { ".": "./dist/index.js" },
    publishConfig: { main: "./dist/index.js", exports: { ".": "./dist/index.js" } },
  },
  null,
  2,
) + "\n";

const MANIFEST_FULLY_MATCHING = JSON.stringify(
  {
    name: "@test/fully-matching",
    version: "1.0.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": "./dist/index.js" },
    publishConfig: { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": "./dist/index.js" } },
  },
  null,
  2,
) + "\n";

const MANIFEST_ENTRY = JSON.stringify(
  {
    name: "@test/entry",
    version: "3.0.0",
    exports: { ".": "./src/index.ts", "./server": "./src/server.ts" },
    publishConfig: { main: "./dist/index.js", exports: { ".": { import: "./dist/index.js" }, "./server": { import: "./dist/server.js" } } },
    dependencies: {
      "@test/direct": "workspace:*",
      "@test/no-publish-config": "workspace:*",
      "@test/off-closure": "^1.0.0",
      "@test/pc-main-types": "workspace:*",
      "@test/same-exports": "workspace:*",
      "@test/fully-matching": "workspace:*",
    },
    devDependencies: { "@test/dev-only": "workspace:*" },
  },
  null,
  2,
) + "\n";

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-runtime-exports-"));
  const ws = ["packages:", "  - packages/*", "  - packages/nested/**", '  - "!packages/ignored/**"'].join("\n") + "\n";
  write(path.join(workDir, "pnpm-workspace.yaml"), ws);

  writePackage(path.join(workDir, "packages", "entry"), MANIFEST_ENTRY, { dist: true, extraFile: "keep.txt" });
  writePackage(path.join(workDir, "packages", "direct"), MANIFEST_DIRECT, { dist: true });
  writePackage(path.join(workDir, "packages", "transitive"), MANIFEST_TRANSITIVE, { dist: true });
  writePackage(path.join(workDir, "packages", "no-pc"), MANIFEST_NO_PC);
  writePackage(path.join(workDir, "packages", "off-closure"), MANIFEST_OFF_CLOSURE, { dist: true });
  writePackage(path.join(workDir, "packages", "dev-only"), MANIFEST_DEVONLY, { dist: true });
  writePackage(path.join(workDir, "packages", "nested", "deep", "pkg"), JSON.stringify({ name: "@test/nested-pkg", version: "1.0.0" }, null, 2) + "\n");
  // `direct` depends on `transitive` (one hop past the entry's direct deps).
  const direct = readPkg(path.join(workDir, "packages", "direct"));
  direct.dependencies = { "@test/transitive": "workspace:*" };
  fs.writeFileSync(path.join(workDir, "packages", "direct", "package.json"), JSON.stringify(direct, null, 2) + "\n");
  // Selection edge cases: publishConfig.main/types without exports, exports
  // already matching while main/types differ, and a fully matching package.
  writePackage(path.join(workDir, "packages", "pc-main-types"), MANIFEST_PC_MAIN_TYPES, { dist: true });
  writePackage(path.join(workDir, "packages", "same-exports"), MANIFEST_SAME_EXPORTS, { dist: true });
  writePackage(path.join(workDir, "packages", "fully-matching"), MANIFEST_FULLY_MATCHING, { dist: true });
  // A package outside the closure that must never be touched.
  writePackage(path.join(workDir, "packages", "ignored"), MANIFEST_OFF_CLOSURE, { dist: true });
});

after(() => {
  fs.rmSync(workDir, { force: true, recursive: true });
});

describe("parseWorkspaceGlobs", () => {
  it("reads the packages block and stops at the next key", () => {
    const text = "packages:\n  - a/*\n  - 'b/c'\nignored: true\n  - not-a-glob\n";
    assert.deepEqual(parseWorkspaceGlobs(text), ["a/*", "b/c"]);
  });

  it("returns [] when there is no packages key", () => {
    assert.deepEqual(parseWorkspaceGlobs("other: []\n"), []);
  });
});

describe("globToRegExp", () => {
  it("keeps * within a segment and lets ** span", () => {
    assert.ok(globToRegExp("packages/*").test("packages/db"));
    assert.ok(!globToRegExp("packages/*").test("packages/adapters/db"));
    assert.ok(globToRegExp("packages/**").test("packages/a/b/c"));
  });
});

describe("workspacePackageDirs", () => {
  it("expands one-level globs and excludes negated trees", () => {
    const dirs = workspacePackageDirs(workDir);
    const names = dirs.map((d) => path.relative(workDir, d)).sort();
    assert.deepEqual(names, [
      "packages/dev-only",
      "packages/direct",
      "packages/entry",
      "packages/fully-matching",
      "packages/nested/deep/pkg",
      "packages/no-pc",
      "packages/off-closure",
      "packages/pc-main-types",
      "packages/same-exports",
      "packages/transitive",
    ]);
    // packages/ignored must not be a workspace member.
    assert.ok(!dirs.some((d) => d.includes("ignored")));
  });
});

describe("buildPackageIndex and collectWorkspaceClosure", () => {
  it("maps package names to dirs", () => {
    const index = buildPackageIndex(workDir);
    assert.equal(index.get("@test/entry"), path.join(workDir, "packages", "entry"));
    assert.ok(index.has("@test/nested-pkg"));
  });

  it("walks dependencies and optionalDependencies transitively and stops at devDependencies", () => {
    const index = buildPackageIndex(workDir);
    const closure = collectWorkspaceClosure("@test/entry", index);
    assert.deepEqual([...closure.keys()].sort(), [
      "@test/direct",
      "@test/entry",
      "@test/fully-matching",
      "@test/no-publish-config",
      "@test/pc-main-types",
      "@test/same-exports",
      "@test/transitive",
    ]);
  });

  it("rejects an unknown entry", () => {
    const index = buildPackageIndex(workDir);
    assert.throws(() => collectWorkspaceClosure("@test/off-closure-entry", index), /not found in the workspace/);
  });
});

describe("publishOverrides", () => {
  it("collects main/types/exports and never bin", () => {
    assert.deepEqual(publishOverrides({ publishConfig: { bin: "x", main: "y", exports: {} } }), {
      main: "y",
      exports: {},
    });
    assert.deepEqual(publishOverrides({}), {});
  });
});

describe("applyToText", () => {
  it("substitutes only the given keys and keeps the rest of the bytes", () => {
    const overrides = { exports: { ".": "./dist/index.js" } };
    const next = applyToText(MANIFEST_TRANSITIVE, overrides);
    const pkg = JSON.parse(next);
    assert.deepEqual(pkg.exports, { ".": "./dist/index.js" });
    assert.equal(pkg.customField, "keep-me");
    assert.deepEqual(pkg.nested, { untouched: true });
    assert.equal(next, `${JSON.stringify(pkg, null, 2)}\n`);
    assert.ok(next.endsWith("\n"));
  });
});

describe("main apply/restore end to end", () => {
  it("apply --dry-run prints the table and writes nothing", () => {
    const log = silentLog();
    const code = main(["apply", "--entry", "@test/entry", "--root", workDir, "--dry-run"], log);
    assert.equal(code, 0);
    const table = log.lines.join("\n");
    assert.match(table, /@test\/direct/);
    assert.match(table, /@test\/transitive/);
    assert.match(table, /@test\/pc-main-types\s+main\+types\s+dist: yes/);
    assert.match(table, /@test\/same-exports\s+main\+exports\s+dist: yes/);
    assert.match(table, /skipped \(no publishConfig main\/types\/exports\): @test\/no-publish-config/);
    assert.match(table, /skipped \(already serving dist\): @test\/fully-matching/);
    assert.match(table, /skipped \(entry package\): @test\/entry/);
    assert.match(table, /dry-run: 4 package\(s\) to substitute/);
    // Nothing written: no backup, no rewritten manifests.
    assert.ok(!fs.existsSync(path.join(workDir, "node_modules", ".cache", "myrmidon-prod-exports")));
    const entry = readPkg(path.join(workDir, "packages", "entry"));
    assert.equal(entry.exports["."], "./src/index.ts");
  });

  it("apply substitutes main/types/exports from publishConfig and leaves the rest byte-stable", () => {
    const log = silentLog();
    const code = main(["apply", "--entry", "@test/entry", "--root", workDir], log);
    assert.equal(code, 0);

    const transitiveText = fs.readFileSync(path.join(workDir, "packages", "transitive", "package.json"), "utf8");
    const transitive = JSON.parse(transitiveText);
    assert.deepEqual(transitive.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./extra": "./dist/extra.js",
    });
    assert.equal(transitive.main, "./dist/index.js");
    assert.equal(transitive.types, "./dist/index.d.ts");
    assert.equal(transitive.customField, "keep-me");
    assert.deepEqual(transitive.nested, { untouched: true });
    assert.ok(transitiveText.endsWith("\n"));
    assert.ok(!("publishConfig" in transitive) === false); // publishConfig kept
    assert.ok(transitive.publishConfig && transitive.publishConfig.main === "./dist/index.js");

    // publishConfig.main/types without publishConfig.exports are substituted too.
    const pcMainTypes = readPkg(path.join(workDir, "packages", "pc-main-types"));
    assert.equal(pcMainTypes.main, "./dist/index.js");
    assert.equal(pcMainTypes.types, "./dist/index.d.ts");
    assert.deepEqual(pcMainTypes.exports, { ".": "./src/index.ts" }); // no pc.exports: untouched

    // exports already serving dist but main/types differing still substitutes main.
    const sameExports = readPkg(path.join(workDir, "packages", "same-exports"));
    assert.equal(sameExports.main, "./dist/index.js");
    assert.deepEqual(sameExports.exports, { ".": "./dist/index.js" });

    // Off-closure and dev-only packages stay untouched, ignored package too.
    const offClosure = readPkg(path.join(workDir, "packages", "off-closure"));
    assert.equal(offClosure.exports["."], "./src/index.ts");
    const devOnly = readPkg(path.join(workDir, "packages", "dev-only"));
    assert.equal(devOnly.exports["."], "./src/index.ts");
    const ignored = readPkg(path.join(workDir, "packages", "ignored"));
    assert.equal(ignored.exports["."], "./src/index.ts");
    // Workspace dependency specifiers are not rewritten.
    const entry = readPkg(path.join(workDir, "packages", "entry"));
    assert.equal(entry.dependencies["@test/direct"], "workspace:*");

    // Backup exists with original texts.
    const backupFile = path.join(workDir, "node_modules", ".cache", "myrmidon-prod-exports", "backup.json");
    const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
    assert.deepEqual(Object.keys(backup.packages).sort(), [
      "@test/direct",
      "@test/pc-main-types",
      "@test/same-exports",
      "@test/transitive",
    ]);
    assert.equal(backup.packages["@test/transitive"].originalText, MANIFEST_TRANSITIVE);
  });

  it("second apply is idempotent and does not overwrite the backup", () => {
    const backupFile = path.join(workDir, "node_modules", ".cache", "myrmidon-prod-exports", "backup.json");
    const before = fs.readFileSync(backupFile, "utf8");
    const log = silentLog();
    const code = main(["apply", "--entry", "@test/entry", "--root", workDir], log);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(backupFile, "utf8"), before);
    const transitive = JSON.parse(fs.readFileSync(path.join(workDir, "packages", "transitive", "package.json"), "utf8"));
    assert.equal(transitive.main, "./dist/index.js");
  });

  it("restore returns every touched package.json byte-for-byte and removes the backup", () => {
    const log = silentLog();
    const code = main(["restore", "--root", workDir], log);
    assert.equal(code, 0);
    for (const [dir, expected] of [
      ["entry", MANIFEST_ENTRY],
      ["direct", (function () {
        const pkg = JSON.parse(MANIFEST_DIRECT);
        pkg.dependencies = { "@test/transitive": "workspace:*" };
        return JSON.stringify(pkg, null, 2) + "\n";
      })()],
      ["transitive", MANIFEST_TRANSITIVE],
      ["pc-main-types", MANIFEST_PC_MAIN_TYPES],
      ["same-exports", MANIFEST_SAME_EXPORTS],
    ]) {
      const actual = fs.readFileSync(path.join(workDir, "packages", dir, "package.json"), "utf8");
      assert.equal(actual, expected, `${dir}/package.json byte-identical`);
    }
    assert.ok(!fs.existsSync(path.join(workDir, "node_modules", ".cache", "myrmidon-prod-exports", "backup.json")));
  });

  it("restore without a backup reports and exits 0", () => {
    const log = silentLog();
    const code = main(["restore", "--root", workDir], log);
    assert.equal(code, 0);
    assert.ok(log.lines.join("\n").includes("no backup"));
  });

  it("apply without dist fails atomically with exit code 2 and writes nothing", () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "prod-runtime-exports-nodist-"));
    try {
      fs.writeFileSync(path.join(missing, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
      const manifest = (name, extra) => JSON.stringify(
        {
          name,
          version: "1.0.0",
          exports: { ".": "./src/index.ts" },
          publishConfig: { exports: { ".": { import: "./dist/index.js" } } },
          ...(extra ?? {}),
        },
        null,
        2,
      ) + "\n";
      const entryManifest = manifest("@test/nodist-entry", {
        dependencies: { "@test/nodist": "workspace:*" },
      });
      const nodistManifest = manifest("@test/nodist");
      fs.mkdirSync(path.join(missing, "pkgs", "nodist"), { recursive: true });
      fs.writeFileSync(path.join(missing, "pkgs", "nodist", "package.json"), nodistManifest);
      fs.mkdirSync(path.join(missing, "pkgs", "entry"), { recursive: true });
      fs.writeFileSync(path.join(missing, "pkgs", "entry", "package.json"), entryManifest);
      const log = silentLog();
      const code = main(["apply", "--entry", "@test/nodist-entry", "--root", missing], log);
      assert.equal(code, 2);
      assert.match(log.lines.join("\n"), /Preflight failed/);
      assert.equal(fs.readFileSync(path.join(missing, "pkgs", "nodist", "package.json"), "utf8"), nodistManifest);
      assert.ok(!fs.existsSync(path.join(missing, "node_modules", ".cache", "myrmidon-prod-exports")));
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
    }
  });
});

describe("real tree dry-run", () => {
  it("server closure selects the expected packages via selectSubstitutions", () => {
    const index = buildPackageIndex(REAL_ROOT);
    const closure = collectWorkspaceClosure("@myrmidon/server", index);
    const { overridesByPackage, skipReasons } = selectSubstitutions("@myrmidon/server", closure, index);
    // 18 = the server's workspace closure minus the entry itself: the 17
    // src-pointing packages plus @myrmidon/plugin-sdk, whose top-level
    // `exports` already matches publishConfig but `main`/`types` do not.
    assert.deepEqual([...overridesByPackage.keys()].sort(), [
      "@myrmidon/adapter-claude-local",
      "@myrmidon/adapter-codex-local",
      "@myrmidon/adapter-cursor-cloud",
      "@myrmidon/adapter-cursor-local",
      "@myrmidon/adapter-gemini-local",
      "@myrmidon/adapter-grok-local",
      "@myrmidon/adapter-kimi-local",
      "@myrmidon/adapter-omp-local",
      "@myrmidon/adapter-openclaw-gateway",
      "@myrmidon/adapter-opencode-local",
      "@myrmidon/adapter-pi-local",
      "@myrmidon/adapter-utils",
      "@myrmidon/corpus",
      "@myrmidon/db",
      "@myrmidon/hermes-paperclip-adapter",
      "@myrmidon/plugin-sdk",
      "@myrmidon/shared",
      "@myrmidon/skills-catalog",
    ]);
    // Only the entry itself is skipped on the real tree.
    assert.deepEqual([...skipReasons.keys()].sort(), ["@myrmidon/server"]);
    assert.equal(skipReasons.get("@myrmidon/server"), "entry package");
    // plugin-sdk is selected because main/types deviate; the override map
    // carries all its publishConfig keys (identical exports is a no-op write).
    assert.deepEqual(Object.keys(overridesByPackage.get("@myrmidon/plugin-sdk")).sort(), ["exports", "main", "types"]);
  });
});
