// myrmidon(1.6.6 PROCS-1.5): route tests of the readiness contract. The
// readiness service and the supervisor are fakes, so the tests cover the
// status codes and the body shape of /internal/ready and /healthz without a
// database, without a supervisor and without spawning anything.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ReadinessCheck, SupervisorChildView, SupervisorHealthState } from "./domain.js";
import { myrmidonProcessReadinessRoutes, type ProcessReadinessRouteDeps } from "./routes.js";
import { registerProcessSupervisor, type ProcessReadiness } from "./service.js";
import type { BoardProcessRole } from "../process-registry/domain.js";

function check(id: ReadinessCheck["id"], status: ReadinessCheck["status"]): ReadinessCheck {
  return { id, status, detail: null };
}

function fakeReadiness(options: {
  role?: BoardProcessRole;
  checks?: ReadinessCheck[];
  throwOnSnapshot?: boolean;
}): ProcessReadiness {
  const role = options.role ?? "worker";
  const checks =
    options.checks ?? [check("database", "ok"), check("migrations", "ok"), check("bus", "ok")];
  return {
    role: () => role,
    bootId: () => "boot-1",
    checks: async () => checks,
    snapshot: async () => {
      if (options.throwOnSnapshot) throw new Error("readiness exploded");
      return {
        ready: checks.every((entry) => entry.status !== "not_ready"),
        role,
        bootId: "boot-1",
        checks,
        at: "2026-10-10T09:00:00.000Z",
      };
    },
    reportBusSubscription: () => {},
  };
}

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

function appWith(deps: ProcessReadinessRouteDeps) {
  const app = express();
  app.use(myrmidonProcessReadinessRoutes(null, deps));
  return app;
}

describe("GET /internal/ready", () => {
  it("answers 200 with the check list when the process can take traffic", async () => {
    const response = await request(appWith({ readiness: fakeReadiness({ role: "api" }) })).get(
      "/internal/ready",
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      status: "ok",
      ready: true,
      role: "api",
      bootId: "boot-1",
      checks: [check("database", "ok"), check("migrations", "ok"), check("bus", "ok")],
      at: "2026-10-10T09:00:00.000Z",
    });
  });

  it("answers 503 with the failing checks when the process is not ready yet", async () => {
    const response = await request(
      appWith({
        readiness: fakeReadiness({
          checks: [check("database", "ok"), check("migrations", "not_ready")],
        }),
      }),
    ).get("/internal/ready");
    expect(response.status).toBe(503);
    expect(response.body.ready).toBe(false);
    expect(response.body.checks).toContainEqual(check("migrations", "not_ready"));
  });

  it("still answers 503 instead of crashing when a check throws", async () => {
    const response = await request(
      appWith({ readiness: fakeReadiness({ throwOnSnapshot: true }) }),
    ).get("/internal/ready");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: "not_ready", ready: false, role: "worker" });
    expect(response.body.error).toBe("readiness exploded");
  });
});

describe("GET /healthz without a supervisor (api child, single process)", () => {
  it("answers 200 for the process itself", async () => {
    const response = await request(appWith({ readiness: fakeReadiness({ role: "api" }) })).get(
      "/healthz",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      scope: "process",
      role: "api",
      ready: true,
      reason: "process_ready",
      supervisorState: null,
      api: { desired: 1, ready: 1, starting: 0 },
    });
  });

  it("answers 503 when the process itself is not ready", async () => {
    const response = await request(
      appWith({ readiness: fakeReadiness({ checks: [check("database", "not_ready")] }) }),
    ).get("/healthz");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ready: false, reason: "process_not_ready" });
  });
});

describe("GET /healthz with a supervisor", () => {
  const readyChecks = [check("database", "ok"), check("migrations", "ok"), check("bus", "ok")];

  it("answers 200 only when every one of the N api processes is ready", async () => {
    const response = await request(
      appWith({
        readiness: fakeReadiness({ checks: readyChecks }),
        processSupervisor: supervisor("split", 3, [
          { ready: true, draining: false },
          { ready: true, draining: false },
          { ready: true, draining: false },
        ]),
      }),
    ).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      scope: "supervisor",
      reason: "all_api_ready",
      supervisorState: "split",
      api: { desired: 3, ready: 3, starting: 0 },
    });
  });

  it("answers 503 while the N-th api process is still starting", async () => {
    const response = await request(
      appWith({
        readiness: fakeReadiness({ checks: readyChecks }),
        processSupervisor: supervisor("split", 3, [
          { ready: true, draining: false },
          { ready: true, draining: false },
          { ready: false, draining: false },
        ]),
      }),
    ).get("/healthz");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ready: false,
      reason: "api_not_ready",
      api: { desired: 3, ready: 2, starting: 1 },
    });
  });

  it("answers 503 while the split is starting", async () => {
    const response = await request(
      appWith({
        readiness: fakeReadiness({ checks: readyChecks }),
        processSupervisor: supervisor("startingSplit", 3, []),
      }),
    ).get("/healthz");
    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("split_starting");
  });

  it("answers 200 in the single lane as soon as this process is ready", async () => {
    const response = await request(
      appWith({
        readiness: fakeReadiness({ role: "worker", checks: readyChecks }),
        processSupervisor: supervisor("single", 1, []),
      }),
    ).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scope: "supervisor", reason: "process_ready" });
  });
});

describe("GET /healthz and the process-local supervisor registry", () => {
  it("picks up a supervisor registered after the app was built, because the split starts later than the app", async () => {
    const app = appWith({ readiness: fakeReadiness({ role: "worker" }) });
    try {
      const before = await request(app).get("/healthz");
      expect(before.status).toBe(200);
      expect(before.body.scope).toBe("process");

      registerProcessSupervisor(
        supervisor("split", 3, [
          { ready: true, draining: false },
          { ready: false, draining: false },
          { ready: false, draining: false },
        ]),
      );

      const after = await request(app).get("/healthz");
      expect(after.status).toBe(503);
      expect(after.body).toMatchObject({
        scope: "supervisor",
        reason: "api_not_ready",
        supervisorState: "split",
        api: { desired: 3, ready: 1, starting: 2 },
      });
    } finally {
      registerProcessSupervisor(null);
    }
  });
});