import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncDirectoryToSsh, type SshRemoteExecutionSpec } from "./ssh.js";

// myrmidon(OPE-13041): the upload pipe `tar | ssh` must not depend on the order
// in which the two 'close' events arrive. A fake `ssh` and a fake `tar` are put
// first on PATH; the fake tar reports its exit later than ssh does.

const FAKE_SSH_SCRIPT = `#!/bin/sh
case "$FAKE_SSH_MODE" in
  ssh-fail)
    echo "ssh: remote closed the session" >&2
    exit 255 ;;
  *)
    exit 0 ;;
esac
`;

// Writes nothing to stdout, so the exit order is decided by the sleeps alone.
const FAKE_TAR_SCRIPT = `#!/bin/sh
case "$FAKE_TAR_MODE" in
  late-ok)
    sleep 0.4
    exit 0 ;;
  late-fail)
    echo "tar: ./a.txt: Cannot open: Permission denied" >&2
    sleep 0.4
    exit 2 ;;
  hang)
    exec sleep 30 ;;
  *)
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

describe.skipIf(process.platform === "win32")("ssh upload: tar and ssh exit order (OPE-13041)", () => {
  let rootDir = "";
  let sourceDir = "";
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(key: string, value: string): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "ssh-tar-order-test-"));
    sourceDir = path.join(rootDir, "source-dir");
    const binDir = path.join(rootDir, "bin");
    await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(binDir, { recursive: true })]);
    await writeFile(path.join(binDir, "ssh"), FAKE_SSH_SCRIPT, { mode: 0o755 });
    await writeFile(path.join(binDir, "tar"), FAKE_TAR_SCRIPT, { mode: 0o755 });
    await writeFile(path.join(sourceDir, "a.txt"), "hello");
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

  it("succeeds when ssh closes with code 0 before tar, and tar then exits with 0", async () => {
    setEnv("FAKE_SSH_MODE", "ok");
    setEnv("FAKE_TAR_MODE", "late-ok");
    await expect(syncDirectoryToSsh({ spec, localDir: sourceDir, remoteDir: "/workspace" })).resolves.toBeUndefined();
  });

  it("reports the tar exit code and stderr when tar fails after ssh already exited with 0", async () => {
    setEnv("FAKE_SSH_MODE", "ok");
    setEnv("FAKE_TAR_MODE", "late-fail");
    await expect(syncDirectoryToSsh({ spec, localDir: sourceDir, remoteDir: "/workspace" })).rejects.toThrow(
      /Permission denied/,
    );
  });

  it("reports the ssh failure when ssh exits with a non-zero code before tar", async () => {
    setEnv("FAKE_SSH_MODE", "ssh-fail");
    setEnv("FAKE_TAR_MODE", "hang");
    await expect(syncDirectoryToSsh({ spec, localDir: sourceDir, remoteDir: "/workspace" })).rejects.toThrow(
      /ssh: remote closed the session/,
    );
  });
});
