import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  withWorktreePortRegistryLock,
  withWorktreePortRegistryLockSync,
} from "./worktree-port-registry.js";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-port-registry-lock-"));
  temporaryRoots.push(root);
  return root;
}

const PROBE_SERVER_WORKER_SOURCE = `
const net = require("node:net");
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(workerData.probeTimeoutMs || 500, () => socket.destroy());
  socket.once("data", (candidate) => {
    socket.end(candidate === workerData.token ? "owned" : "denied");
  });
});

parentPort.once("message", (msg) => {
  if (msg === "close") {
    server.close(() => {
      parentPort.postMessage("closed");
    });
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  Atomics.store(control, 1, address.port);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
});
`;

function startProbeServerWorker(token: string): {
  port: number;
  close: () => Promise<void>;
  terminate: () => void;
} {
  const control = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(PROBE_SERVER_WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: {
      control: control.buffer,
      token,
      probeTimeoutMs: 500,
    },
  });

  Atomics.wait(control, 0, 0, 2_000);
  if (Atomics.load(control, 0) !== 1) {
    void worker.terminate();
    throw new Error("Failed to start probe server worker");
  }
  const port = Atomics.load(control, 1);
  return {
    port,
    async close() {
      await new Promise<void>((resolve) => {
        worker.once("message", (msg) => {
          if (msg === "closed") resolve();
        });
        worker.postMessage("close");
      });
      await worker.terminate();
    },
    terminate() {
      void worker.terminate();
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree port registry lock", () => {
  it("does not reclaim a stale lock while its fallback ownership probe responds", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const token = "stale-owner-token";
    const probe = startProbeServerWorker(token);

    try {
      fs.mkdirSync(lockPath);
      // Write redundant backup owner and omit primary owner.json to verify fallback reading
      const backupOwnerPath = path.join(lockPath, "owner.backup.json");
      fs.writeFileSync(
        backupOwnerPath,
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          processIdentity: "unavailable-process-identity",
          probePort: probe.port,
          token,
        })}\n`,
      );
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

      const observedLockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      expect(observedLockAgeMs).toBeGreaterThan(5_000);

      let secondEntered = false;
      const second = withWorktreePortRegistryLock(homeDir, async () => {
        secondEntered = true;
      });
      await delay(100);

      expect(secondEntered).toBe(false);

      // Close probe server so the probe now fails; the stale lock is reclaimed
      await probe.close();
      await second;
      expect(secondEntered).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      probe.terminate();
    }
  }, 10_000);

  it("refreshes the lease throughout an async critical section", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");

    await withWorktreePortRegistryLock(homeDir, async () => {
      await delay(5_250);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(2_000);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  }, 10_000);

  it("reclaims an old lock after its owner process exits", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        probePort: 1,
        token: "dead-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims an old lock when its pid belongs to a different process", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: "reused-pid-owner",
        probePort: 1,
        token: "abandoned-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refreshes the lease while a synchronous critical section blocks the main thread", () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const blocker = new Int32Array(new SharedArrayBuffer(4));

    withWorktreePortRegistryLockSync(homeDir, () => {
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
      Atomics.wait(blocker, 0, 0, 1_500);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(1_250);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
