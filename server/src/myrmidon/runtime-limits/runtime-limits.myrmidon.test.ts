// myrmidon(C0) RUNTIME-LIMITS: the runtime-limits routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, admission, resweep), so validation, permissions, the audit record and
// the live apply are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { runtimeLimitsRoutes } from "./routes.js";
import {
  RUNTIME_LIMITS_ACTION,
  runtimeLimitsService,
  type RuntimeLimitsServiceDeps,
} from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [] };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

const ENV_ONLY = { MYRMIDON_MAX_CONCURRENT_RUNS: "8" };
// myrmidon(1.6.2 RUN-ADMISSION): the start ramp and the host floor are on by default.
// myrmidon(1.6.5 RUN-ADMISSION, rc.3): the busy ceiling joins the default-on
// set; the PSI ceiling stays off until the operator sets it.
const RAMP_AND_HOST = {
  maxStartsPerMinute: 5,
  minFreeHostMemoryMb: 15360,
  maxHostLoadPercentPerCore: 90,
  maxHostCpuBusyPercent: 90,
  maxHostCpuPsiSomeAvg10: null,
};
// myrmidon(1.6.5 RUN-FAIRNESS): the per-agent start share is on by default.
const SHARE = { maxPerAgentStartSharePercent: 15 };

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  companyIds?: string[];
  settingsError?: Error;
  /** myrmidon(1.6.5 rc.2): the live host CPU reading the view carries. */
  hostLoad?: RuntimeLimitsServiceDeps["hostLoad"];
  /** myrmidon(1.6.5 RUN-FAIRNESS): the live queue snapshot the view carries. */
  queueSnapshot?: RuntimeLimitsServiceDeps["queueSnapshot"];
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const updated: Array<{ runLimits: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as unknown };

  const deps: Partial<RuntimeLimitsServiceDeps> = {
    settings: {
      getGeneral: async () => {
        if (options.settingsError) throw options.settingsError;
        return { runLimits: current.stored };
      },
      updateGeneral: async (patch: { runLimits: unknown }) => {
        current.stored = patch.runLimits;
        updated.push(patch);
        calls.push("write");
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
      calls.push("audit");
    },
    apply: (limits) => calls.push(`apply:${limits.maxConcurrentRuns}`),
    scheduleResweep: () => calls.push("resweep"),
    ...(options.hostLoad ? { hostLoad: options.hostLoad } : {}),
    ...(options.queueSnapshot ? { queueSnapshot: options.queueSnapshot } : {}),
    env: options.env ?? ENV_ONLY,
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", runtimeLimitsRoutes({} as Db, runtimeLimitsService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, calls, updated, audits, deps };
}

const URL = "/api/myrmidon/runtime-limits";

describe("myrmidon(C0) runtime limits: reading the effective values", () => {
  it("reports the environment values as the source when settings never saved them", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body).toEqual({
      limits: { maxConcurrentRuns: 8, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST, ...SHARE },
      sources: {
        maxConcurrentRuns: "env",
        maxStartsPerMinute: "default",
        minFreeMemoryMb: "default",
        runMemoryEstimateMb: "default",
        minFreeHostMemoryMb: "default",
        maxHostLoadPercentPerCore: "default",
        maxPerAgentStartSharePercent: "default",
      },
      // myrmidon(1.6.5 rc.2): the view carries the live host CPU reading; the
      // harness has no admission, so there is none.
      hostLoad: null,
      // myrmidon(1.6.5 RUN-FAIRNESS): without a queue snapshot source the view
      // carries none.
      queue: null,
    });
  });

  it("myrmidon(1.6.5 rc.2): carries the live host CPU reading next to the ceiling", async () => {
    const hostLoad = {
      state: "open" as const,
      thresholdPercent: 90,
      load1: 19.2,
      cores: 16,
      loadPercentPerCore: 120,
      backgroundPercentPerCore: 115,
      load15PercentPerCore: 115,
      loadAboveBackgroundPercent: 5,
      // myrmidon(1.6.5 rc.3): the row keeps the legacy decision, so the new
      // fields report "not consulted".
      cpuBusyPercent: null,
      busyThresholdPercent: null,
      psiSomeAvg10: null,
      psiThresholdPercent: null,
      source: "load-average" as const,
      reason: null,
      heldSince: null,
    };
    // The reading is what the settings page shows next to the field, and it
    // comes from the same admission that decides on the run.
    const { withActor } = harness({ hostLoad: () => hostLoad });
    const res = await request(withActor(member)).get(URL).expect(200);
    expect(res.body.hostLoad).toEqual(hostLoad);
  });

  it("reports the stored settings as the source once they exist", async () => {
    const { app } = harness({
      stored: {
        maxConcurrentRuns: 3,
        maxStartsPerMinute: 4,
        minFreeMemoryMb: 1500,
        runMemoryEstimateMb: 250,
        minFreeHostMemoryMb: 8192,
      },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits).toEqual({
      maxConcurrentRuns: 3,
      maxStartsPerMinute: 4,
      minFreeMemoryMb: 1500,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 8192,
      // myrmidon(1.6.5): the row lacks the CPU ceiling; it resolves from the default.
      maxHostLoadPercentPerCore: 90,
      // myrmidon(1.6.5 RUN-FAIRNESS): the row lacks the start share; the default.
      maxPerAgentStartSharePercent: 15,
    });
    expect(Object.values(res.body.sources)).toEqual([
      "settings",
      "settings",
      "settings",
      "settings",
      "settings",
      "default",
      "default",
    ]);
  });

  it("myrmidon(1.6.2): a row saved before the host floor existed keeps its values and gets the default floor", async () => {
    const { app } = harness({
      stored: { maxConcurrentRuns: 3, maxStartsPerMinute: 12, minFreeMemoryMb: 1500, runMemoryEstimateMb: 250 },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits).toEqual({
      maxConcurrentRuns: 3,
      maxStartsPerMinute: 12,
      minFreeMemoryMb: 1500,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 15360,
      maxHostLoadPercentPerCore: 90,
      maxPerAgentStartSharePercent: 15,
    });
    expect(res.body.sources.maxStartsPerMinute).toBe("settings");
    expect(res.body.sources.minFreeHostMemoryMb).toBe("default");
    expect(res.body.sources.maxHostLoadPercentPerCore).toBe("default");
    expect(res.body.sources.maxPerAgentStartSharePercent).toBe("default");
  });

  it("falls back to the environment when the stored row is not canonical", async () => {
    const { app } = harness({ stored: { maxConcurrentRuns: 0 } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits.maxConcurrentRuns).toBe(8);
    expect(res.body.sources.maxConcurrentRuns).toBe("env");
  });
});

describe("myrmidon(C0) runtime limits: access", () => {
  it("refuses agents on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ maxConcurrentRuns: 4 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("lets a board member read but not write", async () => {
    const h = harness();
    await request(h.withActor(member)).get(URL).expect(200);
    await request(h.withActor(member)).patch(URL).send({ maxConcurrentRuns: 4 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("refuses a board member without any organization access", async () => {
    const h = harness();
    await request(h.withActor(outsider)).get(URL).expect(403);
  });

  it("lets an instance admin write", async () => {
    const h = harness();
    await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 4 }).expect(200);
    expect(h.updated).toEqual([
      { runLimits: { maxConcurrentRuns: 4, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST, ...SHARE } },
    ]);
  });
});

describe("myrmidon(C0) runtime limits: a change reaches the live admission", () => {
  it("writes the row, audits every company, then applies and resweeps", async () => {
    const h = harness({ companyIds: [COMPANY_ID, "company-b"] });
    const res = await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 12 }).expect(200);

    // The environment value became the stored value for the keys the patch leaves alone.
    expect(h.updated).toEqual([
      { runLimits: { maxConcurrentRuns: 12, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST, ...SHARE } },
    ]);
    expect(res.body.limits.maxConcurrentRuns).toBe(12);
    expect(res.body.sources.maxConcurrentRuns).toBe("settings");

    expect(h.audits).toHaveLength(2);
    for (const entry of h.audits) {
      expect(entry).toMatchObject({ action: RUNTIME_LIMITS_ACTION, entityType: "instance_settings" });
      expect(entry.details).toEqual({
        previous: { maxConcurrentRuns: 8, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST, ...SHARE },
        next: { maxConcurrentRuns: 12, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST, ...SHARE },
        changedKeys: ["maxConcurrentRuns"],
      });
    }
    expect(h.audits.map((entry) => entry.companyId)).toEqual([COMPANY_ID, "company-b"]);

    // Audit and row first, then the limits in force: the live admission must
    // never run ahead of what the log says it is.
    expect(h.calls).toEqual(["write", "audit", "audit", "apply:12", "resweep"]);
  });

  it("can switch a cap off with null and keeps the per-run budget", async () => {
    const h = harness({ stored: { maxConcurrentRuns: 5, maxStartsPerMinute: 6, minFreeMemoryMb: 7, runMemoryEstimateMb: 250 } });
    const res = await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: null }).expect(200);
    expect(res.body.limits).toEqual({
      maxConcurrentRuns: null,
      maxStartsPerMinute: 6,
      minFreeMemoryMb: 7,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 15360,
      maxHostLoadPercentPerCore: 90,
      maxPerAgentStartSharePercent: 15,
    });
  });

  it("myrmidon(1.6.2): the host floor and the start ramp change on the fly and can be switched off", async () => {
    const h = harness();
    const res = await request(h.withActor(admin))
      .patch(URL)
      .send({ minFreeHostMemoryMb: 12288, maxStartsPerMinute: 3 })
      .expect(200);
    expect(res.body.limits).toMatchObject({ minFreeHostMemoryMb: 12288, maxStartsPerMinute: 3 });
    expect(res.body.sources.minFreeHostMemoryMb).toBe("settings");
    expect(h.audits[0]!.details).toMatchObject({ changedKeys: ["maxStartsPerMinute", "minFreeHostMemoryMb"] });
    expect(h.calls).toEqual(["write", "audit", "apply:8", "resweep"]);

    const off = await request(h.withActor(admin)).patch(URL).send({ minFreeHostMemoryMb: null }).expect(200);
    expect(off.body.limits.minFreeHostMemoryMb).toBeNull();
    await request(h.withActor(admin)).patch(URL).send({ minFreeHostMemoryMb: 0 }).expect(400);
  });

  it("myrmidon(1.6.5): the host CPU ceiling changes on the fly and can be switched off", async () => {
    const h = harness();
    const res = await request(h.withActor(admin))
      .patch(URL)
      .send({ maxHostLoadPercentPerCore: 150 })
      .expect(200);
    expect(res.body.limits.maxHostLoadPercentPerCore).toBe(150);
    expect(res.body.sources.maxHostLoadPercentPerCore).toBe("settings");
    expect(h.audits[0]!.details).toMatchObject({ changedKeys: ["maxHostLoadPercentPerCore"] });

    const off = await request(h.withActor(admin)).patch(URL).send({ maxHostLoadPercentPerCore: null }).expect(200);
    expect(off.body.limits.maxHostLoadPercentPerCore).toBeNull();
    await request(h.withActor(admin)).patch(URL).send({ maxHostLoadPercentPerCore: 0 }).expect(400);
    await request(h.withActor(admin)).patch(URL).send({ maxHostLoadPercentPerCore: 1.5 }).expect(400);
    // The refused writes changed nothing after the two accepted ones.
    expect(h.updated.at(-1)!.runLimits).toMatchObject({ maxHostLoadPercentPerCore: null });
  });

  it("refuses values that are not a positive integer and writes nothing", async () => {
    const h = harness();
    for (const body of [
      { maxConcurrentRuns: 0 },
      { maxConcurrentRuns: -3 },
      { maxConcurrentRuns: 1.5 },
      { maxConcurrentRuns: "8" },
      { runMemoryEstimateMb: null },
      { minFreeMemoryMb: 100, bogus: 1 },
    ]) {
      await request(h.withActor(admin)).patch(URL).send(body).expect(400);
    }
    expect(h.updated).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("keeps the environment values in force when the settings write fails", async () => {
    const h = harness();
    vi.spyOn(h.deps.settings!, "updateGeneral").mockRejectedValue(new Error("database is down"));
    await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 12 }).expect(500);
    expect(h.calls).toEqual([]);
  });
});

describe("myrmidon(1.6.5 RUN-FAIRNESS) runtime limits: the per-agent start share", () => {
  it("changes the share on the fly, validates it as a percentage and can switch it off", async () => {
    const h = harness();
    const res = await request(h.withActor(admin))
      .patch(URL)
      .send({ maxPerAgentStartSharePercent: 25 })
      .expect(200);
    expect(res.body.limits.maxPerAgentStartSharePercent).toBe(25);
    expect(res.body.sources.maxPerAgentStartSharePercent).toBe("settings");
    expect(h.audits[0]!.details).toMatchObject({ changedKeys: ["maxPerAgentStartSharePercent"] });

    const off = await request(h.withActor(admin)).patch(URL).send({ maxPerAgentStartSharePercent: null }).expect(200);
    expect(off.body.limits.maxPerAgentStartSharePercent).toBeNull();

    await request(h.withActor(admin)).patch(URL).send({ maxPerAgentStartSharePercent: 0 }).expect(400);
    await request(h.withActor(admin)).patch(URL).send({ maxPerAgentStartSharePercent: 101 }).expect(400);
    await request(h.withActor(admin)).patch(URL).send({ maxPerAgentStartSharePercent: 1.5 }).expect(400);
    // The refused writes changed nothing after the two accepted ones.
    expect(h.updated.at(-1)!.runLimits).toMatchObject({ maxPerAgentStartSharePercent: null });
  });

  it("carries the share in the GET view, default 15", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits.maxPerAgentStartSharePercent).toBe(15);
    expect(res.body.sources.maxPerAgentStartSharePercent).toBe("default");
  });
});

describe("myrmidon(1.6.5 RUN-FAIRNESS) runtime limits: the queue snapshot", () => {
  const SNAPSHOT = {
    active: 48,
    limit: 51,
    queued: 12,
    oldestQueuedAt: "2026-10-06T10:00:00.000Z",
    oldestQueuedAgentId: "agent-9",
  };

  it("carries the queue snapshot in the read view", async () => {
    const { app } = harness({ queueSnapshot: async () => SNAPSHOT });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.queue).toEqual(SNAPSHOT);
  });

  it("returns the queue snapshot after an update too", async () => {
    const h = harness({ queueSnapshot: async () => SNAPSHOT });
    const res = await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 60 }).expect(200);
    expect(res.body.queue).toEqual(SNAPSHOT);
  });

  it("reads null when the snapshot source is missing, and survives a source failure", async () => {
    const missing = harness();
    const resMissing = await request(missing.app).get(URL).expect(200);
    expect(resMissing.body.queue).toBeNull();

    const failing = harness({
      queueSnapshot: async () => {
        throw new Error("database is down");
      },
    });
    const resFailing = await request(failing.app).get(URL).expect(200);
    expect(resFailing.body.queue).toBeNull();
  });
});