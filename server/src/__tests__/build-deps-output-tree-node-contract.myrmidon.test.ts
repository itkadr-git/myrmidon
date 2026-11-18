import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("build dependency output tree node contract", () => {
  const contract = fileURLToPath(new URL("../../../scripts/myrmidon/ci/build-deps-output-tree.myrmidon.test.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
