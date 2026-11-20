import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the condensation source byte refresh contract", () => {
  const contract = fileURLToPath(new URL("../../../scripts/myrmidon/bundle-audit/import-report-condensation-source-byte-refresh.myrmidon.test.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
