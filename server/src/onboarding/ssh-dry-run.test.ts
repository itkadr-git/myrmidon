// myrmidon(SERVER-ONBOARD): behavioural tests for the real SSH dry-run
// executor's sudo detection.
//
// The production executor sends a remote command over SSH and must only
// report `passwordlessSudo: true` when `sudo -n true` actually succeeds.
// These tests verify the shell command string that the executor builds so
// that a regression in the shell logic is caught without needing a live
// SSH server.
//
// We intercept `child_process.execFile` and capture the arguments.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRealSshDryRunExecutor } from "./ssh-dry-run.js";

// The private key material used in tests — a well-formed PEM marker is
// enough because the executor only writes it to a temp file; no real SSH
// connection is made (execFile is mocked).
const TEST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
TESTKEYMARKER
-----END OPENSSH PRIVATE KEY-----`;

const TEST_KEY_MARKER = "TESTKEYMARKER";

describe("createRealSshDryRunExecutor — sudo detection", () => {
  let execFileSpy: ReturnType<typeof vi.spyOn>;
  let capturedArgs: string[] | null = null;
  let execCallback: ((error: Error | null, stdout: string, stderr: string) => void) | null = null;

  beforeEach(() => {
    capturedArgs = null;
    execCallback = null;

    // Mock execFile to capture the ssh command and args, then invoke the
    // callback synchronously with a canned result.
    const cp = require("node:child_process") as typeof import("node:child_process");
    execFileSpy = vi.spyOn(cp, "execFile").mockImplementation(
      (
        _file: unknown,
        args: unknown,
        _opts: unknown,
        cb?: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        capturedArgs = args as string[];
        execCallback = cb ?? null;
        // Return immediately; the caller awaits a promise we resolve below.
        return {} as ReturnType<typeof cp.execFile>;
      },
    );
  });

  afterEach(() => {
    execFileSpy.mockRestore();
  });

  function completeProbe(result: { error: Error | null; stdout: string; stderr: string }) {
    // Allow the executor's promise chain to settle before firing the callback.
    setImmediate(() => {
      execCallback?.(result.error, result.stdout, result.stderr);
    });
  }

  it("uses '&& echo SUDO_OK' so the marker only appears when sudo succeeds", async () => {
    const executor = createRealSshDryRunExecutor();

    const probePromise = executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: TEST_KEY,
    });

    // Wait for the executor to reach the execFile call.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(capturedArgs).not.toBeNull();
    const remoteCmd = capturedArgs![capturedArgs!.length - 1]!;
    expect(remoteCmd).toContain("sudo -n true 2>/dev/null && echo SUDO_OK");
    // Must NOT use ';' before echo — that would print SUDO_OK unconditionally.
    expect(remoteCmd).not.toContain("; echo SUDO_OK");

    completeProbe({
      error: null,
      stdout: "Linux node-a 6.1.0 x86_64\nSUDO_OK\n",
      stderr: "",
    });

    const result = await probePromise;
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.passwordlessSudo).toBe(true);
    }
  });

  it("reports passwordlessSudo=false when sudo marker is absent from stdout", async () => {
    const executor = createRealSshDryRunExecutor();

    const probePromise = executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: TEST_KEY,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    completeProbe({
      error: null,
      stdout: "Linux node-a 6.1.0 x86_64\n",
      stderr: "",
    });

    const result = await probePromise;
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.passwordlessSudo).toBe(false);
    }
  });

  it("never places the private key material in the ssh argument list", async () => {
    const executor = createRealSshDryRunExecutor();

    const probePromise = executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: TEST_KEY,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(capturedArgs).not.toBeNull();
    const allArgs = capturedArgs!.join(" ");
    expect(allArgs).not.toContain(TEST_KEY_MARKER);

    completeProbe({
      error: null,
      stdout: "Linux node-a 6.1.0 x86_64\n",
      stderr: "",
    });

    await probePromise;
  });
});
