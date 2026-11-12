import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// myrmidon(OPE-12844): behavioral tests for the fix in #2959 (OPE-12794).
// Same approach as ssh-sync-back-cleanup.myrmidon.test.ts: a fake `ssh` first
// on PATH, no sshd and no real network. Three behaviors are pinned:
// 1) a child that exits before the stdin write finishes (early stdin close,
//    EPIPE) settles `spawnText` through `runSshCommand` as a managed error —
//    before the fix the stdin stream had no "error" listener and the process
//    died with an unhandled exception;
// 2) in the tar|ssh upload pair (`syncDirectoryToSsh`) an ssh side that dies
//    early stops the paired tar (SIGTERM through the stdin error handler or
//    the ssh-close handler) and settles with the ssh report instead of hanging;
// 3) stderr above the 64 KiB tail limit (`createStderrTailBuffer`) is capped
//    to the tail and marked with «…обрезано N байт»: the beginning is dropped,
//    the end is kept, so the final diagnostic line survives.

const SYNC_BACK_PREFIX = "paperclip-ssh-sync-back-";

const FAKE_SSH_SCRIPT = `#!/bin/sh
case "$FAKE_SSH_MODE" in
  drop-stdin)
    # Exits before reading stdin, like a remote that refuses the session.
    echo "remote host closed connection" >&2
    exit 255 ;;
  large-stderr)
    # ~98 KiB of unique stderr lines, then the final diagnostic and a failure.
    awk 'BEGIN { for (i = 1; i <= 2000; i++) printf "stderr-line-%04d-padding-padding-padding-padding\\n", i }' >&2
    echo "ssh: transfer closed with 1 error(s) remaining" >&2
    exit 255 ;;
  *)
    cat >/dev/null 2>&1
    exit 0 ;;
esac
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

describe.skipIf(process.platform === "win32")("ssh stdin EPIPE and stderr tail (fix #2959)", () => {
  let rootDir = "";
  let isolatedTmp = "";
  let sourceDir = "";
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(key: string, value: string): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  async function leftoverStagingDirs(): Promise<string[]> {
    return (await readdir(isolatedTmp)).filter((name) => name.startsWith(SYNC_BACK_PREFIX));
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "ssh-stdin-epipe-test-"));
    isolatedTmp = path.join(rootDir, "tmp");
    sourceDir = path.join(rootDir, "source-dir");
    const binDir = path.join(rootDir, "bin");
    await Promise.all([
      mkdir(isolatedTmp, { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    await writeFile(path.join(binDir, "ssh"), FAKE_SSH_SCRIPT, { mode: 0o755 });
    // Enough bytes that tar is still writing when the fake ssh is long gone.
    await writeFile(path.join(sourceDir, "large.bin"), Buffer.alloc(1024 * 1024, 0xaa));

    // myrmidon(OPE-12727): the sync-back staging directory lands in a private
    // tmpdir, not in the shared /tmp.
    setEnv("TMPDIR", isolatedTmp);
    setEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("spawnText settles as a managed error when the child exits before the stdin write ends", async () => {
    // runSshCommand with stdin goes through spawnText; a large payload makes
    // the write outlive the fake ssh, so the stdin stream reports EPIPE.
    setEnv("FAKE_SSH_MODE", "drop-stdin");

    // Either the stdin write error surfaces ("ssh stdin: …") or the close with
    // code 255 does — both are managed outcomes. An unhandled 'error' event on
    // child.stdin would crash the test process instead of rejecting.
    await expect(runSshCommand(spec, "echo done", { stdin: "x".repeat(512 * 1024) })).rejects.toThrow(
      /ssh stdin|remote host closed connection|exited with code 255/,
    );
  });

  it("stops the paired tar and settles when ssh dies early during upload", async () => {
    setEnv("FAKE_SSH_MODE", "drop-stdin");

    // The upload pipes tar stdout into ssh stdin; the fake ssh exits 255
    // without reading it. The promise must settle with the ssh failure and tar
    // must be stopped — a hang or an unhandled stdin error would fail the test.
    await expect(syncDirectoryToSsh({ spec, localDir: sourceDir, remoteDir: "/workspace" })).rejects.toThrow(
      /ssh stdin|remote host closed connection|exited with code 255|exited before tar finished/,
    );
  }, 20_000);

  it("caps stderr above the tail limit with the truncation marker, keeping the end", async () => {
    setEnv("FAKE_SSH_MODE", "large-stderr");

    // The download direction reports ssh's stderr through the tail buffer when
    // ssh closes: every 'data' chunk is delivered before 'close', so the cap
    // and the marker are deterministic here.
    let caughtError: unknown = null;
    try {
      await syncDirectoryFromSsh({ spec, remoteDir: "/workspace", localDir: sourceDir });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const message = (caughtError as Error).message;
    // Marker with the dropped byte count, and the kept tail reaches the final
    // diagnostic line while the dropped head is gone.
    expect(message).toMatch(/…обрезано \d+ байт/);
    expect(message).toContain("stderr-line-2000");
    expect(message).toContain("transfer closed with 1 error");
    expect(message).not.toContain("stderr-line-0001");

    // The failed restore still removed its staging directory.
    expect(await leftoverStagingDirs()).toEqual([]);
  }, 20_000);
});
