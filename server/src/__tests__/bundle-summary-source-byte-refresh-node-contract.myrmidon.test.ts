import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("summary source byte refresh node contract", () => {
  const contract = resolve(process.cwd(), "scripts/myrmidon/bundle-audit/import-report-summary-source-byte-refresh.myrmidon.test.mjs");
  const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
