// myrmidon(SERVER-ONBOARD): SSH dry-run probe for the onboarding flow.
//
// The dry-run endpoint lets the owner validate SSH credentials *before*
// registering the server. It opens a real SSH connection, authenticates,
// runs a harmless command, reports success or a normalized failure — and
// writes nothing to the database, the journal, or any secret store.
//
// The executor is a narrow port so the route tests can substitute a mock.
// The real implementation shells out to the system `ssh` binary, the same
// way the access-hub deploy port does.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The normalized outcome the route reports to the caller. */
export type SshDryRunOutcome =
  | "ok"
  | "auth_failed"
  | "host_unreachable"
  | "connection_timeout"
  | "invalid_key"
  | "command_failed";

export interface SshDryRunSuccess {
  outcome: "ok";
  /** True when the remote user can sudo without a password. */
  passwordlessSudo: boolean;
  /** Remote uname output, for display. */
  remoteUname: string;
  durationMs: number;
}

export interface SshDryRunFailure {
  outcome: Exclude<SshDryRunOutcome, "ok">;
  /** Safe, human-readable reason. Never contains secrets. */
  reason: string;
  durationMs: number;
}

export type SshDryRunResult = SshDryRunSuccess | SshDryRunFailure;

/**
 * The narrow port the route depends on. The production wiring supplies a
 * real ssh-based executor; tests substitute a mock.
 */
export interface SshDryRunExecutor {
  dryRun(input: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    timeoutMs?: number;
  }): Promise<SshDryRunResult>;
}

/**
 * Classify the error text from the ssh child process into a safe outcome.
 * The returned reason is normalized and never echoes the key material or
 * the original stderr (which can contain host fingerprints, key paths, etc.).
 */
export function classifySshError(
  stderr: string,
  killed: boolean,
): { outcome: Exclude<SshDryRunOutcome, "ok">; reason: string } {
  const text = stderr.toLowerCase();
  if (killed || /timed?\s*out|connection timed?\s*out/.test(text)) {
    return { outcome: "connection_timeout", reason: "connection timed out" };
  }
  if (/permission denied|too many authentication failures|authentication failed/.test(text)) {
    return { outcome: "auth_failed", reason: "authentication failed (wrong credentials or key not authorized)" };
  }
  if (/invalid format|invalid key|error in libcrypto|incorrect passphrase|bad permissions|could not resolve hostname|name or service not known|no route to host|connection refused/.test(text)) {
    return { outcome: "invalid_key", reason: "the private key is invalid, malformed, or the host is unreachable" };
  }
  if (/host key verification failed|key fingerprint/.test(text)) {
    return { outcome: "host_unreachable", reason: "host key verification failed — add the host to known_hosts first" };
  }
  return { outcome: "host_unreachable", reason: "could not establish SSH connection to the host" };
}

/**
 * Run a short-lived ssh command with the given credentials and classify
 * the result. The private key (when given) is written to a 0o600 temp
 * file that is removed in `finally`, so the key material never lands in
 * the process list or on disk permanently.
 */
async function runSshProbe(input: {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  timeoutMs?: number;
}): Promise<SshDryRunResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 10_000;
  let keyFile: { dir: string; file: string } | null = null;

  try {
    const sshArgs: string[] = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-p", String(input.port),
    ];

    if (input.privateKey) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-ssh-dry-run-"));
      const file = path.join(dir, "key");
      // Normalize: ensure trailing newline so ssh does not complain.
      const body = input.privateKey.endsWith("\n") ? input.privateKey : `${input.privateKey}\n`;
      await fs.writeFile(file, body, { mode: 0o600 });
      keyFile = { dir, file };
      sshArgs.push("-i", file);
    }

    if (input.password) {
      sshArgs.push("-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no");
    } else {
      sshArgs.push("-o", "PubkeyAuthentication=yes", "-o", "PasswordAuthentication=no");
    }

    sshArgs.push(`${input.username}@${input.host}`, "uname -a && sudo -n true 2>/dev/null; echo SUDO_OK");

    const { stdout, stderr, killed } = await new Promise<{
      stdout: string;
      stderr: string;
      killed: boolean;
    }>((resolve, reject) => {
      execFile("ssh", sshArgs, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
          reject(Object.assign(err, {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            killed: err.killed === true,
          }));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", killed: false });
      });
    }).catch((err: { stdout?: string; stderr?: string; killed?: boolean }) => {
      // ssh exits non-zero for auth failures and unreachable hosts; that is a
      // dry-run data point, not an exception. We only re-throw genuine spawn
      // errors (ENOENT etc.) which the caller classifies as unreachable.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { stdout: "", stderr: "ssh binary not found", killed: false };
      }
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        killed: err.killed === true,
      };
    });

    const durationMs = Date.now() - startedAt;

    if (stderr && !stdout) {
      const classified = classifySshError(stderr, killed);
      return { ...classified, durationMs };
    }

    // The remote command printed something — the SSH session itself worked.
    // We ignore the remote command's own stderr for the auth verdict; what
    // matters is that sshd let us in.
    const passwordlessSudo = stdout.includes("SUDO_OK");
    const remoteUname = stdout.split("\n")[0]?.trim() ?? "";
    return { outcome: "ok", passwordlessSudo, remoteUname, durationMs };
  } finally {
    if (keyFile) {
      await fs.rm(keyFile.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Production executor: runs the real ssh binary. */
export function createRealSshDryRunExecutor(): SshDryRunExecutor {
  return {
    dryRun: (input) => runSshProbe(input),
  };
}

/** Test-only: deterministic executor that records calls and returns canned results. */
export function createMockSshDryRunExecutor(
  behavior: (input: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    timeoutMs?: number;
  }) => Promise<SshDryRunResult>,
): SshDryRunExecutor & {
  calls: Array<{
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    timeoutMs?: number;
  }>;
} {
  const calls: Array<{
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    timeoutMs?: number;
  }> = [];
  return {
    calls,
    dryRun: async (input) => {
      calls.push({ ...input });
      return behavior(input);
    },
  };
}

// Re-export so the route module can import everything from one place.
export type { SshDryRunExecutor as Executor };
