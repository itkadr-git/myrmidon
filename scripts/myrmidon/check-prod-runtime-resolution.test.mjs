// Tests for check-prod-runtime-resolution.mjs (OPE-12671, BOARD-START-BUNDLE Ч1.2).
//
// Every scenario runs the real CLI `main()` through child-process-free direct
// invocation against fixtures built in a per-test temporary directory: a fake
// workspace with `node_modules/@myrmidon/*` packages and a fake compiled
// `server/dist` tree. No network, no database, no running server, no tsx —
// the same guarantees the script itself promises.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectFailures,
  main,
  parseArgs,
  scanImports,
} from "./check-prod-runtime-resolution.mjs";

const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "prod-resolution-fixture-"));

/** Capture console-like log/error output of a main() invocation. */
function runMain(fixtureDir, argv) {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = main(argv, log, fixtureDir);
  return { code, output: lines.join("\n") };
}

function writePkg(fixtureDir, name, { exports, main: mainField, distFiles = {}, srcFiles = {} }) {
  const pkgDir = path.join(fixtureDir, "node_modules", "@myrmidon", name);
  fs.mkdirSync(pkgDir, { recursive: true });
  const pkgJson = { name: `@myrmidon/${name}`, version: "1.0.0", type: "module" };
  if (exports !== undefined) pkgJson.exports = exports;
  if (mainField !== undefined) pkgJson.main = mainField;
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson));
  for (const [rel, body] of Object.entries(distFiles)) {
    const file = path.join(pkgDir, "dist", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  for (const [rel, body] of Object.entries(srcFiles)) {
    const file = path.join(pkgDir, "src", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return pkgDir;
}

/** Minimal compiled server dist: one entry importing the given specifiers. */
function writeServerDist(fixtureDir, entryBody, extraFiles = {}) {
  const dist = path.join(fixtureDir, "server", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), entryBody);
  for (const [rel, body] of Object.entries(extraFiles)) {
    const file = path.join(dist, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dist;
}

describe("parseArgs", () => {
  it("requires --dist", () => {
    assert.throws(() => parseArgs([]), /--dist/);
  });

  it("rejects unknown arguments", () => {
    assert.throws(() => parseArgs(["--dist", "x", "--wat"]), /неизвестный аргумент/);
  });

  it("accepts --dist= form and --skip-vendor-runner", () => {
    const args = parseArgs(["--dist=server/dist", "--skip-vendor-runner"]);
    assert.deepEqual(args, { dist: "server/dist", skipVendorRunner: true });
  });
});

describe("scanImports", () => {
  it("finds static, export-from, side-effect, dynamic and new URL imports with line numbers", () => {
    const text = [
      'import { a } from "@myrmidon/a";',
      'export { b } from "./b.js";',
      'import "@myrmidon/c";',
      'const m = await import("@myrmidon/d");',
      'const u = new URL("../x.ts", import.meta.url);',
      '// import { noise } from "@myrmidon/noise";',
      'const t = `import { x } from "@myrmidon/tpl";`;',
    ].join("\n");
    const imports = scanImports(text);
    const specs = imports.map((i) => `${i.line}:${i.specifier}`);
    assert.deepEqual(specs, [
      "1:@myrmidon/a",
      "2:./b.js",
      "3:@myrmidon/c",
      "4:@myrmidon/d",
      "5:../x.ts",
    ]);
  });
});

describe("main on fixtures", () => {
  it("(1) flags exports pointing at src/x.ts with importer, specifier and reason", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "x", {
        exports: { ".": "./src/index.ts" },
        srcFiles: { "index.ts": "export const x = 1;\n" },
      });
      const dist = writeServerDist(dir, 'import { x } from "@myrmidon/x";\nexport { x };\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      assert.match(output, /server\/dist\/index\.js:1 @myrmidon\/x → exports указывает на \.ts/);
      assert.match(output, /1 сбой в 1 пакете/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(2) types+import conditions with a working dist are clean", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "ok", {
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
        distFiles: {
          "index.js": 'export const ok = 1;\nimport { helper } from "./helper.js";\nexport { helper };\n',
          "helper.js": 'import { deep } from "./deep/index.js";\nexport { deep };\n',
          "deep/index.js": "export const deep = 2;\n",
          "index.d.ts": "export declare const ok = 1;\n",
        },
      });
      const dist = writeServerDist(dir, 'import { ok } from "@myrmidon/ok";\nexport { ok };\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 0, output);
      assert.match(output, /0 сбоев в 0 пакетах/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(3) subpath covered by a ./* pattern resolves instead of reporting missing", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "pat", {
        exports: { "./*": "./dist/*.js" },
        distFiles: { "pat-util.js": "export const u = 1;\n" },
      });
      const dist = writeServerDist(dir, 'import { u } from "@myrmidon/pat/pat-util";\nexport { u };\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 0, output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(4) flags a target file named in exports that is missing from dist", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "nobuild", {
        exports: { ".": { import: "./dist/index.js" } },
        distFiles: {},
      });
      const dist = writeServerDist(dir, 'import { x } from "@myrmidon/nobuild";\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      assert.match(output, /@myrmidon\/nobuild → файл не собран/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(5) flags relative .ts imports", () => {
    const dir = mkdtemp();
    try {
      const dist = writeServerDist(dir, 'import { a } from "./a.ts";\nexport { a };\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      assert.match(output, /server\/dist\/index\.js:1 \.\/a\.ts → относительный импорт \.ts/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(6) flags new URL(\"....ts\", import.meta.url) literals", () => {
    const dir = mkdtemp();
    try {
      const dist = writeServerDist(dir, 'const asset = new URL("../x.ts", import.meta.url);\nexport { asset };\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      assert.match(output, /new URL указывает на \.ts/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(7) resolves dynamic import(\"@myrmidon/x\") with a string literal", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "x", { exports: { ".": "./src/index.ts" }, srcFiles: { "index.ts": "" } });
      const dist = writeServerDist(dir, 'const m = await import("@myrmidon/x");\nexport { m };\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      assert.match(output, /@myrmidon\/x → exports указывает на \.ts/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(8) reports three different failures in one fixture, not just the first", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "a", { exports: { ".": "./src/index.ts" }, srcFiles: { "index.ts": "" } });
      writePkg(dir, "b", { exports: { ".": { import: "./dist/index.js" } }, distFiles: {} });
      const dist = writeServerDist(
        dir,
        [
          'import { a } from "@myrmidon/a";',
          'import { b } from "@myrmidon/b";',
          'import { z } from "./z.ts";',
          "export { a, b, z };",
        ].join("\n"),
      );
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      assert.match(output, /@myrmidon\/a → exports указывает на \.ts/);
      assert.match(output, /@myrmidon\/b → файл не собран/);
      assert.match(output, /\.\/z\.ts → относительный импорт \.ts/);
      assert.match(output, /3 сбоя в 2 пакетах/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(9) --skip-vendor-runner ignores dist/vendor/paperclip-runner failures", () => {
    const dir = mkdtemp();
    try {
      const dist = writeServerDist(dir, "export {};\n", {
        "vendor/paperclip-runner/index.js": 'import "@myrmidon/broken";\n',
      });
      const distArg = path.relative(dir, dist);
      const withFailures = runMain(dir, ["--dist", distArg]);
      assert.equal(withFailures.code, 1);
      assert.match(withFailures.output, /@myrmidon\/broken/);

      const skipped = runMain(dir, ["--dist", distArg, "--skip-vendor-runner"]);
      assert.equal(skipped.code, 0, skipped.output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows @myrmidon imports into package dist and flags that package's own bad imports", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "good", {
        exports: { ".": { import: "./dist/index.js" } },
        distFiles: {
          "index.js": 'import { inner } from "@myrmidon/inner";\nexport { inner };\n',
        },
      });
      writePkg(dir, "inner", {
        exports: { ".": { import: "./dist/index.js" } },
        distFiles: {
          "index.js": 'import { helper } from "./helper.js";\nexport { helper };\n',
          "helper.js": 'import { ghost } from "@myrmidon/missing-pkg";\nexport { ghost };\n',
        },
      });
      const dist = writeServerDist(dir, 'import { good } from "@myrmidon/good";\n');
      const { code, output } = runMain(dir, ["--dist", path.relative(dir, dist)]);
      assert.equal(code, 1);
      // server/dist -> @myrmidon/good (clean) -> @myrmidon/inner -> inner's
      // helper.js: the failure is attributed to the file that actually
      // imports the missing package, two hops into the package graph.
      assert.match(output, /node_modules\/@myrmidon\/inner\/dist\/helper\.js:1 @myrmidon\/missing-pkg → пакет не найден/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing dist directory as usage error without scanning", () => {
    const dir = mkdtemp();
    try {
      const { code, output } = runMain(dir, ["--dist", path.join(dir, "absent")]);
      assert.equal(code, 2);
      assert.match(output, /dist не найден/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collectFailures returns structured rows sorted by file and line", () => {
    const dir = mkdtemp();
    try {
      writePkg(dir, "a", { exports: { ".": "./src/index.ts" }, srcFiles: { "index.ts": "" } });
      const dist = writeServerDist(dir, "", {
        "zz.js": 'import { late } from "@myrmidon/a";\n',
        "aa.js": 'import { early } from "@myrmidon/a";\nimport { u } from "./u.ts";\n',
      });
      const failures = collectFailures(dist);
      assert.deepEqual(
        failures.map((f) => [path.basename(f.file), f.line, f.reason]),
        [
          ["aa.js", 1, "exports указывает на .ts"],
          ["aa.js", 2, "относительный импорт .ts"],
          ["zz.js", 1, "exports указывает на .ts"],
        ],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
