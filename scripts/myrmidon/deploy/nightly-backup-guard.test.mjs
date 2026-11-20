import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const guard = fileURLToPath(new URL("./nightly-backup-guard.sh", import.meta.url));

test("a failed operator backup query stops the guard", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nightly-guard-"));
  try {
    writeFileSync(path.join(dir, "runuser"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const result = spawnSync("bash", [guard], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PBS query failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
