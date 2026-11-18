import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("executes the release package reload node contract", () => {
  const contract = path.resolve(process.cwd(), "scripts/release-package-check-reload.myrmidon.test.mjs");
  const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
