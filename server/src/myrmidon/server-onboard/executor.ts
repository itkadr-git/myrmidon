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

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { OwnedFleetResource } from "@myrmidon/shared";
import { generateSshKeyPair, sshPublicKey } from "./ssh-key.js";
import { OnboardSshTransport } from "./ssh-transport.js";
import type {
  SshConnectionOptions,
  SshExecutionResult,
  SshExecutor,
} from "../../services/fleet/mock-ssh-executor.js";
import type { OnboardJobClaim } from "./store.js";

const ROLLBACK_DELAY_SECONDS = 300;
// systemd timers default to a one-minute AccuracySec window.
const RECOVERY_GRACE_MS = 90_000;
const RECOVERY_CONNECT_TIMEOUT_MS = 5_000;
const RECOVERY_RETRY_MS = 1_000;

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
    verifiedAccessPublicKey?: string,
    ownedFirewallRule?: Extract<OwnedFleetResource, { kind: "firewall_rule" }>,
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
    let verifiedAccessPublicKey: string | undefined;
    let ownedFirewallRule: Extract<OwnedFleetResource, { kind: "firewall_rule" }> | undefined;
    let currentStep: string | null = null;
    let activeSsh: SshExecutor | null = null;
    let activePrivateKey: string | null = claim.secretValues.accessKey ?? null;
    let pendingFirewallRollback: (() => Promise<void>) | null = null;
    let commitFirewall: (() => Promise<void>) | null = null;
    let discardFirewallBackup: (() => Promise<void>) | null = null;
    let pendingPasswordRollback: (() => Promise<void>) | null = null;
    let commitPassword: (() => Promise<void>) | null = null;
    let discardPasswordBackup: (() => Promise<void>) | null = null;


    try {
      const steps = claim.steps && claim.steps.length > 0 ? claim.steps : ["connect", "preflight", "access", "verify"];

      // Initial connection options
      const connOptions: SshConnectionOptions = {
        host: claim.server.hostname,
        port: claim.server.port,
        username: claim.server.username,
        hostVerifier: async (fingerprint) => {
          if (discoveredFingerprint && discoveredFingerprint !== fingerprint) return false;
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

      const restoreOverSsh = async (
        original: SshExecutor,
        options: SshConnectionOptions,
        timerConfirmedAt: number,
        restore: (ssh: SshExecutor) => Promise<void>,
      ) => {
        try {
          await restore(original);
          return;
        } catch {
          // The host timer stays armed if the original session is lost.
        }
        const deadline = timerConfirmedAt + ROLLBACK_DELAY_SECONDS * 1000 + RECOVERY_GRACE_MS;
        let recovery: SshExecutor;
        for (;;) {
          try {
            recovery = await connectVerified({ ...options, timeoutMs: RECOVERY_CONNECT_TIMEOUT_MS });
            break;
          } catch (error) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw error;
            await delay(Math.min(RECOVERY_RETRY_MS, remaining));
          }
        }
        try {
          await restore(recovery);
        } finally {
          await recovery.disconnect().catch(() => {});
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
            const memoryRes = await activeSsh.execute("free -m");
            if (memoryRes.exitCode !== 0 || !/^Mem:\s+\d+/m.test(memoryRes.stdout)) {
              throw new Error("Preflight check failed: unable to determine memory information");
            }

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

            verifiedAccessPublicKey = pubKeyToInstall;

            // Optional password disable (only after key login verified)
            if (!claim.options.keepPassword) {
              const unit = `myrmidon-sshd-${randomUUID()}`;
              const backup = `/var/tmp/${unit}`;
              const file = "/etc/ssh/sshd_config.d/50-myrmidon-hardening.conf";
              const prerequisites = await activeSsh.execute(": check-myrmidon-password-prerequisites; command -v flock >/dev/null && command -v systemd-run >/dev/null && sudo systemctl show --property=Version --value >/dev/null");
              if (prerequisites.exitCode !== 0) throw new Error("Password rollback timer prerequisites unavailable; refusing to modify sshd");
              const restoreScript = `set -eu
exec 9>${backup}/lock
flock -x 9
test "$#" -gt 0 || test ! -e ${backup}/committed || exit 0
test ! -e ${backup}/restored || exit 0
touch ${backup}/expired
if test -f ${backup}/installed-inode; then
  if test ! -f ${backup}/file-restored; then
    test ! -L ${file}
    test -f ${file}
    test "$(stat -c %d:%i ${file})" = "$(cat ${backup}/installed-inode)"
    cmp -s ${file} ${backup}/installed-content
    if test -f ${backup}/absent; then
      rm -f ${file}
    else
      replacement=$(mktemp ${file}.restore.XXXXXX)
      trap "rm -f -- \"$replacement\"" EXIT
      cp -p ${backup}/original "$replacement"
      mv -fT "$replacement" ${file}
    fi
    touch ${backup}/file-restored
  fi
  sshd -t
  systemctl reload ssh || systemctl reload sshd
fi
touch ${backup}/restored`;
              const snapshot = await activeSsh.execute(`: snapshot-myrmidon-password-config; sudo mkdir -m 700 ${backup} && sudo test ! -L ${file} && (if sudo test -e ${file}; then sudo test -f ${file} && sudo cp -p ${file} ${backup}/original; else sudo touch ${backup}/absent; fi) && printf '%s' '${restoreScript}' | sudo tee ${backup}/restore.sh >/dev/null && sudo sh -n ${backup}/restore.sh`);
              if (snapshot.exitCode !== 0) throw new Error("Cannot snapshot password hardening configuration");
              const passwordSsh = activeSsh;
              const lockedPassword = (action: string) => passwordSsh.execute(`sudo flock -w 30 ${backup}/lock /bin/sh -c 'set -eu; test ! -e ${backup}/expired; systemctl is-active --quiet ${unit}.timer; ${action}'`);
              const verifyPasswordSsh = async () => {
                const checkSsh = await connectVerified(keyConnOptions);
                try {
                  const check = await checkSsh.execute('echo "myrmidon-key-verify"');
                  if (check.exitCode !== 0 || check.stdout.trim() !== "myrmidon-key-verify") throw new Error("unexpected SSH verification response");
                } finally {
                  await checkSsh.disconnect().catch(() => {});
                }
              };
              const armed = await passwordSsh.execute(`: start-myrmidon-password-timer; sudo systemd-run --unit=${unit} --on-active=${ROLLBACK_DELAY_SECONDS}s /bin/sh ${backup}/restore.sh >/dev/null && sudo systemctl is-active --quiet ${unit}.timer && echo timer-confirmed`);
              if (armed.exitCode !== 0 || armed.stdout.trim() !== "timer-confirmed") throw new Error("Password rollback timer start or confirmation failed; refusing to modify sshd");
              const timerConfirmedAt = performance.now();
              pendingPasswordRollback = async () => {
                const restore = async (ssh: SshExecutor) => {
                  const result = await ssh.execute(`: restore-myrmidon-password-config; sudo /bin/sh ${backup}/restore.sh immediate && sudo test -f ${backup}/restored && sudo systemctl stop ${unit}.timer`);
                  if (result.exitCode !== 0) throw new Error("configuration restoration failed");
                };
                await restoreOverSsh(passwordSsh, keyConnOptions, timerConfirmedAt, restore);
                await verifyPasswordSsh();
              };
              commitPassword = async () => {
                const committed = await lockedPassword(`systemctl stop ${unit}.timer; touch ${backup}/committed`);
                if (committed.exitCode !== 0) throw new Error("Password rollback timer disarm failed or rollback already started");
              };
              discardPasswordBackup = async () => { await passwordSsh.execute(`sudo rm -rf ${backup}`); };
              {
                // Record the new inode and bytes before publishing the candidate atomically.
                const write = await lockedPassword(`test ! -L ${file}; if test -f ${backup}/absent; then test ! -e ${file}; else test -f ${file}; cmp -s ${backup}/original ${file}; fi; mkdir -p /etc/ssh/sshd_config.d; candidate=$(mktemp ${file}.new.XXXXXX); trap "rm -f -- \"$candidate\"" EXIT; if test -f ${backup}/original; then cp -p ${backup}/original "$candidate"; else chmod 644 "$candidate"; fi; printf "PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n" > "$candidate"; cp "$candidate" ${backup}/installed-content; stat -c %d:%i "$candidate" > ${backup}/candidate-inode; mv -fT ${backup}/candidate-inode ${backup}/installed-inode; mv -fT "$candidate" ${file}`);
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
                await verifyPasswordSsh();
              }
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
              activeSsh = await connectVerified(connOptions);
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
            const prerequisites = await activeSsh.execute(": check-myrmidon-firewall-prerequisites; command -v systemd-run >/dev/null && command -v systemctl >/dev/null && command -v flock >/dev/null && sudo systemctl show --property=Version --value >/dev/null");
            if (prerequisites.exitCode !== 0) {
              throw new Error("Firewall rollback timer prerequisites unavailable; refusing unsafe firewall changes");
            }

            const ssh = activeSsh;
            const nonce = randomUUID();
            const timer = `myrmidon-firewall-${nonce}`;
            const { companyId, serverId } = claim.job;
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
            if (!uuid.test(companyId) || !uuid.test(serverId)) {
              throw new Error("Firewall hardening requires a valid ownership scope");
            }
            const ruleMarker = `myrmidon:${companyId}:${serverId}:${nonce}`;
            const rollbackDir = `/var/tmp/${timer}`;
            const incomingPolicy = /^Default:\s+(allow|deny|reject) \(incoming\)/.exec(defaultLines[0] ?? "")?.[1];
            if (!incomingPolicy) throw new Error("Firewall default policy unconfirmed; refusing unsafe firewall changes");
            const port = claim.server.port;
            const verifyFirewallSsh = async () => {
              const fresh = await connectVerified(connOptions);
              try {
                const probe = await fresh.execute('echo "ufw-connectivity-ok"');
                if (probe.exitCode !== 0 || probe.stdout.trim() !== "ufw-connectivity-ok") {
                  throw new Error("Firewall SSH connectivity verification failed");
                }
              } finally {
                await fresh.disconnect().catch(() => {});
              }
            };
            const disarm = async () => {
              const stopped = await ssh.execute(`: stop-myrmidon-firewall-timer; sudo systemctl stop ${timer}.timer`);
              if (stopped.exitCode !== 0) throw new Error("Firewall rollback timer disarm failed");
            };
            const discard = async () => { await ssh.execute(`sudo rm -rf ${rollbackDir}`); };
            const runLocked = (marker: string, action: string) =>
              ssh.execute(`: ${marker}; sudo flock -w 30 ${rollbackDir}/lock /bin/sh -c 'set -eu; test ! -e ${rollbackDir}/expired; systemctl is-active --quiet ${timer}.timer; ${action}'`);
            let timerConfirmedAt: number;
            try {
              // UFW matches deletes by rule tuple, not comment. Refuse ambiguous tuples.
              const restoreScript = `#!/bin/sh
set -eu
export LC_ALL=C
exec 9>${rollbackDir}/lock
flock -x 9
test "$#" -gt 0 || test ! -e ${rollbackDir}/committed || exit 0
test ! -e ${rollbackDir}/restored || exit 0
touch ${rollbackDir}/expired
if [ -f ${rollbackDir}/policy-changed ]; then
  current=$(ufw status verbose)
  statuses=$(printf "%s\\n" "$current" | grep -iE "^[[:space:]]*Status:" || true)
  defaults=$(printf "%s\\n" "$current" | grep -iE "^[[:space:]]*Default:" || true)
  [ "$statuses" = "Status: active" ] || exit 1
  printf "%s\\n" "$defaults" | grep -Eq "^Default: (allow|deny|reject) \\(incoming\\), (allow|deny|reject) \\(outgoing\\), (allow|deny|reject|disabled) \\(routed\\)$" || exit 1
  [ "$(printf "%s\\n" "$defaults" | grep -c .)" -eq 1 ] || exit 1
  if printf "%s\\n" "$defaults" | grep -q "^Default: deny "; then
    ufw default ${incomingPolicy} incoming
  fi
fi
if [ -f ${rollbackDir}/rule-changed ]; then
  rules=$(ufw status numbered)
  statuses=$(printf "%s\\n" "$rules" | grep -iE "^[[:space:]]*Status:" || true)
  [ "$statuses" = "Status: active" ] || exit 1
  matches=$(printf "%s\\n" "$rules" | grep -E "# ${ruleMarker}[[:space:]]*$" || true)
  if [ -n "$matches" ]; then
    unexpected=$(printf "%s\\n" "$matches" | grep -vE "^\\[[[:space:]]*[0-9]+\\][[:space:]]+${port}/tcp( \\(v6\\))?[[:space:]]+ALLOW IN[[:space:]]+Anywhere( \\(v6\\))?[[:space:]]+# ${ruleMarker}[[:space:]]*$" || true)
    [ -z "$unexpected" ] || exit 1
    [ "$(printf "%s\\n" "$matches" | grep -c .)" -le 2 ] || exit 1
    [ "$(printf "%s\\n" "$matches" | grep -c "(v6)" || true)" -le 1 ] || exit 1
    [ "$(printf "%s\\n" "$matches" | grep -vc "(v6)" || true)" -le 1 ] || exit 1
    candidates=$(printf "%s\\n" "$rules" | grep -E "^\\[[[:space:]]*[0-9]+\\][[:space:]]+${port}/tcp( \\(v6\\))?[[:space:]]+ALLOW IN[[:space:]]+Anywhere( \\(v6\\))?([[:space:]]+#.*)?[[:space:]]*$" || true)
    [ "$candidates" = "$matches" ] || exit 1
    ufw --force delete allow ${port}/tcp comment ${ruleMarker}
    rules=$(ufw status numbered)
    [ "$(printf "%s\\n" "$rules" | grep -iE "^[[:space:]]*Status:" || true)" = "Status: active" ] || exit 1
    if printf "%s\\n" "$rules" | grep -Eq "# ${ruleMarker}[[:space:]]*$"; then exit 1; fi
  fi
fi
touch ${rollbackDir}/restored
`;
              const preparation = await ssh.execute(`: prepare-myrmidon-firewall-restore; sudo mkdir -m 700 ${rollbackDir} && printf '%s' '${restoreScript}' | sudo tee ${rollbackDir}/restore.sh >/dev/null && sudo chmod 700 ${rollbackDir}/restore.sh && sudo sh -n ${rollbackDir}/restore.sh`);
              if (preparation.exitCode !== 0) throw new Error("Firewall rollback preparation failed; refusing unsafe firewall changes");
              const start = await ssh.execute(`: start-myrmidon-firewall-timer; sudo systemd-run --unit=${timer} --on-active=${ROLLBACK_DELAY_SECONDS}s /bin/sh ${rollbackDir}/restore.sh >/dev/null && sudo systemctl is-active --quiet ${timer}.timer && echo timer-confirmed`);
              if (start.exitCode !== 0 || start.stdout.trim() !== "timer-confirmed") {
                throw new Error("Firewall rollback timer start or confirmation failed; refusing unsafe firewall changes");
              }
              const check = await ssh.execute(`: check-myrmidon-firewall-timer; sudo systemctl is-active --quiet ${timer}.timer && echo timer-confirmed`);
              if (check.exitCode !== 0 || check.stdout.trim() !== "timer-confirmed") {
                throw new Error("Firewall rollback timer liveness confirmation failed; refusing unsafe firewall changes");
              }
              timerConfirmedAt = performance.now();
            } catch (error) {
              await disarm().then(discard).catch(() => {});
              const detail = error instanceof Error ? error.message : String(error);
              throw new Error(`Firewall rollback preparation/start failed: ${detail}`);
            }

            pendingFirewallRollback = async () => {
              await restoreOverSsh(ssh, connOptions, timerConfirmedAt, async (recovery) => {
                const restored = await recovery.execute(`: restore-myrmidon-firewall; sudo /bin/sh ${rollbackDir}/restore.sh immediate && sudo test -f ${rollbackDir}/restored`);
                if (restored.exitCode !== 0) throw new Error("Scoped restore command failed");
                const stopped = await recovery.execute(`: stop-myrmidon-firewall-timer; sudo systemctl stop ${timer}.timer`);
                if (stopped.exitCode !== 0) throw new Error("Firewall rollback timer disarm failed");
                await recovery.execute(`sudo rm -rf ${rollbackDir}`).catch(() => {});
              });
              await verifyFirewallSsh();
            };
            commitFirewall = async () => {
              // Fence a timer that has already started before reporting success.
              const committed = await runLocked("stop-myrmidon-firewall-timer", `systemctl stop ${timer}.timer; touch ${rollbackDir}/committed`);
              if (committed.exitCode !== 0) throw new Error("Firewall rollback timer disarm failed or rollback already started");
            };
            discardFirewallBackup = discard;

            // UFW plain allow can replace an existing rule with the same tuple.
            // Prepend avoids replacing it (a duplicate is reported as skipped).
            // Mark intent inside the lock, before a potentially partial apply.
            const allow = await runLocked("apply-myrmidon-firewall-allow", `touch ${rollbackDir}/rule-changed; LC_ALL=C ufw prepend allow ${port}/tcp comment ${ruleMarker}`);
            const added = allow.stdout.trim().split(/\r?\n/);
            if (allow.exitCode !== 0 || !added.every((line) => /^Rule (?:inserted|added)(?: \(v6\))?$/.test(line))) {
              throw new Error("Firewall SSH allow failed or existing rule ownership is unconfirmed");
            }
            await verifyFirewallSsh();
            if (incomingPolicy !== "deny") {
              const deny = await runLocked("apply-myrmidon-firewall-deny", `export LC_ALL=C; state=$(ufw status verbose); status=$(printf "%s\\n" "$state" | grep -iE "^[[:space:]]*Status:" || true); defaults=$(printf "%s\\n" "$state" | grep -iE "^[[:space:]]*Default:" || true); test "$status" = "Status: active"; test "$(printf "%s\\n" "$defaults" | grep -c .)" -eq 1; printf "%s\\n" "$defaults" | grep -Eq "^Default: ${incomingPolicy} \\(incoming\\), (allow|deny|reject) \\(outgoing\\), (allow|deny|reject|disabled) \\(routed\\)$"; touch ${rollbackDir}/policy-changed; ufw default deny incoming`);
              if (deny.exitCode !== 0) throw new Error("Firewall incoming deny policy failed or original policy changed");
              await verifyFirewallSsh();
            }
            ownedFirewallRule = { kind: "firewall_rule", backend: "ufw", rule: `allow ${port}/tcp`, marker: ruleMarker };
            await reporter.reportStep("harden", "ok", "Firewall allow-before-deny verified via fresh SSH; rollback remains armed");
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

      if (commitFirewall) await commitFirewall();
      if (commitPassword) await commitPassword();
      await reporter.reportCompletion("succeeded", null, discoveredFingerprint, verifiedAccessPublicKey, ownedFirewallRule);
      pendingFirewallRollback = null;
      if (discardFirewallBackup) await discardFirewallBackup().catch(() => {});
      pendingPasswordRollback = null;
      if (discardPasswordBackup) await discardPasswordBackup().catch(() => {});
      return {
        status: "succeeded",
        hostKeyFingerprint: discoveredFingerprint,
        stepsCompleted,
      };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);

      if (pendingFirewallRollback) {
        try {
          await pendingFirewallRollback();
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          message += `; firewall rollback failed or unconfirmed: ${detail}`;
        }
      }

      if (pendingPasswordRollback) {
        try {
          await pendingPasswordRollback();
          if (discardPasswordBackup) await discardPasswordBackup().catch(() => {});
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          message += `; password configuration rollback unconfirmed: ${detail}`;
        }
      }

      for (const secret of Object.values(claim.secretValues)) {
        if (secret) message = message.split(secret).join("[REDACTED]");
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
