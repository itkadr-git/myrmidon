// myrmidon(SERVER-ONBOARD): unit tests for Mock SSH Executor in server package.

import { describe, expect, it, beforeEach } from "vitest";
import {
  createMockSshExecutor,
  MockSshExecutor,
  SshAuthenticationError,
  SshTimeoutError,
  type SshExecutor,
} from "./mock-ssh-executor.js";

describe("MockSshExecutor — SshExecutor Interface Conformance", () => {
  it("implements the SshExecutor interface methods", async () => {
    const executor: SshExecutor = createMockSshExecutor();

    expect(typeof executor.connect).toBe("function");
    expect(typeof executor.disconnect).toBe("function");
    expect(typeof executor.isConnected).toBe("function");
    expect(typeof executor.execute).toBe("function");
    expect(typeof executor.exec).toBe("function");

    expect(executor.isConnected()).toBe(false);
    await executor.connect({ host: "192.0.2.1", username: "ubuntu" });
    expect(executor.isConnected()).toBe(true);

    const result = await executor.execute("echo hello");
    expect(result.exitCode).toBe(0);

    const execResult = await executor.exec("echo world");
    expect(execResult.exitCode).toBe(0);

    await executor.disconnect();
    expect(executor.isConnected()).toBe(false);
  });
});

describe("MockSshExecutor — Scenarios (success, timeout, auth_fail)", () => {
  describe("success scenario", () => {
    it("connects successfully and runs commands", async () => {
      const executor = new MockSshExecutor({ scenario: "success" });

      await executor.connect({ host: "192.0.2.1", port: 22, username: "deploy" });
      expect(executor.isConnected()).toBe(true);

      const result = await executor.execute("uptime");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("allows dynamic switching to and from success scenario", async () => {
      const executor = new MockSshExecutor({ scenario: "auth_fail" });
      expect(executor.config.scenario).toBe("auth_fail");

      executor.setScenario("success");
      expect(executor.config.scenario).toBe("success");

      await executor.connect({ host: "192.0.2.1", username: "root" });
      expect(executor.isConnected()).toBe(true);
    });
  });

  describe("timeout scenario", () => {
    it("throws SshTimeoutError on connect when scenario is timeout", async () => {
      const executor = new MockSshExecutor({
        scenario: "timeout",
        timeoutMs: 5000,
      });

      await expect(
        executor.connect({ host: "192.0.2.55", port: 22, username: "admin" }),
      ).rejects.toThrow(SshTimeoutError);

      expect(executor.isConnected()).toBe(false);
    });

    it("throws SshTimeoutError when command is executed without connection in timeout scenario", async () => {
      const executor = new MockSshExecutor({ scenario: "timeout" });

      await expect(executor.execute("uname -a")).rejects.toThrow(SshTimeoutError);
    });

    it("simulates timeout for specific long-running commands", async () => {
      const executor = new MockSshExecutor({
        scenario: "success",
        timeoutCommands: ["sleep 100", /apt-get update/],
      });

      await executor.connect();

      // Normal command succeeds
      const quick = await executor.execute("hostname");
      expect(quick.exitCode).toBe(0);

      // Targeted timeout command throws
      await expect(executor.execute("sleep 100")).rejects.toThrow(SshTimeoutError);
      await expect(executor.execute("sudo apt-get update")).rejects.toThrow(SshTimeoutError);
    });
  });

  describe("auth_fail scenario", () => {
    it("throws SshAuthenticationError on connect when scenario is auth_fail", async () => {
      const executor = new MockSshExecutor({
        scenario: "auth_fail",
        authFailReason: "Permission denied (publickey)",
      });

      await expect(
        executor.connect({ host: "192.0.2.1", username: "root" }),
      ).rejects.toThrow(SshAuthenticationError);

      expect(executor.isConnected()).toBe(false);
    });

    it("throws SshAuthenticationError with default reason message", async () => {
      const executor = new MockSshExecutor({ scenario: "auth_fail" });

      await expect(executor.connect()).rejects.toThrow(/SSH authentication failed/);
    });

    it("throws SshAuthenticationError when command is executed without connection in auth_fail scenario", async () => {
      const executor = new MockSshExecutor({ scenario: "auth_fail" });

      await expect(executor.execute("whoami")).rejects.toThrow(SshAuthenticationError);
    });
  });
});

describe("MockSshExecutor — Basic Inventory Script Execution", () => {
  let executor: MockSshExecutor;

  beforeEach(() => {
    executor = createMockSshExecutor({
      inventory: {
        hostname: "test-host-01",
        kernel: "6.8.0-test",
        arch: "x86_64",
        cpuCores: 8,
        cpuModel: "AMD EPYC 7763",
        memoryTotalMb: 16384,
        memoryFreeMb: 12288,
        diskTotalGb: 200,
        diskFreeGb: 150,
        passwordlessSudo: true,
        dockerInstalled: true,
      },
    });
  });

  it("emulates uname family commands", async () => {
    const unameAll = await executor.execute("uname -a");
    expect(unameAll.exitCode).toBe(0);
    expect(unameAll.stdout).toContain("Linux");
    expect(unameAll.stdout).toContain("test-host-01");

    const arch = await executor.execute("uname -m");
    expect(arch.stdout.trim()).toBe("x86_64");

    const kernel = await executor.execute("uname -r");
    expect(kernel.stdout.trim()).toBe("6.8.0-test");

    const os = await executor.execute("uname -s");
    expect(os.stdout.trim()).toBe("Linux");
  });

  it("emulates /etc/os-release inventory check", async () => {
    const osRelease = await executor.execute("cat /etc/os-release");
    expect(osRelease.exitCode).toBe(0);
    expect(osRelease.stdout).toContain('NAME="Ubuntu"');
    expect(osRelease.stdout).toContain('VERSION="24.04');
  });

  it("emulates lscpu and nproc CPU discovery", async () => {
    const lscpu = await executor.execute("lscpu");
    expect(lscpu.exitCode).toBe(0);
    expect(lscpu.stdout).toContain("CPU(s):                          8");
    expect(lscpu.stdout).toContain("AMD EPYC 7763");

    const nproc = await executor.execute("nproc");
    expect(nproc.stdout.trim()).toBe("8");
  });

  it("emulates memory and disk space checks", async () => {
    const free = await executor.execute("free -m");
    expect(free.exitCode).toBe(0);
    expect(free.stdout).toContain("16384");

    const df = await executor.execute("df -h /");
    expect(df.exitCode).toBe(0);
    expect(df.stdout).toContain("200G");
    expect(df.stdout).toContain("150G");
  });

  it("reports passwordless sudo accurately", async () => {
    // Sudo enabled
    const sudoOk = await executor.execute("sudo -n true");
    expect(sudoOk.exitCode).toBe(0);

    // Sudo disabled
    executor.setInventory({ passwordlessSudo: false });
    const sudoFail = await executor.execute("sudo -n true");
    expect(sudoFail.exitCode).toBe(1);
    expect(sudoFail.stderr).toContain("sudo: a password is required");
  });

  it("emulates docker availability discovery", async () => {
    const dockerVer = await executor.execute("docker --version");
    expect(dockerVer.exitCode).toBe(0);
    expect(dockerVer.stdout).toContain("Docker version");

    // When docker is not installed
    executor.setInventory({ dockerInstalled: false });
    const noDocker = await executor.execute("docker --version");
    expect(noDocker.exitCode).toBe(127);
    expect(noDocker.stderr).toContain("docker: command not found");
  });
});

describe("MockSshExecutor — In-Memory Command Logging and Assertions", () => {
  it("records all executed commands with options, timestamps, and results", async () => {
    const executor = createMockSshExecutor();
    await executor.connect({ host: "node1.internal", username: "infra" });

    await executor.execute("uname -a");
    await executor.execute("df -h", { timeoutMs: 3000 });
    await executor.execute("sudo systemctl status myrmidon", { sudo: true });

    const commands = executor.getExecutedCommands();
    expect(commands.length).toBe(3);

    expect(commands[0].command).toBe("uname -a");
    expect(commands[0].result?.exitCode).toBe(0);

    expect(commands[1].command).toBe("df -h");
    expect(commands[1].options?.timeoutMs).toBe(3000);

    expect(commands[2].command).toBe("sudo systemctl status myrmidon");
    expect(commands[2].options?.sudo).toBe(true);

    expect(executor.getCommandHistory()).toEqual([
      "uname -a",
      "df -h",
      "sudo systemctl status myrmidon",
    ]);

    expect(executor.getLastCommand()?.command).toBe("sudo systemctl status myrmidon");
  });

  it("supports assertion helper methods: hasExecuted, findCommand, filterCommands", async () => {
    const executor = createMockSshExecutor();
    await executor.connect();

    await executor.execute("mkdir -p /opt/app");
    await executor.execute("chown -R app:app /opt/app");
    await executor.execute("chmod 755 /opt/app");

    // Substring pattern matching
    expect(executor.hasExecuted("mkdir -p")).toBe(true);
    expect(executor.hasExecuted("systemctl")).toBe(false);

    // RegExp pattern matching
    expect(executor.hasExecuted(/chmod\\s+755/)).toBe(true);
    expect(executor.hasExecuted(/chmod\\s+777/)).toBe(false);

    // Finding individual records
    const chownCmd = executor.findCommand(/chown/);
    expect(chownCmd).toBeDefined();
    expect(chownCmd?.command).toBe("chown -R app:app /opt/app");

    // Filtering
    const optCommands = executor.filterCommands("/opt/app");
    expect(optCommands.length).toBe(3);

    // Resetting history
    executor.clearHistory();
    expect(executor.getExecutedCommands()).toEqual([]);
    expect(executor.getCommandHistory()).toEqual([]);
    expect(executor.hasExecuted("mkdir")).toBe(false);
  });

  it("records connection history and parameters", async () => {
    const executor = createMockSshExecutor();

    await executor.connect({ host: "host-a", port: 22, username: "user1" });
    await executor.disconnect();
    await executor.connect({ host: "host-b", port: 2222, username: "user2" });

    const attempts = executor.getConnectionAttempts();
    expect(attempts.length).toBe(2);
    expect(attempts[0].host).toBe("host-a");
    expect(attempts[0].username).toBe("user1");
    expect(attempts[1].host).toBe("host-b");
    expect(attempts[1].port).toBe(2222);
  });
});

describe("MockSshExecutor — Custom Command Mapping and Failure Injection", () => {
  it("allows exact and pattern response registration via mockResponse", async () => {
    const executor = createMockSshExecutor();
    await executor.connect();

    executor.mockResponse("my-custom-cli --status", {
      stdout: '{"status": "healthy", "version": "1.0.0"}\\n',
      exitCode: 0,
    });

    executor.mockResponse(/iptables -L/, "Chain INPUT (policy ACCEPT)\\n");

    const customRes = await executor.execute("my-custom-cli --status");
    expect(customRes.stdout).toContain("healthy");

    const iptablesRes = await executor.execute("sudo iptables -L -n");
    expect(iptablesRes.stdout).toContain("Chain INPUT");
  });

  it("allows configuring specific failing commands via failCommands", async () => {
    const executor = createMockSshExecutor({
      failCommands: {
        "systemctl restart nginx": {
          exitCode: 1,
          stderr: "Job for nginx.service failed because the control process exited with error code.",
        },
      },
    });
    await executor.connect();

    const normal = await executor.execute("hostname");
    expect(normal.exitCode).toBe(0);

    const failed = await executor.execute("systemctl restart nginx");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("nginx.service failed");
  });
});

describe("MockSshExecutor — End-to-End Server Onboarding Simulation", () => {
  it("simulates a complete successful server onboarding flow and validates command sequence", async () => {
    const executor = createMockSshExecutor({
      inventory: {
        hostname: "prod-edge-01",
        passwordlessSudo: true,
      },
    });

    // 1. Initial connection with temporary credentials
    await executor.connect({
      host: "203.0.113.10",
      port: 22,
      username: "deploy",
      password: "temporary-initial-pass",
    });
    expect(executor.isConnected()).toBe(true);

    // 2. Preflight checks
    const whoami = await executor.execute("whoami");
    expect(whoami.stdout.trim()).toBe("deploy");

    const sudoCheck = await executor.execute("sudo -n true");
    expect(sudoCheck.exitCode).toBe(0);

    // 3. Hardware / OS Inventory
    const osRelease = await executor.execute("cat /etc/os-release");
    expect(osRelease.stdout).toContain("Ubuntu");

    const cpu = await executor.execute("lscpu");
    expect(cpu.stdout).toContain("CPU(s)");

    const mem = await executor.execute("free -m");
    expect(mem.stdout).toContain("Mem:");

    const disk = await executor.execute("df -h /");
    expect(disk.stdout).toContain("/dev/root");

    // 4. Deploy permanent public key
    const boardPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoardKeyGenerated4FleetManagement test@board";
    await executor.execute("mkdir -p ~/.ssh && chmod 700 ~/.ssh");
    await executor.execute(`echo "${boardPublicKey}" >> ~/.ssh/authorized_keys`);
    await executor.execute("chmod 600 ~/.ssh/authorized_keys");

    // 5. Hardening: firewall configuration
    await executor.execute("sudo ufw allow 22/tcp");
    await executor.execute("sudo ufw default deny incoming");

    // 6. Assert exact execution history in memory
    const history = executor.getCommandHistory();
    expect(history).toEqual([
      "whoami",
      "sudo -n true",
      "cat /etc/os-release",
      "lscpu",
      "free -m",
      "df -h /",
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
      `echo "${boardPublicKey}" >> ~/.ssh/authorized_keys`,
      "chmod 600 ~/.ssh/authorized_keys",
      "sudo ufw allow 22/tcp",
      "sudo ufw default deny incoming",
    ]);

    expect(executor.hasExecuted("authorized_keys")).toBe(true);
    expect(executor.hasExecuted(/ufw allow 22/)).toBe(true);
  });

  it("simulates onboarding abort when preflight sudo check fails", async () => {
    const executor = createMockSshExecutor({
      inventory: {
        passwordlessSudo: false,
      },
    });

    await executor.connect({ host: "198.51.100.2", username: "limited-user" });

    // Step 1: Preflight sudo check
    const sudoRes = await executor.execute("sudo -n true");
    expect(sudoRes.exitCode).not.toBe(0);

    // Flow detects missing sudo and aborts BEFORE deploying keys or hardening
    const onboardingAborted = sudoRes.exitCode !== 0;
    expect(onboardingAborted).toBe(true);

    expect(executor.hasExecuted("authorized_keys")).toBe(false);
    expect(executor.hasExecuted(/ufw/)).toBe(false);
    expect(executor.getCommandHistory()).toEqual(["sudo -n true"]);
  });

  it("supports SshDryRunExecutor contract for quick probe validations", async () => {
    const executor = createMockSshExecutor({
      scenario: "success",
      inventory: {
        passwordlessSudo: true,
        uname: "Linux custom-host 6.1.0 x86_64",
      },
    });

    const probe = await executor.dryRun({
      host: "192.0.2.1",
      port: 22,
      username: "deploy",
      privateKey: "[REDACTED TEST KEY]",
    });

    expect(probe.outcome).toBe("ok");
    if (probe.outcome === "ok") {
      expect(probe.passwordlessSudo).toBe(true);
      expect(probe.remoteUname).toBe("Linux custom-host 6.1.0 x86_64");
    }
  });
});
