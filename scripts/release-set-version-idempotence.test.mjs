import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));

test("set-version accepts a repeated literal CLI version without changing bytes", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(scratch, "myrmidon-version-idempotence-"));
  const put = (path, data) => {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  };
  try {
    put("scripts/release-package-manifest.json", JSON.stringify([{ dir: "cli", name: "myrmidon", publishFromCi: true }]));
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    put("cli/package.json", '{"name":"myrmidon","version":"old"}\n');
    put("cli/src/index.ts", 'program.version("old");\n');
    const invoke = () => spawnSync(process.execPath, [join(root, "scripts/release-package-map.mjs"), "set-version", "2026.11.16"], { encoding: "utf8" });
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    const paths = ["cli/package.json", "cli/src/index.ts"];
    const before = paths.map((path) => readFileSync(join(root, path)));
    const second = invoke();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(paths.map((path) => readFileSync(join(root, path))), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
