// myrmidon(SERVER-ONBOARD): real executor for the onboarding dry-run probes.
// All probes are read-only and all failures are normalized before they leave this module.

// @ts-ignore
import { Client as DefaultSshClient } from "ssh2";
import { lookup } from "node:dns/promises";
import type { ProbeOutcome, OnboardingDryRunExecutor } from "./dry-run.js";

type SshClient = {
  once(event: string, listener: (...args: any[]) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;
  connect(config: Record<string, unknown>): void;
  exec(command: string, callback: (error: Error | undefined, stream?: SshStream) => void): void;
  end(): void;
  destroy?(): void;
};
type SshStream = {
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  stderr?: { on(event: string, listener: (...args: any[]) => void): void };
  close?(): void;
  end?(): void;
};

export type SshClientConstructor = new () => SshClient;

export type RealOnboardingDryRunExecutorDeps = {
  sshClientConstructor?: SshClientConstructor;
};

function resolveSshClientConstructor(custom?: SshClientConstructor): SshClientConstructor {
  if (custom) return custom;
  if (typeof DefaultSshClient === "function") {
    return DefaultSshClient as unknown as SshClientConstructor;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = require("ssh2");
    return (req?.Client ?? req?.default?.Client ?? req) as SshClientConstructor;
  } catch {
    throw new Error("Unable to load ssh2 Client constructor");
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function dnsFailure(error: unknown): ProbeOutcome {
  const code = errorCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { status: "failed", code: "dns_not_found", message: "hostname does not resolve" };
  }
  if (code === "ETIMEDOUT") {
    return { status: "failed", code: "dns_timeout", message: "DNS resolution timed out" };
  }
  return { status: "failed", code: "dns_error", message: "DNS resolution failed" };
}

function sshFailure(error: unknown): ProbeOutcome {
  const code = errorCode(error);
  if (code === "ETIMEDOUT" || code === "TIMEOUT") {
    return { status: "failed", code: "ssh_timeout", message: "SSH connection timed out" };
  }
  if (code === "ECONNREFUSED") {
    return { status: "failed", code: "ssh_connection_refused", message: "the SSH port is closed" };
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return { status: "failed", code: "ssh_unreachable", message: "no route to the host" };
  }
  if (/auth|permission denied|authentication/i.test(String((error as Error)?.message ?? ""))) {
    return { status: "failed", code: "ssh_auth_failed", message: "SSH authentication failed" };
  }
  return { status: "failed", code: "ssh_unreachable", message: "could not establish an SSH connection" };
}

function connectConfig(input: {
  host: string;
  port: number;
  username: string;
  auth: { password?: string; privateKey?: string };
  timeoutMs: number;
}): Record<string, unknown> {
  return {
    host: input.host,
    port: input.port,
    username: input.username,
    ...(input.auth.privateKey
      ? { privateKey: input.auth.privateKey }
      : { password: input.auth.password }),
    readyTimeout: input.timeoutMs,
    // No host-key state is written by the dry-run process.
    hostVerifier: () => true,
  };
}

function execReadOnly(
  input: { host: string; port: number; username: string; auth: { password?: string; privateKey?: string }; timeoutMs: number },
  command: string,
  customClientConstructor?: SshClientConstructor,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const SshClient = resolveSshClientConstructor(customClientConstructor);
    const client = new SshClient();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { client.destroy?.(); }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))), input.timeoutMs);
    client.once("ready", () => {
      client.exec(command, (error, stream) => {
        if (error || !stream) {
          clearTimeout(timer);
          finish(() => reject(error ?? new Error("SSH command failed")));
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer | string) => { stdout += data.toString(); });
        stream.stderr?.on("data", (data: Buffer | string) => { stderr += data.toString(); });
        stream.once("close", () => {
          clearTimeout(timer);
          finish(() => resolve({ stdout, stderr }));
        });
      });
    });
    client.once("error", (error: Error) => {
      clearTimeout(timer);
      finish(() => reject(error));
    });
    try { client.connect(connectConfig(input)); } catch (error) {
      clearTimeout(timer);
      finish(() => reject(error));
    }
  });
}

export function createRealOnboardingDryRunExecutor(
  deps: RealOnboardingDryRunExecutorDeps = {},
): OnboardingDryRunExecutor {
  return {
    async resolveDns(host) {
      try {
        const result = await lookup(host);
        return { status: "ok", code: "dns_ok", message: `resolved to ${result.address}` };
      } catch (error) {
        return dnsFailure(error);
      }
    },

    async probeSsh(host, port, username, auth, timeoutMs) {
      try {
        await execReadOnly(
          { host, port, username, auth, timeoutMs },
          "true",
          deps.sshClientConstructor,
        );
        return { status: "ok", code: "ssh_ok", message: "SSH authentication succeeded" };
      } catch (error) {
        return sshFailure(error);
      }
    },

    async probePermissions(host, port, username, auth, timeoutMs) {
      try {
        const result = await execReadOnly(
          { host, port, username, auth, timeoutMs },
          "sudo -n true && printf SUDO_OK",
          deps.sshClientConstructor,
        );
        if (result.stdout.includes("SUDO_OK")) {
          return { status: "ok", code: "permissions_ok", message: "passwordless sudo available" };
        }
        return { status: "failed", code: "permissions_sudo_denied", message: "passwordless sudo is not available" };
      } catch (error) {
        const code = errorCode(error);
        if (code === "ETIMEDOUT") return { status: "failed", code: "ssh_timeout", message: "SSH command timed out" };
        return { status: "failed", code: "permissions_sudo_denied", message: "permission probe failed" };
      }
    },
  };
}
