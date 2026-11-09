import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";

it("runs the DOCS-CHAIN task generator regression suite without skips", () => {
  const suite = fileURLToPath(
    new URL("../../scripts/docs-chain/create-chain-tasks.test.mjs", import.meta.url),
  );
  const output = execFileSync(process.execPath, ["--test", suite], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  expect(output).toContain("fail 0");
  expect(output).toContain("skipped 0");
}, 35_000);
