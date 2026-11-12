import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncDirectoryFromSsh } from "./ssh.js";

// myrmidon(OPE-12788): fake `ssh` and `tar` executables on PATH stand in for a
// real transfer, so a tar killed by a signal (exit code null) can be reproduced
// without sshd.
describe.skipIf(process.platform === "win32")("syncDirectoryFromSsh when local tar dies", () => {
  let rootDir = "";
  let previousPath: string | undefined;
  let previousTmpdir: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-signal-"));
    previousPath = process.env.PATH;
    previousTmpdir = process.env.TMPDIR;
    await mkdir(path.join(rootDir, "bin"), { recursive: true });
    await mkdir(path.join(rootDir, "tmp"), { recursive: true });
    await writeFile(path.join(rootDir, "bin", "ssh"), "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path.join(rootDir, "bin", "ssh"), 0o755);
    process.env.PATH = `${path.join(rootDir, "bin")}${path.delimiter}${previousPath ?? ""}`;
    // The restore staging directory is created under os.tmpdir().
    process.env.TMPDIR = path.join(rootDir, "tmp");
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(rootDir, { recursive: true, force: true });
  });

  async function runRestore(tarScript: string): Promise<unknown> {
    await writeFile(path.join(rootDir, "bin", "tar"), tarScript, "utf8");
    await chmod(path.join(rootDir, "bin", "tar"), 0o755);
    const localDir = path.join(rootDir, "work");
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "keep.txt"), "original\n", "utf8");
    let caught: unknown = null;
    try {
      await syncDirectoryFromSsh({
        spec: {
          host: "127.0.0.1",
          port: 22,
          username: "u",
          remoteWorkspacePath: "/remote",
          remoteCwd: "/remote",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: false,
        },
        remoteDir: "/remote",
        localDir,
      });
    } catch (error) {
      caught = error;
    }
    // The working copy must be untouched and the staging directory removed.
    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("original\n");
    await expect(readdir(path.join(rootDir, "tmp"))).resolves.toEqual([]);
    return caught;
  }

  it.each(["TERM", "KILL"])("rejects with the signal name when tar is killed by SIG%s", async (signal) => {
    const caught = await runRestore(`#!/bin/sh\nkill -${signal} $$\n`);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(`tar terminated by signal SIG${signal}`);
  });

  it("still rejects with the exit code when tar exits non-zero", async () => {
    const caught = await runRestore("#!/bin/sh\nexit 3\n");
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("tar exited with code 3");
  });
});
