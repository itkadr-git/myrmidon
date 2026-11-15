import { describe, expect, it } from "vitest";
import { MockSshExecutor } from "../../services/fleet/mock-ssh-executor.js";
import { FleetOnboardExecutor, type ExecutorReporter } from "./executor.js";
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
