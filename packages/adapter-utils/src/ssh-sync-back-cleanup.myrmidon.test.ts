import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncDirectoryFromSsh, type SshRemoteExecutionSpec } from "./ssh.js";

// OPE-12727: the board pulls a run's workspace back from an SSH runner into
// `<tmp>/paperclip-ssh-sync-back-XXXXXX`; leftovers of 0.7-4.1 GB each filled
// the board's /tmp (26 GB on 12.11). These tests put a fake `ssh` first on PATH
// (it serves a tar stream, or fails the way ssh does) and point `os.tmpdir()`
// at a private directory, so they need neither a sshd nor a shared /tmp. A fake
// `tar` in front of the real one can die on extraction, like tar on a full disk.

const execFileAsync = promisify(execFile);
const SYNC_BACK_PREFIX = "paperclip-ssh-sync-back-";

const FAKE_SSH_SCRIPT = `#!/bin/sh
case "$FAKE_SSH_MODE" in
  serve)
    exec tar -cf - -C "$FAKE_SSH_SOURCE_DIR" . ;;
  refuse)
    echo "ssh: connect to host runner.invalid port 2222: Connection refused" >&2
    exit 255 ;;
  truncated)
    tar -cf - -C "$FAKE_SSH_SOURCE_DIR" . | head -c 20000
    echo "Connection reset by peer" >&2
    exit 255 ;;
esac
`;

// Fails only the extracting side (`tar -xf -`); every other call reaches the
// real tar, including the one the fake ssh uses to produce the stream.
const FAKE_TAR_SCRIPT = `#!/bin/sh
if [ "$FAKE_TAR_MODE" = "die-on-extract" ] && [ "$1" = "-xf" ]; then
  echo "tar: ./big.bin: Cannot write: No space left on device" >&2
  exit 2
fi
PATH="$FAKE_ORIGINAL_PATH"
export PATH
exec tar "$@"
`;

const spec: SshRemoteExecutionSpec = {
  host: "runner.invalid",
  port: 2222,
  username: "paperclip",
  remoteWorkspacePath: "/workspace",
  remoteCwd: "/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

describe.skipIf(process.platform === "win32")("syncDirectoryFromSsh staging directory cleanup", () => {
  let rootDir = "";
  let isolatedTmp = "";
  let sourceDir = "";
  let localDir = "";
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(key: string, value: string): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  async function leftoverStagingDirs(): Promise<string[]> {
    return (await readdir(isolatedTmp)).filter((name) => name.startsWith(SYNC_BACK_PREFIX));
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "ssh-sync-back-cleanup-test-"));
    isolatedTmp = path.join(rootDir, "tmp");
    sourceDir = path.join(rootDir, "remote-workspace");
    localDir = path.join(rootDir, "local-workspace");
    const binDir = path.join(rootDir, "bin");
    await Promise.all([
      mkdir(isolatedTmp, { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
      mkdir(localDir, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    await writeFile(path.join(binDir, "ssh"), FAKE_SSH_SCRIPT, { mode: 0o755 });
    await writeFile(path.join(binDir, "tar"), FAKE_TAR_SCRIPT, { mode: 0o755 });
    await writeFile(path.join(sourceDir, "hello.txt"), "hello from the runner\n", "utf8");
    await writeFile(path.join(sourceDir, "big.bin"), Buffer.alloc(256 * 1024, 7));

    setEnv("TMPDIR", isolatedTmp);
    setEnv("FAKE_ORIGINAL_PATH", process.env.PATH ?? "");
    setEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
    setEnv("FAKE_SSH_SOURCE_DIR", sourceDir);
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    // Tests create read-only directories on purpose; make them removable first.
    await execFileAsync("chmod", ["-R", "u+rwx", rootDir]).catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("removes the staging directory after a successful sync-back", async () => {
    setEnv("FAKE_SSH_MODE", "serve");

    await syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir });

    expect(await readFile(path.join(localDir, "hello.txt"), "utf8")).toBe("hello from the runner\n");
    expect(await leftoverStagingDirs()).toEqual([]);
  });

  it("removes the staging directory when ssh fails", async () => {
    setEnv("FAKE_SSH_MODE", "refuse");

    await expect(syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir })).rejects.toThrow(
      "Connection refused",
    );

    expect(await leftoverStagingDirs()).toEqual([]);
  });

  it("removes a partly extracted staging directory when the stream is cut", async () => {
    setEnv("FAKE_SSH_MODE", "truncated");

    await expect(syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir })).rejects.toThrow(
      "Connection reset by peer",
    );

    expect(await leftoverStagingDirs()).toEqual([]);
  });

  it("settles and removes the staging directory when tar dies while ssh is still sending", async () => {
    // ssh blocks on a full pipe once nothing reads its output, so before the fix
    // the restore never settled and its `finally` never ran.
    setEnv("FAKE_SSH_MODE", "serve");
    setEnv("FAKE_TAR_MODE", "die-on-extract");

    await expect(syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir })).rejects.toThrow(
      "No space left on device",
    );

    expect(await leftoverStagingDirs()).toEqual([]);
  }, 20_000);

  it("removes a staging directory that holds read-only directories", async () => {
    setEnv("FAKE_SSH_MODE", "serve");
    const readOnlyDir = path.join(sourceDir, "pkg", "mod");
    await mkdir(readOnlyDir, { recursive: true });
    await writeFile(path.join(readOnlyDir, "module.go"), "package mod\n", "utf8");
    await chmod(readOnlyDir, 0o555);

    await syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir });

    expect(await readFile(path.join(localDir, "pkg", "mod", "module.go"), "utf8")).toBe("package mod\n");
    expect(await leftoverStagingDirs()).toEqual([]);
  });

  it("prunes staging directories left by a restore whose process died, and only those", async () => {
    setEnv("FAKE_SSH_MODE", "serve");
    const staleDir = path.join(isolatedTmp, `${SYNC_BACK_PREFIX}stale01`);
    const freshDir = path.join(isolatedTmp, `${SYNC_BACK_PREFIX}fresh01`);
    const otherDir = path.join(isolatedTmp, "unrelated-old-dir");
    for (const dir of [staleDir, freshDir, otherDir]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "leftover.bin"), Buffer.alloc(1024, 1));
    }
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await utimes(staleDir, fiveHoursAgo, fiveHoursAgo);
    await utimes(otherDir, fiveHoursAgo, fiveHoursAgo);

    await syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir });

    expect(await leftoverStagingDirs()).toEqual([`${SYNC_BACK_PREFIX}fresh01`]);
    expect((await stat(otherDir)).isDirectory()).toBe(true);
  });
});
