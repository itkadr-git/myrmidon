import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the subgraph source-byte refresh CLI contract", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = spawnSync(process.execPath, ["--test", path.join(root, "scripts/myrmidon/bundle-audit/import-report-subgraph-source-byte-refresh.myrmidon.test.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/(?:pass 1|ok 1)/);
}, 65_000);
