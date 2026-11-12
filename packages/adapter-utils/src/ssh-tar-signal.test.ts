import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncDirectoryFromSsh } from "./ssh.js";

// Connection details are never dialed: the fake `ssh` on PATH replaces the real
// client, and the fake `tar` kills itself with an uncatchable signal so its
// close event reports code === null (the killed-process shape from the bug).
const SPEC = {
  host: "127.0.0.1",
  port: 22,
  username: "root",
  remoteWorkspacePath: "/tmp/paperclip-tar-signal-unused",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

describe("syncDirectoryFromSsh local tar termination", () => {
  it("rejects with a signal error, keeps the target directory, and removes staging when tar is killed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-tar-signal-"));
    try {
      const fakeBin = path.join(rootDir, "bin");
      const localDir = path.join(rootDir, "local");
      await mkdir(fakeBin, { recursive: true });
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, "keep.txt"), "must survive a failed restore");
      const fakeTar = path.join(fakeBin, "tar");
      await writeFile(fakeTar, '#!/bin/sh\nkill -KILL "$$"\n');
      await chmod(fakeTar, 0o755);
      const fakeSsh = path.join(fakeBin, "ssh");
      await writeFile(fakeSsh, "#!/bin/sh\nprintf x\n");
      await chmod(fakeSsh, 0o755);

      const stagingPrefix = "paperclip-ssh-sync-back-";
      const stagingBefore = (await readdir(os.tmpdir())).filter((name) => name.startsWith(stagingPrefix));

      // syncDirectoryFromSsh spawns `ssh` and `tar` with the ambient PATH; the
      // swap is confined to this call and restored even when the promise rejects.
      const previousPath = process.env.PATH;
      process.env.PATH = fakeBin;
      let outcome: unknown;
      try {
        outcome = await syncDirectoryFromSsh({
          spec: SPEC,
          remoteDir: path.posix.join(SPEC.remoteWorkspacePath, "unused"),
          localDir,
          exclude: [],
        }).then(
          () => "resolved",
          (error: unknown) => error,
        );
      } finally {
        process.env.PATH = previousPath;
      }

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/signal/);

      // A failed restore must not be reported as success: the target directory
      // keeps its previous content instead of being replaced by the truncated
      // staging copy.
      await expect(stat(path.join(localDir, "keep.txt"))).resolves.toBeTruthy();
      await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe(
        "must survive a failed restore",
      );

      // The staging directory is removed on the failure path, not leaked.
      const stagingAfter = (await readdir(os.tmpdir())).filter((name) => name.startsWith(stagingPrefix));
      expect(stagingAfter).toEqual(stagingBefore);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
