import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("SDK build dependency invalidation node contract", () => {
  const result = spawnSync(process.execPath, ["--test", path.join(root, "scripts/myrmidon/ci/build-deps-sdk-invalidation.myrmidon.test.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 70_000);
