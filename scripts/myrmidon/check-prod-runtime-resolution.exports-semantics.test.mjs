import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectFailures, matchExportsTarget } from "./check-prod-runtime-resolution.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(process.env.HOME, ".cache");
const cli = fileURLToPath(new URL("./check-prod-runtime-resolution.mjs", import.meta.url));

function fixture(exportsField, imports, run) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "exports-semantics-"));
  try {
    const pkg = path.join(dir, "node_modules/@myrmidon/example");
    fs.mkdirSync(path.join(pkg, "dist/feature"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@myrmidon/example", type: "module", exports: exportsField }));
    for (const file of ["a.js", "b.js", "feature/x.js"]) fs.writeFileSync(path.join(pkg, "dist", file), `export default ${JSON.stringify(file)};`);
    const dist = path.join(dir, "server/dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.js"), imports.map((s) => `import ${JSON.stringify(s)};`).join("\n"));
    return run(dir, dist);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("null and nested arrays resolve without mutation", () => {
  const cases = [
    [{ ".": null }, ".", null],
    [{ ".": { import: null, default: "./dist/b.js" } }, ".", null],
    [{ ".": ["./dist/a.js", "./dist/b.js"] }, ".", "./dist/a.js"],
    [{ "./x": [{ types: "./x.d.ts" }, [{ import: "./dist/a.js" }]] }, "./x", "./dist/a.js"],
    [{ ".": { types: "./x.d.ts" } }, ".", null],
  ];
  for (const [field, subpath, expected] of cases) {
    const original = structuredClone(field);
    assert.equal(matchExportsTarget(field, undefined, subpath), expected);
    assert.deepEqual(field, original);
  }
});

test("exact and most specific wildcard win independently of key order", () => {
  for (const entries of [
    [["./*", "./dist/*.js"], ["./feature/*", "./dist/feature/*.js"], ["./feature/exact", "./dist/a.js"]],
    [["./feature/exact", "./dist/a.js"], ["./feature/*", "./dist/feature/*.js"], ["./*", "./dist/*.js"]],
  ]) {
    const field = Object.fromEntries(entries);
    assert.equal(matchExportsTarget(field, undefined, "./feature/x"), "./dist/feature/x.js");
    assert.equal(matchExportsTarget(field, undefined, "./feature/exact"), "./dist/a.js");
    assert.equal(matchExportsTarget({ "./*": "./dist/*.js", "./feature/*": null }, undefined, "./feature/x"), null);
  }
});

test("Node import agrees with selection and never falls back to an existing file", () => {
  const exportsField = { ".": ["./dist/missing.js", "./dist/b.js"], "./*": "./dist/*.js", "./feature/*": "./dist/feature/*.js" };
  fixture(exportsField, [], (dir) => {
    for (const [subpath, expected] of [[".", "ERR_MODULE_NOT_FOUND"], ["./feature/x", "feature/x.js"]]) {
      const spec = "@myrmidon/example" + (subpath === "." ? "" : subpath.slice(1));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(spec)}).then(m=>console.log(m.default)).catch(e=>{console.log(e.code);process.exitCode=1})`], { cwd: dir, encoding: "utf8" });
      assert.equal(result.stdout.trim(), expected);
      const chosen = matchExportsTarget(exportsField, undefined, subpath);
      assert.equal(chosen, subpath === "." ? "./dist/missing.js" : "./dist/feature/x.js");
    }
  });
});

test("collectFailures and actual CLI report blocked exports without crashing", () => {
  fixture({ ".": null }, ["@myrmidon/example"], (dir, dist) => {
    const failures = collectFailures(dist);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].specifier, "@myrmidon/example");
    assert.ok(failures[0].reason);
    const result = spawnSync(process.execPath, [cli, "--dist", dist], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /@myrmidon\/example/);
    assert.doesNotMatch(result.stdout + result.stderr, /TypeError|\bat .*\.mjs:\d/);
  });
});

test("working runtime condition succeeds; types-only fails closed", () => {
  for (const [field, count] of [[{ ".": { types: "./dist/a.d.ts", import: "./dist/a.js" } }, 0], [{ ".": { types: "./dist/a.d.ts" } }, 1]]) {
    fixture(field, ["@myrmidon/example"], (_dir, dist) => assert.equal(collectFailures(dist).length, count));
  }
});
