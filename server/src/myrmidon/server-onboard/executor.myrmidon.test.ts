import { describe, expect, it } from "vitest";
import { MockSshExecutor } from "../../services/fleet/mock-ssh-executor.js";
import { defaultGenerateKeyPair, FleetOnboardExecutor, type ExecutorReporter } from "./executor.js";
import type { OnboardJobClaim } from "./store.js";

function createMockReporter(): {
  reporter: ExecutorReporter;
  steps: Array<{ step: string; result: "ok" | "skipped" | "failed"; detail?: string | null }>;
  completion: { status: "succeeded" | "failed"; error?: string | null; hostKeyFingerprint?: string | null } | null;
} {
  const steps: Array<{ step: string; result: "ok" | "skipped" | "failed"; detail?: string | null }> = [];
  let completion: { status: "succeeded" | "failed"; error?: string | null; hostKeyFingerprint?: string | null } | null = null;

  return {
    reporter: {
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
  it("generates an OpenSSH authorized_keys-compatible Ed25519 public key", () => {
    const { publicKey } = defaultGenerateKeyPair();
    const [algorithm, encoded] = publicKey.trim().split(/\s+/);
    expect(algorithm).toBe("ssh-ed25519");
    const wire = Buffer.from(encoded ?? "", "base64");
    expect(wire.readUInt32BE(0)).toBe(11);
    expect(wire.subarray(4, 15).toString()).toBe("ssh-ed25519");
    expect(wire.readUInt32BE(15)).toBe(32);
    expect(wire.length).toBe(51);
  });

  it("executes standard onboarding workflow and disables password when keepPassword=false", async () => {
    const mockSsh = new MockSshExecutor();
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
    mockSsh.mockResponse("sudo sshd -t", { stdout: "", exitCode: 0 });
    mockSsh.mockResponse("sudo sshd -T", { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    mockSsh.mockResponse(/sshd -T -C /, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    mockSsh.mockResponse(/sudo systemctl reload/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sudo ufw allow/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/nohup sh -c 'sleep 300/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sudo ufw default deny incoming/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    mockSsh.mockResponse(/pkill -f 'sleep 300/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse('echo "onboard-verified"', { stdout: "onboard-verified\n", exitCode: 0 });

    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIgeneratedKey test-key",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key\n-----END OPENSSH PRIVATE KEY-----",
      }),
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
        accessKeySecretKey: null,
        hostKeyFingerprint: null,
      },
      steps: ["connect", "preflight", "access", "harden", "monitoring", "role", "verify"],
      options: { keepPassword: false, installDocker: false, role: "generic" },
      secretValues: {
        bootstrapPassword: "initial-password-123",
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
    expect(mockSsh.hasExecuted(/pkill -f 'sleep 300/)).toBe(true);
  });

  it("fails preflight when disk usage exceeds 90%", async () => {
    const mockSsh = new MockSshExecutor();
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
    const mockSsh = new MockSshExecutor();
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

  it("stops before key verification when authorized_keys installation fails", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse(/mkdir -p ~\/\.ssh/, { stdout: "", stderr: "permission denied", exitCode: 1 });
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-key-install", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockSsh.hasExecuted('echo "myrmidon-key-verify"')).toBe(false);
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("rejects a forged key verification marker before changing password authentication", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "not-myrmidon-key-verify\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-key-marker", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockSsh.hasExecuted(/50-myrmidon-hardening\.conf/)).toBe(false);
  });

  it("does not install a fabricated public key when an existing private key is supplied", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-existing-access-key", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: true },
      secretValues: { accessKey: "existing-private-key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("succeeded");
    expect(ssh.hasExecuted(/AAAAC3NzaC1lZDI1NTE5AAAAIExistingKey/)).toBe(false);
  });

  it("closes the bootstrap connection after switching to verified key authentication", async () => {
    const initial = new MockSshExecutor();
    const verified = new MockSshExecutor();
    verified.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    const connections = [initial, verified];
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => {
        const connection = connections.shift();
        if (!connection) throw new Error("Unexpected SSH connection");
        return connection;
      },
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const claim: any = {
      job: { id: "job-bootstrap-disconnect", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("succeeded");
    expect(initial.isConnected()).toBe(false);
    expect(verified.isConnected()).toBe(false);
  });

  it("closes the fresh SSH connection when key verification fails", async () => {
    const initial = new MockSshExecutor();
    const fresh = new MockSshExecutor();
    fresh.mockResponse('echo "myrmidon-key-verify"', { stdout: "incorrect", exitCode: 0 });
    const connections = [initial, fresh];
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => {
        const connection = connections.shift();
        if (!connection) throw new Error("Unexpected SSH connection");
        return connection;
      },
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const claim: any = {
      job: { id: "job-key-disconnect", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(fresh.isConnected()).toBe(false);
    expect(initial.hasExecuted(/50-myrmidon-hardening\.conf/)).toBe(false);
  });

  it("writes password directives as separate sshd configuration lines", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    ssh.mockResponse(/sshd -T/, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-password-lines", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("succeeded");
    expect(ssh.hasExecuted(/printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n'/)).toBe(true);
  });

  it("does not report password hardening when effective sshd settings still allow passwords", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    ssh.mockResponse(/sshd -T/, { stdout: "passwordauthentication yes\nkbdinteractiveauthentication yes\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => ssh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const claim: any = {
      job: { id: "job-effective-password-settings", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const reporter = createMockReporter();
    const result = await executor.execute(claim, reporter.reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/restore-myrmidon-password-config/)).toBe(true);
    expect(reporter.steps).not.toContainEqual(expect.objectContaining({ step: "access", result: "ok" }));
  });

  it("rejects password hardening when a matching SSH context still permits passwords", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    ssh.mockResponse("sudo sshd -T", { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    ssh.mockResponse(/sshd -T .* -C |sshd -T -C /, { stdout: "passwordauthentication yes\nkbdinteractiveauthentication yes\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => ssh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const claim: any = {
      job: { id: "job-match-password-settings", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Effective sshd configuration still permits password authentication");
    expect(ssh.hasExecuted(/restore-myrmidon-password-config/)).toBe(true);
    expect(ssh.hasExecuted(/^sudo systemctl reload/)).toBe(false);
  });

  it("fails and restores password configuration when sshd reload fails", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    mockSsh.mockResponse(/sshd -T/, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    mockSsh.mockResponse(/sudo systemctl reload ssh \|\| sudo systemctl reload sshd/, { exitCode: 1, stderr: "reload failed" });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-reload", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockReporter.completion?.status).toBe("failed");
    expect(mockSsh.hasExecuted(/restore-myrmidon-password-config/)).toBe(true);
  });

  it("reports a failed password configuration restoration instead of claiming rollback succeeded", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    mockSsh.mockResponse("sudo sshd -t", { exitCode: 1, stderr: "invalid configuration" });
    mockSsh.mockResponse(/restore-myrmidon-password-config/, { exitCode: 1, stderr: "restore failed" });
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-restore-failure", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("configuration restoration failed");
    expect(result.error).toContain("sshd configuration test failed");
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("reports password restoration failure when the SSH restore command throws", async () => {
    const ssh = new MockSshExecutor({ timeoutCommands: [/restore-myrmidon-password-config/] });
    ssh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    ssh.mockResponse("sudo sshd -t", { exitCode: 1, stderr: "invalid configuration" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-restore-timeout", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("configuration restoration failed");
  });

  it("restores the password configuration when the post-reload SSH check fails", async () => {
    const initial = new MockSshExecutor();
    const verified = new MockSshExecutor();
    const fresh = new MockSshExecutor();
    verified.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    fresh.mockResponse('echo "myrmidon-key-verify"', { stdout: "forged-myrmidon-key-verify\n", exitCode: 0 });
    verified.mockResponse("sudo sshd -T", { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    verified.mockResponse(/sshd -T -C /, { stdout: "passwordauthentication no\nkbdinteractiveauthentication no\n", exitCode: 0 });
    const connections = [initial, verified, fresh];
    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => {
        const connection = connections.shift();
        if (!connection) throw new Error("Unexpected SSH connection");
        return connection;
      },
      generateKeyPair: () => ({ publicKey: "ssh-ed25519 test", privateKey: "private-key" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-post-reload", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "pass" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("SSH verification after password hardening failed");
    expect(verified.hasExecuted(/restore-myrmidon-password-config/)).toBe(true);
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("refuses active firewall changes when scoped rollback is unavailable", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { stdout: "Status: active\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-unsafe-rollback", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/scoped.*rollback.*unavailable/i);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
    expect(ssh.hasExecuted(/pkill|restore-myrmidon-firewall/)).toBe(false);
  });

  it("fails closed without mutating an initially disabled firewall", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { stdout: "Status: inactive\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-inactive", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/inactive.*refus/i);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
  });

  it("does not mutate the firewall when reading its original state times out", async () => {
    const ssh = new MockSshExecutor({ timeoutCommands: [/^sudo ufw status$/] });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-status-timeout", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted("sudo ufw status")).toBe(true);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
  });

  it("rejects contradictory firewall status before attempting hardening", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { stdout: "Status: active\nStatus: inactive\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-ambiguous", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/status unconfirmed/i);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
  });

  it("rejects an invalid SSH port before issuing firewall commands", async () => {
    const mockSsh = new MockSshExecutor();
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-firewall-port", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 65536, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockSsh.hasExecuted(/ufw/)).toBe(false);
  });

  it("refuses firewall mutation when the original state cannot be snapshotted", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse(/snapshot-myrmidon-firewall/, { exitCode: 1, stderr: "snapshot failed" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-snapshot-failed", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/sudo ufw allow|sudo ufw default/)).toBe(false);
  });

  it("restores the saved firewall state when adding the SSH rule partially fails", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse(/sudo ufw allow/, { exitCode: 1, stderr: "rule partially applied" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-allow-partial", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/restore-myrmidon-firewall/)).toBe(true);
    expect(ssh.hasExecuted("sudo ufw disable")).toBe(false);
  });

  it("preserves an operator's concurrent rule when a partially applied SSH allow is rolled back", async () => {
    const rules = new Set(["operator-original"]);
    const ssh = new MockSshExecutor({ onCommand: (command) => {
      if (command.includes("sudo ufw allow")) {
        rules.add("onboarding-ssh");
        rules.add("operator-concurrent");
        return { exitCode: 1, stderr: "rule partially applied" };
      }
      if (command.includes("restore-myrmidon-firewall")) {
        if (/cp .*\/etc\/ufw/.test(command)) rules.delete("operator-concurrent");
        if (/ufw .*delete|ufw delete/.test(command)) rules.delete("onboarding-ssh");
      }
      return undefined;
    } });
    ssh.mockResponse("sudo ufw status", { exitCode: 0, stdout: "Status: active\n" });
    ssh.mockResponse(/start-myrmidon-firewall-timer/, { exitCode: 0, stdout: "timer-confirmed\n" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-concurrent-rule-state", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/sudo ufw allow/)).toBe(true);
    expect(ssh.hasExecuted(/restore-myrmidon-firewall/)).toBe(true);
    expect([...rules].sort()).toEqual(["operator-concurrent", "operator-original"]);
  });

  it("does not overwrite concurrent UFW configuration changes when an allow command fails", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse(/sudo ufw allow/, { exitCode: 1, stderr: "rule partially applied" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-concurrent-change", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/cp -a .*\/ufw\/\. \/etc\/ufw\//)).toBe(false);
    expect(ssh.hasExecuted(/cp -a .*\/ufw-default \/etc\/default\/ufw/)).toBe(false);
  });

  it("attempts firewall restoration when the SSH allow command loses its connection", async () => {
    const ssh = new MockSshExecutor({ timeoutCommands: [/sudo ufw allow/] });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-allow-timeout", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/restore-myrmidon-firewall/)).toBe(true);
    expect(ssh.hasExecuted(/sudo ufw default deny/)).toBe(false);
  });

  it("does not disarm another onboarding job's firewall rollback timer", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-scoped-timer", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("succeeded");
    expect(ssh.hasExecuted(/pkill\s+-f/)).toBe(false);
  });

  it("does not disable an existing firewall when connectivity verification fails", async () => {
    const initial = new MockSshExecutor();
    const fresh = new MockSshExecutor();
    initial.mockResponse(/ufw status/, { stdout: "Status: active\n", exitCode: 0 });
    fresh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "incorrect", exitCode: 0 });
    const connections = [initial, fresh];
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => {
      const connection = connections.shift();
      if (!connection) throw new Error("Unexpected SSH connection");
      return connection;
    } });
    const claim: any = {
      job: { id: "job-existing-firewall", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(initial.hasExecuted(/ufw disable/)).toBe(false);
  });

  it("does not disable an existing firewall when applying the deny policy fails", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse(/ufw status/, { stdout: "Status: active\n", exitCode: 0 });
    ssh.mockResponse(/sudo ufw default deny incoming/, { exitCode: 1, stderr: "policy failed" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-existing-firewall-policy-failure", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted("sudo ufw disable")).toBe(false);
  });

  it("does not enable the firewall when the SSH allow rule fails", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse(/sudo ufw allow/, { stdout: "", stderr: "rule rejected", exitCode: 1 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-firewall-allow", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"],
      options: { keepPassword: true },
      secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockSsh.hasExecuted(/sudo ufw default deny incoming/)).toBe(false);
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("refuses firewall changes when the timer launch returns without confirming a running timer", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { exitCode: 0, stdout: "Status: active\n" });
    ssh.mockResponse(/start-myrmidon-firewall-timer/, { exitCode: 0, stdout: "" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-unconfirmed-timer", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/start-myrmidon-firewall-timer/)).toBe(true);
    expect(result.error).toMatch(/timer.*(confirm|unconfirmed)/i);
    expect(ssh.hasExecuted(/sudo ufw allow|sudo ufw default/)).toBe(false);
  });

  it("rejects a forged timer confirmation before any firewall mutation", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { exitCode: 0, stdout: "Status: active\n" });
    ssh.mockResponse(/start-myrmidon-firewall-timer/, { exitCode: 0, stdout: "not-timer-confirmed\n" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-forged-firewall-timer", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/start-myrmidon-firewall-timer/)).toBe(true);
    expect(result.error).toMatch(/timer.*(confirm|unconfirmed)/i);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
  });

  it("does not mutate the firewall when starting the rollback timer times out", async () => {
    const ssh = new MockSshExecutor({ timeoutCommands: [/start-myrmidon-firewall-timer/] });
    ssh.mockResponse("sudo ufw status", { exitCode: 0, stdout: "Status: active\n" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-timer-timeout", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/start-myrmidon-firewall-timer/)).toBe(true);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
  });

  it("reports timer launch failure before attempting any firewall mutation", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { exitCode: 0, stdout: "Status: active\n" });
    ssh.mockResponse(/start-myrmidon-firewall-timer/, { exitCode: 1, stderr: "timer unavailable" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-timer-launch-failure", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);

    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/start-myrmidon-firewall-timer/)).toBe(true);
    expect(result.error).toMatch(/timer.*(start|launch|unavailable)/i);
    expect(ssh.hasExecuted(/sudo ufw (allow|default|--force enable|disable)/)).toBe(false);
  });

  it("does not add an SSH rule when the rollback timer cannot start", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse("sudo ufw status", { exitCode: 0, stdout: "Status: active\n" });
    ssh.mockResponse(/nohup sh -c 'sleep 300/, { exitCode: 1, stderr: "timer unavailable" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-firewall-timer-before-rule", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(ssh.hasExecuted(/sudo ufw allow/)).toBe(false);
  });

  it("does not change the firewall policy when the rollback timer cannot start", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse(/nohup sh -c 'sleep 300/, { exitCode: 1, stderr: "timer unavailable" });
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-firewall-timer", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockSsh.hasExecuted(/sudo ufw default deny incoming/)).toBe(false);
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("fails hardening when the firewall policy command fails even if SSH remains reachable", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse(/sudo ufw default deny incoming/, { exitCode: 1, stderr: "ufw failed" });
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-firewall-policy", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("reports an unconfirmed firewall restoration when the deny policy and rollback both fail", async () => {
    const ssh = new MockSshExecutor();
    ssh.mockResponse(/sudo ufw default deny incoming/, { exitCode: 1, stderr: "policy failed" });
    ssh.mockResponse("sudo ufw disable", { exitCode: 1, stderr: "rollback failed" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh });
    const claim: any = {
      job: { id: "job-policy-rollback-failed", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/firewall rollback failed/i);
    expect(result.error).not.toContain("rolled back");
  });

  it("fails hardening if the rollback timer cannot be disarmed", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "ufw-connectivity-ok\n", exitCode: 0 });
    mockSsh.mockResponse(/pkill -f 'sleep 300/, { exitCode: 1, stderr: "timer still active" });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const claim: any = {
      job: { id: "job-firewall-disarm", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.stepsCompleted).not.toContain("harden");
  });

  it("closes the fresh firewall verification connection when connectivity fails", async () => {
    const initial = new MockSshExecutor();
    const fresh = new MockSshExecutor();
    fresh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "incorrect", exitCode: 0 });
    const connections = [initial, fresh];
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => {
      const connection = connections.shift();
      if (!connection) throw new Error("Unexpected SSH connection");
      return connection;
    } });
    const claim: any = {
      job: { id: "job-firewall-disconnect", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(fresh.isConnected()).toBe(false);
  });

  it("reports firewall rollback failure when the rollback command fails", async () => {
    const initial = new MockSshExecutor();
    const fresh = new MockSshExecutor();
    initial.mockResponse("sudo ufw disable", { exitCode: 1, stderr: "permission denied" });
    fresh.mockResponse('echo "ufw-connectivity-ok"', { exitCode: 1 });
    const connections = [initial, fresh];
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => {
      const connection = connections.shift();
      if (!connection) throw new Error("Unexpected SSH connection");
      return connection;
    } });
    const claim: any = {
      job: { id: "job-firewall-rollback-failed", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };

    const result = await executor.execute(claim, createMockReporter().reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("firewall rollback failed");
    expect(result.error).not.toContain("rolled back");
  });

  it("rejects a forged firewall connectivity marker", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "not-ufw-connectivity-ok\n", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-firewall-marker", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["harden"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(mockReporter.completion?.status).toBe("failed");
  });

  it("rolls back firewall and fails job when firewall connectivity check fails", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse(/ssh-keygen -l/, {
      stdout: "256 SHA256:fp root@test (ED25519)",
      exitCode: 0,
    });
    mockSsh.mockResponse("cat /etc/os-release", {
      stdout: 'NAME="Debian GNU/Linux"\nID=debian',
      exitCode: 0,
    });
    mockSsh.mockResponse("df -P /", {
      stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000000 1000000 9000000 10% /",
      exitCode: 0,
    });
    mockSsh.mockResponse("sudo -n true", { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/test -d/, { stdout: "", exitCode: 1 });
    mockSsh.mockResponse(/mkdir -p ~\/\.ssh/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse('echo "myrmidon-key-verify"', { stdout: "myrmidon-key-verify\n", exitCode: 0 });
    mockSsh.mockResponse(/sudo ufw allow/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/nohup sh -c 'sleep 300/, { stdout: "", exitCode: 0 });
    mockSsh.mockResponse(/sudo ufw default deny incoming/, { stdout: "", exitCode: 0 });
    // Simulate connectivity failure after ufw enable:
    mockSsh.mockResponse('echo "ufw-connectivity-ok"', { stdout: "", exitCode: 1 });
    mockSsh.mockResponse("sudo ufw disable", { stdout: "Firewall stopped and disabled on system startup", exitCode: 0 });

    const executor = new FleetOnboardExecutor({
      createSshExecutor: () => mockSsh,
      generateKeyPair: () => ({ publicKey: "pub", privateKey: "priv" }),
    });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-3", companyId: "c1", serverId: "s3" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["connect", "preflight", "access", "harden", "verify"],
      options: { keepPassword: true },
      secretValues: { bootstrapPassword: "pass" },
    };

    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Firewall allow-before-deny verification failed; rolled back");
    expect(mockReporter.completion?.status).toBe("failed");
    // Verify rollback command was executed
    expect(mockSsh.hasExecuted("sudo ufw disable")).toBe(true);
  });

  it("fails TOFU check when host key fingerprint does not match pinned value", async () => {
    const mockSsh = new MockSshExecutor();
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

  it("fails final verification if the fresh SSH command returns the wrong output", async () => {
    const mockSsh = new MockSshExecutor();
    mockSsh.mockResponse('echo "onboard-verified"', { stdout: "unexpected output", exitCode: 0 });
    const executor = new FleetOnboardExecutor({ createSshExecutor: () => mockSsh });
    const mockReporter = createMockReporter();
    const claim: any = {
      job: { id: "job-verify-output", companyId: "c1", serverId: "s1" },
      server: { hostname: "1.2.3.4", port: 22, username: "root" },
      steps: ["verify"], options: { keepPassword: true }, secretValues: { accessKey: "key" },
    };
    const result = await executor.execute(claim, mockReporter.reporter);
    expect(result.status).toBe("failed");
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
    const mockSsh = new MockSshExecutor();
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
