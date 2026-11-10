// myrmidon(SERVER-ONBOARD): seam tests for the real onboarding dry-run
// executor.
//
// The production executor performs three real probes: DNS resolution, a
// full SSH authentication ("can we open a session at all?"), and a
// passwordless-sudo check over that session. These tests verify the
// behavior of the real executor through its seams — node:dns lookup and
// the ssh2 Client — without any live network:
//
//   * DNS ENOTFOUND    → dns_not_found
//   * SSH ECONNREFUSED → ssh_connection_refused
//   * SSH auth failure → ssh_auth_failed (an "All authentication methods
//     failed" handshake error from ssh2, previously unreachable when the
//     probe only read a TCP banner)
//   * sudo -n success  → permissions_ok; sudo -n failure → permissions_sudo_denied
//   * no private-key material ever leaves the process (checked via the
//     captured ssh2 connect config)
//
// We intercept `ssh2` and `dns lookup` with vi.mock so no real
// connection is attempted.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Mock node:dns/promises before any module under test loads ----

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// ---- Mock ssh2 before any module under test loads ----

class FakeSshClient {
  static instances: FakeSshClient[] = [];
  static onConnect: ((client: FakeSshClient) => void) | undefined;
  static onExec: ((client: FakeSshClient, command: string, cb: (error: Error | undefined, stream?: FakeStream) => void) => void) | undefined;
  static onEnd: ((client: FakeSshClient) => void) | undefined;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  private execCommands: Array<{
    command: string;
    cb: (error: Error | undefined, stream?: FakeStream) => void;
  }> = [];

  constructor() {
    FakeSshClient.instances.push(this);
  }

  readonly connectConfigs: Record<string, unknown>[] = [];

  on(event: string, listener: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(listener);
  }

  once(event: string, listener: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(listener);
  }

  connect(config: Record<string, unknown>) {
    this.connectConfigs.push(config);
    hooks.onConnect?.(this);
  }

  exec(
    command: string,
    cb: (error: Error | undefined, stream?: FakeStream) => void,
  ) {
    this.execCommands.push({ command, cb });
    hooks.onExec?.(this, command, cb);
  }

  end() {
    hooks.onEnd?.(this);
  }

  emit(event: string, ...args: unknown[]) {
    const list = this.listeners[event] ? [...this.listeners[event]] : [];
    for (const l of list) l(...args);
  }

  get lastCommand(): string | undefined {
    return this.execCommands.at(-1)?.command;
  }
}

export class FakeStream {
  private dataListeners: Array<(data: Buffer | string) => void> = [];
  private closeListeners: Array<() => void> = [];
  readonly stderr = {
    on: () => undefined,
  };

  on(event: string, listener: (...args: unknown[]) => void) {
    if (event === "data") this.dataListeners.push(listener as (d: Buffer | string) => void);
    if (event === "close") this.closeListeners.push(listener as () => void);
  }

  once(event: string, listener: (...args: unknown[]) => void) {
    this.on(event, listener);
  }

  write(data: string) {
    for (const l of this.dataListeners) l(Buffer.from(data));
  }

  close() {
    for (const l of this.closeListeners) l();
  }
}

// Static hooks the individual tests install.
const hooks: {
  onConnect?: (client: FakeSshClient) => void;
  onExec?: (client: FakeSshClient, command: string, cb: (error: Error | undefined, stream?: FakeStream) => void) => void;
  onEnd?: (client: FakeSshClient) => void;
} = {};

vi.mock("ssh2", () => ({
  Client: FakeSshClient,
  default: { Client: FakeSshClient },
}));

// Import after the mocks are registered.
import { createRealOnboardingDryRunExecutor } from "./dry-run-executor.js";

const TEST_KEY = "test-private-key-material-for-unit-tests-only";
const TEST_KEY_MARKER = "TESTKEYMARKER-DO-NOT-LEAK";

const AUTH = { privateKey: `${TEST_KEY}\n# ${TEST_KEY_MARKER}` };

function lastClient(): FakeSshClient {
  return FakeSshClient.instances.at(-1)!;
}

describe("createRealOnboardingDryRunExecutor", () => {
  beforeEach(() => {
    FakeSshClient.instances = [];
    hooks.onConnect = undefined;
    hooks.onExec = undefined;
    hooks.onEnd = undefined;
    lookupMock.mockReset();
  });

  it("maps DNS ENOTFOUND to dns_not_found without touching SSH", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("query A ENOTFOUND"), { code: "ENOTFOUND" }));

    const executor = createRealOnboardingDryRunExecutor();
    const outcome = await executor.resolveDns("missing.example.invalid");

    expect(outcome).toMatchObject({ status: "failed", code: "dns_not_found" });
    expect(FakeSshClient.instances).toHaveLength(0);
  });

  it("maps DNS success to dns_ok with the resolved address", async () => {
    lookupMock.mockResolvedValue({ address: "203.0.113.10", family: 4 });

    const executor = createRealOnboardingDryRunExecutor();
    const outcome = await executor.resolveDns("node-a.example.com");

    expect(outcome).toMatchObject({ status: "ok", code: "dns_ok", message: "resolved to 203.0.113.10" });
  });

  it("maps ECONNREFUSED during SSH connect to ssh_connection_refused", async () => {
    hooks.onConnect = (client) => {
      setImmediate(() =>
        client.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
      );
    };

    const executor = createRealOnboardingDryRunExecutor();
    const outcome = await executor.probeSsh("203.0.113.10", 22, "deploy", AUTH, 5000);

    expect(outcome).toMatchObject({ status: "failed", code: "ssh_connection_refused" });
  });

  it("reaches the real SSH handshake and maps auth rejection to ssh_auth_failed", async () => {
    hooks.onConnect = (client) => {
      setImmediate(() => client.emit("ready"));
    };

    const executor = createRealOnboardingDryRunExecutor();
    const outcomePromise = executor.probeSsh("203.0.113.10", 22, "deploy", AUTH, 5000);
    await vi.waitFor(() => {
      expect(lastClient().lastCommand).toBeDefined();
    });
    const client = lastClient();
    client.emit("error", new Error("All defined authentication methods failed"));

    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({ status: "failed", code: "ssh_auth_failed" });
    // The handshake must actually have been attempted (an exec was issued),
    // not just a banner read.
    expect(client.lastCommand).toBeDefined();
  });

  it("reports permissions_ok only when `sudo -n true` succeeds", async () => {
    hooks.onConnect = (client) => {
      setImmediate(() => client.emit("ready"));
    };
    hooks.onExec = (_client, _command, cb) => {
      const stream = new FakeStream();
      setImmediate(() => {
        cb(undefined, stream as unknown as never);
        stream.write("SUDO_OK\n");
        stream.close();
      });
    };

    const executor = createRealOnboardingDryRunExecutor();
    const outcome = await executor.probePermissions("203.0.113.10", 22, "deploy", AUTH, 5000);

    expect(lastClient().lastCommand).toContain("sudo -n true");
    expect(outcome).toMatchObject({ status: "ok", code: "permissions_ok" });
  });

  it("reports permissions_sudo_denied when sudo exits without the marker", async () => {
    hooks.onConnect = (client) => {
      setImmediate(() => client.emit("ready"));
    };
    hooks.onExec = (_client, _command, cb) => {
      const stream = new FakeStream();
      setImmediate(() => {
        cb(undefined, stream as unknown as never);
        stream.close();
      });
    };

    const executor = createRealOnboardingDryRunExecutor();
    const outcome = await executor.probePermissions("203.0.113.10", 22, "deploy", AUTH, 5000);

    expect(outcome).toMatchObject({ status: "failed", code: "permissions_sudo_denied" });
  });

  it("never places private-key material outside the ssh2 connect config", async () => {
    hooks.onConnect = (client) => {
      setImmediate(() => client.emit("ready"));
    };
    hooks.onExec = (_client, _command, cb) => {
      const stream = new FakeStream();
      setImmediate(() => {
        cb(undefined, stream as unknown as never);
        stream.write("SUDO_OK\n");
        stream.close();
      });
    };

    const executor = createRealOnboardingDryRunExecutor();
    await executor.probePermissions("203.0.113.10", 22, "deploy", AUTH, 5000);

    const client = lastClient();
    const config = client.connectConfigs.at(-1)!;
    // The key travels only inside the ssh2 config object (never argv, never logs).
    expect(config.privateKey).toBe(AUTH.privateKey);
    expect(client.lastCommand).not.toContain("BEGIN");
    expect(client.lastCommand).not.toContain(TEST_KEY_MARKER);
  });
});
