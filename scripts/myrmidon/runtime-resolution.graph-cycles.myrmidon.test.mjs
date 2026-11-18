import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures, formatFailures, main } from "./check-prod-runtime-resolution.mjs";

function fixture(independentFailure) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "resolution-graph-"));
  const scope = path.join(root, "node_modules", "@myrmidon");
  const marker = path.join(root, "executed");
  try {
    for (const [name, lines] of Object.entries({
      a: ['import "@myrmidon/c-one";'],
      b: ['import "@myrmidon/c-two";', ...(independentFailure ? ['import "@myrmidon/other-missing";'] : [])],
      c: ['import "@myrmidon/a";', 'import "@myrmidon/missing";', `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`],
    })) {
      const dir = path.join(scope, name);
      fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@myrmidon/${name}`, type: "module", exports: "./dist/index.js" }));
      fs.writeFileSync(path.join(dir, "dist", "index.js"), lines.join("\n") + "\n");
    }
    fs.symlinkSync("c", path.join(scope, "c-one"), "dir");
    fs.symlinkSync("c", path.join(scope, "c-two"), "dir");
    const dist = path.join(root, "server", "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.js"), 'import "@myrmidon/a";\nimport "@myrmidon/b";\n');
    return { root, dist, marker, scope };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

for (const independentFailure of [false, true]) {
  test(independentFailure ? "cycle and diamond report both independent failures in order" : "cycle and symlink diamond report the shared failure once", { timeout: 5000 }, () => {
    const { root, dist, marker, scope } = fixture(independentFailure);
    try {
      const expected = [
        ...(independentFailure ? [{ file: path.join(scope, "b", "dist", "index.js"), line: 2, specifier: "@myrmidon/other-missing", reason: "пакет не найден в node_modules", packageName: "@myrmidon/other-missing" }] : []),
        { file: path.join(scope, "c", "dist", "index.js"), line: 2, specifier: "@myrmidon/missing", reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing" },
      ];
      const failures = collectFailures(dist);
      assert.deepEqual(failures, expected);
      const expectedLines = [
        ...(independentFailure ? ["node_modules/@myrmidon/b/dist/index.js:2 @myrmidon/other-missing → пакет не найден в node_modules"] : []),
        "node_modules/@myrmidon/c/dist/index.js:2 @myrmidon/missing → пакет не найден в node_modules",
      ];
      assert.deepEqual(formatFailures(failures, root), expectedLines);
      const output = [];
      const code = main(["--dist", "server/dist"], { log: (line) => output.push(line), error: (line) => output.push(line) }, root);
      assert.equal(code, 1);
      assert.deepEqual(output, [...expectedLines, independentFailure ? "2 сбоя в 2 пакетах" : "1 сбой в 1 пакете"]);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
