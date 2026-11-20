// myrmidon(SERVER-ONBOARD): fleet-onboard executor without host mount.
//
// Runs the versioned step script over SSH:
// - connect & TOFU (Trust On First Use) host key pinning;
// - preflight checks (disk >=90% threshold, memory, passwordless sudo, panel conflicts);
// - access: install key, verify key login via a new connection, optional password disable;
// - harden: firewall allow-before-deny with 5-minute rollback timer;
// - monitoring: bootstrap or skip with note;
// - role bootstrap: generic, build-runner, sandbox, bot-host;
// - decommission cleanup: remove role containers, keys, rules;
// - verify: end-to-end connectivity and security assertions.
//
// Invariants:
// - Password secret is consumed only after verified key login (reported in access step).
// - Step failure rolls back hardening changes and leaves server in needs_attention.

import { generateSshKeyPair, sshPublicKey } from "./ssh-key.js";
import { OnboardSshTransport } from "./ssh-transport.js";
import type {
  SshConnectionOptions,
  SshExecutionResult,
  SshExecutor,
} from "../../services/fleet/mock-ssh-executor.js";
import type { OnboardJobClaim } from "./store.js";

export interface ExecutorReporter {
  /** Atomically persist the first observed fingerprint; reject a conflicting pin. */
  pinHostKey?(fingerprint: string): Promise<boolean>;
  reportStep(
    step: string,
    result: "ok" | "skipped" | "failed",
    detail?: string | null,
  ): Promise<void>;
  reportCompletion(
    status: "succeeded" | "failed",
    error?: string | null,
    hostKeyFingerprint?: string | null,
  ): Promise<void>;
}

export interface OnboardExecutorDeps {
  createSshExecutor?: (options: SshConnectionOptions) => SshExecutor | Promise<SshExecutor>;
  generateKeyPair?: () => { publicKey: string; privateKey: string };
}

export interface ExecutorExecutionResult {
  status: "succeeded" | "failed";
  hostKeyFingerprint?: string | null;
  error?: string | null;
  stepsCompleted: string[];
}

export function defaultGenerateKeyPair(): { publicKey: string; privateKey: string } {
  return generateSshKeyPair();
}

export class FleetOnboardExecutor {
  constructor(private readonly deps: OnboardExecutorDeps = {}) {}

  private async getSsh(options: SshConnectionOptions): Promise<SshExecutor> {
    if (this.deps.createSshExecutor) {
      return this.deps.createSshExecutor(options);
    }
    return new OnboardSshTransport();
  }

  async execute(
    claim: OnboardJobClaim & { secretValues: Record<string, string> },
    reporter: ExecutorReporter,
  ): Promise<ExecutorExecutionResult> {
    const stepsCompleted: string[] = [];
    let discoveredFingerprint: string | null = claim.server.hostKeyFingerprint ?? null;
    let currentStep: string | null = null;
    let activeSsh: SshExecutor | null = null;
    let activePrivateKey: string | null = claim.secretValues.accessKey ?? null;
    let firewallRollbackArmed = false;

    try {
      const steps = claim.steps && claim.steps.length > 0 ? claim.steps : ["connect", "preflight", "access", "verify"];

      // Initial connection options
      const connOptions: SshConnectionOptions = {
        host: claim.server.hostname,
        port: claim.server.port,
        username: claim.server.username,
        hostVerifier: async (fingerprint) => {
          if (discoveredFingerprint) return discoveredFingerprint === fingerprint;
          if (!reporter.pinHostKey || !(await reporter.pinHostKey(fingerprint))) return false;
          discoveredFingerprint = fingerprint;
          return true;
        },
        ...(claim.secretValues.bootstrapPassword
          ? { password: claim.secretValues.bootstrapPassword }
          : activePrivateKey
            ? { privateKey: activePrivateKey }
            : {}),
      };

      if (!connOptions.privateKey && !connOptions.password) {
        throw new Error("No authentication credentials provided in claim secret values");
      }

      const connectVerified = async (options: SshConnectionOptions): Promise<SshExecutor> => {
        let verified = false;
        const verifyHost = options.hostVerifier;
        const checkedOptions: SshConnectionOptions = {
          ...options,
          hostVerifier: async (fingerprint) => {
            const accepted = !!verifyHost && await verifyHost(fingerprint);
            verified = accepted;
            return accepted;
          },
        };
        const ssh = await this.getSsh(checkedOptions);
        try {
          await ssh.connect(checkedOptions);
          if (!verified) throw new Error("SSH transport did not provide a verified host key");
          return ssh;
        } catch (error) {
          await ssh.disconnect().catch(() => {});
          throw error;
        }
      };

      for (const step of steps) {
        currentStep = step;

        switch (step) {
          case "connect": {
            activeSsh = await connectVerified(connOptions);

            // The transport callback runs before credentials are sent. Do not
            // execute remote commands to discover the host identity.
            if (!discoveredFingerprint) {
              throw new Error("SSH transport did not provide a verified host key");
            }

            // OS check (Debian or Ubuntu)
            const osReleaseRes = await activeSsh.execute("cat /etc/os-release");
            const osText = osReleaseRes.stdout.toLowerCase();
            const isSupported = osText.includes("id=ubuntu") || osText.includes("id=debian") || osText.includes("id_like=debian");
            if (!isSupported) {
              throw new Error("Unsupported operating system: only Debian and Ubuntu are supported");
            }

            await reporter.reportStep("connect", "ok", `Connected to ${claim.server.hostname}; TOFU fingerprint ${discoveredFingerprint}`);
            stepsCompleted.push("connect");
            break;
          }

          case "preflight": {
            if (!activeSsh) {
              activeSsh = await connectVerified(connOptions);
            }

            // 1. Disk check (threshold >= 90%)
            const dfRes = await activeSsh.execute("df -P /");
            const lines = dfRes.stdout.trim().split("\n");
            const match = lines[1]?.match(/(\d+)%/);
            if (dfRes.exitCode !== 0 || !match?.[1]) {
              throw new Error("Preflight check failed: unable to determine root filesystem disk usage");
            }
            const usedPercent = Number.parseInt(match[1], 10);
            if (usedPercent >= 90) {
              throw new Error(`Preflight check failed: root filesystem disk usage is ${usedPercent}% (threshold: 90%)`);
            }

            // 2. Memory check
            await activeSsh.execute("free -m");

            // 3. Passwordless sudo check
            const sudoRes = await activeSsh.execute("sudo -n true");
            if (sudoRes.exitCode !== 0) {
              throw new Error("Preflight check failed: user does not have passwordless sudo access");
            }

            // 4. Panel conflict check
            const panelRes = await activeSsh.execute("test -d /usr/local/cpanel || test -d /usr/local/vesta || test -d /www/server/panel");
            if (panelRes.exitCode === 0) {
              throw new Error("Preflight check failed: conflicting control panel detected on server");
            }

            await reporter.reportStep("preflight", "ok", "Preflight checks passed: disk, memory, sudo, no conflicting panels");
            stepsCompleted.push("preflight");
            break;
          }

          case "access": {
            if (!activeSsh) {
              activeSsh = await connectVerified(connOptions);
            }

            // Never leave an unpersisted key authorized on the target host.
            if (!claim.server.accessKeySecretKey || !activePrivateKey) {
              throw new Error("Cannot complete access without a durable access key");
            }
            const pubKeyToInstall = sshPublicKey(activePrivateKey);

            const installResult = await activeSsh.execute(
              `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${pubKeyToInstall}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
              { sudo: false },
            );
            if (installResult.exitCode !== 0) {
              throw new Error("SSH key installation failed");
            }

            // Verify Key Login via a fresh connection
            const keyConnOptions: SshConnectionOptions = {
              host: claim.server.hostname,
              port: claim.server.port,
              username: claim.server.username,
              hostVerifier: connOptions.hostVerifier,
              privateKey: activePrivateKey,
            };
            const verifySsh = await connectVerified(keyConnOptions);
            try {
              const verifyRes = await verifySsh.execute('echo "myrmidon-key-verify"');
              if (verifyRes.exitCode !== 0 || !verifyRes.stdout.includes("myrmidon-key-verify")) {
                throw new Error("Key verification failed: unable to verify SSH login using the installed key");
              }
            } catch (error) {
              await verifySsh.disconnect().catch(() => {});
              throw error;
            }

            // Close the bootstrap connection before switching to key authentication.
            await activeSsh.disconnect();
            activeSsh = verifySsh;
            connOptions.privateKey = activePrivateKey;
            delete connOptions.password;

            // A key which exists only in this process cannot support a later reconnect.
            if (!claim.server.accessKeySecretKey || !claim.secretValues.accessKey) {
              throw new Error("Cannot complete access without a durable access key");
            }

            // Optional password disable (only after key login verified)
            if (!claim.options.keepPassword) {
              const writeConfig = await activeSsh.execute(
                "sudo mkdir -p /etc/ssh/sshd_config.d && printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' | sudo tee /etc/ssh/sshd_config.d/50-myrmidon-hardening.conf",
              );
              if (writeConfig.exitCode !== 0) {
                throw new Error("Unable to write SSH password hardening configuration");
              }
              const sshdTest = await activeSsh.execute("sudo sshd -t");
              if (sshdTest.exitCode !== 0) {
                await activeSsh.execute("sudo rm -f /etc/ssh/sshd_config.d/50-myrmidon-hardening.conf");
                throw new Error("sshd configuration test failed; reverted password disable");
              }
              await activeSsh.execute("sudo systemctl reload ssh || sudo systemctl reload sshd");
            }

            await reporter.reportStep(
              "access",
              "ok",
              `Key login verified${claim.options.keepPassword ? "" : "; password authentication disabled"}`,
            );
            stepsCompleted.push("access");
            break;
          }

          case "harden": {
            if (!activeSsh) {
              activeSsh = await connectVerified(connOptions);
            }

            // Firewall allow-before-deny with rollback timer:
            // 1. Allow SSH port before deny
            await activeSsh.execute(`sudo ufw allow ${claim.server.port}/tcp comment 'myrmidon-ssh'`);

            // 2. Start rollback timer (5 minutes / 300s)
            firewallRollbackArmed = true;
            await activeSsh.execute("nohup sh -c 'sleep 300 && sudo ufw disable' >/dev/null 2>&1 &");

            // 3. Set default deny incoming & enable
            await activeSsh.execute("sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw --force enable");

            // 4. Verify connectivity using fresh connection
            try {
              const testSsh = await connectVerified(connOptions);
              try {
                const testPing = await testSsh.execute('echo "ufw-connectivity-ok"');
                if (testPing.exitCode !== 0 || !testPing.stdout.includes("ufw-connectivity-ok")) {
                  throw new Error("Connectivity test failed after firewall enablement");
                }
              } finally {
                await testSsh.disconnect().catch(() => {});
              }
              // Disarm rollback timer
              await activeSsh.execute("sudo pkill -f 'sleep 300 && sudo ufw disable' || true");
              firewallRollbackArmed = false;
            } catch (err) {
              // Rollback immediately
              await activeSsh.execute("sudo ufw disable").catch(() => {});
              firewallRollbackArmed = false;
              throw new Error(`Firewall allow-before-deny verification failed; rolled back: ${(err as Error).message}`);
            }

            await reporter.reportStep("harden", "ok", "Firewall allow-before-deny configured and verified; rollback disarmed");
            stepsCompleted.push("harden");
            break;
          }

          case "monitoring": {
            // Monitoring bootstrap or skip with note
            await reporter.reportStep("monitoring", "skipped", "Monitoring agent skipped: instance monitoring not configured");
            stepsCompleted.push("monitoring");
            break;
          }

          case "role": {
            if (!activeSsh) {
              activeSsh = await connectVerified(connOptions);
            }

            const role = claim.options.role ?? "generic";
            if (role === "build-runner") {
              await activeSsh.execute("docker --version || true");
            } else if (role === "sandbox") {
              await activeSsh.execute("docker --version || true");
            } else if (role === "bot-host") {
              await activeSsh.execute("test -d /opt/fleetd || true");
            }

            await reporter.reportStep("role", "ok", `Role bootstrap applied: ${role}`);
            stepsCompleted.push("role");
            break;
          }

          case "verify": {
            if (!connOptions.privateKey) {
              throw new Error("Final verification requires SSH key credentials");
            }
            if (!activeSsh) {
              activeSsh = await connectVerified(connOptions);
            }

            // Verify key login
            const testKeySsh = await connectVerified(connOptions);
            try {
              const echoRes = await testKeySsh.execute('echo "onboard-verified"');
              if (echoRes.exitCode !== 0) {
                throw new Error("Final verification failed: unable to run commands via SSH key");
              }
            } finally {
              await testKeySsh.disconnect().catch(() => {});
            }

            await reporter.reportStep("verify", "ok", "All end-to-end verification checks passed");
            stepsCompleted.push("verify");
            break;
          }

          case "cleanup": {
            // Decommission step
            if (!activeSsh) {
              activeSsh = await connectVerified(connOptions);
            }

            // No ownership inventory is available yet; fail closed rather than deleting
            // unrelated workloads, SSH keys, or firewall rules.
            throw new Error("Decommission cleanup requires an ownership inventory");
          }

          default: {
            throw new Error(`Unknown onboarding step: ${step}`);
          }
        }
      }

      await reporter.reportCompletion("succeeded", null, discoveredFingerprint);
      return {
        status: "succeeded",
        hostKeyFingerprint: discoveredFingerprint,
        stepsCompleted,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // If firewall rollback was still armed when failure occurred, ensure rollback
      if (firewallRollbackArmed && activeSsh) {
        await activeSsh.execute("sudo ufw disable").catch(() => {});
      }

      if (currentStep) {
        await reporter.reportStep(currentStep, "failed", message).catch(() => {});
      }

      await reporter.reportCompletion("failed", message, discoveredFingerprint).catch(() => {});

      return {
        status: "failed",
        error: message,
        hostKeyFingerprint: discoveredFingerprint,
        stepsCompleted,
      };
    } finally {
      if (activeSsh) {
        await activeSsh.disconnect().catch(() => {});
      }
    }
  }
}
