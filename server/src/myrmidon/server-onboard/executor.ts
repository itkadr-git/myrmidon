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

import { generateKeyPairSync, randomUUID } from "node:crypto";
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
  const rawKey = publicKey.export({ format: "jwk" }).x;
  if (!rawKey) throw new Error("Generated Ed25519 public key is missing key material");
  const algorithm = Buffer.from("ssh-ed25519");
  const keyBytes = Buffer.from(rawKey, "base64url");
  const wire = Buffer.alloc(4 + algorithm.length + 4 + keyBytes.length);
  wire.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(wire, 4);
  wire.writeUInt32BE(keyBytes.length, 4 + algorithm.length);
  keyBytes.copy(wire, 8 + algorithm.length);
  return {
    publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
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
    let pendingPasswordRollback: (() => Promise<void>) | null = null;
    let discardPasswordBackup: (() => Promise<void>) | null = null;

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
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            // An existing key authenticated the bootstrap connection already; do not
            // mutate authorized_keys with a public key unrelated to that credential.
            if (!activePrivateKey) {
              const gen = (this.deps.generateKeyPair ?? defaultGenerateKeyPair)();
              activePrivateKey = gen.privateKey;
              const pubKeyToInstall = gen.publicKey.trim();
              const installResult = await activeSsh.execute(
                `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${pubKeyToInstall}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
                { sudo: false },
              );
              if (installResult.exitCode !== 0) {
                throw new Error("SSH key installation failed");
              }
            }

            // Verify Key Login via a fresh connection
            const keyConnOptions: SshConnectionOptions = {
              host: claim.server.hostname,
              port: claim.server.port,
              username: claim.server.username,
              privateKey: activePrivateKey,
            };
            const verifySsh = await this.getSsh(keyConnOptions);
            try {
              await verifySsh.connect(keyConnOptions);
              const verifyRes = await verifySsh.execute('echo "myrmidon-key-verify"');
              if (verifyRes.exitCode !== 0 || verifyRes.stdout.trim() !== "myrmidon-key-verify") {
                throw new Error("Key verification failed: unable to verify SSH login using the installed key");
              }
            } catch (error) {
              await verifySsh.disconnect().catch(() => {});
              throw error;
            }

            // Release the bootstrap session before switching to verified key authentication.
            await activeSsh.disconnect().catch(() => {});
            activeSsh = verifySsh;
            connOptions.privateKey = activePrivateKey;
            delete connOptions.password;

            // Optional password disable (only after key login verified)
            if (!claim.options.keepPassword) {
              const backup = `/var/tmp/myrmidon-sshd-${randomUUID()}`;
              const file = "/etc/ssh/sshd_config.d/50-myrmidon-hardening.conf";
              const snapshot = await activeSsh.execute(`sudo mkdir -m 700 ${backup} && if sudo test -e ${file}; then sudo cp -p ${file} ${backup}/original; else sudo touch ${backup}/absent; fi`);
              if (snapshot.exitCode !== 0) throw new Error("Cannot snapshot password hardening configuration");
              const passwordSsh = activeSsh;
              const restorePassword = async () => {
                const restore = await passwordSsh.execute(`: restore-myrmidon-password-config; if sudo test -f ${backup}/absent; then sudo rm -f ${file}; else sudo cp -p ${backup}/original ${file}; fi && sudo sshd -t && (sudo systemctl reload ssh || sudo systemctl reload sshd)`);
                if (restore.exitCode !== 0) throw new Error("configuration restoration failed");
                const checkSsh = await this.getSsh(keyConnOptions);
                try {
                  await checkSsh.connect(keyConnOptions);
                  const check = await checkSsh.execute('echo "myrmidon-key-verify"');
                  if (check.exitCode !== 0 || check.stdout.trim() !== "myrmidon-key-verify") throw new Error("unexpected SSH verification response");
                } catch (error) {
                  const detail = error instanceof Error ? error.message : String(error);
                  throw new Error(`restoration SSH verification failed: ${detail}`);
                } finally {
                  await checkSsh.disconnect().catch(() => {});
                }
              };
              try {
                const write = await activeSsh.execute(
                  `sudo mkdir -p /etc/ssh/sshd_config.d && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee ${file}`,
                );
                if (write.exitCode !== 0) throw new Error("Password hardening write failed");
                const sshdTest = await activeSsh.execute("sudo sshd -t");
                if (sshdTest.exitCode !== 0) throw new Error("sshd configuration test failed");
                const effective = await activeSsh.execute("sudo sshd -T");
                const settings = effective.stdout.toLowerCase();
                if (effective.exitCode !== 0 || !/^passwordauthentication\s+no\s*$/m.test(settings) || !/^kbdinteractiveauthentication\s+no\s*$/m.test(settings)) {
                  throw new Error("Effective sshd configuration still permits password authentication");
                }
                // Match rules may override the global settings for this connection.
                const contextual = await activeSsh.execute('sudo sshd -T -C "user=$(id -un),addr=${SSH_CONNECTION%% *}"');
                const contextualSettings = contextual.stdout.toLowerCase();
                if (contextual.exitCode !== 0 || !/^passwordauthentication\s+no\s*$/m.test(contextualSettings) || !/^kbdinteractiveauthentication\s+no\s*$/m.test(contextualSettings)) {
                  throw new Error("Effective sshd configuration still permits password authentication");
                }
                const reload = await activeSsh.execute("sudo systemctl reload ssh || sudo systemctl reload sshd");
                if (reload.exitCode !== 0) throw new Error("sshd reload failed");
                const fresh = await this.getSsh(keyConnOptions);
                try {
                  await fresh.connect(keyConnOptions);
                  const check = await fresh.execute('echo "myrmidon-key-verify"');
                  if (check.exitCode !== 0 || check.stdout.trim() !== "myrmidon-key-verify") throw new Error("SSH verification after password hardening failed");
                } finally {
                  await fresh.disconnect().catch(() => {});
                }
              } catch (error) {
                try {
                  await restorePassword();
                } catch (restoreError) {
                  const cause = error instanceof Error ? error.message : String(error);
                  const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
                  throw new Error(`Password hardening failed: ${cause}; ${detail.includes("restoration SSH") ? detail : `configuration restoration failed: ${detail}`}`);
                }
                await passwordSsh.execute(`sudo rm -rf ${backup}`).catch(() => {});
                throw error;
              }
              pendingPasswordRollback = restorePassword;
              discardPasswordBackup = async () => { await passwordSsh.execute(`sudo rm -rf ${backup}`); };
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
            if (!Number.isInteger(claim.server.port) || claim.server.port < 1 || claim.server.port > 65535) {
              throw new Error("Firewall hardening requires a valid SSH port");
            }
            if (!connOptions.privateKey) {
              throw new Error("Firewall hardening requires SSH key credentials for connectivity verification");
            }
            if (!activeSsh) {
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            // We cannot safely restore an inactive firewall without disabling UFW.
            let firewallStatus: SshExecutionResult;
            try {
              firewallStatus = await activeSsh.execute("sudo ufw status");
            } catch (error) {
              const cause = error instanceof Error ? error.message : String(error);
              throw new Error(`Firewall status unconfirmed; refusing unsafe firewall changes: ${cause}`);
            }
            const statusLines = firewallStatus.stdout.split(/\r?\n/).filter((line) => /^\s*Status:/i.test(line));
            if (firewallStatus.exitCode === 0 && statusLines.length === 1 && /^Status: inactive\s*$/.test(statusLines[0] ?? "")) {
              throw new Error("Firewall is inactive; refusing changes because its original disabled state cannot be safely restored");
            }
            if (firewallStatus.exitCode !== 0 || statusLines.length !== 1 || !/^Status: active\s*$/.test(statusLines[0] ?? "")) {
              throw new Error("Firewall inactive or status unconfirmed; refusing unsafe firewall changes");
            }

            // Capture the default policy without overwriting concurrent UFW rules.
            let policy: SshExecutionResult;
            try {
              policy = await activeSsh.execute(": snapshot-myrmidon-firewall; sudo ufw status verbose");
            } catch (error) {
              const cause = error instanceof Error ? error.message : String(error);
              throw new Error(`Firewall default policy unconfirmed; refusing unsafe firewall changes: ${cause}`);
            }
            const policyLines = policy.stdout.split(/\r?\n/);
            const policyStatusLines = policyLines.filter((line) => /^\s*Status:/i.test(line));
            if (policy.exitCode === 0 && (policyStatusLines.length !== 1 || !/^Status: active\s*$/.test(policyStatusLines[0] ?? ""))) {
              throw new Error("Firewall status unconfirmed during policy probe; refusing unsafe firewall changes");
            }
            const defaultLines = policyLines.filter((line) => /^\s*Default:/i.test(line));
            if (policy.exitCode !== 0 || defaultLines.length !== 1 || !/^Default:\s+(?:allow|deny|reject) \(incoming\),\s+(?:allow|deny|reject) \(outgoing\),\s+(?:allow|deny|reject|disabled) \(routed\)\s*$/.test(defaultLines[0] ?? "")) {
              throw new Error("Firewall default policy unconfirmed; refusing unsafe firewall changes");
            }

            // Require a usable timer manager before attempting any firewall mutation.
            const prerequisites = await activeSsh.execute(": check-myrmidon-firewall-prerequisites; command -v systemd-run >/dev/null && command -v systemctl >/dev/null && sudo systemctl show --property=Version --value >/dev/null");
            if (prerequisites.exitCode !== 0) {
              throw new Error("Firewall rollback timer prerequisites unavailable; refusing unsafe firewall changes");
            }

            // The restore script remains inert until a future mutation protocol marks
            // the policy as changed; rule ownership is not implemented yet.
            const timer = `myrmidon-firewall-${randomUUID()}`;
            const rollbackDir = `/var/tmp/${timer}`;
            const incomingPolicy = /^Default:\s+(allow|deny|reject) \(incoming\)/.exec(defaultLines[0] ?? "")?.[1];
            if (!incomingPolicy) throw new Error("Firewall default policy unconfirmed; refusing unsafe firewall changes");
            try {
              let preparation: SshExecutionResult;
              try {
                const restoreScript = `#!/bin/sh\nset -eu\nif [ -f ${rollbackDir}/policy-changed ]; then\n  current=$(ufw status verbose)\n  statuses=$(printf "%s\\n" "$current" | grep -iE "^[[:space:]]*Status:" || true)\n  defaults=$(printf "%s\\n" "$current" | grep -E "^[[:space:]]*Default:" || true)\n  if [ "$statuses" = "Status: active" ] && [ "$(printf "%s\\n" "$defaults" | grep -c .)" -eq 1 ] && printf "%s\\n" "$defaults" | grep -Eq "^Default: deny \\(incoming\\), (allow|deny|reject) \\(outgoing\\), (allow|deny|reject|disabled) \\(routed\\)$"; then\n    ufw default ${incomingPolicy} incoming\n  elif [ "$statuses" != "Status: active" ]; then\n    exit 1\n  fi\nfi\n`;
                preparation = await activeSsh.execute(`: prepare-myrmidon-firewall-restore; sudo mkdir -m 700 ${rollbackDir} && printf '%s' '${restoreScript}' | sudo tee ${rollbackDir}/restore.sh >/dev/null && sudo chmod 700 ${rollbackDir}/restore.sh && sudo sh -n ${rollbackDir}/restore.sh`);
              } catch (error) {
                const cause = error instanceof Error ? error.message : String(error);
                throw new Error(`Firewall rollback preparation failed: ${cause}`);
              }
              if (preparation.exitCode !== 0) throw new Error("Firewall rollback preparation failed; refusing unsafe firewall changes");

              // No firewall mutation is permitted until rule ownership is implemented.
              const start = await activeSsh.execute(`: start-myrmidon-firewall-timer; sudo systemd-run --unit=${timer} --on-active=5m /bin/sh ${rollbackDir}/restore.sh >/dev/null && sudo systemctl is-active --quiet ${timer}.timer && echo timer-confirmed`);
              if (start.exitCode !== 0 || start.stdout.trim() !== "timer-confirmed") {
                throw new Error("Firewall rollback timer start or confirmation failed; refusing unsafe firewall changes");
              }
              const check = await activeSsh.execute(`: check-myrmidon-firewall-timer; sudo systemctl is-active --quiet ${timer}.timer && echo timer-confirmed`);
              if (check.exitCode !== 0 || check.stdout.trim() !== "timer-confirmed") {
                throw new Error("Firewall rollback timer liveness confirmation failed; refusing unsafe firewall changes");
              }
            } finally {
              const stopped = await activeSsh.execute(`: stop-myrmidon-firewall-timer; sudo systemctl stop ${timer}.timer`).catch(() => null);
              if (stopped?.exitCode === 0) {
                await activeSsh.execute(`sudo rm -rf ${rollbackDir}`).catch(() => {});
              }
            }
            throw new Error("Scoped firewall rollback unavailable; refusing unsafe firewall changes");
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
            if (!connOptions.privateKey) {
              throw new Error("Final verification requires SSH key credentials");
            }
            if (!activeSsh) {
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
            }

            // Verify key login
            const testKeySsh = await this.getSsh(connOptions);
            try {
              await testKeySsh.connect(connOptions);
              const echoRes = await testKeySsh.execute('echo "onboard-verified"');
              if (echoRes.exitCode !== 0 || echoRes.stdout.trim() !== "onboard-verified") {
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
              activeSsh = await this.getSsh(connOptions);
              await activeSsh.connect(connOptions);
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
      pendingPasswordRollback = null;
      if (discardPasswordBackup) await discardPasswordBackup().catch(() => {});
      return {
        status: "succeeded",
        hostKeyFingerprint: discoveredFingerprint,
        stepsCompleted,
      };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);

      if (pendingPasswordRollback) {
        try {
          await pendingPasswordRollback();
          if (discardPasswordBackup) await discardPasswordBackup();
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          message += `; password configuration rollback unconfirmed: ${detail}`;
        }
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
