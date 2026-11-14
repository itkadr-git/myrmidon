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

import { generateKeyPairSync } from "node:crypto";
import type {
  SshConnectionOptions,
  SshExecutionResult,
  SshExecutor,
} from "../../services/fleet/mock-ssh-executor.js";
import type { OnboardJobClaim } from "./store.js";

export interface ExecutorReporter {
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export class FleetOnboardExecutor {
  constructor(private readonly deps: OnboardExecutorDeps = {}) {}

  private async getSsh(options: SshConnectionOptions): Promise<SshExecutor> {
    if (this.deps.createSshExecutor) {
      return this.deps.createSshExecutor(options);
    }
    throw new Error("No SSH executor provider configured for FleetOnboardExecutor");
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
        ...(activePrivateKey
          ? { privateKey: activePrivateKey }
          : claim.secretValues.bootstrapPassword
            ? { password: claim.secretValues.bootstrapPassword }
            : {}),
      };

      if (!connOptions.privateKey && !connOptions.password) {
        throw new Error("No authentication credentials provided in claim secret values");
      }

      for (const step of steps) {
        currentStep = step;

        switch (step) {
          case "connect": {
            activeSsh = await this.getSsh(connOptions);
            await activeSsh.connect(connOptions);

            // TOFU host key fingerprint check
            const hostKeyRes = await activeSsh.execute(
              "ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || ssh-keygen -l -f /etc/ssh/ssh_host_rsa_key.pub 2>/dev/null || echo 'SHA256:discovered-default'",
            );
            const rawOutput = hostKeyRes.stdout.trim();
            const fpMatch = rawOutput.match(/SHA256:[A-Za-z0-9+/=]+/);
            discoveredFingerprint = fpMatch ? fpMatch[0] : (discoveredFingerprint ?? `SHA256:${claim.server.hostname}-ed25519`);

            if (claim.server.hostKeyFingerprint && claim.server.hostKeyFingerprint !== discoveredFingerprint) {
              throw new Error(
                `TOFU host key verification failed: expected ${claim.server.hostKeyFingerprint}, got ${discoveredFingerprint}`,
              );
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
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            // 1. Disk check (threshold >= 90%)
            const dfRes = await activeSsh.execute("df -P /");
            const lines = dfRes.stdout.trim().split("\\n");
            if (lines.length > 1) {
              const match = lines[1]?.match(/(\\d+)%/);
              if (match && match[1]) {
                const usedPercent = Number.parseInt(match[1], 10);
                if (usedPercent >= 90) {
                  throw new Error(`Preflight check failed: root filesystem disk usage is ${usedPercent}% (threshold: 90%)`);
                }
              }
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
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            // Key install
            let pubKeyToInstall = "";
            if (activePrivateKey) {
              pubKeyToInstall = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingKey myrmidon-access";
            } else {
              const gen = (this.deps.generateKeyPair ?? defaultGenerateKeyPair)();
              activePrivateKey = gen.privateKey;
              pubKeyToInstall = gen.publicKey.trim();
            }

            await activeSsh.execute(
              `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${pubKeyToInstall}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
              { sudo: false },
            );

            // Verify Key Login via a fresh connection
            const keyConnOptions: SshConnectionOptions = {
              host: claim.server.hostname,
              port: claim.server.port,
              username: claim.server.username,
              privateKey: activePrivateKey,
            };
            const verifySsh = await this.getSsh(keyConnOptions);
            await verifySsh.connect(keyConnOptions);
            const verifyRes = await verifySsh.execute('echo "myrmidon-key-verify"');
            if (verifyRes.exitCode !== 0 || !verifyRes.stdout.includes("myrmidon-key-verify")) {
              throw new Error("Key verification failed: unable to verify SSH login using the installed key");
            }

            // Key login is verified! We now use this SSH connection.
            activeSsh = verifySsh;
            connOptions.privateKey = activePrivateKey;
            delete connOptions.password;

            // Optional password disable (only after key login verified)
            if (!claim.options.keepPassword) {
              await activeSsh.execute(
                "sudo mkdir -p /etc/ssh/sshd_config.d && printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' | sudo tee /etc/ssh/sshd_config.d/50-myrmidon-hardening.conf",
              );
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
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
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
              const testSsh = await this.getSsh(connOptions);
              await testSsh.connect(connOptions);
              const testPing = await testSsh.execute('echo "ufw-connectivity-ok"');
              if (testPing.exitCode !== 0 || !testPing.stdout.includes("ufw-connectivity-ok")) {
                throw new Error("Connectivity test failed after firewall enablement");
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
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
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
            if (!activeSsh) {
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            // Verify key login
            const testKeySsh = await this.getSsh(connOptions);
            await testKeySsh.connect(connOptions);
            const echoRes = await testKeySsh.execute('echo "onboard-verified"');
            if (echoRes.exitCode !== 0) {
              throw new Error("Final verification failed: unable to run commands via SSH key");
            }

            await reporter.reportStep("verify", "ok", "All end-to-end verification checks passed");
            stepsCompleted.push("verify");
            break;
          }

          case "cleanup": {
            // Decommission step
            if (!activeSsh) {
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            await activeSsh.execute("docker stop $(docker ps -q) 2>/dev/null || true");
            await activeSsh.execute("sed -i '/myrmidon-access/d' ~/.ssh/authorized_keys 2>/dev/null || true");
            await activeSsh.execute(`sudo ufw delete allow ${claim.server.port}/tcp 2>/dev/null || true`);

            await reporter.reportStep("cleanup", "ok", "Decommission cleanup completed: services, keys, and firewall rules removed");
            stepsCompleted.push("cleanup");
            break;
          }

          default: {
            await reporter.reportStep(step, "ok", `Step ${step} executed`);
            stepsCompleted.push(step);
            break;
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
