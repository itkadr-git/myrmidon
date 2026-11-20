import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemGitRunner } from "./git-export-git.js";

describe("system git runner", () => {
  it("preserves argv, cwd, environment and both output streams without a shell", async () => {
    const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR ?? process.env.MYRMIDON_SCRATCH_DIR ?? os.homedir(), "git-runner-"));
    const originalEnv = { ...process.env };
    try {
      const bin = path.join(root, "bin");
      const cwd = path.join(root, "working directory");
      const marker = path.join(root, "shell-marker");
      await mkdir(bin);
      await mkdir(cwd);
      const shim = path.join(bin, "git");
      await writeFile(shim, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), inherited: process.env.RUNNER_INHERITED, overridden: process.env.RUNNER_OVERRIDE, added: process.env.RUNNER_ADDED }));\nprocess.stderr.write("separate stderr\\n");\n`);
      await chmod(shim, 0o755);
      process.env.RUNNER_INHERITED = "caller value";
      process.env.RUNNER_OVERRIDE = "caller original";
      const before = { ...process.env };
      const args = ["space value", "\u96ea \u03bb", "--leading-dash", `$(touch ${marker})`, "; touch " + marker, "'quoted'", "a&b|c"];
      const expected = JSON.stringify({ argv: args, cwd, inherited: "caller value", overridden: "child override", added: "child only" });
      const result = await createSystemGitRunner().git(cwd, args, {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_OVERRIDE: "child override",
        RUNNER_ADDED: "child only",
      });
      expect(result.stdout).toBe(expected);
      expect(result.stderr).toBe("separate stderr\n");
      expect(process.env).toEqual(before);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const key of ["RUNNER_INHERITED", "RUNNER_OVERRIDE"]) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
