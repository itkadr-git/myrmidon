import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const contract = fileURLToPath(new URL("../../../scripts/myrmidon/bundle-audit/import-report-sinks-source-byte-refresh.myrmidon.test.mjs", import.meta.url));

it("runs the sinks source byte refresh contract", () => {
  const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
