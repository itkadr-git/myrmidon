import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-docker-deps-stage.mjs", import.meta.url));

test("deps stage accepts tab-separated shell COPY only", () => {
  const root = mkdtempSync(path.join(process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir(), "deps-copy-"));
  try {
    mkdirSync(path.join(root, "packages/alpha"), { recursive: true });
    writeFileSync(path.join(root, "packages/alpha/package.json"), "{}");
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    for (const [instruction, expected] of [
      ["COPY\tpackages/alpha/package.json /app/", 0],
      ["COPY packages/alpha/package.json /app/", 0],
      ["COPYX\tpackages/alpha/package.json /app/", 1],
      ["copy\tpackages/alpha/package.json /app/", 1],
      ['COPY\t["packages/alpha/package.json", "/app/"]', 1],
      ["COPY\t\\\n  packages/alpha/package.json /app/", 1],
    ]) {
      writeFileSync(path.join(root, "Dockerfile"), `FROM node AS deps\n${instruction}\nFROM node AS final\n`);
      const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, expected, `${instruction}: ${result.stderr}`);
      if (expected === 0) assert.match(result.stdout, /^PASS\s*$/);
      else assert.match(result.stderr, /missing package manifest coverage for: packages\/alpha\/package\.json/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
