import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemGitRunner } from "./git-export-git.js";

describe("knowledge export system git runner failures", () => {
  it("rejects nonzero exits and timeouts, kills the child, and remains usable", async () => {
    const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir(), "git-runner-"));
    const pidFile = path.join(root, "pid");
    const env = {
      PATH: root,
      HOME: root,
      GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      SHIM_PID_FILE: pidFile,
    };
    let pid: number | undefined;
    try {
      await writeFile(path.join(root, "git"), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'fail') {
  process.stdout.write('failure stdout\\n');
  process.stderr.write('failure stderr\\n');
  process.exitCode = 7;
} else if (process.argv[2] === 'hang') {
  fs.writeFileSync(process.env.SHIM_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('success stdout\\n');
  process.stderr.write('success stderr\\n');
}
`, { mode: 0o755 });
      const runner = createSystemGitRunner(1000);
      await expect(runner.git(root, ["fail"], env)).rejects.toMatchObject({
        code: 7, stdout: "failure stdout\n", stderr: "failure stderr\n",
      });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const bounded = Promise.race([
          runner.git(root, ["hang"], env),
          new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("runner did not time out")), 4000); }),
        ]);
        await expect(bounded).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
      } finally {
        clearTimeout(watchdog);
      }
      pid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      await expect(runner.git(root, ["success"], env)).resolves.toEqual({
        stdout: "success stdout\n", stderr: "success stderr\n",
      });
    } finally {
      if (pid === undefined) {
        pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      }
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
