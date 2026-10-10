// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the standalone
// worker runtime. Pins:
//   * the role gate refuses anything but PAPERCLIP_PROCESS_ROLE=worker —
//     a mislaunched worker would double every background sweep against the
//     api process;
//   * the minimal local config (MYRMIDON_WORKER_PROCESSES) defaults to one
//     executor and rejects counts outside the stage-1 shape;
//   * the worker's loopback app mounts the ч.F readiness routes and nothing
//     else — `/internal/ready` answers through the shared
//     `createProcessReadiness` engine (database, migrations, bus), the public
//     API surface is not reachable on the worker port.

import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  createWorkerReadinessApp,
  resolveWorkerProcessConfig,
  WORKER_COUNT_MAX,
  WORKER_DEFAULT_PORT,
} from "./index.js";

describe("resolveWorkerProcessConfig", () => {
  it("accepts the worker role with defaults", () => {
    const config = resolveWorkerProcessConfig({ PAPERCLIP_PROCESS_ROLE: "worker" });
    expect(config.role).toBe("worker");
    expect(config.workerCount).toBe(1);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(WORKER_DEFAULT_PORT);
  });

  it("refuses to start without the role gate", () => {
    expect(() => resolveWorkerProcessConfig({})).toThrow(/PAPERCLIP_PROCESS_ROLE must be "worker"/);
    expect(() => resolveWorkerProcessConfig({ PAPERCLIP_PROCESS_ROLE: "api" })).toThrow(
      /PAPERCLIP_PROCESS_ROLE must be "worker"/,
    );
  });

  it("bounds the worker count of the minimal local config", () => {
    expect(
      resolveWorkerProcessConfig({
        PAPERCLIP_PROCESS_ROLE: "worker",
        MYRMIDON_WORKER_PROCESSES: String(WORKER_COUNT_MAX),
      }).workerCount,
    ).toBe(WORKER_COUNT_MAX);
    expect(() =>
      resolveWorkerProcessConfig({
        PAPERCLIP_PROCESS_ROLE: "worker",
        MYRMIDON_WORKER_PROCESSES: "0",
      }),
    ).toThrow(/MYRMIDON_WORKER_PROCESSES/);
    expect(() =>
      resolveWorkerProcessConfig({
        PAPERCLIP_PROCESS_ROLE: "worker",
        MYRMIDON_WORKER_PROCESSES: String(WORKER_COUNT_MAX + 1),
      }),
    ).toThrow(/MYRMIDON_WORKER_PROCESSES/);
    expect(() =>
      resolveWorkerProcessConfig({
        PAPERCLIP_PROCESS_ROLE: "worker",
        MYRMIDON_WORKER_PROCESSES: "two",
      }),
    ).toThrow(/MYRMIDON_WORKER_PROCESSES/);
  });

  it("honours the probe host/port overrides", () => {
    const config = resolveWorkerProcessConfig({
      PAPERCLIP_PROCESS_ROLE: "worker",
      MYRMIDON_WORKER_HOST: "0.0.0.0",
      MYRMIDON_WORKER_PORT: "4101",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(4101);
  });
});

describe("createWorkerReadinessApp (the ч.F contract of the worker)", () => {
  it("answers /internal/ready with the worker role and the ч.F check shape", async () => {
    // db: null — the database check degrades to not_applicable (the probe of
    // the real engine is covered by the process-readiness tests); the
    // migrations check reads the startup-recovery state, which is `ready`
    // outside the startup window. The role comes from PAPERCLIP_PROCESS_ROLE,
    // which vitest does not set — pin the contract by setting it for the test.
    const previousRole = process.env.PAPERCLIP_PROCESS_ROLE;
    process.env.PAPERCLIP_PROCESS_ROLE = "worker";
    try {
      const app = createWorkerReadinessApp({ db: null as never });
      const res = await request(app).get("/internal/ready");
      expect(res.body.role).toBe("worker");
      expect(res.body.checks.map((check: { id: string }) => check.id).sort()).toEqual([
        "bus",
        "database",
        "migrations",
      ]);
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      if (previousRole === undefined) delete process.env.PAPERCLIP_PROCESS_ROLE;
      else process.env.PAPERCLIP_PROCESS_ROLE = previousRole;
    }
  });

  it("answers /healthz with the same worker role", async () => {
    const previousRole = process.env.PAPERCLIP_PROCESS_ROLE;
    process.env.PAPERCLIP_PROCESS_ROLE = "worker";
    try {
      const app = createWorkerReadinessApp({ db: null as never });
      const res = await request(app).get("/healthz");
      expect(res.body.role).toBe("worker");
      // Without a ч.B supervisor the aggregate degrades to the process's own checks.
      expect(res.body.scope).toBe("process");
    } finally {
      if (previousRole === undefined) delete process.env.PAPERCLIP_PROCESS_ROLE;
      else process.env.PAPERCLIP_PROCESS_ROLE = previousRole;
    }
  });

  it("serves no public API route on the worker port", async () => {
    const app = createWorkerReadinessApp({ db: null as never });
    const res = await request(app).get("/api/companies");
    expect(res.status).toBe(404);
  });
});
