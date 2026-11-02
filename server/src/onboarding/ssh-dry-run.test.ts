// myrmidon(SERVER-ONBOARD): behavioural tests for the real SSH dry-run
// executor's sudo detection.
//
// The production executor sends a remote command over SSH and must only
// report `passwordlessSudo: true` when `sudo -n true` actually succeeds.
// These tests verify the shell command string that the executor builds so
// that a regression in the shell logic is caught without needing a live
// SSH server.
//
// We intercept `child_process.execFile` via vi.mock and capture the
// arguments passed to the ssh invocation.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Mock child_process.execFile before any module under test loads ----

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

// Import after the mock is registered.
import { createRealSshDryRunExecutor } from "./ssh-dry-run.js";

// The private key material used in tests — a well-formed PEM marker is
// enough because the executor only writes it to a temp file; no real SSH
// connection is made (execFile is mocked).
const TEST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
TESTKEYMARKER
-----END OPENSSH PRIVATE KEY-----`;

const TEST_KEY_MARKER = "TESTKEYMARKER";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface CapturedCall {
  args: string[];
}

function captureNextExecFileCall(result: { error: Error | null; stdout: string; stderr: string }): Promise<CapturedCall> {
  return new Promise((resolve, reject) => {
    execFileMock.mockImplementationOnce(
      (_file: unknown, args: unknown, _opts: unknown, cb?: ExecFileCallback) => {
        if (typeof cb !== "function") {
          reject(new Error("execFile called without callback"));
          return;
        }
        resolve({ args: args as string[] });
        // Defer invoking the callback so the caller can observe the args
        // before the result is delivered.
        setImmediate(() => {
          cb(result.error, result.stdout, result.stderr);
        });
      },
    );
  });
}

describe("createRealSshDryRunExecutor — sudo detection", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("uses '&& echo SUDO_OK' so the marker only appears when sudo succeeds", async () => {
    const executor = createRealSshDryRunExecutor();

    const capturedPromise = captureNextExecFileCall({
      error: null,
      stdout: "Linux node-a 6.1.0 x86_64\nSUDO_OK\n",
      stderr: "",
    });

    const probePromise = executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: TEST_KEY,
    });

    const captured = await capturedPromise;

    expect(captured.args.length).toBeGreaterThan(0);
    const remoteCmd = captured.args[captured.args.length - 1]!;
    expect(remoteCmd).toContain("sudo -n true 2>/dev/null && echo SUDO_OK");
    // Must NOT use ';' before echo — that would print SUDO_OK unconditionally.
    expect(remoteCmd).not.toContain("; echo SUDO_OK");

    const result = await probePromise;
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.passwordlessSudo).toBe(true);
    }
  });

  it("reports passwordlessSudo=false when sudo marker is absent from stdout", async () => {
    const executor = createRealSshDryRunExecutor();

    const capturedPromise = captureNextExecFileCall({
      error: null,
      stdout: "Linux node-a 6.1.0 x86_64\n",
      stderr: "",
    });

    const probePromise = executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: TEST_KEY,
    });

    await capturedPromise;

    const result = await probePromise;
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.passwordlessSudo).toBe(false);
    }
  });

  it("never places the private key material in the ssh argument list", async () => {
    const executor = createRealSshDryRunExecutor();

    const capturedPromise = captureNextExecFileCall({
      error: null,
      stdout: "Linux node-a 6.1.0 x86_64\n",
      stderr: "",
    });

    const probePromise = executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: TEST_KEY,
    });

    const captured = await capturedPromise;

    const allArgs = captured.args.join(" ");
    expect(allArgs).not.toContain(TEST_KEY_MARKER);

    await probePromise;
  });
});
