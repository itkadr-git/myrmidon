import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_REAP = path.join(ROOT, "docker/agent-runtime/omp-ssh/run-reap");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("docker/agent-runtime/omp-ssh/run-reap", () => {
  it("exists and is executable", () => {
    assert.ok(fs.existsSync(RUN_REAP), "run-reap script must exist");
    const stat = fs.statSync(RUN_REAP);
    assert.ok((stat.mode & 0o111) !== 0, "run-reap must be executable");
  });

  it("reaps processes inside the task directory while leaving processes outside alive", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-run-reap-test-"));
    const insideDir = path.join(baseDir, "task-workspace");
    const outsideDir = path.join(baseDir, "other-workspace");
    fs.mkdirSync(insideDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const procInside = spawn("sleep", ["300"], {
      cwd: insideDir,
      stdio: "ignore",
    });
    const procOutside = spawn("sleep", ["300"], {
      cwd: outsideDir,
      stdio: "ignore",
    });

    const insideExit = new Promise((resolve) => procInside.on("exit", (code, signal) => resolve({ code, signal })));

    try {
      assert.ok(procInside.pid && isPidAlive(procInside.pid), "procInside must be running");
      assert.ok(procOutside.pid && isPidAlive(procOutside.pid), "procOutside must be running");

      const result = spawnSync(RUN_REAP, [insideDir], {
        encoding: "utf8",
        timeout: 10_000,
      });

      assert.equal(result.status, 0, `run-reap failed: ${result.stderr}`);
      assert.match(result.stdout, /Stopped [1-9]\d* process\(es\)/);

      const exitInfo = await Promise.race([
        insideExit,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for procInside exit")), 3000)),
      ]);
      assert.ok(exitInfo.signal === "SIGTERM" || exitInfo.signal === "SIGKILL", `procInside was stopped with ${exitInfo.signal}`);
      assert.equal(isPidAlive(procOutside.pid), true, "process outside task directory must remain alive");
    } finally {
      if (procInside.pid && isPidAlive(procInside.pid)) {
        try { process.kill(procInside.pid, "SIGKILL"); } catch {}
      }
      if (procOutside.pid && isPidAlive(procOutside.pid)) {
        try { process.kill(procOutside.pid, "SIGKILL"); } catch {}
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("leaves sibling directories with prefix match alone", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-run-reap-prefix-"));
    const taskDir = path.join(baseDir, "task");
    const siblingDir = path.join(baseDir, "task-other");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });

    const procSibling = spawn("sleep", ["300"], {
      cwd: siblingDir,
      stdio: "ignore",
      detached: true,
    });

    try {
      assert.ok(procSibling.pid && isPidAlive(procSibling.pid));

      const result = spawnSync(RUN_REAP, [taskDir], {
        encoding: "utf8",
        timeout: 10_000,
      });

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Stopped 0 process\(es\)/);
      assert.equal(isPidAlive(procSibling.pid), true, "sibling process must not be killed");
    } finally {
      if (procSibling.pid && isPidAlive(procSibling.pid)) {
        try { process.kill(procSibling.pid, "SIGKILL"); } catch {}
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports 0 stopped processes on missing directory", () => {
    const result = spawnSync(RUN_REAP, ["/tmp/nonexistent-omp-path-12345"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Stopped 0 process\(es\)/);
  });

  it("rejects invalid or root directories", () => {
    const resultRoot = spawnSync(RUN_REAP, ["/"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.notEqual(resultRoot.status, 0);

    const resultEmpty = spawnSync(RUN_REAP, [""], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.notEqual(resultEmpty.status, 0);
  });
});
