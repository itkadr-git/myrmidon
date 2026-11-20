import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockSshExecutor } from "../../services/fleet/mock-ssh-executor.js";
import { defaultGenerateKeyPair, FleetOnboardExecutor, type ExecutorReporter } from "./executor.js";
import type { OnboardJobClaim } from "./store.js";

class VerifiedMockSsh extends MockSshExecutor {
  constructor(options: string | ConstructorParameters<typeof MockSshExecutor>[0] = "SHA256:testfingerprint123456789") {
    super(typeof options === "string" ? undefined : options);
    this.fingerprint = typeof options === "string" ? options : "SHA256:testfingerprint123456789";
  }

  private readonly fingerprint: string;

  override async connect(options?: Parameters<MockSshExecutor["connect"]>[0]) {
    if (!options?.hostVerifier || !(await options.hostVerifier(this.fingerprint))) {
      throw new Error("TOFU host key verification failed");
    }
    await super.connect(options);
  }
}

function createMockReporter(): {
  reporter: ExecutorReporter;
  steps: Array<{ step: string; result: "ok" | "skipped" | "failed"; detail?: string | null }>;
  completion: { status: "succeeded" | "failed"; error?: string | null; hostKeyFingerprint?: string | null } | null;
} {
  const steps: Array<{ step: string; result: "ok" | "skipped" | "failed"; detail?: string | null }> = [];
  let completion: { status: "succeeded" | "failed"; error?: string | null; hostKeyFingerprint?: string | null } | null = null;

  return {
    reporter: {
      async pinHostKey() { return true; },
      async reportStep(step, result, detail) {
        steps.push({ step, result, detail });
      },
      async reportCompletion(status, error, hostKeyFingerprint) {
        completion = { status, error, hostKeyFingerprint };
      },
    },
    steps,
    get completion() {
      return completion;
    },
  };
}

describe("FleetOnboardExecutor (OPE-8840 contract tests)", () => {
  it("redacts claim credentials from transport failures and reports", async () => {
    const password = "bootstrap-sensitive-value";
    const key = "private-sensitive-value";
    class FailingSsh extends MockSshExecutor {
      override async connect() { throw new Error(`failure ${password} ${key}`); }
    }
    const reporter = createMockReporter();
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => new FailingSsh() });
    const claim = {
      job: { id: "job", companyId: "c1", serverId: "s1" },
      server: { hostname: "example.com", port: 22, username: "root" },
      steps: ["connect"], options: { keepPassword: true },
      secretValues: { bootstrapPassword: password, accessKey: key },
    } as unknown as OnboardJobClaim & { secretValues: Record<string, string> };
    const result = await executor.execute(claim, reporter.reporter);
    const exposed = JSON.stringify({ result, steps: reporter.steps, completion: reporter.completion });
    expect(result.status).toBe("failed");
    expect(exposed).not.toContain(password);
    expect(exposed).not.toContain(key);
  });

  it("rejects a changed host key during handshake before authenticating", async () => {
    const events: string[] = [];
    class HandshakeSsh extends MockSshExecutor {
      override async connect(options?: Parameters<MockSshExecutor["connect"]>[0]) {
        const verify = options && Reflect.get(options, "hostVerifier");
        if (typeof verify !== "function") throw new Error("Host verifier missing");
        events.push("host-key");
        if (!(await verify("SHA256:changed"))) throw new Error("Host key rejected");
        events.push("authentication");
      }
    }
    const ssh = new HandshakeSsh();
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-host", companyId: "c1", serverId: "s1" },
      server: { hostname: "example.com", port: 22, username: "root", hostKeyFingerprint: "SHA256:original" },
      steps: ["connect"],
      options: { keepPassword: false },
      secretValues: { bootstrapPassword: "sensitive" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(events).toEqual(["host-key"]);
  });

  it("rejects a connection that skipped host verification even when a pin exists", async () => {
    const ssh = new MockSshExecutor();
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-unverified", companyId: "c1", serverId: "s1" },
      server: { hostname: "example.com", port: 22, username: "root", hostKeyFingerprint: "SHA256:original" },
      steps: ["connect"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "sensitive" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("SSH transport did not provide a verified host key");
    expect(ssh.hasExecuted("cat /etc/os-release")).toBe(false);
  });

  it("generates an OpenSSH public key matching its private key", async () => {
    const { createPublicKey } = await import("node:crypto");
    const pair = defaultGenerateKeyPair();
    const derived = createPublicKey(pair.privateKey).export({ format: "jwk" });
    const [algorithm, encoded] = pair.publicKey.split(" ");
    expect(algorithm).toBe("ssh-ed25519");
    const wire = Buffer.from(encoded, "base64");
    const typeLength = wire.readUInt32BE(0);
    const keyLength = wire.readUInt32BE(4 + typeLength);
    expect(derived.x).toBeDefined();
    expect(wire.subarray(8 + typeLength, 8 + typeLength + keyLength)).toEqual(Buffer.from(derived.x ?? "", "base64url"));
  });
  it("executes standard onboarding workflow and disables password when keepPassword=false", async () => {
    const mockSsh = new VerifiedMockSsh();
    // mock responses
    mockSsh.mockResponse(/ssh-keygen -l/, {
      stdout: "256 SHA256:testfingerprint123456789 root@test (ED25519)",
      exitCode: 0,
    });
    mockSsh.mockResponse("cat /etc/os-release", {
      stdout: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian',
      exitCode: 0,
    });
    mockSsh.mockResponse("df -P /", {
      stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000000 2000000 8000000 20% /",
      exitCode: 0,
    });
    mockSsh.mockResponse("sudo -n true", { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/test -d \/usr\/local\/cpanel/, { stdout: "", exitCode: 1 });
    mockSsh.mockResponse(/mkdir -p ~\/\.ssh/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    mockSsh.mockResponse(/50-myrmidon-hardening\.conf/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/start-myrmidon-password-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    mockSsh.mockResponse(/check-myrmidon-firewall-prerequisites/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse("sudo sshd -t", { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sudo systemctl reload/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sshd -T/, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    mockSsh.mockResponse("sudo ufw status", { stdout: "Status: active\n", exitCode: 0 });
    mockSsh.mockResponse(/snapshot-myrmidon-firewall/, { stdout: "Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n", exitCode: 0 });
    mockSsh.mockResponse(/start-myrmidon-firewall-timer|check-myrmidon-firewall-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    mockSsh.mockResponse(/ufw prepend allow/, { stdout: "Rule inserted\n", exitCode: 0 });
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    mockSsh.mockResponse('echo "onboard-verified"', { stdout: "onboard-verified\n", exitCode: 0 });

    const durablePair = defaultGenerateKeyPair();
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
    });

    const mockReporter = createMockReporter();
    const claim: OnboardJobClaim & { secretValues: Record<string, string> } = {
      job: {
        id: "job-1",
        companyId: "comp-1",
        serverId: "srv-1",
        kind: "onboard",
        status: "claimed",
        step: "connect",
        stepLog: [],
        error: null,
        createdBy: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      server: {
        id: "srv-1",
        slug: "srv-node-1",
        hostname: "server.example.com",
        port: 22,
        username: "ubuntu",
        protocol: "ssh",
        keepPassword: false,
        passwordSecretKey: "fleet-srv-node-1-bootstrap-password",
        accessKeySecretKey: "fleet-srv-node-1-access-key",
        hostKeyFingerprint: null,
      },
      steps: ["connect", "preflight", "access", "harden", "monitoring", "role", "verify"],
      options: { keepPassword: false, installDocker: false, role: "generic" },
      secretValues: {
        bootstrapPassword: "initial-password-123",
        accessKey: durablePair.privateKey,
      },
    };

    const result = await executor.execute(claim, mockReporter.reporter);

    expect(result.status).toBe("succeeded");
    expect(result.hostKeyFingerprint).toBe("SHA256:testfingerprint123456789");
    expect(mockReporter.completion?.status).toBe("succeeded");
    expect(mockReporter.steps.map((s) => s.step)).toEqual([
      "connect",
      "preflight",
      "access",
      "harden",
      "monitoring",
      "role",
      "verify",
    ]);

    // Check that hardening conf was written and sshd tested
    expect(mockSsh.hasExecuted("sudo sshd -t")).toBe(true);
    // Check that ufw rollback was disarmed after connectivity verification
    expect(mockSsh.hasExecuted(/stop-myrmidon-firewall-timer/)).toBe(true);
  });

  it("does not install an unpersisted key when the durable key is missing", async () => {
    const ssh = new VerifiedMockSsh();
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-missing-key", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root", accessKeySecretKey: null },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("durable access key");
    expect(ssh.hasExecuted(/authorized_keys/)).toBe(false);
  });

  it("never disables password authentication for a key generated only in executor memory", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-ephemeral", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root", accessKeySecretKey: null },
      steps: ["access"],
      options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("durable access key");
    expect(mockSsh.hasExecuted('echo "myrmidon-key-verify"')).toBe(false);
    expect(mockSsh.hasExecuted(/PasswordAuthentication no/)).toBe(false);
  });

  it("fails onboarding with an ephemeral key even when password retention is requested", async () => {
    const ssh = new VerifiedMockSsh();
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => ssh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const claim: any = {
      job: { id: "job-ephemeral-retained", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root", accessKeySecretKey: null },
      steps: ["access"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };
    const reporter = createMockReporter();
    const result = await executor.execute(claim, reporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("durable access key");
    expect(reporter.completion?.status).toBe("failed");
    expect(ssh.hasExecuted(/PasswordAuthentication no/)).toBe(false);
  });

  it("fails preflight when disk usage exceeds 90%", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse(/ssh-keygen -l/, {
      stdout: "256 SHA256:fingerprint root@test (ED25519)",
      exitCode: 0,
    });
    mockSsh.mockResponse("cat /etc/os-release", {
      stdout: 'NAME="Ubuntu"\nID=ubuntu',
      exitCode: 0,
    });
    mockSsh.mockResponse("df -P /", {
      stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000000 9500000 500000 95% /",
      exitCode: 0,
    });

    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-2", companyId: "c1", serverId: "s2" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["connect", "preflight", "access", "verify"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("disk usage is 95%");
    expect(mockReporter.completion?.status).toBe("failed");
    expect(mockReporter.steps).toContainEqual({
      step: "preflight",
      result: "failed",
      detail: expect.stringContaining("disk usage is 95%"),
    });
  });

  it("fails preflight when disk usage cannot be determined", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse("df -P /", { stdout: "", stderr: "df failed", exitCode: 1 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-disk", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["preflight"],
      options: { keepPassword: true },
      secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("disk usage");
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("fails preflight when memory information is unavailable", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse("free -m", { stdout: "", stderr: "free failed", exitCode: 1 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-memory", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["preflight"],
      options: { keepPassword: true },
      secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("memory");
    expect(mockReporter.steps).toContainEqual({
      step: "preflight", result: "failed", detail: expect.stringContaining("memory"),
    });
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("stops before key verification when authorized_keys installation fails", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse(/mkdir -p ~\/\.ssh/, { stdout: "", stderr: "permission denied", exitCode: 1 });
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-key-install", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root", accessKeySecretKey: "stored" },
      steps: ["access"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass", accessKey: defaultGenerateKeyPair().privateKey },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("SSH key installation failed");
    expect(mockSsh.hasExecuted('echo "myrmidon-key-verify"')).toBe(false);
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("allows SSH before denying incoming traffic and verifies a fresh connection", async () => {
    const ssh = new VerifiedMockSsh();
    ssh.mockResponse("sudo ufw status", { stdout: "Status: active\n", exitCode: 0 });
    ssh.mockResponse(/snapshot-myrmidon-firewall/, { stdout: "Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n", exitCode: 0 });
    ssh.mockResponse(/check-myrmidon-firewall-prerequisites/, { stdout: "", exitCode: 0 });
    ssh.mockResponse(/prepare-myrmidon-firewall-restore/, { stdout: "", exitCode: 0 });
    ssh.mockResponse(/start-myrmidon-firewall-timer|check-myrmidon-firewall-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    ssh.mockResponse(/ufw prepend allow/, { stdout: "Rule added\n", exitCode: 0 });
    ssh.mockResponse(/ufw default deny incoming/, { stdout: "", exitCode: 0 });
    ssh.mockResponse(/stop-myrmidon-firewall-timer/, { stdout: "", exitCode: 0 });
    ssh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-success", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.error ?? null).toBeNull();
    expect(result.status).toBe("succeeded");
    const commands = ssh.executedCommands.map(({ command }) => command);
    const timer = commands.findIndex((command) => command.includes("check-myrmidon-firewall-timer"));
    const allow = commands.findIndex((command) => command.includes("ufw prepend allow"));
    const deny = commands.findIndex((command) => command.includes("ufw default deny incoming"));
    const verify = commands.findLastIndex((command) => command.includes('echo "ufw-connectivity-ok"'));
    expect(timer).toBeGreaterThanOrEqual(0);
    expect(allow).toBeGreaterThan(timer);
    expect(deny).toBeGreaterThan(allow);
    expect(verify).toBeGreaterThan(deny);
    expect(ssh.connectionHistory.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses firewall mutation when timer startup exits successfully without confirmation", async () => {
    let timerStartAttempted = false;
    const ssh = new VerifiedMockSsh({ onCommand: (command) => {
      if (command.includes("start-myrmidon-firewall-timer")) {
        timerStartAttempted = true;
        return { exitCode: 0, stdout: "" };
      }
      return undefined;
    } });
    ssh.mockResponse("sudo ufw status", { stdout: "Status: active\n", exitCode: 0 });
    ssh.mockResponse(/snapshot-myrmidon-firewall/, { stdout: "Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n", exitCode: 0 });
    ssh.mockResponse(/check-myrmidon-firewall-prerequisites/, { stdout: "", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-timer-unconfirmed", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(timerStartAttempted).toBe(true);
    expect(result.error).toMatch(/timer.*confirm/i);
    expect(ssh.hasExecuted(/apply-myrmidon-firewall-(allow|deny)/)).toBe(false);
  });

  it.each(["allow", "deny", "ambiguous"])("handles a scoped rollback after an executed %s failure", async (failure) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "myrmidon-ufw-partial-"));
    const rules = join(dir, "rules");
    const calls = join(dir, "calls");
    const policy = join(dir, "policy");
    writeFileSync(rules, "operator-original\n");
    writeFileSync(policy, "allow\n");
    writeFileSync(join(dir, "sudo"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  ufw|systemctl|systemd-run|flock|mkdir|tee|chmod|sh|/bin/sh|rm) exec "$@" ;;
esac
exit 97
`);
    writeFileSync(join(dir, "ufw"), `#!/bin/sh
printf 'ufw %s\\n' "$*" >> "$CALLS"
case "$1" in
      status)
        printf 'Status: active\\n'
        if [ "$2" = verbose ]; then printf 'Default: %s (incoming), allow (outgoing), disabled (routed)\\n' "$(tr -d '\\n' < "$POLICY")"; fi
        if [ "$2" = numbered ] && [ -s "$RULES.owner" ]; then
          if [ "$FAILURE" = ambiguous ]; then printf '[ 1] 22/tcp ALLOW IN Anywhere # operator\\n'; fi
          printf '[ 1] 22/tcp ALLOW IN Anywhere # %s\\n' "$(tr -d '\\n' < "$RULES.owner")"
        fi ;;
      prepend)
        printf '%s\\n' "$5" > "$RULES.owner"
        printf 'onboarding-ssh\\noperator-concurrent\\n' >> "$RULES"
        if [ "$FAILURE" != deny ]; then exit 1; fi
        printf 'Rule inserted\\n' ;;
      default)
        printf '%s\\n' "$2" > "$POLICY"
        if [ "$2" = deny ]; then exit 1; fi ;;
      --force)
        [ "$2 $3 $4 $5 $6" = "delete allow 22/tcp comment $(tr -d '\\n' < "$RULES.owner")" ] || exit 1
        grep -vx onboarding-ssh "$RULES" > "$RULES.new" && mv "$RULES.new" "$RULES" && rm "$RULES.owner" ;;
      *) exit 97 ;;
esac
`);
    for (const name of ["systemctl", "systemd-run"]) {
      writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    chmodSync(join(dir, "ufw"), 0o700);
    chmodSync(join(dir, "sudo"), 0o700);
    try {
      const ssh = new VerifiedMockSsh({ onCommand: (command) => {
        if (command === 'echo "ufw-connectivity-ok"') return { stdout: "ufw-connectivity-ok\n", exitCode: 0 };
        const result = spawnSync("sh", ["-c", command.replaceAll("/var/tmp/myrmidon-firewall-", `${dir}/myrmidon-firewall-`)], {
          encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, RULES: rules, POLICY: policy, FAILURE: failure }, timeout: 5000,
        });
        return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
      } });
      const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
      const claim: any = {
        job: { id: "job-real-concurrent-partial", companyId: "c1", serverId: "s1" },
        server: { hostname: "1.2.3.4", port: 22, username: "root" },
        steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
      };
      const result = await executor.execute(claim, createMockReporter().reporter);
      expect(result.status).toBe("failed");
      if (failure === "ambiguous") {
        expect(result.error).toMatch(/rollback failed or unconfirmed/);
        expect(readFileSync(calls, "utf8")).not.toContain("ufw --force delete");
        return;
      }
      expect(result.error).not.toMatch(/rollback failed or unconfirmed/);
      expect(readFileSync(calls, "utf8")).toMatch(/ufw prepend allow/);
      expect(readFileSync(calls, "utf8").includes("ufw default deny incoming")).toBe(failure === "deny");
      expect(readFileSync(policy, "utf8")).toBe("allow\n");
      expect(readFileSync(rules, "utf8").split("\n").filter(Boolean).sort()).toEqual(["operator-concurrent", "operator-original"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies a fresh SSH connection after a failed deny policy is restored", async () => {
    const primary = new VerifiedMockSsh();
    const beforeDeny = new VerifiedMockSsh();
    const restored = new VerifiedMockSsh();
    primary.mockResponse("sudo ufw status", { stdout: "Status: active\n", exitCode: 0 });
    primary.mockResponse(/snapshot-myrmidon-firewall/, { stdout: "Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n", exitCode: 0 });
    primary.mockResponse(/start-myrmidon-firewall-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    primary.mockResponse(/check-myrmidon-firewall-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    primary.mockResponse(/ufw prepend allow/, { stdout: "Rule inserted\n", exitCode: 0 });
    primary.mockResponse(/ufw default deny incoming/, { exitCode: 1, stderr: "policy failed" });
    beforeDeny.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    restored.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    const connections = [primary, beforeDeny, restored];
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => {
      const connection = connections.shift();
      if (!connection) throw new Error("Unexpected SSH connection");
      return connection;
    } });
    const claim: any = {
      job: { id: "job-deny-restore-ssh", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(primary.hasExecuted(/ufw default deny incoming/)).toBe(true);
    expect(beforeDeny.hasExecuted('echo "ufw-connectivity-ok"')).toBe(true);
    expect(beforeDeny.isConnected()).toBe(false);
    expect(primary.hasExecuted(/restore-myrmidon-firewall/)).toBe(true);
    expect(restored.hasExecuted('echo "ufw-connectivity-ok"')).toBe(true);
    expect(restored.isConnected()).toBe(false);
  });

  it("fails and restores password configuration when sshd reload fails", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse(/start-myrmidon-password-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    mockSsh.mockResponse(/sshd -T/, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    mockSsh.mockResponse("sudo systemctl reload ssh || sudo systemctl reload sshd", { exitCode: 1, stderr: "reload failed" });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-reload", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root", accessKeySecretKey: "stored" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass", accessKey: defaultGenerateKeyPair().privateKey },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockReporter.completion?.status).toBe("failed");
    expect(mockSsh.hasExecuted(/restore-myrmidon-password-config/)).toBe(true);
  });

  it("restores password configuration if subsequent firewall hardening fails", async () => {
    const ssh = new VerifiedMockSsh();
    ssh.mockResponse(/start-myrmidon-password-timer/, { stdout: "timer-confirmed\n", exitCode: 0 });
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    ssh.mockResponse(/sshd -T/, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    ssh.mockResponse("sudo ufw status", { stdout: "Status: active\n", exitCode: 0 });
    ssh.mockResponse(/snapshot-myrmidon-firewall/, { stdout: "Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n", exitCode: 0 });
    ssh.mockResponse(/check-myrmidon-firewall-prerequisites/, { exitCode: 0, stdout: "" });
    ssh.mockResponse(/start-myrmidon-firewall-timer/, { exitCode: 1, stderr: "timer unavailable" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-password-then-firewall-failure", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root", accessKeySecretKey: "stored" },
      steps: ["access", "harden"], options: { keepPassword: false },
      secretValues: { accessKey: defaultGenerateKeyPair().privateKey },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/start-myrmidon-firewall-timer/)).toBe(true);
    expect(result.error).toMatch(/timer.*(start|confirm)/i);
    expect(ssh.hasExecuted(/restore-myrmidon-password-config/)).toBe(true);
  });

  it("fails TOFU check when host key fingerprint does not match pinned value", async () => {
    const mockSsh = new VerifiedMockSsh("SHA256:differentKeyRoot");
    mockSsh.mockResponse(/ssh-keygen -l/, {
      stdout: "256 SHA256:differentKeyRoot root@test (ED25519)",
      exitCode: 0,
    });

    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-4", companyId: "c1", serverId: "s4" },
      server: {
        hostname: "1.2.3.4",
        port: 22,
        username: "root",
        hostKeyFingerprint: "SHA256:expectedPinnedKey",
      },
      steps: ["connect", "preflight", "verify"],
      options: { keepPassword: true },
      secretValues: { accessKey: "fake-key" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("TOFU host key verification failed");
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("does not report key verification success when only password credentials are available", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "onboard-verified"', { stdout: "onboard-verified\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-verify-password", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["verify"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockReporter.steps).toContainEqual({
      step: "verify", result: "failed", detail: expect.stringContaining("key"),
    });
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("fails rather than reporting an unknown step as executed", async () => {
    const mockSsh = new MockSshExecutor();
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-unknown", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["unexpected-step"],
      options: { keepPassword: true },
      secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockReporter.steps).toContainEqual({
      step: "unexpected-step", result: "failed", detail: expect.stringContaining("Unknown"),
    });
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("handles decommission job cleanup step", async () => {
    const mockSsh = new VerifiedMockSsh();
    mockSsh.mockResponse(/docker stop/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sed -i/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sudo ufw delete allow/, { stdout: "", exitCode: 0 });

    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-5", companyId: "c1", serverId: "s5", kind: "decommission" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["cleanup"],
      options: { keepPassword: true },
      secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    // Without an ownership inventory, cleanup must fail without touching workloads.
    expect(mockSsh.hasExecuted("docker stop $(docker ps -q) 2>/dev/null || true")).toBe(false);
    expect(mockReporter.steps).toEqual([
      { step: "cleanup", result: "failed", detail: expect.stringContaining("ownership inventory") },
    ]);
  });
});
