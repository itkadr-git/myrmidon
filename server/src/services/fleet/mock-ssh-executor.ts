// myrmidon(SERVER-ONBOARD): mock SSH executor for fleet onboarding testing.
//
// Allows testing server onboarding flows without physical access to remote hosts.
// Simulates successful connections, authentication failures, connection timeouts,
// and execution of basic system inventory scripts (uname, os-release, lscpu, free, df, sudo).
// Records all executed commands in-memory for test assertions.

import type { SshDryRunResult } from "../../onboarding/ssh-dry-run.js";

/** Recognized scenario outcomes for the mock executor. */
export type SshAuthScenario = "success" | "timeout" | "auth_fail";

/** Connection configuration for an SSH target host. */
export interface SshConnectionOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  timeoutMs?: number;
}

/** Execution options for running commands over SSH. */
export interface SshExecuteOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  sudo?: boolean;
}

/** Normalized command execution output. */
export interface SshExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string | null;
  durationMs?: number;
}

/**
 * Common SSH executor interface for running commands on remote servers.
 */
export interface SshExecutor {
  connect(options?: SshConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  execute(command: string, options?: SshExecuteOptions): Promise<SshExecutionResult>;
  exec(command: string, options?: SshExecuteOptions): Promise<SshExecutionResult>;
}

/** Error raised when an SSH connection or command times out. */
export class SshTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  readonly outcome = "timeout" as const;

  constructor(message = "SSH connection timed out") {
    super(message);
    this.name = "SshTimeoutError";
  }
}

/** Error raised when SSH authentication fails. */
export class SshAuthenticationError extends Error {
  readonly code = "AUTH_FAILED";
  readonly outcome = "auth_fail" as const;

  constructor(message = "SSH authentication failed (wrong credentials or key not authorized)") {
    super(message);
    this.name = "SshAuthenticationError";
  }
}

/** Error raised when an SSH host cannot be reached or connected. */
export class SshConnectionError extends Error {
  readonly code = "ECONNREFUSED";
  readonly outcome = "host_unreachable" as const;

  constructor(message = "SSH connection failed: host unreachable") {
    super(message);
    this.name = "SshConnectionError";
  }
}

/** Recorded in-memory record of a command execution. */
export interface LoggedCommand {
  command: string;
  options?: SshExecuteOptions;
  timestamp: number;
  result?: SshExecutionResult;
  error?: Error;
}

/** Server inventory details simulated by the mock executor. */
export interface MockServerInventory {
  osRelease?: string;
  uname?: string;
  kernel?: string;
  arch?: string;
  hostname?: string;
  cpuCores?: number;
  cpuModel?: string;
  memoryTotalMb?: number;
  memoryFreeMb?: number;
  diskTotalGb?: number;
  diskFreeGb?: number;
  passwordlessSudo?: boolean;
  dockerInstalled?: boolean;
  dockerVersion?: string;
}

/** Default Linux server inventory profile. */
export const DEFAULT_MOCK_INVENTORY: Required<MockServerInventory> = {
  osRelease: `NAME="Ubuntu"
VERSION="24.04 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04 LTS"
VERSION_ID="24.04"
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble`,
  uname: "Linux srv-node-01 6.8.0-40-generic #40-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux",
  kernel: "6.8.0-40-generic",
  arch: "x86_64",
  hostname: "srv-node-01",
  cpuCores: 4,
  cpuModel: "AMD EPYC 7763 64-Core Processor",
  memoryTotalMb: 8192,
  memoryFreeMb: 6144,
  diskTotalGb: 100,
  diskFreeGb: 75,
  passwordlessSudo: true,
  dockerInstalled: true,
  dockerVersion: "Docker version 27.1.1, build 6312585",
};

export type CommandHandler = (
  command: string,
  options?: SshExecuteOptions,
) => Partial<SshExecutionResult> | string | undefined;

/** Configuration options for MockSshExecutor. */
export interface MockSshConfig {
  /** Target scenario outcome for connection/authentication: success, timeout, auth_fail. */
  scenario?: SshAuthScenario;
  /** Custom reason message for auth_fail scenario. */
  authFailReason?: string;
  /** Custom timeout threshold in milliseconds. */
  timeoutMs?: number;
  /** Simulated latency delay for operations in milliseconds. */
  latencyMs?: number;
  /** Initial connection options if pre-connected. */
  connection?: SshConnectionOptions;
  /** Simulated hardware/system inventory details. */
  inventory?: Partial<MockServerInventory>;
  /** Exact command-to-response mapping. */
  commandResponses?: Record<string, Partial<SshExecutionResult> | string>;
  /** Pattern/regex matching for command responses. */
  patternResponses?: Array<{
    pattern: string | RegExp;
    response: Partial<SshExecutionResult> | string | CommandHandler;
  }>;
  /** Commands that trigger an SshTimeoutError. */
  timeoutCommands?: (string | RegExp)[];
  /** Commands that exit with failure. */
  failCommands?: Record<string, { exitCode?: number; stderr?: string }>;
  /** Custom fallback command handler. */
  onCommand?: CommandHandler;
}

/**
 * Mock implementation of SshExecutor for testing server onboarding.
 */
export class MockSshExecutor implements SshExecutor {
  public config: MockSshConfig;
  public executedCommands: LoggedCommand[] = [];
  public connectionHistory: SshConnectionOptions[] = [];
  private connected = false;
  private currentConnection: SshConnectionOptions | null = null;

  constructor(config: MockSshConfig = {}) {
    this.config = {
      scenario: "success",
      ...config,
      inventory: {
        ...DEFAULT_MOCK_INVENTORY,
        ...config.inventory,
      },
    };

    if (config.connection) {
      this.currentConnection = { ...config.connection };
      if (this.config.scenario === "success") {
        this.connected = true;
      }
    }
  }

  /** Current connection state. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Configure or update scenario dynamically. */
  setScenario(scenario: SshAuthScenario): void {
    this.config.scenario = scenario;
    if (scenario !== "success") {
      this.connected = false;
    }
  }

  /** Update simulated server inventory. */
  setInventory(inventory: Partial<MockServerInventory>): void {
    this.config.inventory = {
      ...this.config.inventory,
      ...inventory,
    };
  }

  /** Register a custom mock response for an exact command or regex pattern. */
  mockResponse(
    commandOrPattern: string | RegExp,
    response: Partial<SshExecutionResult> | string | CommandHandler,
  ): void {
    if (typeof commandOrPattern === "string" && typeof response !== "function") {
      this.config.commandResponses = {
        ...this.config.commandResponses,
        [commandOrPattern]: response,
      };
    } else {
      this.config.patternResponses = [
        ...(this.config.patternResponses ?? []),
        { pattern: commandOrPattern, response },
      ];
    }
  }

  /** Connect to the remote host according to the configured scenario. */
  async connect(options?: SshConnectionOptions): Promise<void> {
    const conn = options ?? this.config.connection ?? {
      host: "127.0.0.1",
      port: 22,
      username: "root",
    };

    this.connectionHistory.push({ ...conn });
    this.currentConnection = conn;

    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    if (this.config.scenario === "timeout") {
      this.connected = false;
      throw new SshTimeoutError(
        `SSH connection to ${conn.host}:${conn.port ?? 22} timed out after ${this.config.timeoutMs ?? 10000}ms`,
      );
    }

    if (this.config.scenario === "auth_fail") {
      this.connected = false;
      throw new SshAuthenticationError(
        this.config.authFailReason ??
          `SSH authentication failed for user ${conn.username}@${conn.host}: Permission denied (publickey,password)`,
      );
    }

    this.connected = true;
  }

  /** Disconnect from the SSH host. */
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Alias for execute. */
  async exec(command: string, options?: SshExecuteOptions): Promise<SshExecutionResult> {
    return this.execute(command, options);
  }

  /** Execute a command on the remote host and record it in memory. */
  async execute(command: string, options?: SshExecuteOptions): Promise<SshExecutionResult> {
    const timestamp = Date.now();

    // Auto-connect on execute if not yet connected and not configured with an error scenario
    if (!this.connected) {
      if (this.config.scenario === "auth_fail") {
        const error = new SshAuthenticationError(
          this.config.authFailReason ?? "SSH authentication failed: Permission denied",
        );
        this.executedCommands.push({ command, options, timestamp, error });
        throw error;
      }
      if (this.config.scenario === "timeout") {
        const error = new SshTimeoutError("SSH command execution timed out: not connected");
        this.executedCommands.push({ command, options, timestamp, error });
        throw error;
      }
      this.connected = true;
    }

    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Check if this specific command should time out
    if (this.config.timeoutCommands?.some((t) => (typeof t === "string" ? command.includes(t) : t.test(command)))) {
      const error = new SshTimeoutError(`Command execution timed out: ${command}`);
      this.executedCommands.push({ command, options, timestamp, error });
      throw error;
    }

    // Check if this command should fail
    const failureMatch = this.config.failCommands ? this.config.failCommands[command] : undefined;
    if (failureMatch) {
      const result: SshExecutionResult = {
        stdout: "",
        stderr: failureMatch.stderr ?? `Command failed with exit code ${failureMatch.exitCode ?? 1}`,
        exitCode: failureMatch.exitCode ?? 1,
        signal: null,
        durationMs: 5,
      };
      this.executedCommands.push({ command, options, timestamp, result });
      return result;
    }

    // Evaluate response
    const result = this.resolveCommandResponse(command, options);
    this.executedCommands.push({ command, options, timestamp, result });
    return result;
  }

  /** Compatibility with SshDryRunExecutor for onboarding validation endpoints. */
  async dryRun(input: {
    host: string;
    port: number;
    username: string;
    privateKey: string;
    timeoutMs?: number;
  }): Promise<SshDryRunResult> {
    const startedAt = Date.now();
    this.connectionHistory.push({
      host: input.host,
      port: input.port,
      username: input.username,
      privateKey: input.privateKey,
      timeoutMs: input.timeoutMs,
    });

    const durationMs = Date.now() - startedAt;

    if (this.config.scenario === "auth_fail") {
      return {
        outcome: "auth_failed",
        reason: this.config.authFailReason ?? "authentication failed (wrong credentials or key not authorized)",
        durationMs,
      };
    }

    if (this.config.scenario === "timeout") {
      return {
        outcome: "connection_timeout",
        reason: "connection timed out",
        durationMs,
      };
    }

    const inv = { ...DEFAULT_MOCK_INVENTORY, ...this.config.inventory };
    const uname =
      this.config.inventory?.uname ??
      `Linux ${inv.hostname} ${inv.kernel} #40-Ubuntu SMP PREEMPT_DYNAMIC ${inv.arch} ${inv.arch} ${inv.arch} GNU/Linux`;
    return {
      outcome: "ok",
      passwordlessSudo: inv.passwordlessSudo ?? true,
      remoteUname: uname,
      durationMs,
    };
  }

  /** Returns all logged command execution events. */
  getExecutedCommands(): LoggedCommand[] {
    return [...this.executedCommands];
  }

  /** Returns just the executed command strings in invocation order. */
  getCommandHistory(): string[] {
    return this.executedCommands.map((c) => c.command);
  }

  /** Returns the last executed command record or undefined if none. */
  getLastCommand(): LoggedCommand | undefined {
    return this.executedCommands[this.executedCommands.length - 1];
  }

  /** Checks whether a command matching the given pattern was executed. */
  hasExecuted(pattern: string | RegExp): boolean {
    if (typeof pattern === "string") {
      return this.executedCommands.some((c) => c.command.includes(pattern));
    }
    return this.executedCommands.some((c) => pattern.test(c.command));
  }

  /** Finds the first logged command matching the given pattern. */
  findCommand(pattern: string | RegExp): LoggedCommand | undefined {
    if (typeof pattern === "string") {
      return this.executedCommands.find((c) => c.command.includes(pattern));
    }
    return this.executedCommands.find((c) => pattern.test(c.command));
  }

  /** Filters logged commands matching the given pattern. */
  filterCommands(pattern: string | RegExp): LoggedCommand[] {
    if (typeof pattern === "string") {
      return this.executedCommands.filter((c) => c.command.includes(pattern));
    }
    return this.executedCommands.filter((c) => pattern.test(c.command));
  }

  /** Returns all recorded connection attempts. */
  getConnectionAttempts(): SshConnectionOptions[] {
    return [...this.connectionHistory];
  }

  /** Clears all logged commands and connection history. */
  clearHistory(): void {
    this.executedCommands = [];
    this.connectionHistory = [];
  }

  /**
   * Resolves command output matching against:
   * 1. Exact commandResponses
   * 2. Pattern responses
   * 3. Custom onCommand handler
   * 4. Standard inventory command simulations
   * 5. Fallback success
   */
  private resolveCommandResponse(command: string, options?: SshExecuteOptions): SshExecutionResult {
    const trimmed = command.trim();

    // 1. Exact match in commandResponses
    if (this.config.commandResponses && trimmed in this.config.commandResponses) {
      return this.normalizeResult(this.config.commandResponses[trimmed]);
    }

    // 2. Pattern responses
    if (this.config.patternResponses) {
      for (const pr of this.config.patternResponses) {
        const matches = typeof pr.pattern === "string" ? trimmed.includes(pr.pattern) : pr.pattern.test(trimmed);
        if (matches) {
          const resp = typeof pr.response === "function" ? pr.response(trimmed, options) : pr.response;
          if (resp !== undefined) {
            return this.normalizeResult(resp);
          }
        }
      }
    }

    // 3. Custom onCommand handler
    if (this.config.onCommand) {
      const resp = this.config.onCommand(trimmed, options);
      if (resp !== undefined) {
        return this.normalizeResult(resp);
      }
    }

    // 4. Built-in system and inventory command handlers
    const inventoryResult = this.resolveInventoryCommand(trimmed);
    if (inventoryResult) {
      return inventoryResult;
    }

    // 5. Default benign success response
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 5,
    };
  }

  /**
   * Emulates basic system inventory scripts:
   * - uname, uname -a, uname -m, uname -r
   * - cat /etc/os-release
   * - lscpu, nproc
   * - free -m, free -h
   * - df -h, df -P /
   * - hostname
   * - sudo -n true
   * - docker --version
   * - whoami
   */
  private resolveInventoryCommand(command: string): SshExecutionResult | null {
    const inv: Required<MockServerInventory> = {
      ...DEFAULT_MOCK_INVENTORY,
      ...this.config.inventory,
    };
    if (!this.config.inventory?.uname) {
      inv.uname = `Linux ${inv.hostname} ${inv.kernel} #40-Ubuntu SMP PREEMPT_DYNAMIC ${inv.arch} ${inv.arch} ${inv.arch} GNU/Linux`;
    }

    // Sudo check
    if (command === "sudo -n true" || command.includes("sudo -n true")) {
      if (inv.passwordlessSudo) {
        // If command includes the SUDO_OK marker chain (like in ssh-dry-run)
        const stdout = command.includes("echo SUDO_OK") ? "SUDO_OK\n" : "";
        return { stdout, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
      }
      return {
        stdout: "",
        stderr: "sudo: a password is required\n",
        exitCode: 1,
        signal: null,
        durationMs: 5,
      };
    }

    // OS release / distribution details
    if (
      command.includes("/etc/os-release") ||
      command.includes("/etc/system-release") ||
      command.includes("/etc/*release")
    ) {
      return { stdout: `${inv.osRelease}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // Uname inspection
    if (command === "uname -a" || command.startsWith("uname -a")) {
      let stdout = inv.uname;
      if (command.includes("echo SUDO_OK") && inv.passwordlessSudo) {
        stdout += "\nSUDO_OK";
      }
      return { stdout: `${stdout}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }
    if (command === "uname -m") {
      return { stdout: `${inv.arch}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }
    if (command === "uname -r") {
      return { stdout: `${inv.kernel}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }
    if (command === "uname -s") {
      return { stdout: "Linux\n", stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // Hostname
    if (command === "hostname" || command === "hostname -f") {
      return { stdout: `${inv.hostname}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // CPU details
    if (command === "nproc") {
      return { stdout: `${inv.cpuCores}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }
    if (command === "lscpu" || command.includes("lscpu")) {
      const lscpuOutput = `Architecture:                    ${inv.arch}
CPU op-mode(s):                  32-bit, 64-bit
Address sizes:                   48 bits physical, 48 bits virtual
Byte Order:                      Little Endian
CPU(s):                          ${inv.cpuCores}
On-line CPU(s) list:             0-${inv.cpuCores - 1}
Vendor ID:                       AuthenticAMD
Model name:                      ${inv.cpuModel}
CPU family:                      25
Model:                           1
Thread(s) per core:              1
Core(s) per socket:              ${inv.cpuCores}
Socket(s):                       1`;
      return { stdout: `${lscpuOutput}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // Memory details
    if (command === "free -m" || command.includes("free -m")) {
      const total = inv.memoryTotalMb;
      const free = inv.memoryFreeMb;
      const used = total - free;
      const available = free;
      const freeOutput = `               total        used        free      shared  buff/cache   available
Mem:            ${total}        ${used}        ${free}           0           0        ${available}
Swap:           2048           0        2048`;
      return { stdout: `${freeOutput}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // Disk details
    if (command.startsWith("df -h") || command.startsWith("df -P") || command === "df -h /") {
      const total = `${inv.diskTotalGb}G`;
      const avail = `${inv.diskFreeGb}G`;
      const used = `${inv.diskTotalGb - inv.diskFreeGb}G`;
      const usePercent = `${Math.round(((inv.diskTotalGb - inv.diskFreeGb) / inv.diskTotalGb) * 100)}%`;
      const dfOutput = `Filesystem      Size  Used Avail Use% Mounted on
/dev/root        ${total}   ${used}   ${avail}  ${usePercent} /
tmpfs           4.0G     0  4.0G   0% /dev/shm`;
      return { stdout: `${dfOutput}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // User identification
    if (command === "whoami") {
      const user = this.currentConnection?.username ?? "root";
      return { stdout: `${user}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
    }

    // Docker verification
    if (command === "docker --version" || command === "docker -v") {
      if (inv.dockerInstalled) {
        return { stdout: `${inv.dockerVersion}\n`, stderr: "", exitCode: 0, signal: null, durationMs: 5 };
      }
      return {
        stdout: "",
        stderr: "docker: command not found\n",
        exitCode: 127,
        signal: null,
        durationMs: 5,
      };
    }

    if (command === "which docker") {
      if (inv.dockerInstalled) {
        return { stdout: "/usr/bin/docker\n", stderr: "", exitCode: 0, signal: null, durationMs: 5 };
      }
      return {
        stdout: "",
        stderr: "which: no docker in (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)\n",
        exitCode: 1,
        signal: null,
        durationMs: 5,
      };
    }

    return null;
  }

  /** Normalizes a response value into a full SshExecutionResult. */
  private normalizeResult(val: Partial<SshExecutionResult> | string): SshExecutionResult {
    if (typeof val === "string") {
      return {
        stdout: val,
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 5,
      };
    }
    return {
      stdout: val.stdout ?? "",
      stderr: val.stderr ?? "",
      exitCode: val.exitCode ?? 0,
      signal: val.signal ?? null,
      durationMs: val.durationMs ?? 5,
    };
  }
}

/** Factory function to create a new MockSshExecutor. */
export function createMockSshExecutor(config?: MockSshConfig): MockSshExecutor {
  return new MockSshExecutor(config);
}
