import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";

it("runs the ADM connector cache and budget regression suite without database skips", () => {
  const suite = fileURLToPath(new URL("../../scripts/adm-connector/cache.test.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--test", suite], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  expect(output).toContain("fail 0");
  expect(output).toContain("skipped 0");
}, 35_000);
