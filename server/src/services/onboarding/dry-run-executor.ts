// myrmidon(SERVER-ONBOARD): real executor for the onboarding dry-run probes.
//
// Uses only built-in Node modules (node:dns, node:net) so the dry-run has
// no heavy native dependencies. The probes are deliberately read-only:
//
//   * DNS  — dns.lookup(), no side effects.
//   * SSH  — TCP connect + banner read. We close the socket immediately
//            after reading the banner line; no SSH handshake, no auth, no
//            command execution at this stage.
//   * Permissions — skipped in this executor. Determining sudo/write
//            permissions requires a full SSH session and command execution;
//            that deeper probe is implemented separately (OPE-10222). This
//            executor reports the permissions probe as skipped so the
//            orchestrator still returns a valid typed result.
//
// All error paths return a safe code/message pair — no stderr echoes, no
// internal Node error strings that might leak host details beyond what the
// caller already supplied.

import { lookup } from "node:dns/promises";
import net from "node:net";
import type {
  ProbeOutcome,
  OnboardingDryRunExecutor,
} from "./dry-run.js";

function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ETIMEDOUT"
  );
}

function isNotFoundError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOTFOUND" || code === "EAI_AGAIN";
}

function isRefusedError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ECONNREFUSED";
}

function isUnreachableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return (
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EHOSTDOWN" ||
    code === "ENETDOWN"
  );
}

export function createRealOnboardingDryRunExecutor(): OnboardingDryRunExecutor {
  return {
    async resolveDns(host: string): Promise<ProbeOutcome> {
      try {
        const result = await lookup(host);
        return {
          status: "ok",
          code: "dns_ok",
          message: `resolved to ${result.address}`,
        };
      } catch (err) {
        if (isTimeoutError(err)) {
          return {
            status: "failed",
            code: "dns_timeout",
            message: "DNS resolution timed out",
          };
        }
        if (isNotFoundError(err)) {
          return {
            status: "failed",
            code: "dns_not_found",
            message: "hostname does not resolve",
          };
        }
        return {
          status: "failed",
          code: "dns_error",
          message: "DNS resolution failed",
        };
      }
    },

    async probeSsh(
      host: string,
      port: number,
      timeoutMs: number,
    ): Promise<ProbeOutcome> {
      return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
          socket.destroy();
          resolve({
            status: "failed",
            code: "ssh_timeout",
            message: "TCP connection to the SSH port timed out",
          });
        }, timeoutMs);

        socket.once("connect", () => {
          // Wait for the server banner; SSH servers send it first.
        });

        socket.once("data", (data) => {
          clearTimeout(timer);
          socket.destroy();
          const banner = data.toString("utf8", 0, Math.min(data.length, 64));
          if (banner.startsWith("SSH-")) {
            resolve({
              status: "ok",
              code: "ssh_ok",
              message: "SSH banner received",
            });
          } else {
            resolve({
              status: "failed",
              code: "ssh_banner_unexpected",
              message: "the port is open but did not return an SSH banner",
            });
          }
        });

        socket.once("error", (err) => {
          clearTimeout(timer);
          if (isTimeoutError(err)) {
            resolve({
              status: "failed",
              code: "ssh_timeout",
              message: "TCP connection to the SSH port timed out",
            });
          } else if (isRefusedError(err)) {
            resolve({
              status: "failed",
              code: "ssh_connection_refused",
              message: "the SSH port is closed",
            });
          } else if (isUnreachableError(err)) {
            resolve({
              status: "failed",
              code: "ssh_unreachable",
              message: "no route to the host",
            });
          } else {
            resolve({
              status: "failed",
              code: "ssh_unreachable",
              message: "could not establish a TCP connection to the SSH port",
            });
          }
        });
      });
    },

    async probePermissions(): Promise<ProbeOutcome> {
      // The deep SSH auth + sudo probe is a separate concern (OPE-10222).
      // Reporting "skipped" keeps the typed result valid while making it
      // explicit that no permission check ran.
      return {
        status: "skipped",
        code: "permissions_skipped",
        message:
          "permission probe requires a full SSH session; run the SSH dry-run endpoint for a deeper check",
      };
    },
  };
}
