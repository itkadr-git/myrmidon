import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import * as myrmidon from "./myrmidon/index.js";

const baselineTxtPath = fileURLToPath(new URL("./baseline-exports.txt", import.meta.url));
const baselineExports = readFileSync(baselineTxtPath, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

describe("shared export surface snapshot (OPE-9341)", () => {
  it("preserves every symbol from the baseline export snapshot", () => {
    const missing: string[] = [];
    for (const name of baselineExports) {
      if (!(name in shared)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("exports key Myrmidon domain contracts through the root index", () => {
    expect(shared.PRODUCT_NAME).toBe("Myrmidon");
    expect(typeof shared.buildContinuationKey).toBe("function");
    expect(shared.blockerGraphRootsResponseSchema).toBeDefined();
    expect(shared.INTERACTION_ROUTE_TYPES).toBeDefined();
    expect(shared.recoveryFactoryRequestSchema).toBeDefined();
    expect(typeof shared.mergeCapacityPolicyPatch).toBe("function");
    expect(shared.agentAdapterTypeSchema).toBeDefined();
    expect(shared.RUNNER_GOAL_MAX_OBJECTIVE_CHARS).toBeDefined();
  });

  it("exports key Myrmidon domain contracts through the myrmidon barrel", () => {
    expect(myrmidon.PRODUCT_NAME).toBe("Myrmidon");
    expect(typeof myrmidon.buildContinuationKey).toBe("function");
    expect(myrmidon.blockerGraphRootsResponseSchema).toBeDefined();
    expect(myrmidon.INTERACTION_ROUTE_TYPES).toBeDefined();
    expect(myrmidon.recoveryFactoryRequestSchema).toBeDefined();
    expect(typeof myrmidon.mergeCapacityPolicyPatch).toBe("function");
  });

  it("functional execution of exported contracts works as expected", () => {
    const key = shared.buildContinuationKey({
      issueId: "issue-snapshot-test",
      event: "issue_continuation_needed",
      head: "comment-1",
    });
    expect(key).toMatch(/^continuation:v1:[0-9a-f]{32}$/);

    expect(Array.isArray(shared.INTERACTION_ROUTE_TYPES)).toBe(true);
    expect(shared.INTERACTION_ROUTE_TYPES).toContain("decision");
  });
});

describe("generate-shared-exports behavior (OPE-9341)", () => {
  it("rejects stale barrel output with --check and accepts regenerated output", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "shared-exports-test-"));
    try {
      const myrmidonDir = join(fixtureDir, "packages/shared/src/myrmidon");
      const barrelPath = join(myrmidonDir, "index.ts");
      mkdirSync(myrmidonDir, { recursive: true });

      writeFileSync(join(myrmidonDir, "test-mod.ts"), "export const TEST_MOD = 1;\n");

      const scriptPath = fileURLToPath(
        new URL("../../../scripts/generate-shared-exports.mjs", import.meta.url),
      );

      // --check on missing or stale barrel must fail with non-zero exit code
      let staleFailed = false;
      try {
        execFileSync(process.execPath, [scriptPath, "--root", fixtureDir, "--check"], {
          stdio: "pipe",
        });
      } catch (err: any) {
        staleFailed = true;
        expect(err.status).toBe(1);
      }
      expect(staleFailed).toBe(true);

      // Running without --check generates the barrel
      execFileSync(process.execPath, [scriptPath, "--root", fixtureDir], { stdio: "pipe" });
      expect(existsSync(barrelPath)).toBe(true);

      // --check now passes
      const checkResult = execFileSync(
        process.execPath,
        [scriptPath, "--root", fixtureDir, "--check"],
        {
          encoding: "utf8",
        },
      );
      expect(checkResult).toContain("up to date");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
