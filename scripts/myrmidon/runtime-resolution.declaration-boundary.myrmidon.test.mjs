import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { collectFailures, resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writePackage(root, name, target, content) {
  const dir = path.join(root, "node_modules", "@myrmidon", name);
  writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `@myrmidon/${name}`, exports: target }));
  if (content !== null) writeFile(path.join(dir, target), content);
  return dir;
}

it("keeps literal declarations out of runtime traversal but follows JavaScript", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "declaration-boundary-"));
  try {
    const trap = 'import "@myrmidon/trap";\n';
    const declaration = writePackage(root, "declaration", "./dist/index.d.ts", trap);
    const missing = writePackage(root, "missing-declaration", "./dist/index.d.ts", null);
    const runtime = writePackage(root, "runtime", "./dist/index.js", trap);
    const dist = path.join(root, "server", "dist");
    const entry = path.join(dist, "index.js");
    writeFile(entry, [
      'import "@myrmidon/declaration";',
      'import "@myrmidon/missing-declaration";',
      'import "@myrmidon/runtime";',
      'import "./types.d.ts";',
      'new URL("./types.d.ts", import.meta.url);',
      'import "./types.ts";',
      'new URL("./types.ts", import.meta.url);',
      "",
    ].join("\n"));
    writeFile(path.join(dist, "types.d.ts"), trap);

    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/declaration", dist), {
      pkgDir: declaration, packageName: "@myrmidon/declaration", follow: null,
    });
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/missing-declaration", dist), {
      pkgDir: missing, packageName: "@myrmidon/missing-declaration", follow: null,
    });
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/runtime", dist), {
      pkgDir: runtime, packageName: "@myrmidon/runtime", follow: fs.realpathSync(path.join(runtime, "dist/index.js")),
    });
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/trap", dist), {
      failure: "пакет не найден в node_modules", packageName: "@myrmidon/trap",
    });
    assert.deepEqual(collectFailures(dist), [
      { file: path.join(runtime, "dist/index.js"), line: 1, specifier: "@myrmidon/trap", reason: "пакет не найден в node_modules", packageName: "@myrmidon/trap" },
      { file: entry, line: 6, specifier: "./types.ts", reason: "относительный импорт .ts", packageName: null },
      { file: entry, line: 7, specifier: "./types.ts", reason: "new URL указывает на .ts", packageName: null },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
