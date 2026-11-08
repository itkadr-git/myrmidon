import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// OPE-12084 (AUDIT-PHASE-1): acceptance tests for scripts/vendor-share.py —
// JSON with overall_percent + by_component, exit code 0, tolerant of empty
// subdirectories. Pure stdlib Python; tests run via node:test under
// scripts/myrmidon so they are covered by the Script tests CI step.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "vendor-share.py");

function git(repo, args) {
  const res = spawnSync("git", ["-c", "user.email=t@e.c", "-c", "user.name=t", ...args], {
    cwd: repo,
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function write(repo, rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("scripts/vendor-share.py (OPE-12084)", () => {
  it("prints valid JSON with overall_percent, by_component, exits 0, and tolerates empty directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-share-py-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);

    try {
      write(repo, "server/src/services/heartbeat.ts", "a\nb\nc\n");
      write(repo, "ui/src/pages/Board.tsx", "u1\nu2\n");
      write(repo, "packages/mcp-server/index.mjs", "m1\nm2\n");
      write(repo, "packages/paperclip-runner/loop.js", "r1\nr2\n");
      write(repo, "tools/fleetd/main.go", "f1\nf2\n");
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "base"]);
      const baseSha = git(repo, ["rev-parse", "HEAD"]);

      // Copy the metric of record into the fixture so the delegate is available
      const metricDst = path.join(repo, "scripts", "myrmidon");
      fs.mkdirSync(metricDst, { recursive: true });
      fs.copyFileSync(
        path.join(repoRoot, "scripts", "myrmidon", "vendor-share.mjs"),
        path.join(metricDst, "vendor-share.mjs")
      );

      // Introduce an empty directory (git won't track it, but the filesystem has it)
      fs.mkdirSync(path.join(repo, "server", "src", "empty-dir"), { recursive: true });

      const res = spawnSync(process.execPath ? "python3" : "python3", [
        scriptPath,
        "--repo", repo,
        "--base", baseSha,
        "--compact",
      ], {
        encoding: "utf-8",
      });

      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      const payload = JSON.parse(res.stdout);
      assert.ok(typeof payload.overall_percent === "number", "overall_percent is a number");
      assert.ok(payload.by_component && typeof payload.by_component === "object", "by_component exists");

      const expectedComponents = ["server", "ui", "mcp", "worker", "fleet", "other"];
      for (const comp of expectedComponents) {
        assert.ok(comp in payload.by_component, `component ${comp} in by_component`);
        assert.ok(typeof payload.by_component[comp].total === "number");
        assert.ok(typeof payload.by_component[comp].vendor_derived === "number");
        assert.ok(typeof payload.by_component[comp].percent === "number");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
