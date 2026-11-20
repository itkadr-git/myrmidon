import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("executes the explain source byte refresh contract", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "scripts/myrmidon/bundle-audit/import-report-explain-source-byte-refresh.myrmidon.test.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/# pass 1\b/);
  expect(result.stdout).toMatch(/# fail 0\b/);
}, 65000);
