// myrmidon(1.6.6 PROCS-1.5): unit tests of the readiness rules and of the
// per-process check resolution. No database, no HTTP: the probes are injected,
// so every lane of the decision table is reachable in milliseconds.
import { describe, expect, it, vi } from "vitest";
import {
  NOT_READY_STATUS,
  READY_STATUS,
  healthzVerdict,
  processReady,
  readinessBody,
  supervisorApiCounts,
  type HealthzInput,
  type ReadinessCheck,
  type SupervisorChildView,
  type SupervisorHealthState,
} from "./domain.js";
import {
  bindProcessBusReadiness,
  createProcessReadiness,
  processSupervisorForHealthz,
  registerProcessSupervisor,
} from "./service.js";

function check(
  id: ReadinessCheck["id"],
  status: ReadinessCheck["status"],
  detail: string | null = null,
): ReadinessCheck {
  return { id, status, detail };
}

const OK_CHECKS: ReadinessCheck[] = [
  check("database", "ok"),
  check("migrations", "ok"),
  check("bus", "ok", "channels: run_queued"),
];

function supervisor(
  state: SupervisorHealthState,
  desiredApiCount: number,
  children: SupervisorChildView[],
) {
  return {
    state: () => state,
    desiredApiCount: () => desiredApiCount,
    children: () => children,
  };
}

function healthzInput(over: Partial<HealthzInput> = {}): HealthzInput {
  return {
    role: "worker",
    bootId: "boot-1",
    selfReady: true,
    selfChecks: OK_CHECKS,
    supervisor: null,
    now: new Date("2026-10-10T09:00:00.000Z"),
    ...over,
  };
}

describe("processReady", () => {
  it("is ready when every check is ok", () => {
    expect(processReady(OK_CHECKS)).toBe(true);
  });

  it("treats not_applicable as non-blocking, so an unused check cannot fail a healthy process", () => {
    expect(
      processReady([
        check("database", "ok"),
        check("migrations", "ok"),
        check("bus", "not_applicable", "no bus subscription reported by this process"),
      ]),
    ).toBe(true);
  });

  it("is not ready when any check says not_ready", () => {
    expect(processReady([check("database", "ok"), check("migrations", "not_ready")])).toBe(false);
  });
});

describe("supervisorApiCounts", () => {
  it("reports one desired api for a process without a supervisor", () => {
    expect(supervisorApiCounts(null)).toEqual({ desired: 1, ready: 0, starting: 0 });
  });

  it("counts ready and starting children and ignores draining ones", () => {
    const counts = supervisorApiCounts(
      supervisor("split", 3, [
        { ready: true, draining: false },
        { ready: true, draining: false },
        { ready: false, draining: false },
        { ready: true, draining: true },
      ]),
    );
    expect(counts).toEqual({ desired: 3, ready: 2, starting: 1 });
  });

  it("never reports zero desired api processes", () => {
    expect(supervisorApiCounts(supervisor("single", 0, [])).desired).toBe(1);
  });

  it("counts the live children when the supervisor keeps its desired count private", () => {
    // The shape of the PROCS-1.2 supervisor: state() + children(), nothing else.
    const counts = supervisorApiCounts({
      state: () => "split",
      children: () => [
        { ready: true, draining: false },
        { ready: true, draining: false },
        { ready: false, draining: false },
      ],
    });
    expect(counts).toEqual({ desired: 3, ready: 2, starting: 1 });
  });
});

describe("healthzVerdict", () => {
  it("answers for the process itself when no supervisor is wired", () => {
    const verdict = healthzVerdict(healthzInput());
    expect(verdict.status).toBe(READY_STATUS);
    expect(verdict.reason).toBe("process_ready");
    expect(verdict.body.scope).toBe("process");
    expect(verdict.body.supervisorState).toBeNull();
    expect(verdict.body.api).toEqual({ desired: 1, ready: 1, starting: 0 });
    expect(verdict.body.at).toBe("2026-10-10T09:00:00.000Z");
  });

  it("is not ready when this process is not ready", () => {
    const verdict = healthzVerdict(healthzInput({ selfReady: false }));
    expect(verdict.status).toBe(NOT_READY_STATUS);
    expect(verdict.reason).toBe("process_not_ready");
  });

  it("is 200 in split only when all N api processes are ready", () => {
    const verdict = healthzVerdict(
      healthzInput({
        supervisor: supervisor("split", 3, [
          { ready: true, draining: false },
          { ready: true, draining: false },
          { ready: true, draining: false },
        ]),
      }),
    );
    expect(verdict.status).toBe(READY_STATUS);
    expect(verdict.reason).toBe("all_api_ready");
    expect(verdict.body.scope).toBe("supervisor");
    expect(verdict.body.api).toEqual({ desired: 3, ready: 3, starting: 0 });
  });

  it("is 503 in split while one api process is still starting", () => {
    const verdict = healthzVerdict(
      healthzInput({
        supervisor: supervisor("split", 3, [
          { ready: true, draining: false },
          { ready: true, draining: false },
          { ready: false, draining: false },
        ]),
      }),
    );
    expect(verdict.status).toBe(NOT_READY_STATUS);
    expect(verdict.reason).toBe("api_not_ready");
    expect(verdict.body.api).toEqual({ desired: 3, ready: 2, starting: 1 });
  });

  it("is 503 while the split is still starting, even with no children yet", () => {
    const verdict = healthzVerdict(healthzInput({ supervisor: supervisor("startingSplit", 3, []) }));
    expect(verdict.status).toBe(NOT_READY_STATUS);
    expect(verdict.reason).toBe("split_starting");
  });

  it("gates the split on the supervisor's own checks, because it is the one that applies migrations", () => {
    const verdict = healthzVerdict(
      healthzInput({
        selfReady: false,
        supervisor: supervisor("split", 1, [{ ready: true, draining: false }]),
      }),
    );
    expect(verdict.status).toBe(NOT_READY_STATUS);
    expect(verdict.reason).toBe("process_not_ready");
  });

  it("uses this process's readiness in single, emergencySingle and drainingToSingle", () => {
    for (const state of ["single", "emergencySingle", "drainingToSingle"] as const) {
      const ready = healthzVerdict(healthzInput({ supervisor: supervisor(state, 1, []) }));
      expect(ready.status).toBe(READY_STATUS);
      const notReady = healthzVerdict(
        healthzInput({ selfReady: false, supervisor: supervisor(state, 1, []) }),
      );
      expect(notReady.status).toBe(NOT_READY_STATUS);
    }
  });

  it("does not carry a mutable copy of the checks", () => {
    const checks = [check("database", "ok")];
    const verdict = healthzVerdict(healthzInput({ selfChecks: checks }));
    expect(verdict.body.checks).not.toBe(checks);
  });
});

describe("readinessBody", () => {
  it("reports the snapshot under the same field names as /healthz", () => {
    expect(
      readinessBody({
        ready: false,
        role: "api",
        bootId: "boot-1",
        checks: [check("bus", "not_ready", "bus subscription stopped")],
        at: "2026-10-10T09:00:00.000Z",
      }),
    ).toEqual({
      status: "not_ready",
      ready: false,
      role: "api",
      bootId: "boot-1",
      checks: [check("bus", "not_ready", "bus subscription stopped")],
      at: "2026-10-10T09:00:00.000Z",
    });
  });
});

describe("createProcessReadiness", () => {
  const base = {
    role: "api" as const,
    bootId: "boot-api-1",
    databaseProbe: async () => true,
    migrationsApplied: () => true,
  };

  it("is ready with a live database, a finished boot and no bus duty", async () => {
    const readiness = createProcessReadiness(base);
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.role).toBe("api");
    expect(snapshot.bootId).toBe("boot-api-1");
    expect(snapshot.checks.map((entry) => entry.id)).toEqual(["database", "migrations", "bus"]);
    expect(snapshot.checks[2]).toMatchObject({ status: "not_applicable" });
  });

  it("is not ready while the boot recovery has not reported ready (migrations gate)", async () => {
    const readiness = createProcessReadiness({ ...base, migrationsApplied: () => false });
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks.find((entry) => entry.id === "migrations")).toMatchObject({
      status: "not_ready",
    });
  });

  it("reports the database as not ready when the probe fails, and recovers on the next poll", async () => {
    let healthy = false;
    const readiness = createProcessReadiness({
      ...base,
      databaseProbe: async () => healthy,
    });
    expect((await readiness.snapshot()).ready).toBe(false);
    healthy = true;
    expect((await readiness.snapshot()).ready).toBe(true);
  });

  it("reports the probe error as a detail, never as a stack", async () => {
    const readiness = createProcessReadiness({
      ...base,
      databaseProbe: async () => {
        throw new Error("connection refused");
      },
    });
    const database = (await readiness.snapshot()).checks.find((entry) => entry.id === "database");
    expect(database).toMatchObject({ status: "not_ready", detail: "connection refused" });
  });

  it("gives up on a hung probe instead of holding the balancer's request open", async () => {
    const readiness = createProcessReadiness({
      ...base,
      probeTimeoutMs: 20,
      databaseProbe: () => new Promise<boolean>(() => {}),
    });
    const database = (await readiness.snapshot()).checks.find((entry) => entry.id === "database");
    expect(database?.status).toBe("not_ready");
    expect(database?.detail).toContain("timed out");
  });

  it("blocks readiness on a reported but inactive bus subscription", async () => {
    const readiness = createProcessReadiness(base);
    readiness.reportBusSubscription({
      active: false,
      channels: ["run_queued"],
      detail: "LISTEN failed",
    });
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks.find((entry) => entry.id === "bus")).toMatchObject({
      status: "not_ready",
      detail: "LISTEN failed",
    });
  });

  it("counts an active subscription as ok and names its channels", async () => {
    const readiness = createProcessReadiness(base);
    readiness.reportBusSubscription({ active: true, channels: ["run_queued", "run_control"] });
    const bus = (await readiness.snapshot()).checks.find((entry) => entry.id === "bus");
    expect(bus).toMatchObject({ status: "ok", detail: "channels: run_queued, run_control" });
  });

  it("goes back to not_applicable when the demand for the bus disappears", async () => {
    const readiness = createProcessReadiness(base);
    readiness.reportBusSubscription({ active: true, channels: ["run_queued"] });
    readiness.reportBusSubscription(null);
    expect((await readiness.snapshot()).checks.find((entry) => entry.id === "bus")).toMatchObject({
      status: "not_applicable",
    });
  });
});

describe("the process-local supervisor registry", () => {
  it("hands the app the supervisor of this process, and nothing when it is cleared", () => {
    expect(processSupervisorForHealthz()).toBeNull();
    const registered = supervisor("split", 2, [{ ready: true, draining: false }]);
    registerProcessSupervisor(registered);
    expect(processSupervisorForHealthz()).toBe(registered);
    registerProcessSupervisor(null);
    expect(processSupervisorForHealthz()).toBeNull();
  });
});

describe("bindProcessBusReadiness", () => {
  it("turns the bus check on only after the subscription started, and off before it stops", async () => {
    const readiness = createProcessReadiness({
      role: "worker",
      bootId: "boot-worker-1",
      databaseProbe: async () => true,
      migrationsApplied: () => true,
    });
    const order: string[] = [];
    const bus = {
      start: vi.fn(async () => {
        order.push("bus.start");
      }),
      stop: vi.fn(async () => {
        order.push("bus.stop");
      }),
    };
    const bound = bindProcessBusReadiness(readiness, bus, ["run_queued"]);

    await bound.start();
    expect(order).toEqual(["bus.start"]);
    expect((await readiness.snapshot()).checks.find((entry) => entry.id === "bus")).toMatchObject({
      status: "ok",
    });

    await bound.stop();
    expect(order).toEqual(["bus.start", "bus.stop"]);
    expect((await readiness.snapshot()).checks.find((entry) => entry.id === "bus")).toMatchObject({
      status: "not_ready",
    });
  });
});